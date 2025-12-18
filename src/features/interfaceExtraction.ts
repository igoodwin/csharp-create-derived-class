import * as vscode from "vscode";
import { ClassInfo } from "../types";
import {
  collectSymbolsByKind,
  findEnclosingSymbolByKind,
  getDocumentSymbols,
} from "../utils/symbols";
import { findMatchingBrace, getEOL } from "../utils/document";

interface BaseExtractionInfo {
  kind: "property" | "method";
  name: string;
  enclosingClassName?: string;
  startOffset: number;
  requiredTypeParameters: string[];
}

export interface PropertyExtractionInfo extends BaseExtractionInfo {
  kind: "property";
  type: string;
  hasGetter: boolean;
  hasSetter: boolean;
  hasInit: boolean;
}

export interface MethodExtractionInfo extends BaseExtractionInfo {
  kind: "method";
  returnType: string;
  parameters: string;
  fullTypeParameterText: string;
  typeParameters: string[];
  constraints?: string;
  accessibility?: string;
  accessibilityRange?: vscode.Range;
}

export type ExtractedMember =
  | PropertyExtractionInfo
  | MethodExtractionInfo;

export interface AddMemberToInterfaceArgs {
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

export async function detectPropertyAtPosition(
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

export async function detectMethodAtPosition(
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

export async function detectInterfacesInDocument(
  doc: vscode.TextDocument,
  symbols?: vscode.DocumentSymbol[]
): Promise<InterfaceDeclarationInfo[]> {
  const tree = symbols ?? (await getDocumentSymbols(doc));
  const interfaceSymbols = collectSymbolsByKind(
    tree,
    vscode.SymbolKind.Interface
  );
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

export function isMemberDeclaredInInterfaces(
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

export async function addMemberToExistingInterface(
  doc: vscode.TextDocument,
  interfaceName: string,
  member: ExtractedMember
) {
  const interfaces = await detectInterfacesInDocument(doc);
  const target = interfaces.find((i) => i.name === interfaceName);
  if (!target) {
    vscode.window.showErrorMessage(
      `Interface ${interfaceName} was not found in the document.`
    );
    return;
  }

  if (isMemberDeclaredInInterfaces(member, [target])) {
    vscode.window.showInformationMessage(
      `Member ${member.name} already exists in interface ${interfaceName}.`
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
      `Member ${member.name} was added to interface ${interfaceName}.`
    );
  } else {
    vscode.window.showErrorMessage(
      `Failed to update interface ${interfaceName}.`
    );
  }
}

export async function createInterfaceWithMember(
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
      `Interface ${interfaceName} was created and now contains ${member.name}.`
    );
  } else {
    vscode.window.showErrorMessage("Failed to create interface.");
  }
}

function extractPropertyFromSymbol(
  doc: vscode.TextDocument,
  propertySymbol: vscode.DocumentSymbol,
  symbols: readonly vscode.DocumentSymbol[] | undefined
): PropertyExtractionInfo | undefined {
  const interfaceAncestor = findEnclosingSymbolByKind(
    symbols,
    propertySymbol.range.start,
    [vscode.SymbolKind.Interface]
  );
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
