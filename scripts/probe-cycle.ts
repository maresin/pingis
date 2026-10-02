import { ApiClient } from '../src/api';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';
import { buildSystemPrompts } from '../src/prompts';
import { loadApiConfig } from '../src/config';
import { NullPanel, Orchestrator } from '../src/orchestrator';

const API_DIR = process.env.DS_API_DIR ?? process.argv[2] ?? '';
const TASK = process.env.DS_TASK
  ?? 'Create a file hello.txt with the text "hello". Then write a script hello.py that reads this file and prints its content. Verify the script works.';

const cfgE = loadApiConfig(API_DIR, 'http://127.0.0.1:3000', '', 'executor');
const cfgC = loadApiConfig(API_DIR, 'http://127.0.0.1:3001', '', 'critic');

if (!cfgE.apiKey || !cfgC.apiKey) {
  console.error('No API keys in ~/.pingis/*/.api-key. Start both APIs first.');
  process.exit(1);
}

const CWD = process.cwd();
const log = new Logger(CWD, { appendLine: (s) => console.log(s) });

const prompts = buildSystemPrompts({
  cwd: CWD,
  name: 'probe-cycle',
  task: TASK,
  diskFree: '10 GB',
  ramFree: '4 GB',
  contextLimitChars: cfgE.maxContextChars
});

const apiE = new ApiClient({ baseUrl: cfgE.baseUrl, apiKey: cfgE.apiKey, logger: log });
const apiC = new ApiClient({ baseUrl: cfgC.baseUrl, apiKey: cfgC.apiKey, logger: log });

const exec = new Executor(CWD, log, 120_000);

const orch = new Orchestrator(apiE, apiC, exec, new NullPanel(), log, {
  cwd: CWD,
  name: 'probe-cycle',
  task: TASK,
  timeoutMs: 10 * 60_000,
  executorPrompt: prompts.executorPrompt,
  criticPrompt: prompts.criticPrompt
});

orch.run()
  .then(() => { console.log('--- done ---'); log.close(); })
  .catch(e => { console.error('FAILED:', e); process.exit(1); });
