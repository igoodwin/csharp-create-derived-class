import * as vscode from "vscode";
import * as path from "path";

export function activate(context: vscode.ExtensionContext) {
  const provider: vscode.CodeActionProvider = new CreateDerivedClassProvider();

  // register code action provider for C#
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: "csharp", scheme: "file" },
      provider,
      {
        providedCodeActionKinds:
          CreateDerivedClassProvider.providedCodeActionKinds,
      }
    )
  );

  // register the command invoked by the code action (and also available directly)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.createDerivedClass",
      async (args) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage(
            "Open a C# file and place the cursor on a class declaration."
          );
          return;
        }

        const doc = editor.document;
        const position = editor.selection.active;

        let baseName: string | undefined;
        let typeParameters: string[] = [];

        if (args && typeof args.baseName === "string") {
          baseName = args.baseName;
          if (Array.isArray(args.typeParameters)) {
            typeParameters = args.typeParameters;
          }
        } else {
          const info = await detectClassInfoAtPosition(doc, position);
          if (info) {
            baseName = info.name;
            typeParameters = info.typeParameters;
          }
        }

        if (!baseName) {
          vscode.window.showErrorMessage(
            "Could not detect class name at cursor."
          );
          return;
        }

        const defaultName = `${baseName}Derived`;
        const newName = await vscode.window.showInputBox({
          prompt: `Name for derived class inheriting from ${baseName}`,
          value: defaultName,
          validateInput: (value) => {
            if (!/^[A-Za-z_]\w*$/.test(value)) {
              return "Invalid C# identifier";
            }
            return null;
          },
        });

        if (!newName) {
          return;
        }

        try {
          await createDerivedClassFile(
            doc,
            position,
            baseName,
            newName,
            typeParameters
          );
          vscode.window.showInformationMessage(
            `Created class ${newName} : ${baseName}`
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            "Failed to create file: " + String(err)
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.addPropertyToInterface",
      async (args: AddMemberToInterfaceArgs) => {
        if (!args || !args.uri || !args.member) {
          vscode.window.showErrorMessage(
            "Не удалось определить элемент для добавления в интерфейс."
          );
          return;
        }

        const doc = await vscode.workspace.openTextDocument(args.uri);
        const member = args.member;

        if (args.targetInterfaceName) {
          await addMemberToExistingInterface(
            doc,
            args.targetInterfaceName,
            member
          );
          return;
        }

        const defaultName =
          member.enclosingClassName && member.enclosingClassName.length > 0
            ? `I${member.enclosingClassName}`
            : "INewInterface";

        const interfaceName = await vscode.window.showInputBox({
          prompt: "Имя интерфейса",
          value: defaultName,
          validateInput: (value) => {
            if (!value || !/^[A-Za-z_]\w*$/.test(value)) {
              return "Введите корректное имя интерфейса";
            }
            return null;
          },
        });

        if (!interfaceName) {
          return;
        }

        const interfaces = await detectInterfacesInDocument(doc);
        const existing = interfaces.find((i) => i.name === interfaceName);
        if (existing) {
          await addMemberToExistingInterface(doc, interfaceName, member);
        } else {
          await createInterfaceWithMember(doc, interfaceName, member);
        }
      }
    )
  );
}

export function deactivate() {
  // nothing to clean up
}

interface ClassInfo {
  name: string;
  typeParameters: string[];
}

interface ConstructorInfo {
  accessibility?: string;
  parameters: string;
  argumentList: string;
}

interface AbstractMethodInfo {
  accessibility: string; // public / protected / internal / private
  returnType: string; // Task, Task<T>, int, MyType и т.д.
  name: string; // ProcessAsync
  fullTypeParameterText: string; // "<TArg>" или ""
  typeParameters: string[]; // ["TArg"]
  parameters: string; // "T arg"
  constraints: string; // "where TArg : class" и т.п. или ""
}

interface AbstractPropertyInfo {
  accessibility: string; // public / protected / ...
  type: string; // T, Task<T>, MyType и т.п.
  name: string; // Data
  hasGetter: boolean;
  hasSetter: boolean;
  hasInit: boolean;
}

interface BaseExtractionInfo {
  kind: "property" | "method";
  name: string;
  enclosingClassName?: string;
  startOffset: number;
  requiredTypeParameters: string[];
}

interface PropertyExtractionInfo extends BaseExtractionInfo {
  kind: "property";
  type: string;
  hasGetter: boolean;
  hasSetter: boolean;
  hasInit: boolean;
}

interface MethodExtractionInfo extends BaseExtractionInfo {
  kind: "method";
  returnType: string;
  parameters: string;
  fullTypeParameterText: string;
  typeParameters: string[];
  constraints?: string;
  accessibility?: string;
  accessibilityRange?: vscode.Range;
}

type ExtractedMember = PropertyExtractionInfo | MethodExtractionInfo;

interface AddMemberToInterfaceArgs {
  uri: vscode.Uri;
  member: ExtractedMember;
  targetInterfaceName?: string;
}

interface InterfaceDeclarationInfo {
  name: string;
  bodyText: string;
  insertPosition: vscode.Position;
  memberIndent: string;
}

interface NamespaceBlockInfo {
  name: string;
  type: "block" | "fileScoped";
  insertPosition: vscode.Position;
}

interface DocumentSymbolCacheEntry {
  version: number;
  symbols: vscode.DocumentSymbol[];
}

const documentSymbolCache = new Map<string, DocumentSymbolCacheEntry>();

async function getDocumentSymbols(
  doc: vscode.TextDocument
): Promise<vscode.DocumentSymbol[]> {
  const key = doc.uri.toString();
  const cached = documentSymbolCache.get(key);
  if (cached && cached.version === doc.version) {
    return cached.symbols;
  }

  try {
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", doc.uri);
    if (symbols) {
      documentSymbolCache.set(key, { version: doc.version, symbols });
      return symbols;
    }
  } catch (err) {
    console.warn("Failed to retrieve document symbols", err);
  }

  documentSymbolCache.delete(key);
  return [];
}

