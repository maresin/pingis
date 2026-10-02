import * as fs from 'fs';
import * as path from 'path';
import {
  AgentName,
  AssistantResponse,
  ChatMessage,
  StopError,
  ToolCall
} from './types';
import { toolsFor } from './tools';

export interface LoggerLike {
  event(who: string, event: string, payload?: object): void;
}

export class AgentSession {
  readonly who: AgentName;
  readonly systemPrompt: string;

  chatSessionId: string | null = null;
  isFirstCall = true;
  cookieHeader = '';

  constructor(who: AgentName, systemPrompt: string) {
    this.who = who;
    this.systemPrompt = systemPrompt;
  }

  absorbCookies(headers: Headers) {
    const setCookie = headers.get('set-cookie');
    if (!setCookie) return;
    const pairs = setCookie
      .split(/,(?=[^ ])/)
      .map(c => c.split(';')[0].trim())
      .filter(Boolean);
    this.cookieHeader = pairs.join('; ');
  }
}

export interface ApiOptions {
  baseUrl: string;
  apiKey: string;
  logger: LoggerLike;
  onRawResponse?: (who: AgentName, json: unknown) => void;
}

export interface ChatOptions {
  files?: string[];
}

export class ApiClient {
  constructor(private opts: ApiOptions) {}

  async chat(
    session: AgentSession,
    msg: ChatMessage,
    chatOpts: ChatOptions = {}
  ): Promise<AssistantResponse> {
    const messages: ChatMessage[] = [];
    if (session.isFirstCall) {
      messages.push({ role: 'system', content: session.systemPrompt });
    }
    messages.push(msg);

    const body = {
      model: 'deepseek-chat',
      messages,
      tools: toolsFor(session.who),
      tool_choice: 'required',
      stream: false,
      extra_body: {
        deepthink: true,
        web_search: true
      }
    };

    return this.post(
      session,
      '/v1/chat/completions',
      body,
      chatOpts.files ?? [],
      3
    );
  }

  /**
   * Create a new chat on the server side for this session.
   * After the call, the entire dialog history on the server is reset.
   */
  async newChat(session: AgentSession, restore = false): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const r = await fetch(`${this.opts.baseUrl}/v1/chat/new`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ restore }),
        signal: controller.signal
      });

      if (!r.ok) {
        const detail = await safeText(r);
        this.opts.logger.event(session.who, 'error', {
          stage: 'chat_new',
          code: `http_${r.status}`,
          detail
        });
        return;
      }

      session.isFirstCall = true;
      session.chatSessionId = null;
      this.opts.logger.event(session.who, 'chat_new', { restore });
    } catch (e: any) {
      this.opts.logger.event(session.who, 'error', {
        stage: 'chat_new',
        code: 'exception',
        detail: String(e)
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post(
    session: AgentSession,
    endpoint: string,
    body: any,
    files: string[],
    retriesLeft: number
  ): Promise<AssistantResponse> {
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) {
      headers['Authorization'] = `Bearer ${this.opts.apiKey}`;
    }
    if (session.cookieHeader) {
      headers['Cookie'] = session.cookieHeader;
    }

    let payload: string | FormData;
    if (files.length > 0) {
      const form = new FormData();
      for (const f of files) {
        const buf = fs.readFileSync(f);
        form.append('files', new Blob([buf]), path.basename(f));
      }
      form.append('data', JSON.stringify(body));
      payload = form;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let r: Response;
    try {
      r = await fetch(`${this.opts.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: payload
      });
    } catch (e: any) {
      const cause = e?.cause;
      const detail = [
        e?.message ?? String(e),
        cause?.code,
        cause?.message,
        cause?.address ? `${cause.address}:${cause.port}` : undefined
      ].filter(Boolean).join(' | ');
      throw new StopError('network_error', detail);
    }

    session.absorbCookies(r.headers);

    if (r.status === 200) {
      const json = await r.json();
      this.opts.onRawResponse?.(session.who, json);
      return this.handleSuccess(session, json);
    }

    if (r.status === 401) throw new StopError('unauthorized', await safeText(r));
    if (r.status === 403) throw new StopError('forbidden',    await safeText(r));
    if (r.status === 404) throw new StopError('not_found',    await safeText(r));
    if (r.status === 400) throw new StopError('bad_request',  await safeText(r));
    if (r.status === 409) throw new StopError('context_exhausted');
    if (r.status === 503) {
      // API may still be finishing Chromium init. Give it a chance.
      // Three attempts with 5s pause = 15s wait.
      if (retriesLeft > 0) {
        this.opts.logger.event('orchestrator', 'retry', {
          agent: session.who,
          http_status: 503,
          reason: 'server_busy_retry',
          retries_left: retriesLeft - 1
        });
        await sleep(5000);
        return this.post(session, endpoint, body, files, retriesLeft - 1);
      }
      throw new StopError('server_busy');
    }
    if (r.status === 502) throw new StopError('bad_gateway');
    if (r.status === 500) throw new StopError('server_error', await safeText(r));

    if (r.status === 408 || r.status === 429 || r.status === 504) {
      if (retriesLeft <= 0) {
        throw new StopError(
          r.status === 504 ? 'timeout' : 'network_error',
          `retries exhausted for HTTP ${r.status}`
        );
      }
      this.opts.logger.event('orchestrator', 'retry', {
        agent: session.who,
        http_status: r.status,
        retries_left: retriesLeft - 1
      });
      const delay = r.status === 429 ? 5000 : 1000;
      await sleep(delay);
      return this.post(session, endpoint, body, files, retriesLeft - 1);
    }

    throw new StopError('server_error', `unexpected HTTP ${r.status}`);
  }

  private handleSuccess(session: AgentSession, json: any): AssistantResponse {
    if (!session.chatSessionId) {
      const sid = json.chat_session_id
                ?? json.session_id
                ?? json.id;
      if (typeof sid === 'string' && sid.length > 0) {
        session.chatSessionId = sid;
      }
    }
    session.isFirstCall = false;

    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const rawCalls: any[] = message.tool_calls ?? [];

    const tool_calls: ToolCall[] = [];
    for (const tc of rawCalls) {
      const name = tc.function?.name;
      const argsRaw = tc.function?.arguments;

      let args: any = argsRaw;
      if (typeof argsRaw === 'string') {
        try { args = JSON.parse(argsRaw); }
        catch { args = null; }
      }

      if (!args || typeof args !== 'object') {
        this.opts.logger.event(session.who, 'error', {
          stage: 'parse',
          code: 'bad_tool_args',
          tool_name: name,
          args_type: typeof argsRaw,
          args_preview: typeof argsRaw === 'string'
            ? argsRaw.slice(0, 300)
            : String(argsRaw).slice(0, 300)
        });
        continue;
      }

      if (name === 'execute' || name === 'send_message' || name === 'finalize') {
        tool_calls.push({
          id: tc.id ?? '',
          name,
          args
        } as ToolCall);
      }
    }

    return {
      text: message.content ?? '',
      tool_calls,
      usage: json.usage,
      context_status: json.context_status,
      raw: json
    };
  }
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 500); }
  catch { return ''; }
}
