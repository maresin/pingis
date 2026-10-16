import {
  AgentName,
  AgentPhase,
  AgentStatus,
  ChatMessage,
  ContextStatus,
  ExecResult,
  OrchestratorResult,
  StopError,
  StopReason,
  ToolCall
} from './types';
import { ApiClient, AgentSession } from './api';
import { Executor } from './executor';
import { Logger } from './log';
import { writeToolResults } from './format';
import * as fs from 'fs';
import * as path from 'path';

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
  /**
   * Absolute wall-clock deadline for the whole task, in milliseconds
   * since the epoch. Not a per-attempt duration: retries share the
   * same deadline, so a retry cannot extend the total budget.
   *
   * The orchestrator treats this as the soft deadline (graceful
   * shutdown) and adds GRACE_MS on top for the hard stop.
   */
  deadlineAt: number;
  executorPrompt: string;
  criticPrompt: string;
  initialFiles?: string[];
  /**
   * Absolute paths to the per-agent state dirs under
   * ~/.pingis/deepseek-agents/agents/agent-N/. When provided, the
   * orchestrator writes and checks a `.last-project` marker so that a
   * chat belonging to one project is not silently reused by another.
   *
   * Optional: probe scripts leave it unset and keep the previous
   * behaviour (plan.md alone decides).
   */
  agentDirs?: { executor: string; critic: string };
}

/**
 * Maximum number of "please call finalize" reminders the orchestrator
 * sends to the Critic after the Executor has died (409
 * context_exhausted).
 *
 * This is the only bounded counter in the orchestrator, and it is not
 * a contradiction of the HELP protocol's "no iteration counters"
 * principle. The difference is what the counter guards:
 *
 *   - HELP loop: agents search for a solution. That is a creative
 *     process, unbounded by design — the only budget is time. A
 *     numeric cap there would abort work that is still moving forward.
 *
 *   - This counter: the Executor is already dead and the task cannot
 *     continue. The Critic is being asked to execute one mechanical
 *     step — call the finalize tool. Three reminders are enough to
 *     distinguish "still thinking" from "ignoring the instruction";
 *     after that, stopping with an honest error is better than
 *     looping until the timeout.
 */
const MAX_FINALIZE_REMINDERS = 3;

/**
 * Maximum number of full format-HELP rounds (L1a → L1b → L3) per agent
 * before the task stops with 'protocol_violation'.
 *
 * Rationale: without a bound, the format-HELP loop can run until the
 * task deadline without ever producing a valid tool_calls. Five rounds
 * give the agent up to 15 nudges (3 per round), which is enough to
 * distinguish "stuck on a specific format problem" from "cannot
 * produce valid output". After that, the honest outcome is a terminal
 * failure — no more auto-help.
 *
 * Malformed-tool-call HELP uses a separate counter (malformedRetryE)
 * and is not merged into this limit.
 */
const MAX_FORMAT_ROUNDS = 5;

/**
 * Extra time granted after the soft deadline so a graceful shutdown
 * (Critic finalizing, plan.md / summary.md written) can complete.
 * Added once, to the absolute deadline, not once per attempt.
 */
