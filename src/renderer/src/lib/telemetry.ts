import type { Json, UsageEventName } from "@shared/database.types";
import { getSupabaseClient } from "./supabase";

type UsageEventProperty = string | number | boolean | null;
type UsageEventProperties = Readonly<Record<string, UsageEventProperty>>;

export interface TrackUsageEventInput {
  eventName: UsageEventName;
  eventVersion?: number;
  screen?: string | null;
  classId?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  patchProposalId?: string | null;
  durationMs?: number | null;
  success?: boolean | null;
  errorCode?: string | null;
  properties?: UsageEventProperties;
}

const telemetrySessionStorageKey = "ask_usage_session_id";

const unsafeKeyPattern =
  /(email|mail|password|passwd|token|secret|private.?key|service.?role|env.?value|raw.?path|absolute.?path|ssh.?key|body|message|code|patch|diff|error.?text)/i;

const unsafeTextPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|[^a-z0-9])(sb_secret_|service_role|github[_ -]?token|access[_ -]?token|api[_ -]?key|secret[_ -]?key|password\s*[:=])|(^|[\s"'])\.env($|[\s./\\])|(^|[\s"'])\/(Users|home|var|tmp|private|Volumes|Applications|etc)(\/|[\s"']|$)|(^|[\s"'])[A-Za-z]:\\/i;

const isTelemetryDisabled = (): boolean => {
  const value = import.meta.env.VITE_ASK_TELEMETRY_DISABLED?.trim().toLowerCase();

  return value === "1" || value === "true" || value === "yes";
};

const isSafeText = (value: string): boolean => {
  return value.length <= 240 && !unsafeTextPattern.test(value);
};

const getUsageSessionId = (): string => {
  const existingSessionId = window.sessionStorage.getItem(telemetrySessionStorageKey);

  if (existingSessionId) {
    return existingSessionId;
  }

  const nextSessionId = globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000000";
  window.sessionStorage.setItem(telemetrySessionStorageKey, nextSessionId);

  return nextSessionId;
};

const safeTextOrNull = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  return isSafeText(value) ? value : null;
};

const safeProperties = (properties: UsageEventProperties | undefined): Json => {
  const result: Record<string, Json> = {};

  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!isSafeText(key) || unsafeKeyPattern.test(key)) {
      continue;
    }

    if (typeof value === "string") {
      if (isSafeText(value)) {
        result[key] = value;
      }
      continue;
    }

    result[key] = value;
  }

  return result;
};

export const trackUsageEvent = async (input: TrackUsageEventInput): Promise<void> => {
  if (isTelemetryDisabled()) {
    return;
  }

  const supabase = getSupabaseClient();

  if (!supabase) {
    return;
  }

  try {
    const { error } = await supabase.rpc("track_usage_event", {
      p_event_name: input.eventName,
      p_event_version: input.eventVersion ?? 1,
      p_session_id: getUsageSessionId(),
      p_screen: safeTextOrNull(input.screen),
      p_class_id: input.classId ?? null,
      p_project_id: input.projectId ?? null,
      p_thread_id: input.threadId ?? null,
      p_patch_proposal_id: input.patchProposalId ?? null,
      p_app_version: safeTextOrNull(import.meta.env.VITE_ASK_APP_VERSION),
      p_platform: safeTextOrNull(navigator.platform || null),
      p_duration_ms: input.durationMs ?? null,
      p_success: input.success ?? null,
      p_error_code: safeTextOrNull(input.errorCode),
      p_properties: safeProperties(input.properties),
      p_occurred_at: new Date().toISOString()
    });

    if (error) {
      throw error;
    }
  } catch (error) {
    console.warn("Failed to track usage event", error);
  }
};
