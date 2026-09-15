import { TimeoutError, withTimeout } from "../utils/abort";
import { log } from "../utils/env";
import { getNumberPref, getStringPref } from "../utils/prefs";

/**
 * Thrown for every failure the user should see verbatim. The menu handler
 * surfaces `error.message` directly, so messages are written in plain Chinese
 * and always say what to do next.
 */
export class LLMError extends Error {
  /** HTTP status when the failure came from the API, else `undefined`. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.status = status;
  }
}

/** A single message in the OpenAI-compatible chat format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; text?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

/**
 * Normalises the Base URL so users can paste any of the common shapes:
 * `https://api.deepseek.com`, `.../v1`, or the full `.../chat/completions`.
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new LLMError("尚未配置 API Base URL。请在「设置 → LLM Summarizer」中填写接口地址。");
  }
  if (/\/chat\/completions$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

/**
 * Minimal headers. `User-Agent` cannot be set from a Gecko sandbox and
 * `Content-Type` is always JSON, so only the auth header is conditional —
 * local runtimes (Ollama, LM Studio, vLLM) usually need no key at all.
 */
function buildHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return Object.assign(headers, extra);
}

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint.
 *
 * Deliberately uses the sandbox-global `fetch` — Zotero injects it into the
 * plugin scope, so no HTTP library is needed (and none would be allowed to
 * bypass Zotero's proxy configuration).
 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const baseUrl = getStringPref("apiBaseUrl");
  const apiKey = getStringPref("apiKey");
  const model = getStringPref("modelName");
  const temperature = getNumberPref("temperature", 0, 2);
  const timeoutSeconds = getNumberPref("timeoutSeconds", 5, 600);

  if (!model) {
    throw new LLMError("尚未配置模型名称（Model Name）。请在「设置 → LLM Summarizer」中填写。");
  }

  const url = buildChatCompletionsUrl(baseUrl);
  const body = JSON.stringify({ model, messages, temperature, stream: false });

  log(`POST ${url} model=${model} messages=${messages.length} timeout=${timeoutSeconds}s`);

  try {
    // The timeout is enforced by `withTimeout`, not by an `AbortController`: the
    // plugin sandbox has no such constructor, so a timeout built on one would
    // throw before the request was ever sent (see src/utils/abort.ts). The
    // signal here is only for dropping the socket once we have stopped waiting.
    const response = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers: buildHeaders(apiKey),
          body,
          signal: signal ?? null,
        }),
      timeoutSeconds * 1000,
    );
    return await readResponse(response);
  } catch (e) {
    throw toFriendlyError(e, timeoutSeconds);
  }
}

async function readResponse(response: Response): Promise<string> {
  if (!response.ok) {
    throw new LLMError(await describeHttpError(response), response.status);
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new LLMError(
      "模型返回的不是合法 JSON，可能命中了错误页或代理网关。请检查 Base URL 是否指向了 OpenAI 兼容接口。",
      response.status,
    );
  }

  // Some gateways return 200 with an `error` object rather than a 4xx status.
  if (payload.error?.message) {
    throw new LLMError(`模型返回错误：${payload.error.message}`, response.status);
  }

  const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text;
  if (!content || !content.trim()) {
    throw new LLMError("模型返回了空内容。请稍后重试，或更换模型。", response.status);
  }
  return content.trim();
}

/** Maps HTTP failures onto actionable Chinese messages. */
async function describeHttpError(response: Response): Promise<string> {
  const status = response.status;
  const detail = await readErrorDetail(response);
  const suffix = detail ? `\n服务端返回：${detail}` : "";

  switch (status) {
    case 400:
      return `请求被拒绝（400）。通常是模型名称不受支持，或上下文超出该模型上限。${suffix}`;
    case 401:
      return `鉴权失败（401）：API Key 无效或已过期。请在「设置 → LLM Summarizer」中重新填写。${suffix}`;
    case 402:
      return `账户余额不足（402）。请前往服务商控制台充值后重试。${suffix}`;
    case 403:
      return `访问被拒绝（403）。该 API Key 可能没有调用此模型的权限。${suffix}`;
    case 404:
      return `接口不存在（404）。请检查 Base URL 是否正确（应形如 https://api.deepseek.com/v1）。${suffix}`;
    case 413:
      return `请求体过大（413）。请调低「最大字符数」后重试。${suffix}`;
    case 422:
      return `参数不合法（422）。请检查模型名称与请求参数。${suffix}`;
    case 429:
      return `请求过于频繁或超出配额（429）。请稍后重试，或检查账户的速率限制。${suffix}`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `服务端暂时不可用（${status}）。这是模型服务商侧的故障，请稍后重试。${suffix}`;
    default:
      return `请求失败（HTTP ${status}）。${suffix}`;
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return "";
    }
    try {
      const parsed = JSON.parse(text) as ChatCompletionResponse;
      return parsed.error?.message ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return "";
  }
}

/**
 * Converts transport-level exceptions (DNS, TLS, timeouts) into `LLMError`.
 *
 * `TimeoutError` is ours and unambiguous; the `AbortError` branch is defensive
 * only, covering the narrow case where the socket reports the cancel before
 * `withTimeout` has surfaced its own rejection.
 */
function toFriendlyError(error: unknown, timeoutSeconds: number): LLMError {
  if (error instanceof LLMError) {
    return error;
  }
  if (error instanceof TimeoutError) {
    return new LLMError(
      `请求超时（${timeoutSeconds} 秒）。模型可能正在处理超长文本，可在「设置」中调高超时时间或调低最大字符数。`,
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new LLMError("请求已被取消。");
  }
  if (error instanceof TypeError) {
    return new LLMError(
      "无法连接到 API 服务。请检查网络连接、Base URL 是否正确，以及 Zotero 的代理设置。",
    );
  }
  return new LLMError(`调用模型时发生未知错误：${String(error)}`);
}