function collectSymbolsByKind(
  symbols: readonly vscode.DocumentSymbol[] | undefined,
  kind: vscode.SymbolKind,
  result: vscode.DocumentSymbol[] = []
): vscode.DocumentSymbol[] {
  if (!symbols) {
    return result;
  }

  for (const symbol of symbols) {
    if (symbol.kind === kind) {
      result.push(symbol);
    }
    collectSymbolsByKind(symbol.children, kind, result);
  }

  return result;
}

function findEnclosingSymbolByKind(
  symbols: readonly vscode.DocumentSymbol[] | undefined,
  pos: vscode.Position,
  kinds: readonly vscode.SymbolKind[]
): vscode.DocumentSymbol | undefined {
  if (!symbols) {
    return undefined;
  }

  for (const symbol of symbols) {
    if (!symbol.range.contains(pos)) {
      continue;
    }

    const child = findEnclosingSymbolByKind(symbol.children, pos, kinds);
    if (child) {
      return child;
    }

    if (kinds.includes(symbol.kind)) {
      return symbol;
    }
  }

  return undefined;
}

class CreateDerivedClassProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): Promise<(vscode.CodeAction | vscode.Command)[]> {
    // detect if cursor is on a class declaration
    const pos = range instanceof vscode.Selection ? range.start : range.start;
    const actions: vscode.CodeAction[] = [];

    const symbols = await getDocumentSymbols(document);

    const classInfo = await detectClassInfoAtPosition(document, pos, symbols);
    if (classInfo) {
      const title = `Create derived class '${classInfo.name}Derived'`;
      const action = new vscode.CodeAction(
        title,
        vscode.CodeActionKind.QuickFix
      );
      action.command = {
        command: "extension.createDerivedClass",
        title,
        arguments: [
          { baseName: classInfo.name, typeParameters: classInfo.typeParameters },
        ],
      };
      action.isPreferred = true;
      actions.push(action);
    }

    let memberInfo: ExtractedMember | undefined =
      await detectPropertyAtPosition(document, pos, symbols);
    if (!memberInfo) {
      memberInfo = await detectMethodAtPosition(document, pos, symbols);
    }

    if (memberInfo) {
      const interfaces = await detectInterfacesInDocument(document, symbols);
      if (!isMemberDeclaredInInterfaces(memberInfo, interfaces)) {
        const baseAction = new vscode.CodeAction(
          "Выделить в интерфейс...",
          vscode.CodeActionKind.QuickFix
        );
        baseAction.command = {
          command: "extension.addPropertyToInterface",
          title: "Выделить в интерфейс",
          arguments: [
            {
              uri: document.uri,
              member: memberInfo,
            },
          ],
        };
        actions.push(baseAction);

        for (const iface of interfaces) {
          const ifaceAction = new vscode.CodeAction(
            `Добавить в интерфейс ${iface.name}`,
            vscode.CodeActionKind.QuickFix
          );
          ifaceAction.command = {
            command: "extension.addPropertyToInterface",
            title: `Добавить в интерфейс ${iface.name}`,
            arguments: [
              {
                uri: document.uri,
                member: memberInfo,
                targetInterfaceName: iface.name,
              },
            ],
          };
          actions.push(ifaceAction);
        }
      }
    }

    return actions;
  }
}

function buildArgumentList(parameterList: string): string {
  if (!parameterList || !parameterList.trim()) {
    return "";
  }

  const parts = parameterList.split(",");
  const args: string[] = [];

  for (const part of parts) {
    const beforeEquals = part.split("=")[0].trim(); // отбрасываем значения по умолчанию
    if (!beforeEquals) {
      continue;
    }

    // разбиваем по пробелам: могут быть ref/out/in/this, тип, имя
    const tokens = beforeEquals.split(/\s+/);
    if (tokens.length === 0) {
      continue;
    }

    const name = tokens[tokens.length - 1];
    const modifiers = tokens.filter((t) =>
      ["ref", "out", "in", "this"].includes(t)
    );

    if (!name) {
      continue;
    }

    const arg = (modifiers.length ? modifiers.join(" ") + " " : "") + name;
    args.push(arg);
  }

  return args.join(", ");
}

/**
 * Try to detect class name if the cursor is on a line like "public class Foo" or "class Foo : Bar"
 */
async function detectClassInfoAtPosition(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  symbols?: vscode.DocumentSymbol[]
): Promise<ClassInfo | undefined> {
  const tree = symbols ?? (await getDocumentSymbols(doc));
  const classSymbol = findEnclosingSymbolByKind(tree, pos, [
    vscode.SymbolKind.Class,
  ]);

  if (classSymbol) {
    const fromSymbol = extractClassInfoFromSymbol(classSymbol);
    if (fromSymbol) {
      return fromSymbol;
    }
    return detectClassInfoAtPositionLegacy(doc, classSymbol.selectionRange.start);
  }

  return detectClassInfoAtPositionLegacy(doc, pos);
}

function extractClassInfoFromSymbol(
  symbol: vscode.DocumentSymbol
): ClassInfo | undefined {
  const match = /^([A-Za-z_]\w*)(?:<([^>]+)>)?/.exec(symbol.detail);
  if (!match) {
    return undefined;
  }

  const name = match[1];
  const typeParameters: string[] = [];
  if (match[2]) {
    match[2].split(",").forEach((raw) => {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const idMatch = /^([A-Za-z_]\w*)/.exec(trimmed);
        if (idMatch) {
          typeParameters.push(idMatch[1]);
        }
      }
    });
  }

  return { name, typeParameters };
}

