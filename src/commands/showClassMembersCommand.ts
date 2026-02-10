import * as vscode from "vscode";
import {
  ClassMemberQuickPickItem,
  collectClassMembersAtPosition,
} from "../features/classMembers";
import { collectSymbolsByKind, getDocumentSymbols } from "../utils/symbols";
import { log } from "../utils/output";

export function registerShowClassMembersCommand(
  context: vscode.ExtensionContext
) {
  const disposable = vscode.commands.registerCommand(
    "extension.showClassMembers",
    async () => {
      log("Command: showClassMembers");
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        log("No active editor");
        vscode.window.showErrorMessage(
          "Open a C# file and place the cursor inside a class."
        );
        return;
      }

      const doc = editor.document;
      log(`Doc: ${doc.uri.toString()} scheme=${doc.uri.scheme} lang=${doc.languageId}`);
      if (doc.languageId !== "csharp") {
        vscode.window.showErrorMessage(
          "Class members are only available for C# files."
        );
        return;
      }

      const position = editor.selection.active;
      const result = await collectClassMembersAtPosition(doc, position);
      if (!result) {
        log("No class symbol found at cursor position");
        vscode.window.showErrorMessage("Place the cursor inside a class.");
        return;
      }

      if (result.items.length === 0) {
        log(`No members found for ${result.className}`);
        vscode.window.showInformationMessage(
          `No members found for ${result.className}.`
        );
        return;
      }

      const picked = await vscode.window.showQuickPick<ClassMemberQuickPickItem>(
        result.items,
        {
        placeHolder: `Members of ${result.className}`,
        matchOnDetail: true,
        }
      );

      if (!picked) {
        return;
      }

      const targetDoc = await vscode.workspace.openTextDocument(
        picked.location.uri
      );
      const targetEditor = await vscode.window.showTextDocument(targetDoc);
      targetEditor.selection = new vscode.Selection(
        picked.location.range.start,
        picked.location.range.start
      );
      targetEditor.revealRange(
        picked.location.range,
        vscode.TextEditorRevealType.InCenter
      );
    }
  );

  context.subscriptions.push(disposable);

  const nextDisposable = vscode.commands.registerCommand(
    "extension.navigateToNextClassMember",
    async () => {
      await navigateClassMembers("next");
    }
  );

  const prevDisposable = vscode.commands.registerCommand(
    "extension.navigateToPreviousClassMember",
    async () => {
      await navigateClassMembers("previous");
    }
  );

  context.subscriptions.push(nextDisposable, prevDisposable);
}

type NavigationDirection = "next" | "previous";

async function navigateClassMembers(
  direction: NavigationDirection
): Promise<void> {
  log(`Command: navigateClassMembers (${direction})`);
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    log("No active editor");
    return;
  }

  const doc = editor.document;
  log(`Doc: ${doc.uri.toString()} scheme=${doc.uri.scheme} lang=${doc.languageId}`);
  if (doc.languageId !== "csharp") {
    return;
  }

  const position = editor.selection.active;
  const result = await collectClassMembersAtPosition(doc, position);
  if (!result || result.items.length === 0) {
    log("No class members found for navigation, attempting class navigation");
    const moved = await navigateToNearestClassSymbol(
      editor,
      doc,
      position,
      direction
    );
    if (!moved) {
      log("No class symbols found for navigation");
    }
    return;
  }

  const candidates = filterItemsByNavigationScope(result.items, doc.uri).filter(
    (item) => isNavigableMemberKind(item.symbolKind)
  );
  if (candidates.length === 0) {
    return;
  }

  candidates.sort(compareItems);

  const currentIndex = findCurrentIndex(candidates, doc.uri, position);
  let target: ClassMemberQuickPickItem | undefined;

  if (direction === "next") {
    if (currentIndex >= 0 && currentIndex < candidates.length - 1) {
      target = candidates[currentIndex + 1];
    } else if (currentIndex === -1) {
      target = findFirstAfterPosition(candidates, doc.uri, position);
    }
  } else {
    if (currentIndex > 0) {
      target = candidates[currentIndex - 1];
    } else if (currentIndex === -1) {
      target = findLastBeforePosition(candidates, doc.uri, position);
    }
  }

  if (!target && candidates.length > 0 && isNavigationWrapEnabled()) {
    target =
      direction === "next" ? candidates[0] : candidates[candidates.length - 1];
  }

  if (!target) {
    return;
  }

  await revealLocation(target.location);
}

