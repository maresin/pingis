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
    case 'chat_new':
      return r.restore ? 'restore' : 'new chat';
    case 'http':
      return `${r.method ?? '?'} ${r.endpoint ?? '?'} → ${r.status ?? '?'} (${r.duration_ms ?? '?'}ms)`;
    case 'api_spawn':
      return `spawn ${r.agent} on port ${r.port}`;
    case 'api_ready':
      return `${r.agent} ready on ${r.port}`;
    case 'api_exit':
      return `${r.agent} exit code=${r.code} (${r.reason ?? '?'})`;
    case 'api_cleanup': {
      const pids = (r.killed_pids as number[] | undefined) ?? [];
      return `killed ${pids.length} process(es) on port ${r.port}`;
    }
    case 'context': {
      const p = r.percent_used;
      const used = r.chars_used;
      const lim = r.chars_limit;
      const warn = r.warning_present ? ' [WARN]' : '';
      return `${r.agent}: ${p}% (${used}/${lim})${warn}`;
    }
    case 'api_spawn':
      return `spawn ${r.agent} on port ${r.port}`;
    case 'api_ready':
      return `${r.agent} ready on ${r.port}${r.reused ? ' (reused)' : ''}`;
    case 'api_exit':
      return `${r.agent} exited code=${r.code}`;
    default:
      return '';
  }
}