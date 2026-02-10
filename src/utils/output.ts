import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("C# Create Derived Class");
  }
  return channel;
}

export function log(message: string): void {
  const enabled = vscode.workspace
    .getConfiguration("csharpCreateDerivedClass")
    .get<boolean>("enableLogging", false);
  if (!enabled) {
    return;
  }
  getOutputChannel().appendLine(message);
}
