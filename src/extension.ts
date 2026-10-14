import * as vscode from 'vscode';
import { PanelProvider } from './panel';

export function activate(ctx: vscode.ExtensionContext) {
  const provider = new PanelProvider(ctx);
  // PanelProvider is a Disposable: on window close, dispose() runs.
  // dispose() calls AgentsProcess.stop(), which stops the agents only
  // if this session started them (startedByUs). Reused agents keep running.
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
