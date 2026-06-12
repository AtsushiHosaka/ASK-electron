/// <reference types="vite/client" />

import type { RendererApi } from "../../shared/ipc";

declare global {
  interface Window {
    ask: RendererApi;
  }

  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
    readonly VITE_ASK_APP_BASE_URL?: string;
    readonly VITE_ASK_APP_VERSION?: string;
    readonly VITE_ASK_TELEMETRY_DISABLED?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
