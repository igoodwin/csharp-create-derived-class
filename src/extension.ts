import * as vscode from "vscode";
import { registerCreateDerivedClassCommand } from "./commands/createDerivedClassCommand";
import { registerInterfaceExtractionCommand } from "./commands/interfaceExtractionCommand";
import { registerShowClassMembersCommand } from "./commands/showClassMembersCommand";
import { CreateDerivedClassProvider } from "./providers/createDerivedClassProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider: vscode.CodeActionProvider = new CreateDerivedClassProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: "csharp", scheme: "file" },
      provider,
      {
        providedCodeActionKinds:
          CreateDerivedClassProvider.providedCodeActionKinds,
      }
    )
  );

  registerCreateDerivedClassCommand(context);
  registerInterfaceExtractionCommand(context);
  registerShowClassMembersCommand(context);
}

export function deactivate() {
  // nothing to clean up
}
