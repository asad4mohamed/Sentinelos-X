// Minimal OpenAI-compatible Chat Completions client for NVIDIA's hosted API
// (https://integrate.api.nvidia.com/v1) or a self-hosted NIM. No SDK needed.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface LlmClient {
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult>;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking: boolean;
  timeoutMs: number;
  /** Retries for 429 / 5xx / network errors (default 2). */
  maxRetries?: number;
  /** Base backoff in ms (default 1000; doubles each retry, capped at 10 s). */
  retryBaseMs?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Never let a credential reach logs or the public ai_* tables through an error message. */
export function redactSecrets(text: string, ...secrets: string[]): string {
  let out = text.replace(/nvapi-[A-Za-z0-9_-]{6,}/g, 'nvapi-[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** fetch() wraps network failures as "fetch failed"; include the underlying cause. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const c = cause instanceof Error ? `${(cause as { code?: string }).code ?? ''} ${cause.message}`.trim() : cause ? String(cause) : '';
  return c ? `${err.message} (${c})` : err.message;
}

export class OpenAiCompatibleClient implements LlmClient {
  constructor(private readonly cfg: LlmConfig) {}

  get model() {
    return this.cfg.model;
  }

  private headers() {
    return { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
    const body = {
      model: this.cfg.model,
      messages,
      // Some OpenAI-compatible servers reject tool_choice without tools: only send both together.
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: this.cfg.thinking ? 8192 : 2048,
      stream: false,
      // Nemotron chat-template switch for extended reasoning (per the NIM model card).
      chat_template_kwargs: { enable_thinking: this.cfg.thinking },
    };
    const maxRetries = Math.max(0, Math.min(5, this.cfg.maxRetries ?? 2));
    const base = this.cfg.retryBaseMs ?? 1000;
    let res: Response | undefined;
    let text = '';
    for (let attempt = 0; ; attempt++) {
      let transient: string | null = null;
      try {
        res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        text = await res.text();
        if (RETRYABLE.has(res.status)) transient = `NVIDIA API ${res.status}`;
      } catch (err) {
        transient = `Request to ${this.cfg.baseUrl} failed: ${describe(err)}`;
        res = undefined;
      }
      if (!transient) break;
      if (attempt >= maxRetries) {
        if (res) break; // fall through to the status error below
        throw new LlmError(redactSecrets(transient, this.cfg.apiKey));
      }
      const retryAfter = Number(res?.headers.get('retry-after'));
      await sleep(Math.min(10_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt));
    }
    if (!res!.ok) {
      const hint = res!.status === 404 ? ' (model not found or not enabled for this API key — run `npm run agent:check`)' : res!.status === 401 || res!.status === 403 ? ' (API key rejected)' : res!.status === 429 ? ' (rate limited after retries)' : '';
      throw new LlmError(redactSecrets(`NVIDIA API ${res!.status}${hint}: ${text.slice(0, 300)}`, this.cfg.apiKey), res!.status);
    }
    let json: { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[] };
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError(`Malformed (non-JSON) response from model endpoint: ${redactSecrets(text.slice(0, 200), this.cfg.apiKey)}`);
    }
    const choice = json.choices?.[0];
    if (!choice?.message) throw new LlmError('Response contained no choices');
    return {
      content: choice.message.content ?? null,
      toolCalls: (choice.message.tool_calls ?? []).filter(t => t?.function?.name),
      finishReason: choice.finish_reason ?? null,
    };
  }

  /** Lists model IDs visible to this key, to verify the configured model exists. */
  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, { headers: this.headers(), signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (err) {
      throw new LlmError(`Request to ${this.cfg.baseUrl} failed: ${describe(err)}`);
    }
    if (!res.ok) throw new LlmError(`GET /models → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map(m => m.id);
  }
}
