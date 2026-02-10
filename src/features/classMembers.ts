import * as vscode from "vscode";
import * as path from "path";
import { detectNamespace } from "../utils/document";
import {
  findEnclosingSymbolByKind,
  getDocumentSymbols,
} from "../utils/symbols";
import { getIndexedClassUris, isClassIndexReady } from "../utils/classIndex";
import { log } from "../utils/output";

export interface ClassMemberQuickPickItem extends vscode.QuickPickItem {
  location: vscode.Location;
  symbolKind: vscode.SymbolKind;
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
  log(`Document symbols: ${symbols.length}`);
  const classSymbol = findEnclosingSymbolByKind(symbols, pos, [
    vscode.SymbolKind.Class,
  ]);

  if (!classSymbol) {
    log("No enclosing class symbol found");
    return undefined;
  }

  const className = normalizeClassName(classSymbol.name);
  const namespaceName = detectNamespace(doc);
  log(
    `Collecting members for ${className} namespace=${namespaceName ?? "<global>"}`
  );
  const documents = isPartialClass(doc, classSymbol)
    ? await collectPartialDocuments(doc, className, namespaceName)
    : [doc];

  const items: ClassMemberQuickPickItem[] = [];
  for (const partialDoc of documents) {
    const docSymbols = await getDocumentSymbols(partialDoc);
    const classSymbols = findClassSymbols(docSymbols, className);
    log(
      `Doc ${partialDoc.uri.toString()} classSymbols=${classSymbols.length}`
    );

    for (const partialClass of classSymbols) {
      log(
        `Class ${partialClass.name} members=${partialClass.children.length}`
      );
      for (const member of partialClass.children) {
        if (!isRelevantMember(member)) {
          continue;
        }

        items.push(buildQuickPickItem(doc, partialDoc, member));
      }
    }
  }

  items.sort(compareItems);
  log(`Collected members total=${items.length}`);

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
    workspaceSymbols = await vscode.commands
      .executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", className);
  } catch (err) {
    log(`Failed to query workspace symbols: ${err}`);
  }

  if (!workspaceSymbols) {
    log('No workspace symbols found, skipping partial class search');
    return Array.from(result.values());
  }

  log(`Workspace symbols: ${workspaceSymbols.length}`);
  const loopStartedAt = Date.now();
  let classCount = 0;
  let nameMatchCount = 0;
  let namespaceMatchCount = 0;
  log("Iterating workspace symbols...");
  for (const symbol of workspaceSymbols) {
    if (symbol.kind !== vscode.SymbolKind.Class) {
      continue;
    }
    classCount++;

    const symbolClassName = normalizeClassName(symbol.name);
    if (symbolClassName !== className) {
      continue;
    }
    nameMatchCount++;

    if (!namespacesEqual(symbol.containerName, namespaceName)) {
      continue;
    }
    namespaceMatchCount++;

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
      log(`Failed to open document for symbol: ${err}`);
    }
  }
  log(
    `Workspace symbol scan done in ${Date.now() - loopStartedAt}ms: classes=${classCount} nameMatches=${nameMatchCount} namespaceMatches=${namespaceMatchCount}`
  );

  const indexedUris = getIndexedClassUris(className, namespaceName);
  if (indexedUris) {
    log(`Class index returned ${indexedUris.length} documents.`);
    await addDocumentsFromUris(result, indexedUris);
  }

  if (!isClassIndexReady()) {
    if (result.size <= 1) {
      log(`Found ${result.size} documents from workspace symbols, scanning for more...`);
      await scanWorkspaceForClass(result, className, namespaceName);
    } else {
      log(`Found ${result.size} documents from workspace symbols, skipping fallback scan.`);
    }
  } else {
    log("Class index ready, skipping fallback scan.");
  }

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
  currentDoc: vscode.TextDocument,
  doc: vscode.TextDocument,
  symbol: vscode.DocumentSymbol
): ClassMemberQuickPickItem {
  const fullPath = doc.uri.fsPath;
  const relativePath = path.relative(
    path.dirname(currentDoc.uri.fsPath),
    fullPath
  );
  const displayPath = chooseShorterPath(fullPath, relativePath);
  const line = symbol.selectionRange.start.line + 1;
  const icon = getKindIcon(symbol.kind);
  const label = `${icon} ${symbol.name}`;
  const description = `${displayPath}:${line}`;
  const isDifferentFile = doc.uri.toString() !== currentDoc.uri.toString();
  const locationSuffix = isDifferentFile ? ` • ${displayPath}:${line}` : "";

  return {
    label,
    description,
    detail: locationSuffix,
    location: new vscode.Location(doc.uri, symbol.selectionRange),
    symbolKind: symbol.kind,
  };
}

