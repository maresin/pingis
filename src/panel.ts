import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AgentName,
  AgentStatus,
  ExtToWebview,
  FileAttachment,
  StopReason,
  WebviewToExt
} from './types';
import { ApiClient } from './api';
import { AgentsProcess } from './api-process';
import { Executor } from './executor';
import { Logger, LogSink } from './log';
import { PanelLike, Orchestrator } from './orchestrator';
import { buildSystemPrompts } from './prompts';
import { probeResources } from './resources';

const ATTACHMENTS_DIR = '.pingis/attachments';
const MAX_ATTACHMENT_BYTES = 256 * 1024;
const DEFAULT_TASK_WHEN_ATTACHMENTS_ONLY =
  'See the task description in the attached files.';

export class PanelProvider implements vscode.WebviewViewProvider, PanelLike {
  public static readonly viewType = 'pingis.panel';

  private view?: vscode.WebviewView;
  private orchestrator?: Orchestrator;
  private output?: vscode.OutputChannel;
  private log?: Logger;
  private agents?: AgentsProcess;
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri]
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage(
      (msg: WebviewToExt) => this.onMessage(msg),
      null,
      this.disposables
    );

    this.ctx.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.pushWorkspaceStatus())
    );
  }

  // --- PanelLike ---

  setStatus(who: AgentName, status: AgentStatus): void {
    this.post({ type: 'status', who, status });
  }

  bumpTurn(who: AgentName): void {
    this.post({ type: 'turn', who });
  }

  setElapsed(elapsedMs: number, totalMs: number): void {
    this.post({ type: 'elapsed', elapsedMs, totalMs });
  }

  done(reason: StopReason, summary?: string): void {
    this.post({ type: 'done', reason, summary });
    this.orchestrator = undefined;
    this.agents?.stop();
    this.agents = undefined;
  }

  // --- Webview messages ---

  private async onMessage(msg: WebviewToExt): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pushWorkspaceStatus();
        break;
      case 'start':
        await this.onStart(msg.name, msg.description, msg.attachments);
        break;
      case 'stop':
        this.orchestrator?.stop('user_stopped', 'Stopped by user.');
        break;
      case 'pickFile':
        await this.onPickFile();
        break;
      case 'reset':
        this.post({ type: 'showWelcome' });
        break;
    }
  }

  private pushWorkspaceStatus(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.post({
      type: 'workspaceStatus',
      hasWorkspace: !!folder,
      workspacePath: folder?.uri.fsPath
    });
  }

  private async onStart(
    name: string,
    description: string,
    attachments: FileAttachment[]
  ): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.done('no_workspace', 'Open a project folder to start a task.');
      return;
    }

    let task = description.trim();
    if (!task && attachments.length > 0) {
      task = DEFAULT_TASK_WHEN_ATTACHMENTS_ONLY;
    }
    if (!task) {
      this.done('bad_request', 'Describe the task or attach a description file.');
      return;
    }

    // Save attachments to the working directory.
    const attachmentPaths: string[] = [];
    if (attachments.length > 0) {
      const dir = path.join(cwd, ATTACHMENTS_DIR);
      fs.mkdirSync(dir, { recursive: true });

      const used = new Set<string>();
      for (const f of attachments) {
        const base = sanitizeName(f.name) || 'attachment.txt';
        let candidate = base;
        let i = 1;
        while (used.has(candidate) || fs.existsSync(path.join(dir, candidate))) {
          candidate = `${i}_${base}`;
          i++;
        }
        used.add(candidate);
        fs.writeFileSync(path.join(dir, candidate), f.content, 'utf-8');
        attachmentPaths.push(path.join(dir, candidate));
      }

      task += '\n\nAttached files (read them via execute if needed):\n';
      for (const p of attachmentPaths) {
        task += `- ${path.relative(cwd, p)}\n`;
      }
    }

    const cfg = vscode.workspace.getConfiguration('pingis');
    const apiDir         = cfg.get<string>('apiDir') ?? '';
    const timeoutMin     = cfg.get<number>('taskTimeoutMinutes') ?? 120;
    const execTimeoutSec = cfg.get<number>('execTimeoutSeconds') ?? 120;

    if (!apiDir) {
      this.done(
        'bad_request',
        'Set pingis.apiDir in settings — path to your clone of ' +
        'deepseek-automation-api.'
      );
      return;
    }

    this.output = vscode.window.createOutputChannel('Pingis');
    const sink: LogSink = {
      appendLine: (line: string) => {
        if (isApiNoise(line)) return;
        this.output!.appendLine(line);
      }
    };
    this.log = new Logger(cwd, sink);

    // Build (if needed) and start the multi-agent deployment.
    try {
      this.agents = new AgentsProcess(apiDir, this.log);
      await this.agents.ensureRunning();
    } catch (e: any) {
      this.done('server_error', String(e?.message ?? e));
      return;
    }

    // Empirically measured DeepSeek session context limits (chars):
    //   Russian:  ~2_400_000
    //   English:  ~3_000_000
    //   Chinese:  ~1_000_000
    // Both agents share the same budget; we use the smallest (Russian)
    // so prompt wording stays stable across languages.
    const MAX_CONTEXT_CHARS = 2_400_000;

    const apiCfgE = {
      baseUrl: `http://127.0.0.1:${this.agents.executor.port}`,
      apiKey:  this.agents.executor.apiKey,
      maxContextChars: MAX_CONTEXT_CHARS
    };
    const apiCfgC = {
      baseUrl: `http://127.0.0.1:${this.agents.critic.port}`,
      apiKey:  this.agents.critic.apiKey,
      maxContextChars: MAX_CONTEXT_CHARS
    };

    const resources = await probeResources(cwd);

    const prompts = buildSystemPrompts({
      cwd,
      name,
      task,
      diskFree: resources.diskFree,
      ramFree: resources.ramFree,
      contextLimitChars: apiCfgE.maxContextChars
    });

    const apiE = new ApiClient({
      baseUrl: apiCfgE.baseUrl,
      apiKey: apiCfgE.apiKey,
      logger: this.log
    });
    const apiC = new ApiClient({
      baseUrl: apiCfgC.baseUrl,
      apiKey: apiCfgC.apiKey,
      logger: this.log
    });

    const exec = new Executor(cwd, this.log, execTimeoutSec * 1000);

    this.orchestrator = new Orchestrator(apiE, apiC, exec, this, this.log, {
      cwd,
      name,
      task,
      timeoutMs: timeoutMin * 60_000,
      executorPrompt: prompts.executorPrompt,
      criticPrompt: prompts.criticPrompt,
      initialFiles: attachmentPaths.length > 0 ? attachmentPaths : undefined
    });

    this.post({ type: 'showProgress', name });

    this.orchestrator.run().catch((e) => {
      this.log?.event('orchestrator', 'error', {
        stage: 'panel',
        code: 'crash',
        detail: String(e)
      });
      this.done('crash', String(e));
    });
  }

  private async onPickFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: {
        'Text': ['txt', 'md', 'json', 'yaml', 'yml', 'rst', 'log']
      }
    });
    if (!picked || picked.length === 0) return;

    const files: FileAttachment[] = [];
    const skipped: string[] = [];

    for (const file of picked) {
      try {
        const stat = fs.statSync(file.fsPath);
        if (stat.size > MAX_ATTACHMENT_BYTES) {
          skipped.push(`${path.basename(file.fsPath)} (${(stat.size / 1024).toFixed(0)} KB)`);
          continue;
        }
        const content = fs.readFileSync(file.fsPath, 'utf-8');
        files.push({ name: path.basename(file.fsPath), content });
      } catch {
        skipped.push(path.basename(file.fsPath));
      }
    }

    if (skipped.length > 0) {
      vscode.window.showWarningMessage(
        `Attachments are for task descriptions only. ` +
        `Skipped: ${skipped.join(', ')}. ` +
        `Place data files in the project directory and reference the path in the description.`
      );
    }

    if (files.length > 0) {
      this.post({ type: 'filesAttached', files });
    }
  }

  // --- HTML ---

  private post(msg: ExtToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview): string {
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));

    const htmlPath = path.join(this.ctx.extensionPath, 'media', 'panel.html');
    const template = fs.readFileSync(htmlPath, 'utf-8');
    const nonce = makeNonce();

    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{css\}\}/g, media('panel.css').toString())
      .replace(/\{\{js\}\}/g, media('panel.js').toString());
  }

  dispose(): void {
    this.agents?.stop();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Internal API noise that clutters the Output. Show only significant
// milestones: start, register, POST/Response, errors.
const NOISE_PATTERNS: RegExp[] = [
  /📏 Context size/,
  /💾 Chat state saved/,
  /Waiting for response \(assistantKey/,
  /\[iter \d+\] chunk done/,
  /📌 System prompt/,
  /ℹ️ Tools prompt already sent/,
  /📎 Files included/,
  /📌 Chat ID assigned/,
  /🌍 Language mix/,
  /✅ File\(s\) attached/,
  /✅ Task completed:/,
  /▶️ Executing task:/,
  /🔧 Sending tools system prompt/,
  /✅ Tools prompt sent/,
  /✅ Multi-role prompt sent/,
  /💬 Sending multi-role system prompt/,
  /🔄 System prompts reset/,
  /📌 Chat state restored/
];

function isApiNoise(line: string): boolean {
  for (const p of NOISE_PATTERNS) {
    if (p.test(line)) return true;
  }
  return false;
}