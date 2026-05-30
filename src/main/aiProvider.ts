import type { AiProvider, AiProviderRequest, AiProviderResult } from "../shared/aiPipeline";

const DEFAULT_PROVIDER_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

interface ConfiguredAiProviderEnvironment {
  ASK_AI_PROVIDER_API_KEY?: string;
  ASK_AI_PROVIDER_MODEL?: string;
  ASK_AI_PROVIDER_URL?: string;
  ASK_AI_PROVIDER_TIMEOUT_MS?: string;
}

interface ConfiguredAiProviderOptions {
  env?: ConfiguredAiProviderEnvironment;
  fetchImpl?: typeof fetch;
}

interface ProviderConfig {
  apiKey: string;
  model: string;
  endpointUrl: URL;
  timeoutMs: number;
}

interface ChatCompletionChoice {
  message?: {
    content?: unknown;
  };
  text?: unknown;
}

interface ChatCompletionUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

interface ChatCompletionResponse {
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
}

class AiProviderConfigurationError extends Error {
  readonly code = "PROVIDER_NOT_CONFIGURED";
}

class AiProviderRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const getEnv = (options: ConfiguredAiProviderOptions): ConfiguredAiProviderEnvironment => {
  return options.env ?? process.env;
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS);
};

const normalizeEndpointUrl = (value: string | undefined): URL => {
  const endpointUrl = new URL(value?.trim() || DEFAULT_PROVIDER_URL);
  const isHttps = endpointUrl.protocol === "https:";
  const isLocalHttp =
    endpointUrl.protocol === "http:" &&
    (endpointUrl.hostname === "localhost" || endpointUrl.hostname === "127.0.0.1");

  if (!isHttps && !isLocalHttp) {
    throw new AiProviderConfigurationError(
      "ASK_AI_PROVIDER_URL は https URL または localhost の http URL を指定してください。"
    );
  }

  return endpointUrl;
};

const loadProviderConfig = (env: ConfiguredAiProviderEnvironment): ProviderConfig => {
  const apiKey = env.ASK_AI_PROVIDER_API_KEY?.trim();
  const model = env.ASK_AI_PROVIDER_MODEL?.trim();

  if (!apiKey || !model) {
    throw new AiProviderConfigurationError(
      "ASK_AI_PROVIDER_API_KEY と ASK_AI_PROVIDER_MODEL を main process の環境変数に設定してください。"
    );
  }

  return {
    apiKey,
    model,
    endpointUrl: normalizeEndpointUrl(env.ASK_AI_PROVIDER_URL),
    timeoutMs: parsePositiveInteger(env.ASK_AI_PROVIDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
};

const sanitizeProviderMessage = (value: unknown): string => {
  const message =
    typeof value === "object" && value !== null && "message" in value
      ? String(value.message)
      : typeof value === "string"
        ? value
        : "AI provider request failed.";

  return message
    .replace(/\s+/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted api key]")
    .replace(/\bAKIA[0-9A-Z]{8,}/g, "[redacted api key]")
    .replace(/\bAIza[0-9A-Za-z_-]{8,}/g, "[redacted api key]")
    .replace(/\bsb_secret_[A-Za-z0-9_-]{8,}/g, "[redacted api key]")
    .slice(0, 240);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getChoices = (response: ChatCompletionResponse): ChatCompletionChoice[] => {
  if (!Array.isArray(response.choices)) {
    return [];
  }

  return response.choices.filter(isRecord) as ChatCompletionChoice[];
};

const getCompletionText = (response: ChatCompletionResponse): string => {
  const text = getChoices(response)
    .map((choice) => {
      if (isRecord(choice.message) && typeof choice.message.content === "string") {
        return choice.message.content;
      }

      return typeof choice.text === "string" ? choice.text : "";
    })
    .join("\n")
    .trim();

  if (!text) {
    throw new AiProviderRequestError("PROVIDER_EMPTY_RESPONSE", "AI provider returned no text.");
  }

  return text;
};

const clipText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars).trimEnd();
};

const getUsage = (
  response: ChatCompletionResponse,
  request: AiProviderRequest,
  text: string
): AiProviderResult["usage"] => {
  const usage = isRecord(response.usage) ? (response.usage as ChatCompletionUsage) : null;
  const promptTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completionTokens =
    typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null;

  return {
    inputChars: promptTokens ?? request.prompt.system.length + request.prompt.user.length,
    outputChars: completionTokens ?? text.length
  };
};

const buildRequestBody = (config: ProviderConfig, request: AiProviderRequest): string => {
  return JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: request.prompt.system },
      { role: "user", content: request.prompt.user }
    ],
    temperature: 0.2,
    max_tokens: Math.max(128, Math.ceil(request.options.maxOutputChars / 2))
  });
};

const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AiProviderRequestError("PROVIDER_TIMEOUT", "AI provider request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const createConfiguredAiProvider = (
  options: ConfiguredAiProviderOptions = {}
): AiProvider => {
  const env = getEnv(options);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: "configured-openai-compatible",
    mode: "remote",
    supportsStreaming: false,
    generate: async (request): Promise<AiProviderResult> => {
      const config = loadProviderConfig(env);
      const response = await fetchWithTimeout(
        fetchImpl,
        config.endpointUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json"
          },
          body: buildRequestBody(config, request)
        },
        config.timeoutMs
      );
      const rawResponse = (await response
        .json()
        .catch(() => null)) as ChatCompletionResponse | null;

      if (!response.ok) {
        throw new AiProviderRequestError(
          `PROVIDER_HTTP_${response.status}`,
          sanitizeProviderMessage(rawResponse?.error)
        );
      }

      if (!rawResponse) {
        throw new AiProviderRequestError(
          "PROVIDER_INVALID_RESPONSE",
          "AI provider response is not JSON."
        );
      }

      const text = clipText(getCompletionText(rawResponse), request.options.maxOutputChars);

      return {
        text,
        usage: getUsage(rawResponse, request, text)
      };
    }
  };
};
