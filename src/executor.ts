import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ExecResult } from './types';
import { Logger } from './log';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 64 * 1024; // 64 KB per stream

export interface ExecOptions {
  timeoutMs?: number;
}

export class Executor {
  constructor(
    private cwd: string,
    private log: Logger,
    private defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  async run(
    call_id: string,
    script: string,
    command?: string,
    opts: ExecOptions = {}
  ): Promise<ExecResult> {
    const dir = path.join(this.cwd, '.pingis');
    fs.mkdirSync(dir, { recursive: true });

    const scriptPath = path.join(dir, 'patch.py');
    fs.writeFileSync(scriptPath, script, 'utf-8');

    const rawCmd = command ?? `uv run python "${scriptPath}"`;
    const cmd = normalizeCommand(rawCmd, scriptPath);
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const start = Date.now();

    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd, {
        cwd: this.cwd,
        shell: true,
        detached: true,
        windowsHide: true,
        env: process.env
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        killProcessTree(child);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length <= MAX_STREAM_BYTES) {
          stdout += chunk.toString('utf-8');
        } else if (!stdoutTruncated) {
          const room = Math.max(0, MAX_STREAM_BYTES - stdout.length);
          stdout += chunk.toString('utf-8', 0, room);
          stdout += '\n...[truncated]\n';
          stdoutTruncated = true;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length + chunk.length <= MAX_STREAM_BYTES) {
          stderr += chunk.toString('utf-8');
        } else if (!stderrTruncated) {
          const room = Math.max(0, MAX_STREAM_BYTES - stderr.length);
          stderr += chunk.toString('utf-8', 0, room);
          stderr += '\n...[truncated]\n';
          stderrTruncated = true;
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          call_id,
          command: cmd,
          exit_code: null,
          duration_ms: Date.now() - start,
          stdout,
          stderr: `${stderr}\nspawn error: ${err.message}`,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const duration_ms = Date.now() - start;
        const exitCode = killed ? null : code;

        this.log.event('orchestrator', 'exec', {
          call_id,
          command: cmd,
          exit_code: exitCode,
          duration_ms,
          stdout_len: stdout.length,
          stderr_len: stderr.length,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated
        });

        resolve({
          call_id,
          command: cmd,
          exit_code: exitCode,
          duration_ms,
          stdout,
          stderr,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated
        });
      });
    });
  }
}


const KNOWN_INTERPRETERS = new Set([
  // Python
  'python', 'python3', 'python3.10', 'python3.11', 'python3.12', 'python3.13',
  'pypy', 'pypy3',
  // Node
  'node', 'nodejs', 'deno', 'bun',
  // Shells
  'bash', 'sh', 'zsh', 'fish', 'dash',
  // Ruby / Perl / PHP (for non-standard tasks)
  'ruby', 'perl', 'php'
]);

/**
 * If command is a bare interpreter name (python3, node, bash),
 * we append the path to patch.py. Otherwise return as is.
 *
 * Example: command="python3"  ->  "python3 /path/to/patch.py"
 *         command="uv run python patch.py"  ->  unchanged
 */
function normalizeCommand(command: string, scriptPath: string): string {
  const trimmed = command.trim();
  if (KNOWN_INTERPRETERS.has(trimmed)) {
    return `${trimmed} "${scriptPath}"`;
  }
  return command;
}

/**
 * Kill the entire process tree starting from child.pid.
 * On Windows - taskkill /F /T. On Unix - kill(-pid, SIGKILL).
 */
function killProcessTree(child: import('child_process').ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    return;
  }

  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /F /T /PID ${pid}`, {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    return;
  }

  // Unix: SIGKILL the entire group (spawn was called with detached: true)
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}
