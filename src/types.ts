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
  | 'no_workspace'
  | 'user_stopped'
  | 'crash';

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

export interface TurnCounters {
  executor: number;
  critic: number;
}

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
  | 'chat_new'
  | 'http'
  | 'api_spawn'
  | 'api_ready'
  | 'api_exit'
  | 'api_cleanup'
  | 'context';

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
  | { type: 'done'; reason: StopReason; summary?: string };