function detectClassInfoAtPositionLegacy(
  doc: vscode.TextDocument,
  pos: vscode.Position
): ClassInfo | undefined {
  const line = doc.lineAt(pos.line).text;

  // Ищем что-то вроде: class Foo<T, U>
  const classRegex = /\bclass\s+([A-Za-z_]\w*)\s*(<([^>]+)>)?/;
  const m = classRegex.exec(line);
  if (m && m[1]) {
    const name = m[1];
    const typeParameters: string[] = [];

    if (m[3]) {
      // m[3] — содержимое внутри <>
      m[3].split(",").forEach((p) => {
        const trimmed = p.trim();
        if (trimmed.length > 0) {
          // берём идентификатор до возможных where/ограничений (хотя в объявлении класса их обычно нет)
          const idMatch = /^([A-Za-z_]\w*)/.exec(trimmed);
          if (idMatch) {
            typeParameters.push(idMatch[1]);
          }
        }
      });
    }

    return { name, typeParameters };
  }

  // fallback: как раньше, но без параметров
  const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
  if (wordRange) {
    const word = doc.getText(wordRange);
    for (
      let l = Math.max(0, pos.line - 5);
      l <= Math.min(doc.lineCount - 1, pos.line + 5);
      l++
    ) {
      const text = doc.lineAt(l).text;
      const rx = new RegExp(`\\bclass\\s+${word}\\b`);
      if (rx.test(text)) {
        return { name: word, typeParameters: [] };
      }
    }
  }

  return undefined;
}

function detectConstructors(
  doc: vscode.TextDocument,
  baseName: string
): ConstructorInfo[] {
  const text = doc.getText();
  const ctors: ConstructorInfo[] = [];

  // ищем что-то вроде:
  // public BaseName(...)
  // protected BaseName(...)
  // internal BaseName(...)
  // BaseName(...)
  const ctorRegex = new RegExp(
    `\\b(public|protected|internal|private)?\\s*(?:unsafe\\s+)?${baseName}\\s*\\(([^)]*)\\)`,
    "g"
  );

  let match: RegExpExecArray | null;
  while ((match = ctorRegex.exec(text)) !== null) {
    const accessibility = match[1] ? match[1].trim() : undefined;
    const parameters = match[2] ? match[2].trim() : "";

    // берём только конструкторы "с аргументами"
    if (!parameters) {
      continue;
    }

    const argumentList = buildArgumentList(parameters);

    ctors.push({
      accessibility,
      parameters,
      argumentList,
    });
  }

  return ctors;
}

function findAllIdentifierPositions(
  doc: vscode.TextDocument,
  identifier: string
): vscode.Position[] {
  const text = doc.getText();
  const regex = new RegExp(`\\b${identifier}\\b`, "g");
  const positions: vscode.Position[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const index = match.index;
    const startPos = doc.positionAt(index);
    // ставим курсор в конец идентификатора
    const pos = startPos.translate(0, identifier.length);
    positions.push(pos);
  }
  return positions;
}

function extractClassBody(
  doc: vscode.TextDocument,
  baseName: string
): string | undefined {
  const text = doc.getText();
  const classRegex = new RegExp(`\\bclass\\s+${baseName}[^\\{]*\\{`, "m");
  const match = classRegex.exec(text);
  if (!match) {
    return undefined;
  }

  const startIndex = match.index + match[0].length;
  let depth = 1;
  let i = startIndex;

  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }

  if (depth !== 0) {
    return undefined; // что-то пошло не так с фигурными скобками
  }

  // тело класса — между первой "{" и соответствующей "}"
  return text.slice(startIndex, i - 1);
}

function detectAbstractMethodsInClass(
  doc: vscode.TextDocument,
  baseName: string
): AbstractMethodInfo[] {
  const body = extractClassBody(doc, baseName);
  if (!body) {
    return [];
  }

  const methods: AbstractMethodInfo[] = [];

  // Примеры:
  // public abstract Task ProcessAsync(T arg);
  // protected abstract TResult Transform<TItem>(TItem item) where TItem : class;
  // public abstract Task<int> FooAsync<T>(T arg);

  const methodRegex =
    /\b(public|protected|internal|private)\s+abstract\s+([A-Za-z_][\w<>,\.\s]*)\s+([A-Za-z_]\w*)\s*(<([^>]*)>)?\s*\(([^)]*)\)\s*(where[^;]+)?;/g;

  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(body)) !== null) {
    const accessibility = m[1].trim();
    const returnType = m[2].trim(); // Task, Task<int>, TResult и т.п.
    const name = m[3].trim();
    const fullTypeParameterText = m[4] ? m[4].trim() : ""; // "<T>" или ""
    const typeParamsRaw = m[5] ? m[5].trim() : "";
    const parameters = m[6] ? m[6].trim() : "";
    const constraints = m[7] ? m[7].trim() : "";

    const typeParameters: string[] = [];
    if (typeParamsRaw) {
      for (const part of typeParamsRaw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const idMatch = /^([A-Za-z_]\w*)/.exec(trimmed);
        if (idMatch) {
          typeParameters.push(idMatch[1]);
        }
      }
    }

    methods.push({
      accessibility,
      returnType,
      name,
      fullTypeParameterText,
      typeParameters,
      parameters,
      constraints,
    });
  }

  return methods;
}

function detectAbstractPropertiesInClass(
  doc: vscode.TextDocument,
  baseName: string
): AbstractPropertyInfo[] {
  const body = extractClassBody(doc, baseName);
  if (!body) {
    return [];
  }

  const props: AbstractPropertyInfo[] = [];

  // Примеры:
  // public abstract T Data { get; set; }
  // protected abstract Task<T> Value { get; }
  // public abstract T Item { get; init; }

  const propRegex =
    /\b(public|protected|internal|private)\s+abstract\s+([A-Za-z_][\w<>,\.\s]*)\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g;

  let m: RegExpExecArray | null;
  while ((m = propRegex.exec(body)) !== null) {
    const accessibility = m[1].trim();
    const type = m[2].trim();
    const name = m[3].trim();
    const accessorsBlock = m[4];

    const hasGetter = /get\s*;/.test(accessorsBlock);
    const hasSetter = /set\s*;/.test(accessorsBlock);
    const hasInit = /init\s*;/.test(accessorsBlock);

    props.push({
      accessibility,
      type,
      name,
      hasGetter,
      hasSetter,
      hasInit,
    });
  }

  return props;
}

