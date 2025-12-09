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
          const info = detectClassInfoAtPosition(doc, position);
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

class CreateDerivedClassProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    // detect if cursor is on a class declaration
    const pos = range instanceof vscode.Selection ? range.start : range.start;
    const info = detectClassInfoAtPosition(document, pos);
    if (!info) {
      return [];
    }

    const title = `Create derived class '${info.name}Derived'`;
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.command = {
      command: "extension.createDerivedClass",
      title,
      arguments: [{ baseName: info.name, typeParameters: info.typeParameters }],
    };
    action.isPreferred = true;
    return [action];
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
function detectClassInfoAtPosition(
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
