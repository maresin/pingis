// ==== Roles and messages ====

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

// ==== Attachments ====

export interface FileAttachment {
  name: string;
  content: string;
}

// ==== Tools ====

export type AgentName = 'executor' | 'critic';
export type ToolName = 'execute' | 'send_message' | 'finalize';

export interface ToolSchema {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export interface ToolCallExecute {
  id: string;
  name: 'execute';
  args: { script: string; command?: string };
}
export interface ToolCallSendMessage {
  id: string;
  name: 'send_message';
  args: { to: AgentName; message: string };
}
export interface ToolCallFinalize {
  id: string;
  name: 'finalize';
  args: { comment: string };
}
export type ToolCall = ToolCallExecute | ToolCallSendMessage | ToolCallFinalize;

// ==== API response ====

export interface ContextStatus {
  chars_used: number;
  chars_limit: number;
  percent_used: number;
  language_coefficient: number;
  warning: string | null;
  recommendation: string | null;
  deepseek_length_limit?: {
    detected: boolean;
    readable_percent: number | null;
  };
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AssistantResponse {
  text: string;
  tool_calls: ToolCall[];
  usage?: UsageInfo;
  context_status?: ContextStatus;
  raw: unknown;
}

// ==== Execution result ====

export interface ExecResult {
  call_id: string;
  command: string;
  exit_code: number | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

// ==== Errors ====

export type StopReason =
  | 'done'
  | 'timeout'
  | 'context_exhausted'
  | 'server_busy'
  | 'server_error'
  | 'bad_gateway'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'network_error'
  | 'protocol_violation'
  | 'malformed_tool_call'
  | 'unknown_tool'
  | 'deadlock'
  | 'gave_up'
  | 'no_workspace'
  | 'user_stopped'
  | 'crash';

/**
 * Result returned by Orchestrator.run(). The orchestrator no longer
 * calls panel.done() — the caller (Panel) decides whether to retry
 * or to show the final state.
 */
export interface OrchestratorResult {
  reason: StopReason;
  summary?: string;
}

export class StopError extends Error {
  constructor(
    public readonly reason: StopReason,
    public readonly detail?: string
  ) {
    super(reason);
    this.name = 'StopError';
  }
}

// ==== Resources ====

export interface ResourceSnapshot {
  diskFree: string;
  ramFree: string;
}

// ==== Progress / UI ====

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'execute'
  | 'send_message'
  | 'finalize';

/**
 * What an agent is doing right now, at a coarser granularity than
 * AgentStatus (which is a UI label for the panel). AgentPhase is used
 * for logging and, later, for the HELP-budget check: if an agent stays
 * in `awaiting_help` for too long without resolution, the orchestrator
 * synthesizes IMPOSSIBLE instead of looping until the task timeout.
 *
 * Distinct from the `phase` field inside `event: 'help'` records —
 * that one describes a HELP marker (HELP / HELP_RESPONSE / SOLVED /
 * IMPOSSIBLE), not an agent state.
 */
export type AgentPhase =
  | 'idle'           // nothing in flight; waiting for the next step
  | 'working'        // request sent; awaiting a response
  | 'format_retry'   // previous response unparsable; retrying
  | 'awaiting_help'  // sent HELP:, waiting for HELP_RESPONSE:
  | 'helping';       // received HELP:, working on the response

// ==== Log ====

export type LogEvent =
  | 'task_start'
  | 'system_prompt'
  | 'request'
  | 'response'
  | 'exec'
  | 'route'
  | 'retry'
  | 'error'
  | 'stop'
  // No emitter in src/; belongs to the unused ApiClient.newChat path.
  // See the note on ApiClient.newChat.
  | 'chat_new'
  | 'api_spawn'
  | 'api_ready'
  | 'api_exit'
  | 'context'
  | 'context_transition'
  | 'help'
  | 'artifact'
  | 'agent_phase'
  | 'checkpoint_nudge'
  | 'continuation_nudge';

export interface LogRecord {
  seq: number;
  ts: string;
  who: AgentName | 'orchestrator';
  event: LogEvent;
  [key: string]: unknown;
}

// ==== Webview <-> Extension Host ====

export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'start'; name: string; description: string; attachments: FileAttachment[] }
  | { type: 'stop' }
  | { type: 'pickFile' }
  | { type: 'reset' };

export type ExtToWebview =
  | { type: 'workspaceStatus'; hasWorkspace: boolean; workspacePath?: string }
  | { type: 'showWelcome' }
  | { type: 'showProgress'; name: string }
  | { type: 'filesAttached'; files: FileAttachment[] }
  | { type: 'status'; who: AgentName; status: AgentStatus }
  | { type: 'turn'; who: AgentName }
  | { type: 'elapsed'; elapsedMs: number; totalMs: number }
  | { type: 'retrying'; attempt: number; max: number }
  | { type: 'retryDone' }
  | { type: 'done'; reason: StopReason; summary?: string };