/**
 * Create the new .cs file in the same folder as the document.
 * Detects namespace if possible.
 */
async function createDerivedClassFile(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  baseName: string,
  newName: string,
  typeParameters: string[] = []
) {
  const srcUri = doc.uri;
  const folder = path.dirname(srcUri.fsPath);
  const newFilePath = path.join(folder, `${newName}.cs`);
  const newFileUri = vscode.Uri.file(newFilePath);

  // detect namespace in the current document
  const namespace = detectNamespace(doc);
  const nl = getEOL(doc);
  const indent = "    ";

  const baseGenericSuffix =
    typeParameters.length > 0 ? `<${typeParameters.join(", ")}>` : "";

  // ищем конструкторы базового класса
  const constructors = detectConstructors(doc, baseName);
  const abstractMethods = detectAbstractMethodsInClass(doc, baseName);
  const abstractProperties = detectAbstractPropertiesInClass(doc, baseName);

  let content = "";
  if (namespace) {
    content += `namespace ${namespace}${nl}{${nl}`;
    content += `${indent}public class ${newName} : ${baseName}${baseGenericSuffix}${nl}`;
    content += `${indent}{${nl}`;

    // тело класса
    content += generateClassBody(
      indent,
      newName,
      constructors,
      abstractMethods,
      abstractProperties,
      nl
    );

    content += `${indent}}${nl}`;
    content += `}${nl}`;
  } else {
    content += `public class ${newName} : ${baseName}${baseGenericSuffix}${nl}`;
    content += `{${nl}`;

    content += generateClassBody(
      indent,
      newName,
      constructors,
      abstractMethods,
      abstractProperties,
      nl
    );

    content += `}${nl}`;
  }

  // write the file if not exists; if exists, ask to overwrite
  try {
    // check if file exists
    await vscode.workspace.fs.stat(newFileUri);
    const overwrite = await vscode.window.showQuickPick(
      ["Overwrite", "Cancel"],
      { placeHolder: `${newName}.cs already exists — overwrite?` }
    );
    if (overwrite !== "Overwrite") {
      throw new Error("User cancelled overwrite");
    }
  } catch (err) {
    // stat throws if not exists — that's fine
  }

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(newFileUri, encoder.encode(content));

  // open the new file in editor
  const docNew = await vscode.workspace.openTextDocument(newFileUri);
  const editorNew = await vscode.window.showTextDocument(docNew, {
    preview: false,
  });

  const selections: vscode.Selection[] = [];

  // 1) если есть generic-параметры — создаём мультикурсор по всем их вхождениям
  if (typeParameters && typeParameters.length > 0) {
    for (const p of typeParameters) {
      const positions = findAllIdentifierPositions(docNew, p);
      for (const pos of positions) {
        selections.push(new vscode.Selection(pos, pos));
      }
    }
  }

  // 2) fallback — если generic нет или вдруг не нашли (на всякий случай) — ставим курсор на TODO
  if (selections.length === 0) {
    const lines = docNew.getText().split(/\r?\n/);
    const todoLineIndex = lines.findIndex((l) =>
      l.includes("// TODO: implement")
    );
    if (todoLineIndex >= 0) {
      const pos = new vscode.Position(
        todoLineIndex,
        docNew.lineAt(todoLineIndex).text.length
      );
      selections.push(new vscode.Selection(pos, pos));
    }
  }

  // применяем выборки
  if (selections.length > 0) {
    editorNew.selections = selections;
    const first = selections[0].start;
    editorNew.revealRange(
      new vscode.Range(first, first),
      vscode.TextEditorRevealType.InCenter
    );
  }
}

function detectNamespace(doc: vscode.TextDocument): string | undefined {
  const text = doc.getText();
  const nsRegex = /\bnamespace\s+([A-Za-z_][\w\.]*)\b/;
  const m = nsRegex.exec(text);
  if (m && m[1]) {
    return m[1];
  }
  return undefined;
}

