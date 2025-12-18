import * as vscode from "vscode";

export function getEOL(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

export function detectNamespace(
  doc: vscode.TextDocument
): string | undefined {
  const text = doc.getText();
  const nsRegex = /\bnamespace\s+([A-Za-z_][\w\.]*)\b/;
  const match = nsRegex.exec(text);
  if (match && match[1]) {
    return match[1];
  }
  return undefined;
}

export function findMatchingBrace(
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
