import {
  AgentName,
  AgentStatus,
  ChatMessage,
  ContextStatus,
  ExecResult,
  StopError,
  StopReason,
  ToolCall
} from './types';
import { ApiClient, AgentSession } from './api';
import { Executor } from './executor';
import { Logger } from './log';
import { writeToolResults } from './format';

export interface PanelLike {
  setStatus(who: AgentName, status: AgentStatus): void;
  bumpTurn(who: AgentName): void;
  setElapsed(elapsedMs: number, totalMs: number): void;
  done(reason: StopReason, summary?: string): void;
}

export class NullPanel implements PanelLike {
  setStatus(): void {}
  bumpTurn(): void {}
  setElapsed(): void {}
  done(): void {}
}

interface QueuedItem {
  msg: ChatMessage;
  files?: string[];
}

export interface OrchestratorOptions {
  cwd: string;
  name: string;
  task: string;
  timeoutMs: number;
  executorPrompt: string;
  criticPrompt: string;
  initialFiles?: string[];
}

export class Orchestrator {
  private queueE: QueuedItem[] = [];
  private queueC: QueuedItem[] = [];

  private stopped = false;
  private stopReason: StopReason | null = null;
  private stopSummary?: string;

  private turnE = 0;
  private turnC = 0;

  // How many times in a row the agent returned a response without tool_calls.
  // Reset on the first successful step.
  private protocolRetryE = 0;
  private protocolRetryC = 0;

  // Last context_status from each agent (percent_used, etc.).
  private lastStatusE: ContextStatus | null = null;
  private lastStatusC: ContextStatus | null = null;

  // Dead sessions: the agent hit 409 context_exhausted.
  private deadE = false;
  private deadC = false;

  // How many times Critic tried to message a dead Executor.
  // Limit to 3 attempts, then force stop.
  private criticFinalizeAttempts = 0;

  // Sessions are class fields so step() can handle 409 itself.
  private sessionE: AgentSession | null = null;
  private sessionC: AgentSession | null = null;

  // Cleanup functions for temporary tool-result files.
  // Called in the finally block of run().
  private toolResultCleanups: Array<() => void> = [];

  private tick?: NodeJS.Timeout;

  constructor(
    private apiE: ApiClient,
    private apiC: ApiClient,
    private exec: Executor,
    private panel: PanelLike,
    private log: Logger,
    private opts: OrchestratorOptions
  ) {}

  async run(): Promise<void> {
    this.sessionE = new AgentSession('executor', this.opts.executorPrompt);
    this.sessionC = new AgentSession('critic', this.opts.criticPrompt);
    const sessionE = this.sessionE;
    const sessionC = this.sessionC;

    const start = Date.now();

    this.log.event('orchestrator', 'task_start', {
      name: this.opts.name,
      task: this.opts.task,
      cwd: this.opts.cwd,
      timeout_ms: this.opts.timeoutMs,
      attachments: this.opts.initialFiles?.length ?? 0
    });
    this.log.event('executor', 'system_prompt', { text: this.opts.executorPrompt });
    this.log.event('critic', 'system_prompt', { text: this.opts.criticPrompt });

    this.queueE.push({
      msg: { role: 'user', content: 'Start the task.' },
      files: this.opts.initialFiles
    });

    this.tick = setInterval(() => {
      this.panel.setElapsed(Date.now() - start, this.opts.timeoutMs);
    }, 1000);

    try {
      while (!this.stopped) {
        if (Date.now() - start > this.opts.timeoutMs) {
          this.stop('timeout', 'Task timeout exceeded.');
          break;
        }

        const hasE = this.queueE.length > 0 && !this.deadE;
        const hasC = this.queueC.length > 0 && !this.deadC;

        if (hasE) {
          await this.step('executor', sessionE);
        } else if (hasC) {
          await this.step('critic', sessionC);
        } else if (this.deadE && !this.deadC) {
          // Executor exhausted context, the Critic queue is empty,
          // and Critic did not finish the task.
          this.stop(
            'context_exhausted',
            'Executor exhausted context. Critic failed to finalize.'
          );
          break;
        } else if (this.deadC) {
          this.stop('context_exhausted', 'Critic exhausted context.');
          break;
        } else {
          this.stop('deadlock', 'Both queues are empty.');
          break;
        }
      }
    } catch (e) {
      // 409 context_exhausted is now handled inside step();
      // this branch is never reached.
      if (e instanceof StopError) {
        this.log.event('orchestrator', 'error', {
          stage: 'loop',
          code: e.reason,
          detail: e.detail
        });
        this.stop(e.reason, e.detail);
      } else {
        this.log.event('orchestrator', 'error', {
          stage: 'loop',
          code: 'crash',
          detail: String(e)
        });
        this.stop('crash', String(e));
      }
    } finally {
      // Clean up temporary tool-result files.
      for (const fn of this.toolResultCleanups) {
        try { fn(); } catch { /* ignore */ }
      }
      this.toolResultCleanups = [];

      if (this.tick) clearInterval(this.tick);
      this.panel.done(this.stopReason ?? 'crash', this.stopSummary);
      this.log.event('orchestrator', 'stop', {
        reason: this.stopReason ?? 'crash',
        summary: this.stopSummary,
        turns: { executor: this.turnE, critic: this.turnC },
        duration_ms: Date.now() - start
      });
    }
  }

