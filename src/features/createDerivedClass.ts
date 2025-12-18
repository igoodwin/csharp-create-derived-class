import * as vscode from "vscode";
import { ClassInfo } from "../types";
import {
  findEnclosingSymbolByKind,
  getDocumentSymbols,
} from "../utils/symbols";
import { getEOL } from "../utils/document";

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

export async function createDerivedClass(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  baseName: string,
  newName: string,
  typeParameters: string[] = []
) {
  const nl = getEOL(doc);
  const indentUnit = "    ";

  const baseGenericSuffix =
    typeParameters.length > 0 ? `<${typeParameters.join(", ")}>` : "";

  const constructors = detectConstructors(doc, baseName);
  const abstractMethods = detectAbstractMethodsInClass(doc, baseName);
  const abstractProperties = detectAbstractPropertiesInClass(doc, baseName);

  const symbols = await getDocumentSymbols(doc);
  const baseSymbol =
    findEnclosingSymbolByKind(symbols, pos, [vscode.SymbolKind.Class]) ??
    findClassSymbolByName(symbols, baseName);

  if (!baseSymbol) {
    throw new Error("Could not locate the base class in the current document.");
  }

  const baseLine = doc.lineAt(baseSymbol.selectionRange.start.line);
  const baseIndent = baseLine.text.slice(
    0,
    baseLine.firstNonWhitespaceCharacterIndex
  );

  const classText = buildDerivedClassText(
    baseIndent,
    indentUnit,
    baseName,
    newName,
    baseGenericSuffix,
    constructors,
    abstractMethods,
    abstractProperties,
    nl
  );

  const insertPosition = baseSymbol.range.end;
  const insertText = `${nl}${nl}${classText}`;
  const insertStartOffset = doc.offsetAt(insertPosition);
  const insertEndOffset = insertStartOffset + insertText.length;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, insertPosition, insertText);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("Failed to insert derived class into document.");
  }

  const editor = await vscode.window.showTextDocument(doc);
  const updatedDoc = editor.document;

  const selections: vscode.Selection[] = [];
  const todoSelection = findTodoSelection(
    updatedDoc,
    insertStartOffset,
    insertEndOffset
  );

  if (typeParameters && typeParameters.length > 0) {
    for (const p of typeParameters) {
      const positions = findAllIdentifierPositions(updatedDoc, p);
      for (const pPos of positions) {
        const endOffset = updatedDoc.offsetAt(pPos);
        const startOffset = endOffset - p.length;
        if (
          startOffset >= insertStartOffset &&
          endOffset <= insertEndOffset
        ) {
          selections.push(new vscode.Selection(pPos, pPos));
        }
      }
    }
  }

  if (selections.length === 0 && todoSelection) {
    selections.push(new vscode.Selection(todoSelection, todoSelection));
  }

  if (selections.length > 0) {
    editor.selections = selections;
    const first = selections[0].start;
    editor.revealRange(
      new vscode.Range(first, first),
      vscode.TextEditorRevealType.InCenter
    );
  }
}

function extractClassInfoFromSymbol(
  symbol: vscode.DocumentSymbol
): ClassInfo | undefined {
  const rawName = symbol.detail.split(".").reverse()[0];
  const match = /^([A-Za-z_]\w*)(?:<([^>]+)>)?/.exec(rawName);
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

function buildDerivedClassText(
  baseIndent: string,
  indentUnit: string,
  baseName: string,
  newName: string,
  baseGenericSuffix: string,
  constructors: ConstructorInfo[],
  abstractMethods: AbstractMethodInfo[],
  abstractProperties: AbstractPropertyInfo[],
  nl: string
): string {
  let content = "";
  content += `${baseIndent}public class ${newName} : ${baseName}${baseGenericSuffix}${nl}`;
  content += `${baseIndent}{${nl}`;
  content += generateClassBody(
    indentUnit,
    baseIndent,
    newName,
    constructors,
    abstractMethods,
    abstractProperties,
    nl
  );
  content += `${baseIndent}}${nl}`;
  return content;
}

function generateClassBody(
  indentUnit: string,
  baseIndent: string,
  newName: string,
  constructors: ConstructorInfo[],
  abstractMethods: AbstractMethodInfo[],
  abstractProperties: AbstractPropertyInfo[],
  nl: string
): string {
  const classIndent = baseIndent + indentUnit;
  const innerIndent = classIndent + indentUnit;

  let body = "";
  body += `${classIndent}// TODO: implement${nl}`;

  if (constructors.length > 0) {
    body += nl;

    for (const ctor of constructors) {
      const accessibility = ctor.accessibility || "public";
      const parameters = ctor.parameters;
      const args = ctor.argumentList;

      body += `${classIndent}${accessibility} ${newName}(${parameters}) : base(${args})${nl}`;
      body += `${classIndent}{${nl}`;
      body += `${classIndent}}${nl}${nl}`;
    }
  }

  if (abstractMethods.length > 0) {
    if (constructors.length === 0) {
      body += nl;
    }

    for (const method of abstractMethods) {
      body += `${classIndent}${method.accessibility} override ${method.returnType} ${method.name}${method.fullTypeParameterText}(${method.parameters})`;
      if (method.constraints) {
        body += ` ${method.constraints}`;
      }
      body += nl;
      body += `${classIndent}{${nl}`;
      body += `${innerIndent}throw new System.NotImplementedException();${nl}`;
      body += `${classIndent}}${nl}${nl}`;
    }
  }

  if (abstractProperties.length > 0) {
    if (constructors.length === 0 && abstractMethods.length === 0) {
      body += nl;
    }

    for (const prop of abstractProperties) {
      body += `${classIndent}${prop.accessibility} override ${prop.type} ${prop.name} {`;

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

function findTodoSelection(
  doc: vscode.TextDocument,
  insertStartOffset: number,
  insertEndOffset: number
): vscode.Position | undefined {
  const range = new vscode.Range(
    doc.positionAt(insertStartOffset),
    doc.positionAt(insertEndOffset)
  );
  const text = doc.getText(range);
  const marker = "// TODO: implement";
  const relativeIndex = text.indexOf(marker);
  if (relativeIndex < 0) {
    return undefined;
  }

  const absoluteOffset = insertStartOffset + relativeIndex;
  const lineIndex = doc.positionAt(absoluteOffset).line;
  const line = doc.lineAt(lineIndex);
  return line.range.end;
}

function findClassSymbolByName(
  symbols: readonly vscode.DocumentSymbol[] | undefined,
  name: string
): vscode.DocumentSymbol | undefined {
  if (!symbols) {
    return undefined;
  }

  for (const symbol of symbols) {
    if (symbol.kind === vscode.SymbolKind.Class && symbol.name === name) {
      return symbol;
    }

    const child = findClassSymbolByName(symbol.children, name);
    if (child) {
      return child;
    }
  }

  return undefined;
}
