import * as vscode from "vscode";
import { log } from "./output";

interface DocumentSymbolCacheEntry {
  version: number;
  symbols: vscode.DocumentSymbol[];
}

const documentSymbolCache = new Map<string, DocumentSymbolCacheEntry>();

export async function getDocumentSymbols(
  doc: vscode.TextDocument
): Promise<vscode.DocumentSymbol[]> {
  const key = doc.uri.toString();
  const cached = documentSymbolCache.get(key);
  if (cached && cached.version === doc.version) {
    if (cached.symbols.length > 1) {
      return cached.symbols;
    }
    log(
      `Cached symbols count is ${cached.symbols.length}, attempting refresh...`
    );
  }

  try {
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", doc.uri);
    if (symbols) {
      log(`executeDocumentSymbolProvider returned ${symbols.length} symbols`);
      documentSymbolCache.set(key, { version: doc.version, symbols });
      return symbols;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to retrieve document symbols: ${message}`);
  }

  documentSymbolCache.delete(key);
  return [];
}

export function collectSymbolsByKind(
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

export function findEnclosingSymbolByKind(
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
