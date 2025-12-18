import * as vscode from "vscode";
import {
  createDerivedClass,
  detectClassInfoAtPosition,
} from "../features/createDerivedClass";

export function registerCreateDerivedClassCommand(
  context: vscode.ExtensionContext
) {
  const disposable = vscode.commands.registerCommand(
    "extension.createDerivedClass",
    async (args) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "Open a C# file and place the cursor on a class declaration."
        );
        return;
      }

      const doc = editor.document;
      const position = editor.selection.active;

      let baseName: string | undefined;
      let typeParameters: string[] = [];

      if (args && typeof args.baseName === "string") {
        baseName = args.baseName;
        if (Array.isArray(args.typeParameters)) {
          typeParameters = args.typeParameters;
        }
      } else {
        const info = await detectClassInfoAtPosition(doc, position);
        if (info) {
          baseName = info.name;
          typeParameters = info.typeParameters;
        }
      }

      if (!baseName) {
        vscode.window.showErrorMessage("Could not detect class name at cursor.");
        return;
      }

      const defaultName = `${baseName}Derived`;
      const newName = await vscode.window.showInputBox({
        prompt: `Name for derived class inheriting from ${baseName}`,
        value: defaultName,
        validateInput: (value) => {
          if (!/^[A-Za-z_]\w*$/.test(value)) {
            return "Invalid C# identifier";
          }
          return null;
        },
      });

      if (!newName) {
        return;
      }

      try {
        await createDerivedClass(
          doc,
          position,
          baseName,
          newName,
          typeParameters
        );
        vscode.window.showInformationMessage(
          `Created class ${newName} : ${baseName}`
        );
      } catch (err) {
        vscode.window.showErrorMessage("Failed to create derived class: " + String(err));
      }
    }
  );

  context.subscriptions.push(disposable);
}
