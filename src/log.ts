import * as fs from 'fs';
import * as path from 'path';
import { AgentName, LogEvent, LogRecord } from './types';

export interface LogSink {
  appendLine(text: string): void;
}

export class Logger {
  private seq = 0;
  private stream: fs.WriteStream;
  private sink: LogSink | null;

  constructor(cwd: string, sink: LogSink | null = null) {
    const dir = path.join(cwd, '.pingis');
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(dir, 'session.log'), { flags: 'a' });
    this.sink = sink;
  }

  event(who: AgentName | 'orchestrator', event: LogEvent, payload: object = {}): void {
    const record: LogRecord = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      who,
      event,
      ...payload
    };
    this.stream.write(JSON.stringify(record) + '\n');
    this.sink?.appendLine(`[${who}] ${event} ${shortSummary(record)}`);
  }

  raw(text: string): void {
    this.sink?.appendLine(text);
  }

  close(): void {
    this.stream.end();
  }
}

function shortSummary(r: LogRecord): string {
  switch (r.event) {
    case 'task_start':
      return `name="${r.name}"`;
    case 'system_prompt':
      return `${String(r.text ?? '').length} chars`;
    case 'request':
      return `${r.is_first ? 'first' : 'follow'} files=${r.files ?? 0}`;
    case 'response': {
      const calls = (r.tool_calls as any[] | undefined) ?? [];
      return calls.map(c => c?.name).join(',');
    }
    case 'exec':
      return `exit=${r.exit_code} ${r.duration_ms}ms`;
    case 'route': {
      if (r.kind === 'tool_results') {
        return `${r.from} → ${r.to}: tool_results(${r.count})`;
      }
      return `${r.from} → ${r.to}: ${String(r.message ?? '').slice(0, 60)}`;
    }
    case 'retry':
      return `${r.agent} HTTP ${r.http_status} left=${r.retries_left}`;
    case 'error':
      return `${r.stage}/${r.code}: ${String(r.detail ?? '').slice(0, 80)}`;
    case 'stop':
      return `reason=${r.reason}`;
    // Emitted by ApiClient.newChat when the orchestrator resets the
    // server-side chat at the start of a fresh task.
    case 'chat_new':
      return r.restore ? 'restore' : 'new chat';
    case 'api_spawn':
      if (r.reason === 'build_deployment') {
        return `build deployment at ${r.target ?? r.script ?? '?'}`;
      }
      return `start agents at ${r.agents_dir ?? '?'}`;
    case 'api_ready':
      return `agents ready at ${r.agents_dir ?? '?'}${r.reused ? ' (reused)' : ''}`;
    case 'api_exit':
      return `agents stopped (${r.reason ?? '?'})`;
    case 'help': {
      const phase = String(r.phase ?? r.kind ?? '?');
      const extra = r.enriched ? ' (enriched)' : '';
      const initiator = r.initiator ? ` [${r.initiator}]` : '';
      return `${phase} ${r.from} → ${r.to}${extra}${initiator}`;
    }
    case 'artifact': {
      const action = String(r.action ?? '?');
      const kind = String(r.kind ?? '?');
      const filePath = r.path ? path.basename(String(r.path)) : '';
      if (action === 'fallback' || action === 'write' || action === 'delete') {
        return `${action} ${kind}: ${filePath}`;
      }
      return `${action} ${kind}${r.reason ? ': ' + r.reason : ''}`;
    }
    case 'agent_phase':
      return `${r.from} → ${r.to}${r.reason ? ` (${r.reason})` : ''}`;
    case 'checkpoint_nudge':
      return `${r.streak} executes without check-in`;
    case 'context_transition':
      return `${r.who}: ${r.from_percent}% → ${r.to_percent}% ` +
             `(chat switched)`;
    case 'context': {
      const p = r.percent_used;
      const used = r.chars_used;
      const lim = r.chars_limit;
      const warn = r.warning_present ? ' [WARN]' : '';
      return `${r.agent}: ${p}% (${used}/${lim})${warn}`;
    }
    default:
      return '';
  }
}