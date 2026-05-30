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

export const getPublicAppBaseUrl = (): string => {
  const result = getPublicEnv();

  if (result.ok && result.env.appBaseUrl) {
    return result.env.appBaseUrl.replace(/\/+$/, "");
  }

  return window.location.origin.replace(/\/+$/, "");
};
