import * as vscode from "vscode";
import { collectClassMembersAtPosition } from "../features/classMembers";

export function registerShowClassMembersCommand(
  context: vscode.ExtensionContext
) {
  const disposable = vscode.commands.registerCommand(
    "extension.showClassMembers",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "Open a C# file and place the cursor inside a class."
        );
        return;
      }

      const doc = editor.document;
      if (doc.languageId !== "csharp") {
        vscode.window.showErrorMessage(
          "Class members are only available for C# files."
        );
        return;
      }

      const position = editor.selection.active;
      const result = await collectClassMembersAtPosition(doc, position);
      if (!result) {
        vscode.window.showErrorMessage("Place the cursor inside a class.");
        return;
      }

      if (result.items.length === 0) {
        vscode.window.showInformationMessage(
          `No members found for ${result.className}.`
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(result.items, {
        placeHolder: `Members of ${result.className}`,
        matchOnDetail: true,
      });

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
}