  stop(reason: StopReason, summary?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.stopSummary = summary;
  }

  private async step(who: AgentName, session: AgentSession): Promise<void> {
    const queue = who === 'executor' ? this.queueE : this.queueC;
    const item = queue.shift()!;

    this.panel.setStatus(who, 'thinking');

    this.log.event(who, 'request', {
      is_first: session.isFirstCall,
      files: item.files?.length ?? 0
    });

    const api = who === 'executor' ? this.apiE : this.apiC;

    let resp;
    try {
      resp = await api.chat(session, item.msg, { files: item.files });
    } catch (e) {
      if (e instanceof StopError && e.reason === 'context_exhausted') {
        await this.handleAgentContextExhausted(who);
        return;
      }
      throw e;
    }

    this.panel.bumpTurn(who);
    if (who === 'executor') this.turnE++; else this.turnC++;

    this.log.event(who, 'response', {
      text_len: resp.text.length,
      tool_calls: resp.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.name,
        args_keys: Object.keys((tc as any).args ?? {})
      }))
    });

    // Context tracking: use context_status from the API.
    if (resp.context_status) {
      const cs = resp.context_status;
      if (who === 'executor') this.lastStatusE = cs;
      else this.lastStatusC = cs;

      this.log.event(who, 'context', {
        agent: who,
        percent_used: cs.percent_used,
        chars_used: cs.chars_used,
        chars_limit: cs.chars_limit,
        language_coefficient: cs.language_coefficient,
        warning_present: cs.warning !== null || cs.recommendation !== null,
        warning: cs.warning,
        recommendation: cs.recommendation,
        deepseek_length_detected: cs.deepseek_length_limit?.detected ?? false
      });
    }

    if (resp.usage) {
      this.log.event(who, 'response', {
        usage: resp.usage
      });
    }

    if (resp.tool_calls.length === 0) {
      // Salvage attempt: DeepSeek Web sometimes returns tool_calls as text.
      const salvaged = trySalvageTextualToolCalls(resp.text);
      if (salvaged && salvaged.length > 0) {
        this.log.event(who, 'response', {
          salvaged: true,
          count: salvaged.length,
          names: salvaged.map(tc => tc.name)
        });
        resp.tool_calls = salvaged;
      } else {
        // Salvage failed. DeepSeek Web sometimes returns garbage
        // (a mix of JSON + DSML tags). Retry the same request up to 2 times,
        // adding a service message with an explicit format hint.
        const retries = who === 'executor'
          ? this.protocolRetryE
          : this.protocolRetryC;

        if (retries < 2) {
          if (who === 'executor') this.protocolRetryE++;
          else this.protocolRetryC++;

          this.log.event(who, 'error', {
            stage: 'protocol',
            code: 'no_tool_calls',
            retry: retries + 1,
            max_retries: 2,
            text: resp.text.slice(0, 2000)
          });

          // Return the original item to the queue + a service message.
          queue.unshift(item);
          queue.splice(1, 0, {
            msg: {
              role: 'user',
              content:
                'Your previous response was not recognized as tool_calls. ' +
                'Reply ONLY via tool_calls using the tools ' +
                'execute / send_message. Do not write text responses.'
            }
          });
          this.panel.setStatus(who, 'idle');
          return;
        }

        // Retries exhausted — give up.
        this.log.event(who, 'error', {
          stage: 'protocol',
          code: 'no_tool_calls',
          retry_exhausted: true,
          text: resp.text.slice(0, 2000)
        });
        this.stop(
          'protocol_violation',
          'Response without tool_calls after 3 attempts.'
        );
        return;
      }
    }

    const execResults: ExecResult[] = [];

    for (const tc of resp.tool_calls) {
      const cont = await this.handleToolCall(who, session, tc, execResults);
      if (!cont) {
        this.panel.setStatus(who, 'idle');
        return;
      }
    }

    if (execResults.length > 0) {
      const rf = writeToolResults(execResults);
      this.toolResultCleanups.push(rf.cleanup);
      this.log.event('orchestrator', 'route', {
        from: 'orchestrator',
        to: who,
        kind: 'tool_results',
        count: execResults.length,
        file: rf.path
      });
      const contextPrefix = this.buildContextHint(who);

      queue.push({
        msg: {
          role: 'user',
          content: contextPrefix +
            'Result of the previous tool call is attached.'
        },
        files: [rf.path]
      });
    }

    // Successful step — reset this agent's retry counter.
    if (who === 'executor') this.protocolRetryE = 0;
    else this.protocolRetryC = 0;

    this.panel.setStatus(who, 'idle');
  }

  private async handleAgentContextExhausted(who: AgentName): Promise<void> {
    if (who === 'executor') {
      this.deadE = true;
      this.log.event('orchestrator', 'error', {
        stage: 'context',
        code: 'executor_exhausted',
        detail: 'Executor exhausted context. Asking Critic to finalize.'
      });

      if (this.deadC) {
        this.stop('context_exhausted', 'Both agents exhausted context.');
        return;
      }

      this.queueC.push({
        msg: {
          role: 'user',
          content:
            'CONTEXT_LIMIT: The Executor has exhausted context and can no longer ' +
            'respond. Read .pingis/plan.md (if present) and key ' +
            'files, assess progress. Call finalize with an honest summary: what ' +
            'is done, what is not, and what the user should do on restart.'
        }
      });
    } else {
      this.deadC = true;
      this.stop('context_exhausted', 'Critic exhausted context. Task stopped.');
    }
  }

  private buildContextHint(who: AgentName): string {
    const cs = who === 'executor' ? this.lastStatusE : this.lastStatusC;
    if (!cs) return '';

    const parts: string[] = [];

    // First — the API's built-in signals (most accurate).
    if (cs.warning) {
      parts.push(`[CONTEXT WARNING] ${cs.warning}`);
    }
    if (cs.recommendation) {
      parts.push(`[CONTEXT RECOMMENDATION] ${cs.recommendation}`);
    }

    // Fallback thresholds in case the API is silent.
    if (cs.percent_used >= 92) {
      parts.push(
        `[CONTEXT CRITICAL] Context at ${cs.percent_used}%. ` +
        'Save progress to .pingis/plan.md and send ' +
        'CONTEXT_LIMIT to Critic, then stop.'
      );
    } else if (cs.percent_used >= 85 && !cs.warning) {
      parts.push(
        `[CONTEXT WARNING] Context at ${cs.percent_used}%. ` +
        'Keep responses concise, avoid re-reading files.'
      );
    }

    if (cs.deepseek_length_limit?.detected) {
      parts.push(
        '[CONTEXT WARNING] DeepSeek has truncated a long message. ' +
        'Split future large responses.'
      );
    }

    if (parts.length === 0) return '';
    return parts.join('\n') + '\n\n';
  }

  private async handleToolCall(
    who: AgentName,
    session: AgentSession,
    tc: ToolCall,
    execResults: ExecResult[]
  ): Promise<boolean> {
    if (tc.name === 'execute') {
      const script = (tc.args as any)?.script;
      const command = (tc.args as any)?.command;
      if (typeof script !== 'string' || script.length === 0) {
        this.stop('malformed_tool_call', 'execute without script');
        return false;
      }
      this.panel.setStatus(who, 'execute');
      const result = await this.exec.run(tc.id, script, command);
      execResults.push(result);
      return true;
    }

    if (tc.name === 'send_message') {
      const to = (tc.args as any)?.to;
      const message = (tc.args as any)?.message;
      if (to !== 'executor' && to !== 'critic') {
        this.stop('malformed_tool_call', 'send_message: invalid to');
        return false;
      }
      if (typeof message !== 'string' || message.length === 0) {
        this.stop('malformed_tool_call', 'send_message without message');
        return false;
      }
      if (to === who) {
        this.stop('malformed_tool_call', 'send_message to self');
        return false;
      }

      // Special case: Executor is dead (409) and Critic is trying to reply.
      // Do not forward — ask Critic to finalize the task.
      if (to === 'executor' && this.deadE) {
        this.criticFinalizeAttempts++;
        if (this.criticFinalizeAttempts > 3) {
          this.stop(
            'deadlock',
            'Critic did not finalize after 3 reminders.'
          );
          return false;
        }
        this.queueC.push({
          msg: {
            role: 'user',
            content:
              'Executor is unavailable (context exhausted). ' +
              'Call finalize right now with the current summary.'
          }
        });
        this.log.event('orchestrator', 'route', {
          from: 'orchestrator',
          to: 'critic',
          message: '[executor dead — asking critic to finalize]'
        });
        return true;
      }
      this.panel.setStatus(who, 'send_message');
      const target = to === 'critic' ? this.queueC : this.queueE;
      target.push({ msg: { role: 'user', content: message } });
      this.log.event('orchestrator', 'route', {
        from: who,
        to,
        message
      });
      return true;
    }

    if (tc.name === 'finalize') {
      if (who !== 'critic') {
        this.stop('unknown_tool', 'finalize from executor');
        return false;
      }
      const comment = (tc.args as any)?.comment ?? '';
      this.panel.setStatus(who, 'finalize');
      this.stop('done', String(comment));
      return false;
    }

    this.stop('unknown_tool', `unknown tool: ${(tc as any).name}`);
    return false;
  }
}


/**
 * DeepSeek Web sometimes returns tool_calls outside the structured field,
 * as text inside content: {"tool_calls": [{"name": "...", "arguments": {...}}]}
 * We recognize this format and reconstruct normal ToolCall objects.
 */
function trySalvageTextualToolCalls(text: string): ToolCall[] | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{')) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const list = parsed?.tool_calls;
  if (!Array.isArray(list) || list.length === 0) return null;

  const out: ToolCall[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const name = item?.name;
    const args = item?.arguments;
    if (typeof name !== 'string') continue;
    if (!args || typeof args !== 'object') continue;
    if (name !== 'execute' && name !== 'send_message' && name !== 'finalize') continue;
    out.push({
      id: `salvaged_${Date.now()}_${i}`,
      name,
      args
    } as ToolCall);
  }

  return out.length > 0 ? out : null;
}