function getEOL(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

function generateClassBody(
  indent: string,
  newName: string,
  constructors: ConstructorInfo[],
  abstractMethods: AbstractMethodInfo[],
  abstractProperties: AbstractPropertyInfo[],
  nl: string
): string {
  let body = "";

  // TODO
  body += `${indent}${indent}// TODO: implement${nl}`;

  // Конструкторы
  if (constructors.length > 0) {
    body += nl;

    for (const ctor of constructors) {
      const accessibility = ctor.accessibility || "public";
      const parameters = ctor.parameters;
      const args = ctor.argumentList;

      body += `${indent}${indent}${accessibility} ${newName}(${parameters}) : base(${args})${nl}`;
      body += `${indent}${indent}{${nl}`;
      body += `${indent}${indent}}${nl}${nl}`;
    }
  }

  // Абстрактные методы
  if (abstractMethods.length > 0) {
    if (constructors.length === 0) {
      body += nl;
    }

    for (const method of abstractMethods) {
      body += `${indent}${indent}${method.accessibility} override ${method.returnType} ${method.name}${method.fullTypeParameterText}(${method.parameters})`;
      if (method.constraints) {
        body += ` ${method.constraints}`;
      }
      body += nl;
      body += `${indent}${indent}{${nl}`;
      body += `${indent}${indent}${indent}throw new System.NotImplementedException();${nl}`;
      body += `${indent}${indent}}${nl}${nl}`;
    }
  }

  // Абстрактные свойства
  if (abstractProperties.length > 0) {
    if (constructors.length === 0 && abstractMethods.length === 0) {
      body += nl;
    }

    for (const prop of abstractProperties) {
      body += `${indent}${indent}${prop.accessibility} override ${prop.type} ${prop.name} {`;

      if (prop.hasGetter) {
        body += ` get;`;
      }
      if (prop.hasSetter) {
        body += ` set;`;
      }
      if (prop.hasInit) {
        body += ` init;`;
      }

      body += ` }${nl}`;
    }
  }

  return body;
}

async function detectPropertyAtPosition(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  symbols?: vscode.DocumentSymbol[]
): Promise<PropertyExtractionInfo | undefined> {
  const tree = symbols ?? (await getDocumentSymbols(doc));
  const propertySymbol = findEnclosingSymbolByKind(tree, pos, [
    vscode.SymbolKind.Property,
  ]);

  if (propertySymbol) {
    const propertyInfo = extractPropertyFromSymbol(doc, propertySymbol, tree);
    if (propertyInfo) {
      return propertyInfo;
    }
  }

  return detectPropertyAtPositionLegacy(doc, pos);
}

function extractPropertyFromSymbol(
  doc: vscode.TextDocument,
  propertySymbol: vscode.DocumentSymbol,
  symbols: readonly vscode.DocumentSymbol[] | undefined
): PropertyExtractionInfo | undefined {
  const interfaceAncestor = findEnclosingSymbolByKind(symbols, propertySymbol.range.start, [
    vscode.SymbolKind.Interface,
  ]);
  if (interfaceAncestor) {
    return undefined;
  }

  const range = new vscode.Range(
    new vscode.Position(propertySymbol.range.start.line, 0),
    propertySymbol.range.end
  );
  const text = doc.getText(range);

  const propertyRegex =
    /(?:\[[^\]]*\]\s*)*\b(public|protected|internal|private)\s+(?:static\s+)?(?:virtual\s+|override\s+|abstract\s+|new\s+|sealed\s+|unsafe\s+)?([A-Za-z_][\w<>,\.\[\]\s]*)\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/;

  const match = propertyRegex.exec(text);
  if (!match) {
    return undefined;
  }

  const accessibility = match[1];
  if (accessibility !== "public") {
    return undefined;
  }

  const type = normalizeTypeText(match[2]);
  const name = match[3];
  const accessorBlock = match[4] ?? "";

  const hasGetter = /\bget\b/.test(accessorBlock) || /=>/.test(accessorBlock);
  const hasSetter = /\bset\b/.test(accessorBlock);
  const hasInit = /\binit\b/.test(accessorBlock);

  if (!hasGetter && !hasSetter && !hasInit) {
    return undefined;
  }

  const startOffset = doc.offsetAt(range.start) + match.index;

  let enclosingClassName: string | undefined;
  let enclosingClassTypeParameters: string[] | undefined;
  const classSymbol = findEnclosingSymbolByKind(symbols, range.start, [
    vscode.SymbolKind.Class,
  ]);
  if (classSymbol) {
    const classInfo = extractClassInfoFromSymbol(classSymbol);
    enclosingClassName = classInfo?.name;
    enclosingClassTypeParameters = classInfo?.typeParameters;
  } else {
    const classInfo = detectEnclosingClassInfo(doc, range.start);
    enclosingClassName = classInfo?.name ?? enclosingClassName;
    enclosingClassTypeParameters = classInfo?.typeParameters;
  }

  const requiredTypeParameters = findUsedTypeParameters(
    type,
    enclosingClassTypeParameters
  );

  return {
    kind: "property",
    name,
    type,
    hasGetter,
    hasSetter,
    hasInit,
    enclosingClassName,
    startOffset,
    requiredTypeParameters,
  };
}

function detectPropertyAtPositionLegacy(
  doc: vscode.TextDocument,
  pos: vscode.Position
): PropertyExtractionInfo | undefined {
  const text = doc.getText();
  const propertyRegex =
    /\b(public|protected|internal|private)\s+(?:static\s+)?(?:virtual\s+|override\s+|abstract\s+|new\s+|sealed\s+|unsafe\s+)?([A-Za-z_][\w<>,\.\[\]\s]*)\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g;

  let match: RegExpExecArray | null;
  while ((match = propertyRegex.exec(text)) !== null) {
    const startOffset = match.index;
    const start = doc.positionAt(startOffset);
    const end = doc.positionAt(match.index + match[0].length);
    if (pos.isBefore(start) || pos.isAfter(end)) {
      continue;
    }

    const accessibility = match[1];
    if (accessibility !== "public") {
      return undefined;
    }

    const interfaceName = detectEnclosingInterfaceName(doc, start);
    if (interfaceName) {
      return undefined;
    }

    const type = normalizeTypeText(match[2]);
    const name = match[3];
    const accessorBlock = match[4] ?? "";

    const hasGetter = /\bget\b/.test(accessorBlock);
    const hasSetter = /\bset\b/.test(accessorBlock);
    const hasInit = /\binit\b/.test(accessorBlock);

    if (!hasGetter && !hasSetter && !hasInit) {
      return undefined;
    }

    const enclosingClassInfo = detectEnclosingClassInfo(doc, start);
    const enclosingClassName = enclosingClassInfo?.name;
    const requiredTypeParameters = findUsedTypeParameters(
      type,
      enclosingClassInfo?.typeParameters
    );

    return {
      kind: "property",
      name,
      type,
      hasGetter,
      hasSetter,
      hasInit,
      enclosingClassName,
      startOffset,
      requiredTypeParameters,
    };
  }

  return undefined;
}

async function detectMethodAtPosition(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  symbols?: vscode.DocumentSymbol[]
): Promise<MethodExtractionInfo | undefined> {
  const tree = symbols ?? (await getDocumentSymbols(doc));
  const methodSymbol = findEnclosingSymbolByKind(tree, pos, [
    vscode.SymbolKind.Method,
  ]);

  if (methodSymbol) {
    const info = extractMethodFromSymbol(doc, methodSymbol, tree);
    if (info) {
      return info;
    }
  }

  return detectMethodAtPositionLegacy(doc, pos);
}