function filterItemsByNavigationScope(
  items: ClassMemberQuickPickItem[],
  uri: vscode.Uri
): ClassMemberQuickPickItem[] {
  if (isCrossFileNavigationEnabled()) {
    return items;
  }

  const uriKey = uri.toString();
  return items.filter((item) => item.location.uri.toString() === uriKey);
}

function isCrossFileNavigationEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("csharpCreateDerivedClass")
      .get<boolean>("navigateAcrossFiles", true) ?? true
  );
}

function isNavigationWrapEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("csharpCreateDerivedClass")
      .get<boolean>("wrapNavigation", true) ?? true
  );
}

function isNavigableMemberKind(kind: vscode.SymbolKind): boolean {
  return (
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Property ||
    kind === vscode.SymbolKind.Field ||
    kind === vscode.SymbolKind.Constructor
  );
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

function findCurrentIndex(
  items: ClassMemberQuickPickItem[],
  uri: vscode.Uri,
  position: vscode.Position
): number {
  const uriKey = uri.toString();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.location.uri.toString() !== uriKey) {
      continue;
    }
    if (item.location.range.contains(position)) {
      return i;
    }
  }
  return -1;
}

function findFirstAfterPosition(
  items: ClassMemberQuickPickItem[],
  uri: vscode.Uri,
  position: vscode.Position
): ClassMemberQuickPickItem | undefined {
  for (const item of items) {
    if (compareItemToPosition(item, uri, position) > 0) {
      return item;
    }
  }
  return undefined;
}

function findLastBeforePosition(
  items: ClassMemberQuickPickItem[],
  uri: vscode.Uri,
  position: vscode.Position
): ClassMemberQuickPickItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (compareItemToPosition(item, uri, position) < 0) {
      return item;
    }
  }
  return undefined;
}

function compareItemToPosition(
  item: ClassMemberQuickPickItem,
  uri: vscode.Uri,
  position: vscode.Position
): number {
  const itemKey = item.location.uri.toString();
  const targetKey = uri.toString();
  if (itemKey !== targetKey) {
    return itemKey.localeCompare(targetKey);
  }

  const pos = item.location.range.start;
  if (pos.line !== position.line) {
    return pos.line - position.line;
  }
  return pos.character - position.character;
}

async function navigateToNearestClassSymbol(
  editor: vscode.TextEditor,
  doc: vscode.TextDocument,
  position: vscode.Position,
  direction: NavigationDirection
): Promise<boolean> {
  const symbols = await getDocumentSymbols(doc);
  const classSymbols = collectSymbolsByKind(
    symbols,
    vscode.SymbolKind.Class
  );
  if (classSymbols.length === 0) {
    return false;
  }

  classSymbols.sort(compareClassSymbols);
  const target =
    direction === "next"
      ? findFirstClassAfterPosition(classSymbols, position)
      : findLastClassBeforePosition(classSymbols, position);
  const resolvedTarget =
    target ??
    (isNavigationWrapEnabled()
      ? direction === "next"
        ? classSymbols[0]
        : classSymbols[classSymbols.length - 1]
      : undefined);

  if (!resolvedTarget) {
    return false;
  }

  const location = new vscode.Location(doc.uri, resolvedTarget.selectionRange);
  await revealLocation(location, editor);
  return true;
}

function compareClassSymbols(
  a: vscode.DocumentSymbol,
  b: vscode.DocumentSymbol
): number {
  const posA = a.selectionRange.start;
  const posB = b.selectionRange.start;
  if (posA.line !== posB.line) {
    return posA.line - posB.line;
  }
  return posA.character - posB.character;
}

function findFirstClassAfterPosition(
  items: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  for (const item of items) {
    if (compareClassToPosition(item, position) > 0) {
      return item;
    }
  }
  return undefined;
}

function findLastClassBeforePosition(
  items: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (compareClassToPosition(item, position) < 0) {
      return item;
    }
  }
  return undefined;
}

function compareClassToPosition(
  item: vscode.DocumentSymbol,
  position: vscode.Position
): number {
  const pos = item.selectionRange.start;
  if (pos.line !== position.line) {
    return pos.line - position.line;
  }
  return pos.character - position.character;
}

async function revealLocation(
  location: vscode.Location,
  editor?: vscode.TextEditor
): Promise<void> {
  const targetDoc = await vscode.workspace.openTextDocument(location.uri);
  const targetEditor =
    editor?.document.uri.toString() === location.uri.toString()
      ? editor
      : await vscode.window.showTextDocument(targetDoc);
  targetEditor.selection = new vscode.Selection(
    location.range.start,
    location.range.start
  );
  targetEditor.revealRange(
    location.range,
    vscode.TextEditorRevealType.InCenter
  );
}
