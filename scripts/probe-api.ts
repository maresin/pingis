import * as fs from 'fs';
import * as path from 'path';
import { ApiClient, AgentSession } from '../src/api';
import { buildSystemPrompts } from '../src/prompts';
import { loadApiConfig } from '../src/config';
import { writeToolResults } from '../src/format';
import { AgentName, ExecResult } from '../src/types';

const API_DIR = process.env.DS_API_DIR ?? process.argv[2] ?? '';

const cfg = loadApiConfig(
  API_DIR,
  'http://127.0.0.1:3000',
  ''
);

console.log(`[config] source=${cfg.source} baseUrl=${cfg.baseUrl} key=${cfg.apiKey.slice(0, 16)}...`);

if (!cfg.apiKey) {
  console.error('No API key. Pass the API dir as an argument or via DS_API_DIR.');
  process.exit(1);
}

const RAW_DIR = path.resolve(__dirname, '..', '.pingis', 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const logger = {
  event(who: string, event: string, payload: object = {}) {
    console.log(`[${who}] ${event} ${JSON.stringify(payload)}`);
  }
};

async function main() {
  const prompts = buildSystemPrompts({
    cwd: process.cwd(),
    name: 'probe',
    task: 'Create a file hello.txt with the text "hello".',
    diskFree: '10 GB',
    ramFree: '4 GB'
  });

  const client = new ApiClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    logger,
    onRawResponse: (who: AgentName, json: unknown) => {
      const f = path.join(RAW_DIR, `${who}-${Date.now()}.json`);
      fs.writeFileSync(f, JSON.stringify(json, null, 2));
    }
  });

  const session = new AgentSession('executor', prompts.executorPrompt);

  console.log('--- request 1 ---');
  const r1 = await client.chat(session, {
    role: 'user',
    content: 'Start the task.'
  });
  console.log('text_len:', r1.text.length);
  console.log('tool_calls:', JSON.stringify(r1.tool_calls, null, 2));
  console.log('session_id:', session.chatSessionId);

  if (r1.tool_calls.length === 0) {
    console.log('!!! tool_calls is empty — check the API format');
    process.exit(2);
  }

  console.log('--- request 2 (with attached file) ---');

  const firstCall = r1.tool_calls[0];
  const fakeResult: ExecResult = {
    call_id: firstCall.id,
    command: 'uv run python .pingis/patch.py',
    exit_code: 0,
    duration_ms: 120,
    stdout: 'hello.txt created\n',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false
  };

  const resultFile = writeToolResults([fakeResult]);
  console.log('result file:', resultFile.path);

  try {
    const r2 = await client.chat(
      session,
      {
        role: 'user',
        content: 'Result of the previous tool call is attached.'
      },
      { files: [resultFile.path] }
    );
    console.log('text_len:', r2.text.length);
    console.log('tool_calls:', JSON.stringify(r2.tool_calls, null, 2));
    console.log('session_id:', session.chatSessionId);
  } finally {
    resultFile.cleanup();
  }
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