function extractMethodFromSymbol(
  doc: vscode.TextDocument,
  methodSymbol: vscode.DocumentSymbol,
  symbols: readonly vscode.DocumentSymbol[] | undefined
): MethodExtractionInfo | undefined {
  const interfaceAncestor = findEnclosingSymbolByKind(
    symbols,
    methodSymbol.range.start,
    [vscode.SymbolKind.Interface]
  );
  if (interfaceAncestor) {
    return undefined;
  }

  const range = new vscode.Range(
    new vscode.Position(methodSymbol.range.start.line, 0),
    methodSymbol.range.end
  );
  const text = doc.getText(range);

  const methodRegex =
    /(?:\[[^\]]*\]\s*)*\b(public|protected|internal|private)?\s*((?:(?:static|virtual|override|abstract|new|sealed|async|unsafe|partial|extern)\s+)*)?([A-Za-z_][\w<>,\.\[\]\s]*\??)\s+([A-Za-z_]\w*)\s*(<([^>]*)>)?\s*\(([^)]*)\)\s*((?:where\s+[^{;]+)?)?/;

  const match = methodRegex.exec(text);
  if (!match) {
    return undefined;
  }

  const accessibility = match[1]?.trim();
  if (accessibility && !["public", "private"].includes(accessibility)) {
    return undefined;
  }

  const returnType = normalizeTypeText(match[3]);
  const name = match[4];
  const fullTypeParameterText = match[5] ? match[5].trim() : "";
  const typeParameters = match[6]
    ? match[6]
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [];
  const parameters = match[7] ? match[7].trim() : "";
  const constraints = match[8]?.trim();

  if (!returnType || !name) {
    return undefined;
  }

  const startOffset = doc.offsetAt(range.start) + match.index;
  let accessibilityRange: vscode.Range | undefined;
  if (accessibility) {
    const relIndex = match[0].indexOf(accessibility);
    if (relIndex >= 0) {
      const start = doc.positionAt(startOffset + relIndex);
      const end = doc.positionAt(startOffset + relIndex + accessibility.length);
      accessibilityRange = new vscode.Range(start, end);
    }
  }

  let enclosingClassName: string | undefined;
  let enclosingClassTypeParameters: string[] | undefined;
  const classSymbol = findEnclosingSymbolByKind(symbols, range.start, [
    vscode.SymbolKind.Class,
  ]);
  if (classSymbol) {
    const classInfo = extractClassInfoFromSymbol(classSymbol);
    enclosingClassName = classInfo?.name;
    enclosingClassTypeParameters = classInfo?.typeParameters;
  } else {
    const classInfo = detectEnclosingClassInfo(doc, range.start);
    enclosingClassName = classInfo?.name ?? enclosingClassName;
    enclosingClassTypeParameters = classInfo?.typeParameters;
  }

  const requiredTypeParameters = findUsedTypeParameters(
    `${returnType} ${parameters}`,
    enclosingClassTypeParameters
  );

  return {
    kind: "method",
    name,
    returnType,
    parameters,
    fullTypeParameterText,
    typeParameters,
    constraints,
    accessibility,
    accessibilityRange,
    enclosingClassName,
    startOffset,
    requiredTypeParameters,
  };
}

function detectMethodAtPositionLegacy(
  doc: vscode.TextDocument,
  pos: vscode.Position
): MethodExtractionInfo | undefined {
  const text = doc.getText();
  const methodRegex =
    /\b(public|protected|internal|private)?\s*((?:(?:static|virtual|override|abstract|new|sealed|async|unsafe|partial|extern)\s+)*)?([A-Za-z_][\w<>,\.\[\]\s]*\??)\s+([A-Za-z_]\w*)\s*(<([^>]*)>)?\s*\(([^)]*)\)\s*((?:where\s+[^{;]+)?)?/g;

  let match: RegExpExecArray | null;
  while ((match = methodRegex.exec(text)) !== null) {
    const startOffset = match.index;
    const start = doc.positionAt(startOffset);
    const end = doc.positionAt(match.index + match[0].length);
    if (pos.isBefore(start) || pos.isAfter(end)) {
      continue;
    }

    const accessibility = match[1]?.trim();
    if (accessibility && !["public", "private"].includes(accessibility)) {
      return undefined;
    }

    const returnType = normalizeTypeText(match[3]);
    const name = match[4];
    const fullTypeParameterText = match[5] ? match[5].trim() : "";
    const typeParameters = match[6]
      ? match[6]
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [];
    const parameters = match[7] ? match[7].trim() : "";
    const constraints = match[8]?.trim();

    const interfaceName = detectEnclosingInterfaceName(doc, start);
    if (interfaceName) {
      return undefined;
    }

    const classInfo = detectEnclosingClassInfo(doc, start);
    const requiredTypeParameters = findUsedTypeParameters(
      `${returnType} ${parameters}`,
      classInfo?.typeParameters
    );

    let accessibilityRange: vscode.Range | undefined;
    if (accessibility) {
      const relIndex = match[0].indexOf(accessibility);
      if (relIndex >= 0) {
        const rangeStart = doc.positionAt(startOffset + relIndex);
        const rangeEnd = doc.positionAt(
          startOffset + relIndex + accessibility.length
        );
        accessibilityRange = new vscode.Range(rangeStart, rangeEnd);
      }
    }

    return {
      kind: "method",
      name,
      returnType,
      parameters,
      fullTypeParameterText,
      typeParameters,
      constraints,
      accessibility,
      accessibilityRange,
      enclosingClassName: classInfo?.name,
      startOffset,
      requiredTypeParameters,
    };
  }

  return undefined;
}

function detectEnclosingClassName(
  doc: vscode.TextDocument,
  pos: vscode.Position
): string | undefined {
  return detectEnclosingClassInfo(doc, pos)?.name;
}

