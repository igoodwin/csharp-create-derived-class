import * as vscode from "vscode";
import {
  collectSymbolsByKind,
  findEnclosingSymbolByKind,
  getDocumentSymbols,
} from "../utils/symbols";
import { getEOL } from "../utils/document";

type ClassMemberKind = "field" | "property" | "method";

export interface MovableClassMemberInfo {
  kind: ClassMemberKind;
  name: string;
  range: vscode.Range;
  text: string;
  order: number;
  symbol: vscode.DocumentSymbol;
}

export interface MoveToBaseContext {
  member: MovableClassMemberInfo;
  classSymbol: vscode.DocumentSymbol;
  baseClassSymbol: vscode.DocumentSymbol;
  baseClassName: string;
  allMembers: MovableClassMemberInfo[];
}

export async function detectMoveToBaseContext(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  symbols?: vscode.DocumentSymbol[]
): Promise<MoveToBaseContext | undefined> {
  const tree = symbols ?? (await getDocumentSymbols(doc));
  if (!tree || tree.length === 0) {
    return undefined;
  }

  const memberSymbol = findEnclosingSymbolByKind(tree, pos, [
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Property,
    vscode.SymbolKind.Method,
  ]);
  if (!memberSymbol) {
    return undefined;
  }

  const interfaceAncestor = findEnclosingSymbolByKind(
    tree,
    memberSymbol.range.start,
    [vscode.SymbolKind.Interface]
  );
  if (interfaceAncestor) {
    return undefined;
  }

  const classSymbol = findEnclosingSymbolByKind(
    tree,
    memberSymbol.range.start,
    [vscode.SymbolKind.Class]
  );
  if (!classSymbol) {
    return undefined;
  }

  const baseClassName = detectBaseClassName(doc, classSymbol);
  if (!baseClassName) {
    return undefined;
  }

  const baseClassSymbol = findClassSymbolByName(tree, baseClassName);
  if (!baseClassSymbol || baseClassSymbol === classSymbol) {
    return undefined;
  }

  const allMembers = collectMovableMembers(doc, classSymbol);
  if (allMembers.length === 0) {
    return undefined;
  }

  const member =
    allMembers.find((m) => m.symbol === memberSymbol) ??
    allMembers.find((m) => rangesEqual(m.symbol.range, memberSymbol.range));
  if (!member) {
    return undefined;
  }

  return {
    member,
    classSymbol,
    baseClassSymbol,
    baseClassName,
    allMembers,
  };
}

export function buildMoveMemberWorkspaceEdit(
  doc: vscode.TextDocument,
  context: MoveToBaseContext
): vscode.WorkspaceEdit | undefined {
  const membersToMove = collectMembersWithDependencies(
    context.member,
    context.allMembers
  );
  if (membersToMove.length === 0) {
    return undefined;
  }

  const insertionPosition = findClassInsertionPosition(
    doc,
    context.baseClassSymbol
  );
  if (!insertionPosition) {
    return undefined;
  }

  const orderedMembers = [...membersToMove].sort((a, b) => a.order - b.order);
  const eol = getEOL(doc);
  const betweenMembers = `${eol}${eol}`;
  const preparedTexts = orderedMembers.map((member) =>
    prepareMemberTextForInsertion(member.text, eol)
  );
  const joined = preparedTexts.join(betweenMembers).trimEnd();
  if (!joined) {
    return undefined;
  }

  const insertionText = `${eol}${joined}${eol}`;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, insertionPosition, insertionText);

  const deletionOrder = [...orderedMembers].sort(
    (a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start)
  );
  for (const member of deletionOrder) {
    edit.delete(doc.uri, member.range);
  }

  return edit;
}

function rangesEqual(a: vscode.Range, b: vscode.Range): boolean {
  return a.start.isEqual(b.start) && a.end.isEqual(b.end);
}

function detectBaseClassName(
  doc: vscode.TextDocument,
  classSymbol: vscode.DocumentSymbol
): string | undefined {
  const classText = doc.getText(classSymbol.range);
  const braceIndex = classText.indexOf("{");
  if (braceIndex === -1) {
    return undefined;
  }

  const header = classText.slice(0, braceIndex);
  const colonIndex = header.indexOf(":");
  if (colonIndex === -1) {
    return undefined;
  }

  const afterColon = header.slice(colonIndex + 1);
  if (!afterColon.trim()) {
    return undefined;
  }

  const withoutConstraints = afterColon.split(/\bwhere\b/)[0] ?? "";
  const baseCandidate = withoutConstraints.split(",")[0]?.trim();
  if (!baseCandidate) {
    return undefined;
  }

  return sanitizeClassName(baseCandidate);
}

