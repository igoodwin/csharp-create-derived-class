import * as vscode from "vscode";
import * as path from "path";

export function activate(context: vscode.ExtensionContext) {
  const provider: vscode.CodeActionProvider = new CreateDerivedClassProvider();

  // register code action provider for C#
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

  // register the command invoked by the code action (and also available directly)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.createDerivedClass",
      async (args) => {
        // args may be provided by the CodeAction or called directly
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage(
            "Open a C# file and place the cursor on a class declaration."
          );
          return;
        }

        const doc = editor.document;
        const position = editor.selection.active;

        // try to detect base name from args or current line
        let baseName: string | undefined;
        if (args && typeof args.baseName === "string") {
          baseName = args.baseName;
        } else {
          baseName = detectClassNameAtPosition(doc, position);
        }

        if (!baseName) {
          vscode.window.showErrorMessage(
            "Could not detect class name at cursor."
          );
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
          // cancelled
          return;
        }

        try {
          await createDerivedClassFile(doc, position, baseName, newName);
          vscode.window.showInformationMessage(
            `Created class ${newName} : ${baseName}`
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            "Failed to create file: " + String(err)
          );
        }
      }
    )
  );
}

export function deactivate() {
  // nothing to clean up
}

class CreateDerivedClassProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    // detect if cursor is on a class declaration
    const pos = range instanceof vscode.Selection ? range.start : range.start;
    const className = detectClassNameAtPosition(document, pos);
    if (!className) {
      return [];
    }

    const title = `Create derived class '${className}Derived'`;
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.command = {
      command: "extension.createDerivedClass",
      title,
      arguments: [{ baseName: className }],
    };
    action.isPreferred = true;
    return [action];
  }
}

/**
 * Try to detect class name if the cursor is on a line like "public class Foo" or "class Foo : Bar"
 */
function detectClassNameAtPosition(
  doc: vscode.TextDocument,
  pos: vscode.Position
): string | undefined {
  const line = doc.lineAt(pos.line).text;
  // regex finds "class <Name>"
  const classRegex = /\bclass\s+([A-Za-z_]\w*)\b/;
  const m = classRegex.exec(line);
  if (m && m[1]) {
    return m[1];
  }

  // if not in the same line, try to inspect word under cursor (fallback)
  const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
  if (wordRange) {
    const word = doc.getText(wordRange);
    // heuristic: check a few previous lines to find "class <word>"
    for (
      let l = Math.max(0, pos.line - 5);
      l <= Math.min(doc.lineCount - 1, pos.line + 5);
      l++
    ) {
      const text = doc.lineAt(l).text;
      const rx = new RegExp(`\\bclass\\s+${word}\\b`);
      if (rx.test(text)) {
        return word;
      }
    }
  }
  return undefined;
}

/**
 * Create the new .cs file in the same folder as the document.
 * Detects namespace if possible.
 */
async function createDerivedClassFile(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  baseName: string,
  newName: string
) {
  const srcUri = doc.uri;
  const folder = path.dirname(srcUri.fsPath);
  const newFilePath = path.join(folder, `${newName}.cs`);
  const newFileUri = vscode.Uri.file(newFilePath);

  // detect namespace in the current document
  const namespace = detectNamespace(doc);

  const nl = getEOL(doc);
  const indent = "    ";

  let content = "";
  if (namespace) {
    content += `namespace ${namespace}${nl}{${nl}`;
    content += `${indent}public class ${newName} : ${baseName}${nl}`;
    content += `${indent}{${nl}${indent}${indent}// TODO: implement${nl}${indent}}${nl}`;
    content += `}${nl}`;
  } else {
    content += `public class ${newName} : ${baseName}${nl}`;
    content += `{${nl}${indent}// TODO: implement${nl}}${nl}`;
  }

  // write the file if not exists; if exists, ask to overwrite
  try {
    // check if file exists
    await vscode.workspace.fs.stat(newFileUri);
    const overwrite = await vscode.window.showQuickPick(
      ["Overwrite", "Cancel"],
      { placeHolder: `${newName}.cs already exists — overwrite?` }
    );
    if (overwrite !== "Overwrite") {
      throw new Error("User cancelled overwrite");
    }
  } catch (err) {
    // stat throws if not exists — that's fine
  }

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(newFileUri, encoder.encode(content));

  // open the new file in editor
  const docNew = await vscode.workspace.openTextDocument(newFileUri);
  const editorNew = await vscode.window.showTextDocument(docNew, {
    preview: false,
  });

  // Найти строку с TODO
  const todoLine = docNew
    .getText()
    .split(/\r?\n/)
    .findIndex((l) => l.includes("// TODO: implement"));

  if (todoLine >= 0) {
    const todoRange = new vscode.Position(
      todoLine,
      docNew.lineAt(todoLine).text.length
    );
    editorNew.selection = new vscode.Selection(todoRange, todoRange);
    editorNew.revealRange(
      new vscode.Range(todoRange, todoRange),
      vscode.TextEditorRevealType.InCenter
    );
  }
}

function detectNamespace(doc: vscode.TextDocument): string | undefined {
  const text = doc.getText();
  const nsRegex = /\bnamespace\s+([A-Za-z_][\w\.]*)\b/;
  const m = nsRegex.exec(text);
  if (m && m[1]) {
    return m[1];
  }
  return undefined;
}

function getEOL(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}
