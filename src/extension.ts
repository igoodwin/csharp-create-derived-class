import * as vscode from "vscode";
import { registerCreateDerivedClassCommand } from "./commands/createDerivedClassCommand";
import { registerInterfaceExtractionCommand } from "./commands/interfaceExtractionCommand";
import { registerShowClassMembersCommand } from "./commands/showClassMembersCommand";
import { CreateDerivedClassProvider } from "./providers/createDerivedClassProvider";
import { getOutputChannel, log } from "./utils/output";

export function activate(context: vscode.ExtensionContext) {
  const output = getOutputChannel();
  log("Activating extension...");

  const provider: vscode.CodeActionProvider = new CreateDerivedClassProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { language: "csharp", scheme: "file" },
        { language: "csharp", scheme: "vscode-remote" },
      ],
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

  context.subscriptions.push(output);
}

export function deactivate() {
  // nothing to clean up
}
