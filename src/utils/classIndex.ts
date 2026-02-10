import * as vscode from "vscode";
import { log } from "./output";

type IndexKey = string;

const index = new Map<IndexKey, Set<string>>();
const fileToKeys = new Map<string, Set<IndexKey>>();
let indexReady = false;
let indexBuilding: Promise<void> | undefined;

const pendingUpdates = new Map<string, vscode.Uri>();
let updateTimer: NodeJS.Timeout | undefined;

export function startClassIndexing(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== "csharp") {
        return;
      }
      enqueueUpdate(doc.uri);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.languageId !== "csharp") {
        return;
      }
      ensureIndexBuilding();
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) {
        enqueueUpdate(uri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        removeFile(uri);
      }
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        removeFile(file.oldUri);
        enqueueUpdate(file.newUri);
      }
    })
  );

  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "csharp") {
    ensureIndexBuilding();
  }
}

export function isClassIndexReady(): boolean {
  return indexReady;
}

export function getIndexedClassUris(
  className: string,
  namespaceName: string | undefined
): vscode.Uri[] | undefined {
  if (!indexReady) {
    return undefined;
  }

  const key = makeKey(className, namespaceName);
  const uris = index.get(key);
  if (!uris || uris.size === 0) {
    return [];
  }

  return Array.from(uris, (value) => vscode.Uri.parse(value));
}

function ensureIndexBuilding(): void {
  if (indexBuilding) {
    return;
  }
  indexBuilding = buildIndex().finally(() => {
    indexReady = true;
    log("Class index ready.");
  });
}

async function buildIndex(): Promise<void> {
  let files: vscode.Uri[] = [];
  try {
    files = await vscode.workspace.findFiles(
      "**/*.cs",
      "{**/bin/**,**/obj/**,**/.git/**,**/node_modules/**}"
    );
  } catch (err) {
    log(`Failed to build class index: ${err}`);
    return;
  }

  log(`Building class index from ${files.length} files...`);
  const startedAt = Date.now();

  for (const uri of files) {
    await updateFile(uri);
  }

  log(`Class index build completed in ${Date.now() - startedAt}ms.`);
}

function enqueueUpdate(uri: vscode.Uri): void {
  if (!isCSharpFile(uri)) {
    return;
  }
  pendingUpdates.set(uri.toString(), uri);
  if (updateTimer) {
    return;
  }
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    void flushUpdates();
  }, 250);
}

async function flushUpdates(): Promise<void> {
  const uris = Array.from(pendingUpdates.values());
  pendingUpdates.clear();
  for (const uri of uris) {
    await updateFile(uri);
  }
}

async function updateFile(uri: vscode.Uri): Promise<void> {
  if (!isCSharpFile(uri)) {
    return;
  }
  const key = uri.toString();
  let text = "";
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = Buffer.from(bytes).toString("utf8");
  } catch {
    removeFile(uri);
    return;
  }

  const namespaceName = detectNamespaceFromText(text);
  const classNames = extractClassNames(text);
  const newKeys = new Set<IndexKey>();

  for (const className of classNames) {
    newKeys.add(makeKey(className, namespaceName));
  }

  const oldKeys = fileToKeys.get(key);
  if (oldKeys) {
    for (const oldKey of oldKeys) {
      if (!newKeys.has(oldKey)) {
        const set = index.get(oldKey);
        if (set) {
          set.delete(key);
          if (set.size === 0) {
            index.delete(oldKey);
          }
        }
      }
    }
  }

  if (newKeys.size === 0) {
    fileToKeys.delete(key);
    return;
  }

  for (const newKey of newKeys) {
    let set = index.get(newKey);
    if (!set) {
      set = new Set<string>();
      index.set(newKey, set);
    }
    set.add(key);
  }

  fileToKeys.set(key, newKeys);
}

function removeFile(uri: vscode.Uri): void {
  if (!isCSharpFile(uri)) {
    return;
  }
  const key = uri.toString();
  const keys = fileToKeys.get(key);
  if (!keys) {
    return;
  }

  for (const indexKey of keys) {
    const set = index.get(indexKey);
    if (set) {
      set.delete(key);
      if (set.size === 0) {
        index.delete(indexKey);
      }
    }
  }

  fileToKeys.delete(key);
}

function makeKey(
  className: string,
  namespaceName: string | undefined
): IndexKey {
  return `${namespaceName ?? ""}::${className}`;
}

function detectNamespaceFromText(text: string): string | undefined {
  const match = /\bnamespace\s+([A-Za-z_][\w\.]*)\b/.exec(text);
  return match?.[1];
}

function extractClassNames(text: string): string[] {
  const classRegex = /\bclass\s+([A-Za-z_][\w]*)\b/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(text))) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names;
}

function isCSharpFile(uri: vscode.Uri): boolean {
  return uri.path.endsWith(".cs");
}
