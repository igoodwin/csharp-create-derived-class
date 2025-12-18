import * as vscode from "vscode";
import * as path from "path";
import { ClassInfo } from "../types";
import {
  findEnclosingSymbolByKind,
  getDocumentSymbols,
} from "../utils/symbols";
import { detectNamespace, getEOL } from "../utils/document";

interface ConstructorInfo {
  accessibility?: string;
  parameters: string;
  argumentList: string;
}

interface AbstractMethodInfo {
  accessibility: string;
  returnType: string;
  name: string;
  fullTypeParameterText: string;
  typeParameters: string[];
  parameters: string;
  constraints: string;
}

interface AbstractPropertyInfo {
  accessibility: string;
  type: string;
  name: string;
  hasGetter: boolean;
  hasSetter: boolean;
  hasInit: boolean;
}

export async function detectClassInfoAtPosition(
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

export async function createDerivedClassFile(
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

  const namespace = detectNamespace(doc);
  const nl = getEOL(doc);
  const indent = "    ";

  const baseGenericSuffix =
    typeParameters.length > 0 ? `<${typeParameters.join(", ")}>` : "";

  const constructors = detectConstructors(doc, baseName);
  const abstractMethods = detectAbstractMethodsInClass(doc, baseName);
  const abstractProperties = detectAbstractPropertiesInClass(doc, baseName);

  let content = "";
  if (namespace) {
    content += `namespace ${namespace}${nl}{${nl}`;
    content += `${indent}public class ${newName} : ${baseName}${baseGenericSuffix}${nl}`;
    content += `${indent}{${nl}`;
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

  try {
    await vscode.workspace.fs.stat(newFileUri);
    const overwrite = await vscode.window.showQuickPick(
      ["Overwrite", "Cancel"],
      { placeHolder: `${newName}.cs already exists — overwrite?` }
    );
    if (overwrite !== "Overwrite") {
      throw new Error("User cancelled overwrite");
    }
  } catch (err) {
    // file does not exist
  }

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(newFileUri, encoder.encode(content));

  const docNew = await vscode.workspace.openTextDocument(newFileUri);
  const editorNew = await vscode.window.showTextDocument(docNew, {
    preview: false,
  });

  const selections: vscode.Selection[] = [];

  if (typeParameters && typeParameters.length > 0) {
    for (const p of typeParameters) {
      const positions = findAllIdentifierPositions(docNew, p);
      for (const pPos of positions) {
        selections.push(new vscode.Selection(pPos, pPos));
      }
    }
  }

  if (selections.length === 0) {
    const lines = docNew.getText().split(/\r?\n/);
    const todoLineIndex = lines.findIndex((l) =>
      l.includes("// TODO: implement")
    );
    if (todoLineIndex >= 0) {
      const posTodo = new vscode.Position(
        todoLineIndex,
        docNew.lineAt(todoLineIndex).text.length
      );
      selections.push(new vscode.Selection(posTodo, posTodo));
    }
  }

  if (selections.length > 0) {
    editorNew.selections = selections;
    const first = selections[0].start;
    editorNew.revealRange(
      new vscode.Range(first, first),
      vscode.TextEditorRevealType.InCenter
    );
  }
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
  const classRegex = /\bclass\s+([A-Za-z_]\w*)\s*(<([^>]+)>)?/;
  const match = classRegex.exec(line);
  if (match && match[1]) {
    const name = match[1];
    const typeParameters: string[] = [];

    if (match[3]) {
      match[3].split(",").forEach((p) => {
        const trimmed = p.trim();
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
  const ctorRegex = new RegExp(
    `\\b(public|protected|internal|private)?\\s*(?:unsafe\\s+)?${baseName}\\s*\\(([^)]*)\\)`,
    "g"
  );

  let match: RegExpExecArray | null;
  while ((match = ctorRegex.exec(text)) !== null) {
    const accessibility = match[1] ? match[1].trim() : undefined;
    const parameters = match[2] ? match[2].trim() : "";
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

function buildArgumentList(parameterList: string): string {
  if (!parameterList || !parameterList.trim()) {
    return "";
  }

  const parts = parameterList.split(",");
  const args: string[] = [];

  for (const part of parts) {
    const beforeEquals = part.split("=")[0].trim();
    if (!beforeEquals) {
      continue;
    }

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
    return undefined;
  }

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
  const methodRegex =
    /\b(public|protected|internal|private)\s+abstract\s+([A-Za-z_][\w<>,\.\s]*)\s+([A-Za-z_]\w*)\s*(<([^>]*)>)?\s*\(([^)]*)\)\s*(where[^;]+)?;/g;

  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(body)) !== null) {
    const accessibility = m[1].trim();
    const returnType = m[2].trim();
    const name = m[3].trim();
    const fullTypeParameterText = m[4] ? m[4].trim() : "";
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

function generateClassBody(
  indent: string,
  newName: string,
  constructors: ConstructorInfo[],
  abstractMethods: AbstractMethodInfo[],
  abstractProperties: AbstractPropertyInfo[],
  nl: string
): string {
  let body = "";
  body += `${indent}${indent}// TODO: implement${nl}`;

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
