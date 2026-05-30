import { randomUUID } from "node:crypto";
import type {
  GitHubDeviceFlowPollRequest,
  GitHubDeviceFlowPollResponse,
  GitHubDeviceFlowStartResponse
} from "../shared/ipc";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEFAULT_SCOPE = "read:user";
const DEFAULT_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 30;

type FetchLike = typeof fetch;

interface GitHubDeviceFlowEnvironment {
  ASK_GITHUB_OAUTH_CLIENT_ID?: string;
}

interface DeviceFlowSession {
  clientId: string;
  deviceCode: string;
  expiresAt: Date;
  intervalSeconds: number;
}

interface GitHubDeviceFlowDependencies {
  env?: GitHubDeviceFlowEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  createSessionId?: () => string;
  sessions?: Map<string, DeviceFlowSession>;
}

interface DeviceCodeResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface AccessTokenResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface GitHubUserResponse {
  login?: unknown;
}

interface GitHubDeviceFlowService {
  start: () => Promise<GitHubDeviceFlowStartResponse>;
  poll: (request: GitHubDeviceFlowPollRequest) => Promise<GitHubDeviceFlowPollResponse>;
}

const sanitizeProviderText = (value: unknown): string => {
  const rawText =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "message" in value
        ? String(value.message)
        : "";

  return rawText
    .replace(/\s+/g, " ")
    .replace(/\bgho_[A-Za-z0-9_]{8,}/gi, "[redacted token]")
    .replace(/\bghu_[A-Za-z0-9_]{8,}/gi, "[redacted token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/gi, "[redacted token]")
    .replace(/\b(access_token|device_code)=?[A-Za-z0-9._-]{8,}/gi, "$1=[redacted]")
    .slice(0, 180)
    .trim();
};

const isNetworkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return /fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(error.message);
};

const parsePositiveInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
};

const getClientId = (env: GitHubDeviceFlowEnvironment): string | null => {
  const clientId = env.ASK_GITHUB_OAUTH_CLIENT_ID?.trim();
  return clientId ? clientId : null;
};

const createFormBody = (values: Record<string, string>): URLSearchParams => {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    body.set(key, value);
  }

  return body;
};

const createStartResponse = (
  status: GitHubDeviceFlowStartResponse["status"],
  message: string
): GitHubDeviceFlowStartResponse => ({
  contractVersion: "v1",
  status,
  sessionId: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  message
});

const createPollResponse = (
  status: GitHubDeviceFlowPollResponse["status"],
  message: string,
  session: DeviceFlowSession | null = null
): GitHubDeviceFlowPollResponse => ({
  contractVersion: "v1",
  status,
  githubUsername: null,
  authMethod: null,
  retryAfterSeconds: session?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  expiresAt: session?.expiresAt.toISOString() ?? null,
  message
});

const cleanupExpiredSessions = (sessions: Map<string, DeviceFlowSession>, now: Date): void => {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
};