function detectEnclosingInterfaceName(
  doc: vscode.TextDocument,
  pos: vscode.Position
): string | undefined {
  for (let line = pos.line; line >= 0; line--) {
    const lineText = doc.lineAt(line).text;
    const match = /\binterface\s+([A-Za-z_]\w*)/.exec(lineText);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function detectEnclosingClassInfo(
  doc: vscode.TextDocument,
  pos: vscode.Position
): ClassInfo | undefined {
  for (let line = pos.line; line >= 0; line--) {
    const lineText = doc.lineAt(line).text;
    const match = /\bclass\s+([A-Za-z_]\w*)\s*(<([^>]+)>)?/.exec(lineText);
    if (match && match[1]) {
      const typeParameters: string[] = [];
      if (match[3]) {
        match[3].split(",").forEach((raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            return;
          }
          const idMatch = /^([A-Za-z_]\w*)/.exec(trimmed);
          if (idMatch) {
            typeParameters.push(idMatch[1]);
          }
        });
      }
      return { name: match[1], typeParameters };
    }
  }

  return undefined;
}

function findUsedTypeParameters(
  typeText: string,
  candidates: string[] | undefined
): string[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }

  const used: string[] = [];
  for (const candidate of candidates) {
    const regex = new RegExp(`\\b${candidate}\\b`);
    if (regex.test(typeText)) {
      used.push(candidate);
    }
  }
  return used;
}

function normalizeTypeText(type: string): string {
  return type.replace(/\s+/g, " ").trim();
}

async function detectInterfacesInDocument(
  doc: vscode.TextDocument,
  symbols?: vscode.DocumentSymbol[]
): Promise<InterfaceDeclarationInfo[]> {
  const tree = symbols ?? (await getDocumentSymbols(doc));
  const interfaceSymbols = collectSymbolsByKind(tree, vscode.SymbolKind.Interface);
  const interfaces: InterfaceDeclarationInfo[] = [];

  for (const ifaceSymbol of interfaceSymbols) {
    const info = createInterfaceInfoFromSymbol(doc, ifaceSymbol);
    if (info) {
      interfaces.push(info);
    }
  }

  if (interfaces.length > 0) {
    return interfaces;
  }

  return detectInterfacesInDocumentLegacy(doc);
}

function createInterfaceInfoFromSymbol(
  doc: vscode.TextDocument,
  ifaceSymbol: vscode.DocumentSymbol
): InterfaceDeclarationInfo | undefined {
  const range = new vscode.Range(
    new vscode.Position(ifaceSymbol.range.start.line, 0),
    ifaceSymbol.range.end
  );
  const text = doc.getText(range);
  const openIndex = text.indexOf("{");
  const closeIndex = text.lastIndexOf("}");
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
    return undefined;
  }

  const absoluteOpen = doc.offsetAt(range.start) + openIndex;
  const absoluteClose = doc.offsetAt(range.start) + closeIndex;
  const bodyText = text.slice(openIndex + 1, closeIndex);
  const memberIndent =
    detectMemberIndentation(doc, absoluteOpen + 1, absoluteClose) || "    ";

  return {
    name: ifaceSymbol.name,
    bodyText,
    insertPosition: doc.positionAt(absoluteClose),
    memberIndent,
  };
}

function detectInterfacesInDocumentLegacy(
  doc: vscode.TextDocument
): InterfaceDeclarationInfo[] {
  const interfaces: InterfaceDeclarationInfo[] = [];
  const text = doc.getText();
  const regex = /\binterface\s+([A-Za-z_]\w*)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const braceIndex = text.indexOf("{", regex.lastIndex);
    if (braceIndex === -1) {
      continue;
    }

    const closingIndex = findMatchingBrace(text, braceIndex);
    if (closingIndex === undefined) {
      continue;
    }

    const bodyText = text.slice(braceIndex + 1, closingIndex);
    const insertPosition = doc.positionAt(closingIndex);
    const memberIndent =
      detectMemberIndentation(doc, braceIndex + 1, closingIndex) || "    ";

    interfaces.push({
      name,
      bodyText,
      insertPosition,
      memberIndent,
    });
  }

  return interfaces;
}

function detectMemberIndentation(
  doc: vscode.TextDocument,
  bodyStart: number,
  bodyEnd: number
): string | undefined {
  const startPos = doc.positionAt(bodyStart);
  const endPos = doc.positionAt(bodyEnd);

  for (let line = startPos.line; line < endPos.line; line++) {
    const text = doc.lineAt(line).text;
    if (text.trim().length === 0) {
      continue;
    }
    const indentMatch = /^(\s+)/.exec(text);
    if (indentMatch) {
      return indentMatch[1];
    }
  }

  return undefined;
}

function isMemberDeclaredInInterfaces(
  member: ExtractedMember,
  interfaces: InterfaceDeclarationInfo[]
): boolean {
  if (interfaces.length === 0) {
    return false;
  }

  if (member.kind === "property") {
    const pattern = new RegExp(`\\b${member.name}\\b\\s*\\{`);
    return interfaces.some((i) => pattern.test(i.bodyText));
  }

  const methodPattern = new RegExp(`\\b${member.name}\\b\\s*(<[^>]+>)?\\s*\\(`);
  return interfaces.some((i) => methodPattern.test(i.bodyText));
}

