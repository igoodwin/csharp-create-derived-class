import * as vscode from "vscode";
import { detectNamespace } from "../utils/document";
import {
  findEnclosingSymbolByKind,
  getDocumentSymbols,
} from "../utils/symbols";

export interface ClassMemberQuickPickItem extends vscode.QuickPickItem {
  location: vscode.Location;
}

export interface ClassMembersResult {
  className: string;
  items: ClassMemberQuickPickItem[];
}

export async function collectClassMembersAtPosition(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<ClassMembersResult | undefined> {
  const symbols = await getDocumentSymbols(doc);
  const classSymbol = findEnclosingSymbolByKind(symbols, pos, [
    vscode.SymbolKind.Class,
  ]);

  if (!classSymbol) {
    return undefined;
  }

  const className = normalizeClassName(classSymbol.name);
  const namespaceName = detectNamespace(doc);
  const documents = await collectPartialDocuments(doc, className, namespaceName);

  const items: ClassMemberQuickPickItem[] = [];
  for (const partialDoc of documents) {
    const docSymbols = await getDocumentSymbols(partialDoc);
    const classSymbols = findClassSymbols(docSymbols, className);

    for (const partialClass of classSymbols) {
      for (const member of partialClass.children) {
        if (!isRelevantMember(member)) {
          continue;
        }

        items.push(buildQuickPickItem(partialDoc, member));
      }
    }
  }

  items.sort(compareItems);

  return {
    className,
    items,
  };
}

async function collectPartialDocuments(
  currentDoc: vscode.TextDocument,
  className: string,
  namespaceName: string | undefined
): Promise<vscode.TextDocument[]> {
  const result = new Map<string, vscode.TextDocument>();
  result.set(currentDoc.uri.toString(), currentDoc);

  let workspaceSymbols: vscode.SymbolInformation[] | undefined;
  try {
    workspaceSymbols = await vscode.commands.executeCommand<
      vscode.SymbolInformation[]
    >("vscode.executeWorkspaceSymbolProvider", className);
  } catch (err) {
    console.warn("Failed to query workspace symbols", err);
  }

  if (!workspaceSymbols) {
    return Array.from(result.values());
  }

  for (const symbol of workspaceSymbols) {
    if (symbol.kind !== vscode.SymbolKind.Class) {
      continue;
    }

    const symbolClassName = normalizeClassName(symbol.name);
    if (symbolClassName !== className) {
      continue;
    }

    if (!namespacesEqual(symbol.containerName, namespaceName)) {
      continue;
    }

    const uriKey = symbol.location.uri.toString();
    if (result.has(uriKey)) {
      continue;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(symbol.location.uri);
      const docNamespace = detectNamespace(doc);
      if (!namespacesEqual(docNamespace, namespaceName)) {
        continue;
      }
      result.set(uriKey, doc);
    } catch (err) {
      console.warn("Failed to open document for symbol", err);
    }
  }

  await scanWorkspaceForClass(result, className, namespaceName);

  return Array.from(result.values());
}

function findClassSymbols(
  symbols: readonly vscode.DocumentSymbol[] | undefined,
  className: string,
  found: vscode.DocumentSymbol[] = []
): vscode.DocumentSymbol[] {
  if (!symbols) {
    return found;
  }

  for (const symbol of symbols) {
    const normalized = normalizeClassName(symbol.name);
    if (symbol.kind === vscode.SymbolKind.Class && normalized === className) {
      found.push(symbol);
    }
    findClassSymbols(symbol.children, className, found);
  }

  return found;
}

function buildQuickPickItem(
  doc: vscode.TextDocument,
  symbol: vscode.DocumentSymbol
): ClassMemberQuickPickItem {
  const relativePath = vscode.workspace.asRelativePath(doc.uri);
  const line = symbol.selectionRange.start.line + 1;
  const icon = getKindIcon(symbol.kind);
  const label = `${icon} ${symbol.name}`;
  const description = `${relativePath}:${line}`;
  const detail = buildMemberDetail(doc, symbol);

  return {
    label,
    description,
    detail,
    location: new vscode.Location(doc.uri, symbol.selectionRange),
  };
}

function buildMemberDetail(
  doc: vscode.TextDocument,
  symbol: vscode.DocumentSymbol
): string | undefined {
  const trimmedDetail = symbol.detail?.trim() ?? "";
  if (trimmedDetail.length > 0) {
    return trimmedDetail;
  }

  const lineText = doc.lineAt(symbol.selectionRange.start.line).text.trim();
  if (!lineText) {
    return undefined;
  }

  const limit = 120;
  return lineText.length > limit ? `${lineText.slice(0, limit - 3)}...` : lineText;
}

function compareItems(
  a: ClassMemberQuickPickItem,
  b: ClassMemberQuickPickItem
): number {
  const pathA = a.location.uri.toString();
  const pathB = b.location.uri.toString();
  if (pathA !== pathB) {
    return pathA.localeCompare(pathB);
  }

  const posA = a.location.range.start;
  const posB = b.location.range.start;
  if (posA.line !== posB.line) {
    return posA.line - posB.line;
  }
  return posA.character - posB.character;
}

function isRelevantMember(symbol: vscode.DocumentSymbol): boolean {
  const allowed = new Set<vscode.SymbolKind>([
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Property,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
    vscode.SymbolKind.Event,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Enum,
    vscode.SymbolKind.Class,
  ]);

  return allowed.has(symbol.kind);
}

function getKindIcon(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.Method:
      return "$(symbol-method)";
    case vscode.SymbolKind.Property:
      return "$(symbol-property)";
    case vscode.SymbolKind.Field:
      return "$(symbol-field)";
    case vscode.SymbolKind.Constructor:
      return "$(symbol-method)";
    case vscode.SymbolKind.Event:
      return "$(symbol-event)";
    case vscode.SymbolKind.Struct:
      return "$(symbol-struct)";
    case vscode.SymbolKind.Interface:
      return "$(symbol-interface)";
    case vscode.SymbolKind.Enum:
      return "$(symbol-enum)";
    case vscode.SymbolKind.Class:
      return "$(symbol-class)";
    default:
      return "$(symbol-property)";
  }
}

function normalizeClassName(name: string): string {
  const genericIndex = name.indexOf("<");
  return genericIndex >= 0 ? name.slice(0, genericIndex).trim() : name.trim();
}

function namespacesEqual(
  a: string | undefined,
  b: string | undefined
): boolean {
  const left = (a ?? "").trim();
  const right = (b ?? "").trim();
  return left === right;
}

async function scanWorkspaceForClass(
  result: Map<string, vscode.TextDocument>,
  className: string,
  namespaceName: string | undefined
): Promise<void> {
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(
      "**/*.cs",
      "{**/bin/**,**/obj/**,**/.git/**,**/node_modules/**}"
    );
  } catch (err) {
    console.warn("Failed to scan workspace for partial classes", err);
    return;
  }

  const classRegex = new RegExp(
    `\\bclass\\s+${escapeRegExp(className)}\\b`
  );
  const namespaceRegex = namespaceName
    ? new RegExp(
        `\\bnamespace\\s+${escapeRegExp(namespaceName)}\\s*(\\{|;)`
      )
    : undefined;

  for (const uri of files) {
    const key = uri.toString();
    if (result.has(key)) {
      continue;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      if (!classRegex.test(text)) {
        continue;
      }

      if (namespaceRegex && !namespaceRegex.test(text)) {
        continue;
      }

      result.set(key, doc);
    } catch (err) {
      console.warn("Failed to inspect file for class members", err);
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
