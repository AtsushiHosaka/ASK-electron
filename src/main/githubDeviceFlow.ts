import { randomUUID } from "node:crypto";
import type {
  GithubDeviceFlowPollRequest,
  GithubDeviceFlowPollResponse,
  GithubDeviceFlowStartResponse
} from "../shared/ipc";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_SCOPE = "read:user";

interface GithubDeviceFlowEnvironment {
  ASK_GITHUB_OAUTH_CLIENT_ID?: string;
}

interface GithubDeviceFlowDependencies {
  env?: GithubDeviceFlowEnvironment;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  createId?: () => string;
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
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
  interval?: unknown;
}

interface GithubUserResponse {
  login?: unknown;
  message?: unknown;
}

interface PendingDeviceFlow {
  deviceCode: string;
  expiresAtMs: number;
  intervalSeconds: number;
  clientId: string;
}

const pendingFlows = new Map<string, PendingDeviceFlow>();

const getEnv = (dependencies: GithubDeviceFlowDependencies): GithubDeviceFlowEnvironment => {
  return dependencies.env ?? process.env;
};

const getNow = (dependencies: GithubDeviceFlowDependencies): Date => {
  return dependencies.now?.() ?? new Date();
};

const getFetch = (dependencies: GithubDeviceFlowDependencies): typeof fetch => {
  return dependencies.fetchImpl ?? fetch;
};

const isPositiveNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
};

const getSafeMessage = (fallback: string, value: unknown): string => {
  return (typeof value === "string" && value.trim() ? value : fallback)
    .replace(/\s+/g, " ")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}/g, "[redacted github token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}/g, "[redacted github token]")
    .slice(0, 240);
};

const postGithubForm = async <T>(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams
): Promise<T> => {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ASK Electron"
    },
    body
  });
  const data = (await response.json().catch(() => null)) as T | null;

  if (!response.ok || !data) {
    throw new Error("GitHub Device Flow request failed.");
  }

  return data;
};

const getGithubUsername = async (
  fetchImpl: typeof fetch,
  accessToken: string
): Promise<string | null> => {
  const response = await fetchImpl(USER_URL, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "ASK Electron",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  const data = (await response.json().catch(() => null)) as GithubUserResponse | null;

  if (!response.ok || !data || typeof data.login !== "string" || !data.login.trim()) {
    return null;
  }

  return data.login.trim();
};

const isSafeGithubVerificationUri = (value: string): boolean => {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "https:" && parsedUrl.hostname === "github.com";
  } catch {
    return false;
  }
};

export const startGithubDeviceFlow = async (
  dependencies: GithubDeviceFlowDependencies = {}
): Promise<GithubDeviceFlowStartResponse> => {
  const clientId = getEnv(dependencies).ASK_GITHUB_OAUTH_CLIENT_ID?.trim();

  if (!clientId) {
    return {
      contractVersion: "v1",
      status: "not_configured",
      flowId: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      intervalSeconds: null,
      message:
        "GitHub Device Flow が設定されていません。先生に ASK_GITHUB_OAUTH_CLIENT_ID の設定を依頼してください。"
    };
  }

  const data = await postGithubForm<DeviceCodeResponse>(
    getFetch(dependencies),
    DEVICE_CODE_URL,
    new URLSearchParams({
      client_id: clientId,
      scope: DEFAULT_SCOPE
    })
  );

  if (
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string" ||
    !isPositiveNumber(data.expires_in) ||
    !isSafeGithubVerificationUri(data.verification_uri)
  ) {
    return {
      contractVersion: "v1",
      status: "error",
      flowId: null,
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      intervalSeconds: null,
      message: getSafeMessage("GitHub Device Flow を開始できませんでした。", data.error_description)
    };
  }

  const flowId = dependencies.createId?.() ?? randomUUID();
  const intervalSeconds = isPositiveNumber(data.interval)
    ? Math.max(DEFAULT_INTERVAL_SECONDS, Math.floor(data.interval))
    : DEFAULT_INTERVAL_SECONDS;
  const expiresAtMs = getNow(dependencies).getTime() + data.expires_in * 1000;

  pendingFlows.set(flowId, {
    deviceCode: data.device_code,
    expiresAtMs,
    intervalSeconds,
    clientId
  });

  return {
    contractVersion: "v1",
    status: "started",
    flowId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: new Date(expiresAtMs).toISOString(),
    intervalSeconds,
    message: "GitHub のブラウザコードログインを開始しました。"
  };
};

export const pollGithubDeviceFlow = async (
  request: GithubDeviceFlowPollRequest,
  dependencies: GithubDeviceFlowDependencies = {}
): Promise<GithubDeviceFlowPollResponse> => {
  const pendingFlow = pendingFlows.get(request.flowId);
  const now = getNow(dependencies).getTime();

  if (!pendingFlow || pendingFlow.expiresAtMs <= now) {
    pendingFlows.delete(request.flowId);
    return {
      contractVersion: "v1",
      status: "expired",
      githubUsername: null,
      retryAfterSeconds: null,
      message: "GitHub Device Flow の有効期限が切れました。もう一度開始してください。"
    };
  }

  const data = await postGithubForm<AccessTokenResponse>(
    getFetch(dependencies),
    ACCESS_TOKEN_URL,
    new URLSearchParams({
      client_id: pendingFlow.clientId,
      device_code: pendingFlow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    })
  );

  if (typeof data.access_token === "string" && data.access_token.trim()) {
    pendingFlows.delete(request.flowId);
    const githubUsername = await getGithubUsername(getFetch(dependencies), data.access_token);

    if (!githubUsername) {
      return {
        contractVersion: "v1",
        status: "error",
        githubUsername: null,
        retryAfterSeconds: null,
        message: "GitHub アカウント名を取得できませんでした。もう一度試してください。"
      };
    }

    return {
      contractVersion: "v1",
      status: "authorized",
      githubUsername,
      retryAfterSeconds: null,
      message: "GitHub アカウントを確認しました。"
    };
  }

  const errorCode = typeof data.error === "string" ? data.error : null;

  if (errorCode === "authorization_pending") {
    return {
      contractVersion: "v1",
      status: "pending",
      githubUsername: null,
      retryAfterSeconds: pendingFlow.intervalSeconds,
      message: "GitHub の承認完了を待っています。"
    };
  }

  if (errorCode === "slow_down") {
    pendingFlow.intervalSeconds += 5;
    return {
      contractVersion: "v1",
      status: "slow_down",
      githubUsername: null,
      retryAfterSeconds: pendingFlow.intervalSeconds,
      message: "GitHub の確認間隔を少し空けます。"
    };
  }

  if (errorCode === "expired_token") {
    pendingFlows.delete(request.flowId);
    return {
      contractVersion: "v1",
      status: "expired",
      githubUsername: null,
      retryAfterSeconds: null,
      message: "GitHub Device Flow の有効期限が切れました。もう一度開始してください。"
    };
  }

  if (errorCode === "access_denied") {
    pendingFlows.delete(request.flowId);
    return {
      contractVersion: "v1",
      status: "access_denied",
      githubUsername: null,
      retryAfterSeconds: null,
      message: "GitHub の承認がキャンセルされました。必要なら再試行してください。"
    };
  }

  return {
    contractVersion: "v1",
    status: "error",
    githubUsername: null,
    retryAfterSeconds: null,
    message: getSafeMessage(
      "GitHub Device Flow の状態を確認できませんでした。",
      data.error_description
    )
  };
};