async function addMemberToExistingInterface(
  doc: vscode.TextDocument,
  interfaceName: string,
  member: ExtractedMember
) {
  const interfaces = await detectInterfacesInDocument(doc);
  const target = interfaces.find((i) => i.name === interfaceName);
  if (!target) {
    vscode.window.showErrorMessage(
      `Интерфейс ${interfaceName} не найден в документе.`
    );
    return;
  }

  if (isMemberDeclaredInInterfaces(member, [target])) {
    vscode.window.showInformationMessage(
      `Элемент ${member.name} уже существует в интерфейсе ${interfaceName}.`
    );
    return;
  }

  const eol = getEOL(doc);
  const documentText = doc.getText();
  const insertOffset = doc.offsetAt(target.insertPosition);
  const beforeSlice = documentText.slice(
    Math.max(0, insertOffset - eol.length),
    insertOffset
  );
  const needsLeadingEol = beforeSlice !== eol;

  const insertText =
    (needsLeadingEol ? eol : "") +
    buildInterfaceMemberLine(member, target.memberIndent, eol);

  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, target.insertPosition, insertText);
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) {
    await ensureMethodAccessibility(doc, member);
    vscode.window.showInformationMessage(
      `Элемент ${member.name} добавлен в интерфейс ${interfaceName}.`
    );
  } else {
    vscode.window.showErrorMessage(
      `Не удалось обновить интерфейс ${interfaceName}.`
    );
  }
}

async function createInterfaceWithMember(
  doc: vscode.TextDocument,
  interfaceName: string,
  member: ExtractedMember
) {
  const eol = getEOL(doc);
  const memberPosition =
    typeof member.startOffset === "number"
      ? doc.positionAt(member.startOffset)
      : undefined;
  const namespaceInfo = detectNamespaceBlock(doc, memberPosition);
  const documentText = doc.getText();
  const edit = new vscode.WorkspaceEdit();

  if (namespaceInfo && namespaceInfo.type === "block") {
    const insertOffset = doc.offsetAt(namespaceInfo.insertPosition);
    const beforeSlice = documentText.slice(
      Math.max(0, insertOffset - eol.length),
      insertOffset
    );
    const needsLeadingEol = beforeSlice !== eol;

    const interfaceText =
      (needsLeadingEol ? eol : "") +
      buildInterfaceDeclaration(interfaceName, member, 1, eol);

    edit.insert(doc.uri, namespaceInfo.insertPosition, interfaceText);
  } else {
    const insertPosition =
      doc.lineCount === 0
        ? new vscode.Position(0, 0)
        : doc.lineAt(doc.lineCount - 1).range.end;

    const prefix = documentText.length > 0 ? eol : "";
    const interfaceText =
      prefix + buildInterfaceDeclaration(interfaceName, member, 0, eol);

    edit.insert(doc.uri, insertPosition, interfaceText);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) {
    await ensureMethodAccessibility(doc, member);
    vscode.window.showInformationMessage(
      `Интерфейс ${interfaceName} создан и содержит элемент ${member.name}.`
    );
  } else {
    vscode.window.showErrorMessage("Не удалось создать интерфейс.");
  }
}

function buildInterfaceMemberLine(
  member: ExtractedMember,
  indent: string,
  eol: string
): string {
  if (member.kind === "property") {
    let line = `${indent}${member.type} ${member.name} {`;
    if (member.hasGetter) {
      line += " get;";
    }
    if (member.hasSetter) {
      line += " set;";
    }
    if (member.hasInit) {
      line += " init;";
    }
    line += ` }${eol}`;
    return line;
  }

  let line = `${indent}${member.returnType} ${member.name}${member.fullTypeParameterText}(${member.parameters})`;
  if (member.constraints && member.constraints.length > 0) {
    line += ` ${member.constraints}`;
  }
  line += `;${eol}`;
  return line;
}

function buildInterfaceDeclaration(
  interfaceName: string,
  member: ExtractedMember,
  indentLevel: number,
  eol: string
): string {
  const indentUnit = "    ";
  const indent = indentUnit.repeat(indentLevel);
  const memberIndent = indent + indentUnit;
  const genericSuffix =
    member.requiredTypeParameters && member.requiredTypeParameters.length > 0
      ? `<${member.requiredTypeParameters.join(", ")}>`
      : "";

  let text = `${indent}public interface ${interfaceName}${genericSuffix}${eol}`;
  text += `${indent}{${eol}`;
  text += buildInterfaceMemberLine(member, memberIndent, eol);
  text += `${indent}}${eol}`;
  return text;
}

async function ensureMethodAccessibility(
  doc: vscode.TextDocument,
  member: ExtractedMember
) {
  if (
    member.kind !== "method" ||
    member.accessibility !== "private" ||
    !member.accessibilityRange
  ) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, member.accessibilityRange, "public");
  await vscode.workspace.applyEdit(edit);
}

function detectNamespaceBlock(
  doc: vscode.TextDocument,
  contextPosition?: vscode.Position
): NamespaceBlockInfo | undefined {
  const text = doc.getText();
  const nsRegex = /\bnamespace\s+([A-Za-z_][\w\.]*)\s*(\{|\;)/g;
  const targetOffset =
    contextPosition !== undefined ? doc.offsetAt(contextPosition) : undefined;
  let fallbackBlock: NamespaceBlockInfo | undefined;

  let match: RegExpExecArray | null;
  while ((match = nsRegex.exec(text)) !== null) {
    const name = match[1];
    const delimiter = match[2];

    if (delimiter === ";") {
      const lastLine =
        doc.lineCount === 0
          ? new vscode.Position(0, 0)
          : doc.lineAt(doc.lineCount - 1).range.end;
      return {
        name,
        type: "fileScoped",
        insertPosition: lastLine,
      };
    }

    const braceIndex = text.indexOf("{", match.index);
    if (braceIndex === -1) {
      continue;
    }

    const closingIndex = findMatchingBrace(text, braceIndex);
    if (closingIndex === undefined) {
      continue;
    }

    const info: NamespaceBlockInfo = {
      name,
      type: "block",
      insertPosition: doc.positionAt(closingIndex),
    };

    if (
      targetOffset === undefined ||
      (targetOffset > braceIndex && targetOffset < closingIndex)
    ) {
      return info;
    }

    if (!fallbackBlock) {
      fallbackBlock = info;
    }
  }

  return fallbackBlock;
}

function findMatchingBrace(
  text: string,
  openIndex: number
): number | undefined {
  let depth = 1;
  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}
