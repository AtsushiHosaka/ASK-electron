import type { AuditDecision, AuditEventType, Json } from "@shared/database.types";
import { getSupabaseClient } from "./supabase";

type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface RecordAuditEventInput {
  eventType: AuditEventType;
  decision?: AuditDecision;
  operation: string;
  classId?: string | null;
  projectId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  patchProposalId?: string | null;
  ipcChannel?: string | null;
  requestId?: string | null;
  projectRootHash?: string | null;
  relativePaths?: string[];
  durationMs?: number | null;
  errorCode?: string | null;
  metadata?: AuditMetadata;
}

const unsafeKeyPattern =
  /(password|passwd|token|secret|private.?key|service.?role|env.?value|raw.?path|absolute.?path|ssh.?key)/i;

const unsafeTextPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|(^|[^a-z0-9])(sb_secret_|service_role|github[_ -]?token|access[_ -]?token|api[_ -]?key|secret[_ -]?key|password\s*[:=])|(^|[\s"'])\.env($|[\s./\\])|(^|[\s"'])\/(Users|home|var|tmp|private|Volumes|Applications|etc)(\/|[\s"']|$)|(^|[\s"'])[A-Za-z]:\\/i;

const isSafeText = (value: string): boolean => {
  return value.length <= 240 && !unsafeTextPattern.test(value);
};

const safeMetadata = (metadata: AuditMetadata | undefined): Json => {
  const result: Record<string, Json> = {};

  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (unsafeKeyPattern.test(key)) {
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

export const recordAuditEvent = async (input: RecordAuditEventInput): Promise<void> => {
  const supabase = getSupabaseClient();

  if (!supabase || !isSafeText(input.operation)) {
    return;
  }

  const relativePaths = (input.relativePaths ?? []).filter(isSafeText);

  try {
    await supabase.rpc("record_audit_event", {
      p_event_type: input.eventType,
      p_decision: input.decision ?? "succeeded",
      p_operation: input.operation,
      p_class_id: input.classId ?? null,
      p_project_id: input.projectId ?? null,
      p_thread_id: input.threadId ?? null,
      p_message_id: input.messageId ?? null,
      p_patch_proposal_id: input.patchProposalId ?? null,
      p_ipc_channel: input.ipcChannel ?? null,
      p_request_id: input.requestId ?? globalThis.crypto?.randomUUID?.() ?? null,
      p_project_root_hash: input.projectRootHash ?? null,
      p_relative_paths: relativePaths,
      p_duration_ms: input.durationMs ?? null,
      p_error_code: input.errorCode ?? null,
      p_metadata: safeMetadata(input.metadata),
      p_redaction: {
        absolute_paths_redacted: true,
        secrets_redacted: true,
        output_truncated: false
      }
    });
  } catch (error) {
    console.error("Failed to record audit event", error);
  }
};