function chooseShorterPath(fullPath: string, relativePath: string): string {
  if (!relativePath) {
    return fullPath;
  }
  if (!fullPath) {
    return relativePath;
  }
  return relativePath.length <= fullPath.length ? relativePath : fullPath;
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

function isPartialClass(
  doc: vscode.TextDocument,
  classSymbol: vscode.DocumentSymbol
): boolean {
  const startLine = classSymbol.range.start.line;
  const endLine = classSymbol.selectionRange.start.line;
  const state: ScanState = {
    inLineComment: false,
    inBlockComment: false,
    inString: false,
    inChar: false,
    inVerbatimString: false,
  };
  let token = "";

  for (let line = startLine; line <= endLine; line++) {
    const text = doc.lineAt(line).text;
    const result = scanLineForPartial(text, state, token);
    if (result.found) {
      return true;
    }
    token = result.token;
    state.inLineComment = false;
  }

  return token === "partial";
}

type ScanState = {
  inLineComment: boolean;
  inBlockComment: boolean;
  inString: boolean;
  inChar: boolean;
  inVerbatimString: boolean;
};

function scanLineForPartial(
  text: string,
  state: ScanState,
  token: string
): { found: boolean; token: string } {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (state.inLineComment) {
      break;
    }

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }

    if (state.inString) {
      if (ch === "\\" && next) {
        i++;
        continue;
      }
      if (ch === "\"") {
        state.inString = false;
      }
      continue;
    }

    if (state.inVerbatimString) {
      if (ch === "\"" && next === "\"") {
        i++;
        continue;
      }
      if (ch === "\"") {
        state.inVerbatimString = false;
      }
      continue;
    }

    if (state.inChar) {
      if (ch === "\\" && next) {
        i++;
        continue;
      }
      if (ch === "'") {
        state.inChar = false;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state.inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "@" && next === "\"") {
      state.inVerbatimString = true;
      continue;
    }

    if (ch === "\"") {
      state.inString = true;
      continue;
    }

    if (ch === "'") {
      state.inChar = true;
      continue;
    }

    if (isIdentifierChar(ch)) {
      token += ch;
      continue;
    }

    if (token === "partial") {
      return { found: true, token };
    }
    token = "";
  }

  return { found: token === "partial", token };
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
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
      "{**/bin/**,**/obj/**,**/.git/**,**/node_modules/**}",
      2000
    );
  } catch (err) {
    log(`Failed to scan workspace for partial classes: ${err}`);
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

  const scanStartedAt = Date.now();
  const scanBudgetMs = 1500;
  log(
    `Scanning ${files.length} workspace files for class "${className}" (budget ${scanBudgetMs}ms)...`
  );

  for (const uri of files) {
    if (Date.now() - scanStartedAt > scanBudgetMs) {
      log("Workspace scan exceeded time budget, stopping early.");
      break;
    }

    const key = uri.toString();
    if (result.has(key)) {
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString("utf8");
      if (!classRegex.test(text)) {
        continue;
      }

      if (namespaceRegex && !namespaceRegex.test(text)) {
        continue;
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      result.set(key, doc);
    } catch (err) {
      log(`Failed to inspect file for class members: ${err}`);
    }
  }
}

async function addDocumentsFromUris(
  result: Map<string, vscode.TextDocument>,
  uris: vscode.Uri[]
): Promise<void> {
  for (const uri of uris) {
    const key = uri.toString();
    if (result.has(key)) {
      continue;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      result.set(key, doc);
    } catch (err) {
      log(`Failed to open document from index: ${err}`);
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