const GRACE_MS = 120_000;

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

  // Full format-HELP rounds per agent. One round = L1a → L1b → L3.
  // Incremented when L3 fires; checked before starting a new L1a.
  // Reset on the first successful step.
  private formatRoundsE = 0;
  private formatRoundsC = 0;

  // Last context_status from each agent (percent_used, etc.).
  private lastStatusE: ContextStatus | null = null;
  private lastStatusC: ContextStatus | null = null;

  // Dead sessions: the agent hit 409 context_exhausted.
  private deadE = false;
  private deadC = false;

  // How many times the orchestrator has asked the Critic to finalize
  // while the Executor was dead (409 context_exhausted). Bounded by
  // MAX_FINALIZE_REMINDERS — see its comment for why this is the one
  // place where a numeric counter is correct in this file.
  private criticFinalizeReminders = 0;

  // When true, a stop('done') is treated as a graceful shutdown:
  // plan.md is preserved so the task can be resumed later. Set when
  // the orchestrator hands off to the Critic via CONTEXT_LIMIT: or
  // TIME_LIMIT:.
  private pendingGracefulShutdown = false;

  // Last broken (unparsed) response per agent. Cleared after a
  // successful tool_calls. Used for:
  //   - L1b: preview of the agent's own broken output during retry
  //   - L2:  enriching an agent-sent HELP with technical context
  private brokenBuffer: Map<AgentName, string> = new Map();

  // HELP / HELP_RESPONSE exchanges between Executor and Critic.
  // Observability only; no hard limit. The task timeout is the
  // ultimate bound.
  private helpCycles = 0;

  // How many times in a row the agent sent a malformed tool call
  // (missing required argument, invalid addressee, self-message).
  // Reset on the first well-formed step.
  private malformedRetryE = 0;
  private malformedRetryC = 0;

  // Coarse per-agent state. Observability only at this step — no
  // decision in the orchestrator reads these fields yet. See AgentPhase
  // in types.ts for the phase semantics.
  private phaseE: AgentPhase = 'idle';
  private phaseC: AgentPhase = 'idle';

  // The request content the agent was working from at the start of
  // its current step. Preserved across a HELP round so that, when
  // HELP_RESPONSE arrives, the orchestrator can restore the original
  // framing of the task instead of layering more meta-discussion on
  // top (step 51b).
  private originalE = '';
  private originalC = '';

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

  async run(): Promise<OrchestratorResult> {
    this.sessionE = new AgentSession('executor', this.opts.executorPrompt);
    this.sessionC = new AgentSession('critic', this.opts.criticPrompt);
    const sessionE = this.sessionE;
    const sessionC = this.sessionC;

    const start = Date.now();

    this.log.event('orchestrator', 'task_start', {
      name: this.opts.name,
      task: this.opts.task,
      cwd: this.opts.cwd,
      deadline_at: this.opts.deadlineAt,
      attachments: this.opts.initialFiles?.length ?? 0
    });
    this.log.event('executor', 'system_prompt', { text: this.opts.executorPrompt });
    this.log.event('critic', 'system_prompt', { text: this.opts.criticPrompt });

    // Artifact-based continuation decision.
    //   plan.md present AND marker matches -> resume: leave chats as-is.
    //   Otherwise -> new task: reset both chats.
    //
    // The `.last-project` marker in each agent's state dir records
    // which project the current chat belongs to. Without it, a plan.md
    // left over from one project could cause another project's task to
    // reuse the same chat.
    const planPath = path.join(this.opts.cwd, '.pingis', 'plan.md');
    const hasPlan = fs.existsSync(planPath);

    // Default to true when agentDirs are not provided (probe tests,
    // legacy callers) — keeps the previous behaviour.
    let projectMatches = true;
    if (this.opts.agentDirs) {
      projectMatches = false;
      try {
        const markerE = path.join(this.opts.agentDirs.executor, '.last-project');
        const markerC = path.join(this.opts.agentDirs.critic, '.last-project');
        const eVal = fs.readFileSync(markerE, 'utf-8').trim();
        const cVal = fs.readFileSync(markerC, 'utf-8').trim();
        projectMatches = (eVal === this.opts.cwd && cVal === this.opts.cwd);
      } catch { /* markers missing or unreadable */ }
    }

    if (!hasPlan || !projectMatches) {
      try {
        await this.apiE.newChat(sessionE, false);
        await this.apiC.newChat(sessionC, false);
        this.log.event('orchestrator', 'artifact', {
          action: 'reset',
          kind: 'chats',
          reason: !hasPlan ? 'no plan.md' : 'project marker mismatch'
        });

        if (this.opts.agentDirs) {
          try {
            const markerE = path.join(this.opts.agentDirs.executor, '.last-project');
            const markerC = path.join(this.opts.agentDirs.critic, '.last-project');
            fs.mkdirSync(this.opts.agentDirs.executor, { recursive: true });
            fs.mkdirSync(this.opts.agentDirs.critic, { recursive: true });
            fs.writeFileSync(markerE, this.opts.cwd, 'utf-8');
            fs.writeFileSync(markerC, this.opts.cwd, 'utf-8');
          } catch (e) {
            this.log.event('orchestrator', 'error', {
              stage: 'project_marker',
              code: 'write_failed',
              detail: String(e)
            });
          }
        }
      } catch (e) {
        this.log.event('orchestrator', 'error', {
          stage: 'chat_reset',
          code: 'new_chat_failed',
          detail: String(e)
        });
      }
    } else {
      this.log.event('orchestrator', 'artifact', {
        action: 'resume',
        kind: 'chats',
        reason: 'plan.md present and project matches',
        path: planPath
      });
    }

    this.queueE.push({
      msg: { role: 'user', content: 'Start the task.' },
      files: this.opts.initialFiles
    });

    const totalMs = this.opts.deadlineAt - start;
    this.tick = setInterval(() => {
      this.panel.setElapsed(Date.now() - start, totalMs);
    }, 1000);

    try {
      const softDeadline = this.opts.deadlineAt;
      const hardDeadline = softDeadline + GRACE_MS;
      let softFired = false;

      while (!this.stopped) {
        const now = Date.now();

        if (!softFired && now > softDeadline) {
          softFired = true;
          if (!this.deadC) {
            this.log.event('orchestrator', 'error', {
              stage: 'timeout',
              code: 'soft_deadline',
              detail: 'Asking Critic to finalize.'
            });
            this.pendingGracefulShutdown = true;
            this.queueC.push({
              msg: {
                role: 'user',
                content:
                  'TIME_LIMIT: The overall task time has expired. Read ' +
                  '.pingis/plan.md (if present) and key files. Assess what ' +
                  'is done and what is not. Call finalize with an honest ' +
                  'summary: what is done, what is not, and what the user ' +
                  'should do when restarting the task. Do not keep working.'
              }
            });
          }
        }

        if (now > hardDeadline) {
          this.log.event('orchestrator', 'error', {
            stage: 'timeout',
            code: 'hard_deadline',
            detail: 'Grace period exhausted.'
          });
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

      const summaryPath = path.join(this.opts.cwd, '.pingis', 'summary.md');
      const planPath = path.join(this.opts.cwd, '.pingis', 'plan.md');

      // Fallback summary when the Critic did not write one.
      // Covers clean done, deadlock (empty queues), and gave_up
      // (IMPOSSIBLE from an agent). All three end the task without
      // the Critic having written a summary; the user still needs a
      // persistent record of what happened.
      if ((this.stopReason === 'done' ||
           this.stopReason === 'deadlock' ||
           this.stopReason === 'gave_up')
          && !fs.existsSync(summaryPath)) {
        this.writeFallbackSummary(summaryPath, planPath);
      }

      // Artifact lifecycle: delete plan.md on clean done.
      // On graceful shutdown (CONTEXT_LIMIT / TIME_LIMIT / deadlock) the
      // plan must survive so the task can be resumed later.
      if (this.stopReason === 'done' && !this.pendingGracefulShutdown) {
        if (fs.existsSync(planPath)) {
          try {
            fs.unlinkSync(planPath);
            this.log.event('orchestrator', 'artifact', {
              action: 'delete',
              kind: 'plan',
              path: planPath
            });
          } catch (e) {
            this.log.event('orchestrator', 'error', {
              stage: 'plan_delete',
              code: 'unlink_failed',
              detail: String(e)
            });
          }
        }
      } else if (fs.existsSync(planPath)) {
        this.log.event('orchestrator', 'artifact', {
          action: 'keep',
          kind: 'plan',
          reason: this.pendingGracefulShutdown
            ? 'graceful shutdown'
            : (this.stopReason ?? 'unknown'),
          path: planPath
        });
      }

      // Panel is the caller now; it decides whether to retry or to
      // show the final state. See OrchestratorResult.
      this.log.event('orchestrator', 'stop', {
        reason: this.stopReason ?? 'crash',
        summary: this.stopSummary,
        turns: { executor: this.turnE, critic: this.turnC },
        help_cycles: this.helpCycles,
        duration_ms: Date.now() - start
      });
    }

    return {
      reason: this.stopReason ?? 'crash',
      summary: this.stopSummary
    };
  }

  stop(reason: StopReason, summary?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.stopSummary = summary;
  }

  /**
   * Set an agent's phase and log the transition. No-op when the
   * phase does not change, so idle → idle does not spam the log.
   */
  private setPhase(
    who: AgentName,
    phase: AgentPhase,
    reason?: string
  ): void {
    const current = who === 'executor' ? this.phaseE : this.phaseC;
    if (current === phase) return;
    if (who === 'executor') this.phaseE = phase;
    else this.phaseC = phase;
    this.log.event(who, 'agent_phase', {
      from: current,
      to: phase,
      reason
    });
  }

  private writeFallbackSummary(summaryPath: string, planPath: string): void {
    try {
      let planContent = '';
      if (fs.existsSync(planPath)) {
        planContent = fs.readFileSync(planPath, 'utf-8');
      }
      const lines = [
        '# Task summary (fallback, generated by orchestrator)',
        '',
        '## Task',
        this.opts.task,
        '',
        '## Stop reason',
        this.stopReason ?? 'unknown',
        '',
        '## Stop summary',
        this.stopSummary ?? '',
        '',
        '## Timestamp',
        new Date().toISOString()
      ];
      if (planContent) {
        lines.push('', '## Plan (verbatim)', '', planContent);
      }
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(summaryPath, lines.join('\n'), 'utf-8');
      this.log.event('orchestrator', 'artifact', {
        action: 'fallback',
        kind: 'summary',
        path: summaryPath
      });
    } catch (e) {
      this.log.event('orchestrator', 'error', {
        stage: 'summary_fallback',
        code: 'write_failed',
        detail: String(e)
      });
    }
  }

  private async step(who: AgentName, session: AgentSession): Promise<void> {
    const queue = who === 'executor' ? this.queueE : this.queueC;
    const item = queue.shift()!;

    // Snapshot the framing the agent is about to work from. Used
    // after a HELP round to restore the original request (step 51b).
    if (who === 'executor') this.originalE = item.msg.content;
    else this.originalC = item.msg.content;

    this.setPhase(who, 'working', 'request');
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
      // Salvage A: DeepSeek Web sometimes returns tool_calls as text.
      const salvaged = trySalvageTextualToolCalls(resp.text);
      if (salvaged && salvaged.length > 0) {
        this.log.event(who, 'response', {
          salvaged: true,
          kind: 'full_tool_calls',
          count: salvaged.length,
          names: salvaged.map(tc => tc.name)
        });
        resp.tool_calls = salvaged;
        this.brokenBuffer.delete(who);
        if (who === 'executor') this.protocolRetryE = 0;
        else this.protocolRetryC = 0;
      } else {
        // Salvage B: extract just the "message" field via regex.
        const extracted = tryExtractMessageFromBrokenJson(resp.text);
        if (extracted) {
          const other: AgentName = who === 'executor' ? 'critic' : 'executor';
          this.log.event(who, 'response', {
            salvaged: true,
            kind: 'message_extracted',
            length: extracted.length
          });
          resp.tool_calls = [{
            id: `salvaged_${Date.now()}`,
            name: 'send_message',
            args: { to: other, message: extracted }
          } as ToolCall];
          this.brokenBuffer.delete(who);
          if (who === 'executor') this.protocolRetryE = 0;
          else this.protocolRetryC = 0;
        } else {
          // Full salvage failed. Store the broken text, then escalate:
          // retries 0 → L1a, 1 → L1b, 2 → L3 (orchestrator HELP), 3 → stop.
          this.brokenBuffer.set(who, resp.text.slice(0, 2000));

          const retries = who === 'executor'
            ? this.protocolRetryE
            : this.protocolRetryC;

          if (retries === 0) {
            // Guard: stop before opening a new round if the budget
            // is exhausted. This is checked at the top of a round, so
            // up to MAX_FORMAT_ROUNDS rounds complete in full.
            const rounds = who === 'executor'
              ? this.formatRoundsE
              : this.formatRoundsC;
            if (rounds >= MAX_FORMAT_ROUNDS) {
              this.log.event(who, 'error', {
                stage: 'protocol',
                code: 'format_budget_exhausted',
                rounds
              });
              this.stop(
                'protocol_violation',
                `format budget exhausted (${rounds} full rounds)`
              );
              return;
            }

            // L1a: general hint.
            if (who === 'executor') this.protocolRetryE++;
            else this.protocolRetryC++;

            this.log.event(who, 'error', {
              stage: 'protocol',
              code: 'no_tool_calls',
              retry: 1,
              hint: 'general'
            });
            this.setPhase(who, 'format_retry', 'L1a');

            item.msg.content = item.msg.content +
              '\n\nYour previous response was not recognized as tool_calls. ' +
              'The raw text is in your conversation history — read it.\n\n' +
              'Most likely cause: a missing closing bracket at the end ' +
              'of the JSON, or a message too long to be generated ' +
              'completely.\n\n' +
              'Retry with a SHORTER reply. Ensure every opening bracket ' +
              'has a matching closing bracket.';
            queue.unshift(item);
            this.panel.setStatus(who, 'idle');
            return;
          }

          if (retries === 1) {
            // L1b: preview of the broken output.
            if (who === 'executor') this.protocolRetryE++;
            else this.protocolRetryC++;

            const broken = this.brokenBuffer.get(who) || '';
            const head = broken.slice(0, 800);
            const tail = broken.length > 1200 ? broken.slice(-400) : '';

            this.log.event(who, 'error', {
              stage: 'protocol',
              code: 'no_tool_calls',
              retry: 2,
              hint: 'preview'
            });
            this.setPhase(who, 'format_retry', 'L1b');

            const preview =
              'Your previous response is still not recognized as tool_calls.\n\n' +
              'What we received (first 800 characters):\n\n' +
              head +
              (tail ? '\n\n...\n\nLast 400 characters:\n\n' + tail : '') +
              '\n\nThe truncation or syntax error is likely at the boundary. ' +
              'Retry with a SHORTER reply.';

            item.msg.content = item.msg.content + '\n\n' + preview;
            queue.unshift(item);
            this.panel.setStatus(who, 'idle');
            return;
          }

          // L3 and beyond: orchestrator initiates HELP on the broken
          // agent's behalf. There is no L4 stop — the loop closes only
          // on IMPOSSIBLE from either agent, or on task timeout. The
          // protocol counter resets so the next failure starts at L1a.
          const broken = this.brokenBuffer.get(who) || '';
          const other: AgentName = who === 'executor' ? 'critic' : 'executor';

          this.log.event(who, 'error', {
            stage: 'protocol',
            code: 'no_tool_calls',
            retry: 3,
            hint: 'orchestrator_help'
          });

          const helpMsg =
            'HELP:\n' +
            'Problem: tool_calls unparseable\n' +
            'Error: my last reply was not valid JSON; likely truncated\n' +
            'Tried: two automatic retries with a hint and a preview\n' +
            'Files: n/a\n' +
            'Question: help me reformat — is my message too long?\n\n' +
            '--- last broken attempt ---\n' +
            broken;

          const target = other === 'critic' ? this.queueC : this.queueE;
          target.length = 0;
          target.push({ msg: { role: 'user', content: helpMsg } });

          this.log.event('orchestrator', 'help', {
            phase: 'HELP',
            from: who,
            to: other,
            initiator: 'orchestrator',
            enriched: true
          });
          this.helpCycles++;

          // One full round completed (L1a + L1b + L3).
          if (who === 'executor') this.formatRoundsE++;
          else this.formatRoundsC++;

          this.setPhase(who, 'awaiting_help', 'L3 synthesized');
          this.setPhase(other, 'helping', 'received synthesized HELP');

          if (who === 'executor') this.protocolRetryE = 0;
          else this.protocolRetryC = 0;

          this.panel.setStatus(who, 'idle');
          return;
        }
      }
    }

    // Pre-check: any malformed tool call aborts the whole batch and
    // re-queues the original item with a hint. Mirrors the L1a path
    // for `no_tool_calls`. Only after two retries does the task stop.
    const malformed = firstMalformedToolCall(who, resp.tool_calls);
    if (malformed) {
      const attempt = who === 'executor'
        ? this.malformedRetryE
        : this.malformedRetryC;

      if (attempt === 0) {
        // First failure: one hint attached to the current request.
        if (who === 'executor') this.malformedRetryE++;
        else this.malformedRetryC++;

        this.log.event(who, 'error', {
          stage: 'protocol',
          code: 'malformed_tool_call',
          retry: 1,
          reason: malformed
        });
        this.setPhase(who, 'format_retry', 'malformed');

        item.msg.content = item.msg.content +
          '\n\nYour previous tool call was malformed: ' + malformed + '. ' +
          'Re-send with the correct arguments — the tool schema is in ' +
          'your system prompt.';
        queue.unshift(item);
        this.panel.setStatus(who, 'idle');
        return;
      }

      // Second failure: hand off to the other agent via HELP. No stop.
      const broken = resp.text.slice(0, 2000);
      const other: AgentName = who === 'executor' ? 'critic' : 'executor';

      this.log.event(who, 'error', {
        stage: 'protocol',
        code: 'malformed_tool_call',
        action: 'orchestrator_help',
        reason: malformed
      });

      const helpMsg =
        'HELP:\n' +
        'Problem: my tool call was malformed\n' +
        'Error: ' + malformed + '\n' +
        'Tried: one correction attempt with a hint\n' +
        'Files: n/a\n' +
        'Question: help me produce a valid call\n\n' +
        '--- last broken attempt ---\n' + broken;

      const target = other === 'critic' ? this.queueC : this.queueE;
      target.length = 0;
      target.push({ msg: { role: 'user', content: helpMsg } });

      this.log.event('orchestrator', 'help', {
        phase: 'HELP',
        from: who,
        to: other,
        initiator: 'orchestrator',
        enriched: true
      });
      this.helpCycles++;

      this.setPhase(who, 'awaiting_help', 'malformed help synthesized');
      this.setPhase(other, 'helping', 'received malformed HELP');

      if (who === 'executor') this.malformedRetryE = 0;
      else this.malformedRetryC = 0;

      this.panel.setStatus(who, 'idle');
      return;
    }

    // Well-formed batch — reset the malformed counter for this agent.
    if (who === 'executor') this.malformedRetryE = 0;
    else this.malformedRetryC = 0;

    const execResults: ExecResult[] = [];

    for (const tc of resp.tool_calls) {
      const cont = await this.handleToolCall(who, tc, execResults);
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

    // Successful step — reset this agent's retry counters.
    if (who === 'executor') {
      this.protocolRetryE = 0;
      this.malformedRetryE = 0;
      this.formatRoundsE = 0;
    } else {
      this.protocolRetryC = 0;
      this.malformedRetryC = 0;
      this.formatRoundsC = 0;
    }

    // If handleToolCall did not move the agent into awaiting_help
    // or helping, it has finished its step and is idle again.
    const currentPhase = who === 'executor' ? this.phaseE : this.phaseC;
    if (currentPhase === 'working') {
      this.setPhase(who, 'idle', 'step done');
    }

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

      this.pendingGracefulShutdown = true;
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
    tc: ToolCall,
    execResults: ExecResult[]
  ): Promise<boolean> {
    if (tc.name === 'execute') {
      // Args are pre-validated by firstMalformedToolCall() in step();
      // that check aborts the whole batch before handleToolCall() runs.
      const script = (tc.args as any)?.script;
      const command = (tc.args as any)?.command;
      this.panel.setStatus(who, 'execute');
      const result = await this.exec.run(tc.id, script, command);
      execResults.push(result);
      return true;
    }

    if (tc.name === 'send_message') {
      // Args are pre-validated by firstMalformedToolCall() in step();
      // that check aborts the whole batch before handleToolCall() runs.
      const to = (tc.args as any)?.to;
      let message = (tc.args as any)?.message;

      // Classify the HELP-loop marker. IMPOSSIBLE is terminal; every
      // other marker is log-only and routed normally.
      const phase =
        message.startsWith('HELP_RESPONSE:') ? 'HELP_RESPONSE' :
        message.startsWith('HELP:')          ? 'HELP' :
        message.startsWith('SOLVED:')        ? 'SOLVED' :
        message.startsWith('IMPOSSIBLE:')    ? 'IMPOSSIBLE' :
        message.startsWith('QUESTION:')      ? 'QUESTION' :
        message.startsWith('ANSWER:')        ? 'ANSWER' :
        null;

      if (phase === 'IMPOSSIBLE') {
        this.log.event('orchestrator', 'help', {
          phase: 'IMPOSSIBLE',
          from: who,
          to
        });
        this.pendingGracefulShutdown = true;
        this.stop('gave_up',
          `IMPOSSIBLE from ${who}: ${message.slice(0, 200)}`);
        return false;
      }

      // Enrich HELP with the sender's last broken output, if any.
      if (phase === 'HELP') {
        const broken = this.brokenBuffer.get(who);
        if (broken) {
          message += '\n\n--- last broken attempt ---\n' + broken;
          this.log.event('orchestrator', 'help', {
            phase: 'HELP',
            from: who,
            to,
            enriched: true
          });
        } else {
          this.log.event('orchestrator', 'help', {
            phase: 'HELP',
            from: who,
            to,
            enriched: false
          });
        }
        this.helpCycles++;
        this.setPhase(who, 'awaiting_help', 'HELP sent');
        this.setPhase(to, 'helping', 'HELP received');
      } else if (phase) {
        this.log.event('orchestrator', 'help', {
          phase,
          from: who,
          to
        });
        this.helpCycles++;
        if (phase === 'HELP_RESPONSE' || phase === 'SOLVED') {
          // The sender has finished helping; return to idle. The
          // recipient stays in whatever phase it was — for
          // HELP_RESPONSE it is awaiting_help, for SOLVED it was
          // helping and will be reset when its next step runs.
          this.setPhase(who, 'idle', phase === 'SOLVED'
            ? 'problem solved'
            : 'HELP answered');
        }
      }

      // Special case: Executor is dead (409) and Critic is trying to reply.
      // Do not forward — ask Critic to finalize the task.
      if (to === 'executor' && this.deadE) {
        this.criticFinalizeReminders++;
        if (this.criticFinalizeReminders > MAX_FINALIZE_REMINDERS) {
          this.stop(
            'deadlock',
            `Critic did not finalize after ${MAX_FINALIZE_REMINDERS} reminders.`
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

      // For HELP_RESPONSE, restore the recipient's original framing of
      // the task instead of forwarding the suggestion as the next
      // request. Without this, the recipient's "current request" becomes
      // another layer of HELP chatter, and the original task drifts out
      // of focus over several HELP rounds. See step 51 design notes.
      let outMessage = message;
      if (phase === 'HELP_RESPONSE') {
        const otherOriginal = to === 'executor'
          ? this.originalE
          : this.originalC;
        if (otherOriginal) {
          outMessage =
            'Return to your original task.\n\n' +
            'Original request:\n' +
            otherOriginal +
            '\n\nSuggestion from ' + who + ':\n' +
            message +
            '\n\nResume with the original request. If the suggestion ' +
            'does not help, say so in one line and continue on your own.';
        }
      }

      target.push({ msg: { role: 'user', content: outMessage } });
      this.log.event('orchestrator', 'route', {
        from: who,
        to,
        message: outMessage
      });
      return true;
    }

    if (tc.name === 'finalize') {
      if (who !== 'critic') {
        this.stop('unknown_tool', 'finalize from executor');
        return false;
      }
      const comment = (tc.args as any)?.comment ?? '';

      // Verify that the Critic wrote summary.md. The fallback is written
      // by the orchestrator in the `finally` block when no summary exists.
      const summaryPath = path.join(this.opts.cwd, '.pingis', 'summary.md');
      if (fs.existsSync(summaryPath)) {
        this.log.event('orchestrator', 'artifact', {
          action: 'verify',
          kind: 'summary',
          path: summaryPath
        });
      } else {
        this.log.event('orchestrator', 'error', {
          stage: 'summary_missing',
          code: 'critic_did_not_write',
          detail: 'orchestrator will write a fallback in finally'
        });
      }

      this.panel.setStatus(who, 'finalize');
      this.stop('done', String(comment));
      return false;
    }

    this.stop('unknown_tool', `unknown tool: ${(tc as any).name}`);
    return false;
  }
}


/**
 * Return a human-readable reason if any tool call in the batch is
 * malformed, or null if all calls are well-formed. Checked before any
 * call is executed, so a batch with a broken entry does not
 * half-execute.
 *
 * Malformed cases:
 *   - execute       — missing or empty `script`
 *   - send_message  — invalid `to`, empty `message`, or to = self
 *
 * Note: `finalize` is intentionally NOT checked here. That tool is
 * bound to the Critic role, and using it from the Executor is a role
 * violation (`unknown_tool`), not a formatting problem.
 */
function firstMalformedToolCall(
  who: AgentName,
  calls: ToolCall[]
): string | null {
  for (const tc of calls) {
    if (tc.name === 'execute') {
      const script = (tc.args as any)?.script;
      if (typeof script !== 'string' || script.length === 0) {
        return 'execute called without a script';
      }
    }
    if (tc.name === 'send_message') {
      const to = (tc.args as any)?.to;
      const message = (tc.args as any)?.message;
      if (to !== 'executor' && to !== 'critic') {
        return `send_message called with invalid 'to': ${JSON.stringify(to)}`;
      }
      if (typeof message !== 'string' || message.length === 0) {
        return 'send_message called without a message';
      }
      if (to === who) {
        return 'send_message called with to = self';
      }
    }
  }
  return null;
}

/**
 * Last-resort extraction of the "message" field from a broken tool_calls
 * response. Matches with a regex and unescapes. Returns null if the
 * field is absent or the text does not contain "message".
 *
 * Used when both strict JSON.parse and brace balancing fail — e.g. when
 * the model drops the closing bracket of the arguments object and the
 * entire JSON becomes unparseable.
 */
function tryExtractMessageFromBrokenJson(text: string): string | null {
  if (!text || !text.includes('"message"')) return null;
  const m = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (!m) return null;
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
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
