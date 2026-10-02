import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecResult } from './types';

export interface ToolResultFile {
  path: string;
  cleanup: () => void;
}

export function writeToolResults(results: ExecResult[]): ToolResultFile {
  const dir = path.join(os.tmpdir(), 'pingis');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `tool-result-${Date.now()}.json`);

  const payload = results.map(r => ({
    id: r.call_id,
    exit_code: r.exit_code,
    command: r.command,
    duration_ms: r.duration_ms,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: r.stdout_truncated || r.stderr_truncated
  }));

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

  return {
    path: filePath,
    cleanup: () => {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  };
}