const readJson = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createGitHubDeviceFlowService = (
  dependencies: GitHubDeviceFlowDependencies = {}
): GitHubDeviceFlowService => {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const createSessionId = dependencies.createSessionId ?? randomUUID;
  const sessions = dependencies.sessions ?? new Map<string, DeviceFlowSession>();

  const start = async (): Promise<GitHubDeviceFlowStartResponse> => {
    const clientId = getClientId(env);

    if (!clientId) {
      return createStartResponse(
        "configuration_missing",
        "GitHub ブラウザコードログインを使うには ASK_GITHUB_OAUTH_CLIENT_ID の設定が必要です。先生に相談してください。"
      );
    }

    cleanupExpiredSessions(sessions, now());

    try {
      const response = await fetchImpl(DEVICE_CODE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: createFormBody({
          client_id: clientId,
          scope: DEFAULT_SCOPE
        })
      });
      const body = await readJson<DeviceCodeResponse>(response);

      if (!response.ok || !body) {
        return createStartResponse(
          "provider_error",
          sanitizeProviderText(body?.error_description) ||
            "GitHub のブラウザコードログインを開始できませんでした。時間をおいて再試行してください。"
        );
      }

      if (
        typeof body.device_code !== "string" ||
        typeof body.user_code !== "string" ||
        typeof body.verification_uri !== "string"
      ) {
        return createStartResponse(
          "provider_error",
          "GitHub からブラウザコードログインに必要な情報を受け取れませんでした。"
        );
      }

      const expiresInSeconds = parsePositiveInteger(body.expires_in, 900);
      const intervalSeconds = Math.min(
        parsePositiveInteger(body.interval, DEFAULT_INTERVAL_SECONDS),
        MAX_INTERVAL_SECONDS
      );
      const sessionId = createSessionId();
      const expiresAt = new Date(now().getTime() + expiresInSeconds * 1000);

      sessions.set(sessionId, {
        clientId,
        deviceCode: body.device_code,
        expiresAt,
        intervalSeconds
      });

      return {
        contractVersion: "v1",
        status: "ready",
        sessionId,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresAt: expiresAt.toISOString(),
        intervalSeconds,
        message: "GitHub のブラウザコードログインを開始しました。"
      };
    } catch (error) {
      return createStartResponse(
        isNetworkError(error) ? "network_error" : "provider_error",
        "GitHub に接続できませんでした。ネットワーク状態を確認して再試行してください。"
      );
    }
  };

  const poll = async (
    request: GitHubDeviceFlowPollRequest
  ): Promise<GitHubDeviceFlowPollResponse> => {
    const session = sessions.get(request.sessionId);

    if (!session) {
      return createPollResponse(
        "not_found",
        "ブラウザコードログインのセッションが見つかりません。もう一度開始してください。"
      );
    }

    if (session.expiresAt <= now()) {
      sessions.delete(request.sessionId);
      return createPollResponse(
        "expired",
        "ブラウザコードログインの有効期限が切れました。もう一度開始してください。"
      );
    }

    try {
      const response = await fetchImpl(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: createFormBody({
          client_id: session.clientId,
          device_code: session.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        })
      });
      const body = await readJson<AccessTokenResponse>(response);

      if (!response.ok || !body) {
        return createPollResponse(
          "provider_error",
          "GitHub のログイン完了状態を確認できませんでした。時間をおいて再試行してください。",
          session
        );
      }

      if (typeof body.error === "string") {
        if (body.error === "authorization_pending") {
          return createPollResponse(
            "pending",
            "GitHub 側の入力完了を待っています。ブラウザでコードを入力してください。",
            session
          );
        }

        if (body.error === "slow_down") {
          session.intervalSeconds = Math.min(session.intervalSeconds + 5, MAX_INTERVAL_SECONDS);
          return createPollResponse(
            "slow_down",
            "確認間隔を少し空けます。ブラウザでコード入力が完了していれば自動で続行します。",
            session
          );
        }

        if (body.error === "expired_token") {
          sessions.delete(request.sessionId);
          return createPollResponse(
            "expired",
            "ブラウザコードログインの有効期限が切れました。もう一度開始してください。"
          );
        }

        if (body.error === "access_denied") {
          sessions.delete(request.sessionId);
          return createPollResponse(
            "denied",
            "GitHub ログインがキャンセルされました。必要ならもう一度開始してください。"
          );
        }

        return createPollResponse(
          "provider_error",
          sanitizeProviderText(body.error_description) ||
            "GitHub のログイン完了状態を確認できませんでした。",
          session
        );
      }

      if (typeof body.access_token !== "string" || body.access_token.length === 0) {
        return createPollResponse(
          "provider_error",
          "GitHub からログイン完了情報を受け取れませんでした。",
          session
        );
      }

      const userResponse = await fetchImpl(USER_URL, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${body.access_token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
      const userBody = await readJson<GitHubUserResponse>(userResponse);
      sessions.delete(request.sessionId);

      if (!userResponse.ok || typeof userBody?.login !== "string" || userBody.login.length === 0) {
        return createPollResponse(
          "provider_error",
          "GitHub アカウント名を確認できませんでした。もう一度開始してください。"
        );
      }

      return {
        contractVersion: "v1",
        status: "completed",
        githubUsername: userBody.login,
        authMethod: "device_flow",
        retryAfterSeconds: 0,
        expiresAt: null,
        message: `GitHub アカウント ${userBody.login} を確認しました。`
      };
    } catch (error) {
      return createPollResponse(
        isNetworkError(error) ? "network_error" : "provider_error",
        "GitHub に接続できませんでした。ネットワーク状態を確認して再試行してください。",
        session
      );
    }
  };

  return { start, poll };
};

const defaultDeviceFlowService = createGitHubDeviceFlowService();

export const startGitHubDeviceFlow = (): Promise<GitHubDeviceFlowStartResponse> => {
  return defaultDeviceFlowService.start();
};

export const pollGitHubDeviceFlow = (
  request: GitHubDeviceFlowPollRequest
): Promise<GitHubDeviceFlowPollResponse> => {
  return defaultDeviceFlowService.poll(request);
};
