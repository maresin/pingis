import * as path from 'path';
import { Executor } from '../src/executor';
import { Logger } from '../src/log';

const CWD = process.cwd();

const logger = new Logger(CWD);

async function main() {
  const exec = new Executor(CWD, logger, 30_000);

  const script = `
import pathlib
p = pathlib.Path('probe-exec.txt')
p.write_text('hello', encoding='utf-8')
print('Content:', p.read_text(encoding='utf-8'))
print('Size:', p.stat().st_size, 'bytes')
`;

  const result = await exec.run('test-call-id', script);

  console.log('--- result ---');
  console.log('exit_code:', result.exit_code);
  console.log('duration_ms:', result.duration_ms);
  console.log('stdout:', JSON.stringify(result.stdout));
  console.log('stderr:', JSON.stringify(result.stderr));
  console.log('command:', result.command);

  logger.close();
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});

