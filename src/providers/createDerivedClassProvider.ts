import * as vscode from "vscode";
import {
  detectClassInfoAtPosition,
} from "../features/createDerivedClass";
import {
  detectInterfacesInDocument,
  detectMethodAtPosition,
  detectPropertyAtPosition,
  ExtractedMember,
  isMemberDeclaredInInterfaces,
} from "../features/interfaceExtraction";
import {
  buildMoveMemberWorkspaceEdit,
  detectMoveToBaseContext,
} from "../features/moveToBase";
import { getDocumentSymbols } from "../utils/symbols";

export class CreateDerivedClassProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): Promise<(vscode.CodeAction | vscode.Command)[]> {
    const pos = range instanceof vscode.Selection ? range.start : range.start;
    const actions: vscode.CodeAction[] = [];

    const symbols = await getDocumentSymbols(document);

    const classInfo = await detectClassInfoAtPosition(document, pos, symbols);
    if (classInfo) {
      const title = `Create derived class '${classInfo.name}Derived'`;
      const action = new vscode.CodeAction(
        title,
        vscode.CodeActionKind.QuickFix
      );
      action.command = {
        command: "extension.createDerivedClass",
        title,
        arguments: [
          { baseName: classInfo.name, typeParameters: classInfo.typeParameters },
        ],
      };
      action.isPreferred = true;
      actions.push(action);
    }

    let memberInfo: ExtractedMember | undefined =
      await detectPropertyAtPosition(document, pos, symbols);
    if (!memberInfo) {
      memberInfo = await detectMethodAtPosition(document, pos, symbols);
    }

    if (memberInfo) {
      const interfaces = await detectInterfacesInDocument(document, symbols);
      if (!isMemberDeclaredInInterfaces(memberInfo, interfaces)) {
        const baseAction = new vscode.CodeAction(
          "Extract to interface...",
          vscode.CodeActionKind.QuickFix
        );
        baseAction.command = {
          command: "extension.addPropertyToInterface",
          title: "Extract to interface",
          arguments: [
            {
              uri: document.uri,
              member: memberInfo,
            },
          ],
        };
        actions.push(baseAction);

        for (const iface of interfaces) {
          const ifaceAction = new vscode.CodeAction(
            `Add to interface ${iface.name}`,
            vscode.CodeActionKind.QuickFix
          );
          ifaceAction.command = {
            command: "extension.addPropertyToInterface",
            title: `Add to interface ${iface.name}`,
            arguments: [
              {
                uri: document.uri,
                member: memberInfo,
                targetInterfaceName: iface.name,
              },
            ],
          };
          actions.push(ifaceAction);
        }
      }
    }

    const moveContext = await detectMoveToBaseContext(document, pos, symbols);
    if (moveContext) {
      const moveTitle = `Move '${moveContext.member.name}' to ${moveContext.baseClassName}`;
      const moveAction = new vscode.CodeAction(
        moveTitle,
        vscode.CodeActionKind.Refactor
      );
      const edit = buildMoveMemberWorkspaceEdit(document, moveContext);
      if (edit) {
        moveAction.edit = edit;
        actions.push(moveAction);
      }
    }

    return actions;
  }
}
