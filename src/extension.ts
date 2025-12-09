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
          const info = detectClassInfoAtPosition(doc, position);
          if (info) {
            baseName = info.name;
            typeParameters = info.typeParameters;
          }
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
          return;
        }

        try {
          await createDerivedClassFile(
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

interface ClassInfo {
  name: string;
  typeParameters: string[];
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
    const info = detectClassInfoAtPosition(document, pos);
    if (!info) {
      return [];
    }

    const title = `Create derived class '${info.name}Derived'`;
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.command = {
      command: "extension.createDerivedClass",
      title,
      arguments: [{ baseName: info.name, typeParameters: info.typeParameters }],
    };
    action.isPreferred = true;
    return [action];
  }
}

/**
 * Try to detect class name if the cursor is on a line like "public class Foo" or "class Foo : Bar"
 */
function detectClassInfoAtPosition(
  doc: vscode.TextDocument,
  pos: vscode.Position
): ClassInfo | undefined {
  const line = doc.lineAt(pos.line).text;

  // Ищем что-то вроде: class Foo<T, U>
  const classRegex = /\bclass\s+([A-Za-z_]\w*)\s*(<([^>]+)>)?/;
  const m = classRegex.exec(line);
  if (m && m[1]) {
    const name = m[1];
    const typeParameters: string[] = [];

    if (m[3]) {
      // m[3] — содержимое внутри <>
      m[3].split(",").forEach((p) => {
        const trimmed = p.trim();
        if (trimmed.length > 0) {
          // берём идентификатор до возможных where/ограничений (хотя в объявлении класса их обычно нет)
          const idMatch = /^([A-Za-z_]\w*)/.exec(trimmed);
          if (idMatch) {
            typeParameters.push(idMatch[1]);
          }
        }
      });
    }

    return { name, typeParameters };
  }

  // fallback: как раньше, но без параметров
  const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
  if (wordRange) {
    const word = doc.getText(wordRange);
    for (
      let l = Math.max(0, pos.line - 5);
      l <= Math.min(doc.lineCount - 1, pos.line + 5);
      l++
    ) {
      const text = doc.lineAt(l).text;
      const rx = new RegExp(`\\bclass\\s+${word}\\b`);
      if (rx.test(text)) {
        return { name: word, typeParameters: [] };
      }
    }
  }

  return undefined;
}

function findAllIdentifierPositions(
  doc: vscode.TextDocument,
  identifier: string
): vscode.Position[] {
  const text = doc.getText();
  const regex = new RegExp(`\\b${identifier}\\b`, "g");
  const positions: vscode.Position[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const index = match.index;
    const startPos = doc.positionAt(index);
    // ставим курсор в конец идентификатора
    const pos = startPos.translate(0, identifier.length);
    positions.push(pos);
  }
  return positions;
}

/**
 * Create the new .cs file in the same folder as the document.
 * Detects namespace if possible.
 */
async function createDerivedClassFile(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  baseName: string,
  newName: string,
  typeParameters: string[] = []
) {
  const srcUri = doc.uri;
  const folder = path.dirname(srcUri.fsPath);
  const newFilePath = path.join(folder, `${newName}.cs`);
  const newFileUri = vscode.Uri.file(newFilePath);

  // detect namespace in the current document
  const namespace = detectNamespace(doc);
  const nl = getEOL(doc);
  const indent = "    ";

  const genericParamsText =
    typeParameters.length > 0 ? `<${typeParameters.join(", ")}>` : "";

  let content = "";
  if (namespace) {
    content += `namespace ${namespace}${nl}{${nl}`;
    content += `${indent}public class ${newName} : ${baseName}${genericParamsText}${nl}`;
    content += `${indent}{${nl}${indent}${indent}// TODO: implement${nl}${indent}}${nl}`;
    content += `}${nl}`;
  } else {
    content += `public class ${newName} : ${baseName}${genericParamsText}${nl}`;
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

  const selections: vscode.Selection[] = [];

  // 1) если есть generic-параметры — создаём мультикурсор по всем их вхождениям
  if (typeParameters && typeParameters.length > 0) {
    for (const p of typeParameters) {
      const positions = findAllIdentifierPositions(docNew, p);
      for (const pos of positions) {
        selections.push(new vscode.Selection(pos, pos));
      }
    }
  }

  // 2) fallback — если generic нет или вдруг не нашли (на всякий случай) — ставим курсор на TODO
  if (selections.length === 0) {
    const lines = docNew.getText().split(/\r?\n/);
    const todoLineIndex = lines.findIndex((l) =>
      l.includes("// TODO: implement")
    );
    if (todoLineIndex >= 0) {
      const pos = new vscode.Position(
        todoLineIndex,
        docNew.lineAt(todoLineIndex).text.length
      );
      selections.push(new vscode.Selection(pos, pos));
    }
  }

  // применяем выборки
  if (selections.length > 0) {
    editorNew.selections = selections;
    const first = selections[0].start;
    editorNew.revealRange(
      new vscode.Range(first, first),
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
