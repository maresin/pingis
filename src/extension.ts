import * as vscode from 'vscode';
import { PanelProvider } from './panel';

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new PanelProvider(ctx);
  // Register PanelProvider as Disposable so that closing the window stops API processes.
  ctx.subscriptions.push(provider);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PanelProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('pingis.start', () => {
      vscode.commands.executeCommand('pingis.panel.focus');
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('pingis.showLogs', () => {
      // The log channel is created by PanelProvider when a task starts.
      // If no task has run yet, just open an empty channel.
      const ch = vscode.window.createOutputChannel('Pingis');
      ch.show();
    })
  );
}

export function deactivate() {}
