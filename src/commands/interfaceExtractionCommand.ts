import * as vscode from "vscode";
import {
  AddMemberToInterfaceArgs,
  addMemberToExistingInterface,
  createInterfaceWithMember,
  detectInterfacesInDocument,
} from "../features/interfaceExtraction";

export function registerInterfaceExtractionCommand(
  context: vscode.ExtensionContext
) {
  const disposable = vscode.commands.registerCommand(
    "extension.addPropertyToInterface",
    async (args: AddMemberToInterfaceArgs) => {
      if (!args || !args.uri || !args.member) {
        vscode.window.showErrorMessage(
          "Could not determine member to add to interface."
        );
        return;
      }

      const doc = await vscode.workspace.openTextDocument(args.uri);
      const member = args.member;

      if (args.targetInterfaceName) {
        await addMemberToExistingInterface(
          doc,
          args.targetInterfaceName,
          member
        );
        return;
      }

      const defaultName =
        member.enclosingClassName && member.enclosingClassName.length > 0
          ? `I${member.enclosingClassName}`
          : "INewInterface";

      const interfaceName = await vscode.window.showInputBox({
        prompt: "Interface name",
        value: defaultName,
        validateInput: (value) => {
          if (!value || !/^[A-Za-z_]\w*$/.test(value)) {
            return "Enter a valid interface name";
          }
          return null;
        },
      });

      if (!interfaceName) {
        return;
      }

      const interfaces = await detectInterfacesInDocument(doc);
      const existing = interfaces.find((i) => i.name === interfaceName);
      if (existing) {
        await addMemberToExistingInterface(doc, interfaceName, member);
      } else {
        await createInterfaceWithMember(doc, interfaceName, member);
      }
    }
  );

  context.subscriptions.push(disposable);
}
