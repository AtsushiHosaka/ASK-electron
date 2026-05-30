export interface PublicEnv {
  supabaseUrl: string;
  supabasePublishableKey: string;
  appBaseUrl: string | null;
}

export type PublicEnvResult =
  | {
      ok: true;
      env: PublicEnv;
    }
  | {
      ok: false;
      message: string;
    };

export const getPublicEnv = (): PublicEnvResult => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const appBaseUrl = import.meta.env.VITE_ASK_APP_BASE_URL?.trim() || null;

  if (!supabaseUrl || !supabasePublishableKey) {
    return {
      ok: false,
      message:
        "Supabase の公開設定がありません。VITE_SUPABASE_URL と VITE_SUPABASE_PUBLISHABLE_KEY を設定してください。"
    };
  }

  if (!supabasePublishableKey.startsWith("sb_publishable_")) {
    return {
      ok: false,
      message:
        "Supabase は新しい publishable key を使ってください。値は sb_publishable_ で始まります。"
    };
  }

  return {
    ok: true,
    env: {
      supabaseUrl,
      supabasePublishableKey,
      appBaseUrl
    }
  };
};

const normalizeHttpBaseUrl = (value: string): string | null => {
  try {
    const parsedUrl = new URL(value);

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }

    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

export const getPublicAppBaseUrl = (): string => {
  const result = getPublicEnv();

  if (!result.ok) {
    throw new Error(result.message);
  }

  const appBaseUrl = result.env.appBaseUrl;

  if (appBaseUrl) {
    const normalizedBaseUrl = normalizeHttpBaseUrl(appBaseUrl);

    if (normalizedBaseUrl) {
      return normalizedBaseUrl;
    }

    throw new Error("VITE_ASK_APP_BASE_URL は http(s) URL を指定してください。");
  }

  if (import.meta.env.DEV) {
    return window.location.origin.replace(/\/+$/, "");
  }

  throw new Error("招待リンク作成には VITE_ASK_APP_BASE_URL の設定が必要です。");
};