function sanitizeClassName(name: string): string | undefined {
  let value = name;
  if (value.startsWith("global::")) {
    value = value.slice("global::".length);
  }
  const withoutGenerics = value.split("<")[0].trim();
  if (!withoutGenerics) {
    return undefined;
  }
  const parts = withoutGenerics.split(".");
  return parts[parts.length - 1];
}

function findClassSymbolByName(
  symbols: readonly vscode.DocumentSymbol[],
  name: string
): vscode.DocumentSymbol | undefined {
  const candidates = collectSymbolsByKind(symbols, vscode.SymbolKind.Class);
  const normalizedTarget = name;

  return candidates.find((symbol) => {
    const normalized = sanitizeClassName(symbol.name ?? "") ?? symbol.name;
    if (!normalized) {
      return false;
    }
    return normalized === normalizedTarget;
  });
}

function collectMovableMembers(
  doc: vscode.TextDocument,
  classSymbol: vscode.DocumentSymbol
): MovableClassMemberInfo[] {
  if (!classSymbol.children) {
    return [];
  }

  const members: MovableClassMemberInfo[] = [];
  for (const child of classSymbol.children) {
    const kind = classifySymbolKind(child.kind);
    if (!kind) {
      continue;
    }

    const range = buildMemberRange(doc, child, classSymbol);
    const text = doc.getText(range);
    members.push({
      kind,
      name: child.name,
      range,
      text,
      order: doc.offsetAt(range.start),
      symbol: child,
    });
  }

  members.sort((a, b) => a.order - b.order);
  return members;
}

function classifySymbolKind(
  kind: vscode.SymbolKind
): ClassMemberKind | undefined {
  switch (kind) {
    case vscode.SymbolKind.Field:
      return "field";
    case vscode.SymbolKind.Property:
      return "property";
    case vscode.SymbolKind.Method:
      return "method";
    default:
      return undefined;
  }
}

function buildMemberRange(
  doc: vscode.TextDocument,
  symbol: vscode.DocumentSymbol,
  classSymbol: vscode.DocumentSymbol
): vscode.Range {
  let startLine = symbol.range.start.line;
  while (startLine > classSymbol.range.start.line) {
    const previousLine = doc.lineAt(startLine - 1);
    const trimmed = previousLine.text.trim();
    if (!trimmed) {
      break;
    }
    if (/^(?:\[|\/\/\/|\/\*|\*)/.test(trimmed)) {
      startLine--;
      continue;
    }
    break;
  }

  const start = new vscode.Position(startLine, 0);
  const endLine = symbol.range.end.line;
  const end = doc.lineAt(endLine).rangeIncludingLineBreak.end;
  return new vscode.Range(start, end);
}

function collectMembersWithDependencies(
  root: MovableClassMemberInfo,
  allMembers: MovableClassMemberInfo[]
): MovableClassMemberInfo[] {
  const stack: MovableClassMemberInfo[] = [root];
  const seenKeys = new Set<string>();
  const queuedKeys = new Set<string>([memberKey(root)]);
  const result: MovableClassMemberInfo[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const key = memberKey(current);
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    result.push(current);

    for (const candidate of allMembers) {
      if (candidate === current) {
        continue;
      }
      const candidateKey = memberKey(candidate);
      if (seenKeys.has(candidateKey) || queuedKeys.has(candidateKey)) {
        continue;
      }
      if (usesMemberName(current.text, candidate.name)) {
        stack.push(candidate);
        queuedKeys.add(candidateKey);
      }
    }
  }

  return result;
}

function memberKey(member: MovableClassMemberInfo): string {
  return `${member.range.start.line}:${member.range.start.character}`;
}

function usesMemberName(text: string, memberName: string): boolean {
  if (!memberName) {
    return false;
  }
  const pattern = new RegExp(`\\b${escapeRegExp(memberName)}\\b`);
  return pattern.test(text);
}

function findClassInsertionPosition(
  doc: vscode.TextDocument,
  classSymbol: vscode.DocumentSymbol
): vscode.Position | undefined {
  const classText = doc.getText(classSymbol.range);
  const closingIndex = classText.lastIndexOf("}");
  if (closingIndex === -1) {
    return undefined;
  }

  const absoluteOffset = doc.offsetAt(classSymbol.range.start) + closingIndex;
  return doc.positionAt(absoluteOffset);
}

function prepareMemberTextForInsertion(text: string, eol: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const adjusted = promotePrivateToProtected(trimmed);
  return adjusted.split(/\r?\n/).join(eol);
}

function promotePrivateToProtected(text: string): string {
  const regex = /^(\s*(?:(?:\[[^\]]*\]|\/\/\/.*)\s*)*)(private)(\s+)/;
  if (!regex.test(text)) {
    return text;
  }
  return text.replace(regex, (_match, prefix, _accessibility, suffix) => {
    return `${prefix}protected${suffix}`;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
