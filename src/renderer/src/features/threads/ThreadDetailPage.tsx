import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import type { AiAssistRequest, AiContextEntry } from "../../../../shared/aiPipeline";
import type {
  Database,
  MessageSenderType,
  MessageType,
  PatchStatus,
  ThreadStatus
} from "../../../../shared/database.types";
import type {
  PatchApplyResponse,
  PatchApplyStatus,
  PatchRevertResponse,
  PatchRevertStatus,
  PatchValidateResponse,
  PatchValidationStatus
} from "../../../../shared/ipc";
import {
  normalizePatchTargetPath,
  parseAiPatchProposalOutput,
  validatePatchProposalDraft,
  type PatchProposalDraft
} from "../../../../shared/patchProposal";
import { scanSecrets, type SecretScanFinding } from "../../../../shared/secretScanner";
import { CodeContextViewer } from "../../components/CodeContextViewer";
import { MarkdownMessage } from "../../components/MarkdownMessage";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";
import { trackUsageEvent } from "../../lib/telemetry";
import {
  buildChatMessageInsert,
  removeMessage,
  removePatchProposal,
  sortMessages,
  upsertMessage,
  upsertPatchProposal,
  type MessageRow,
  type PatchProposalRow,
  type PatchProposalSummary
} from "./threadMessageState";

type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];
type ProjectSummary = Pick<ProjectRow, "id" | "local_path_hash" | "name">;

interface ThreadDetailState {
  loading: boolean;
  error: string | null;
  thread: ThreadRow | null;
  project: ProjectSummary | null;
  messages: MessageRow[];
  patchProposalsByMessageId: Map<string, PatchProposalSummary>;
  usersById: Map<string, Pick<UserRow, "id" | "display_name" | "email" | "role">>;
}

interface PatchReviewState {
  validating: boolean;
  applying: boolean;
  reverting: boolean;
  dismissing: boolean;
  validation: PatchValidateResponse | null;
  applyResult: PatchApplyResponse | null;
  revertResult: PatchRevertResponse | null;
  error: string | null;
}

const initialState: ThreadDetailState = {
  loading: true,
  error: null,
  thread: null,
  project: null,
  messages: [],
  patchProposalsByMessageId: new Map(),
  usersById: new Map()
};

const messageTypeLabels: Record<MessageType, string> = {
  text: "文章",
  code: "コード",
  environment: "環境",
  ai_summary: "AI補助",
  patch: "パッチ"
};

const manualMessageTypes = ["text", "code", "environment", "patch"] as const;
type ManualMessageType = (typeof manualMessageTypes)[number];

const senderLabels: Record<MessageSenderType, string> = {
  student: "生徒",
  teacher: "先生",
  ai: "AI",
  system: "System"
};

const statusLabels: Record<ThreadStatus, string> = {
  open: "未対応",
  in_progress: "対応中",
  waiting_student: "生徒確認待ち",
  patch_proposed: "パッチ提案中",
  resolved: "解決済み",
  reopened: "再オープン"
};

const threadStatuses: ThreadStatus[] = [
  "open",
  "in_progress",
  "waiting_student",
  "patch_proposed",
  "resolved",
  "reopened"
];

const studentLifecycleStatuses: ThreadStatus[] = ["resolved", "reopened"];

const patchValidationLabels: Record<PatchValidationStatus, string> = {
  ready: "適用可能",
  root_missing: "ローカル未設定",
  invalid_patch: "パッチ不正",
  denied_path: "保護対象",
  git_missing: "Git未検出",
  git_timeout: "Gitタイムアウト",
  base_mismatch: "ベース不一致",
  dirty: "未コミット変更あり",
  conflict: "競合",
  permission_denied: "権限エラー"
};

const patchApplyLabels: Record<PatchApplyStatus, string> = {
  applied: "適用済み",
  stale: "再確認が必要",
  dirty: "未コミット変更あり",
  conflict: "競合",
  git_missing: "Git未検出",
  git_timeout: "Gitタイムアウト",
  permission_denied: "権限エラー",
  failed: "失敗"
};

const patchRevertLabels: Record<PatchRevertStatus, string> = {
  reverted: "取り消し済み",
  root_missing: "ローカル未設定",
  stale: "再確認が必要",
  dirty: "適用後変更あり",
  backup_missing: "バックアップ未検出",
  git_missing: "Git未検出",
  git_timeout: "Gitタイムアウト",
  permission_denied: "権限エラー",
  failed: "失敗"
};

const patchProposalStatusLabels: Record<PatchStatus, string> = {
  proposed: "提案中",
  applied: "適用済み",
  failed: "失敗",
  reverted: "取り消し済み",
  dismissed: "却下済み"
};

const AI_ESCALATION_MESSAGE_LIMIT = 8;

type LifecycleMessageStatus = "success" | "warning" | "error";

const formatSecretFindingForUi = (finding: SecretScanFinding): string => {
  const line = finding.lineNumber ? `:${finding.lineNumber}` : "";
  return `${finding.sourceLabel}${line} - ${finding.message}`;
};

const formatMessageTime = (value: string): string =>
  new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));

const MESSAGE_PREVIEW_CHAR_LIMIT = 120;

const countTextLines = (value: string): number => {
  const lines = value.split(/\r\n|\r|\n/);
  return Math.max(lines.length, value.length > 0 ? 1 : 0);
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const stripMarkdownForPreview = (value: string): string =>
  collapseWhitespace(
    value
      .replace(/```[\s\S]*?```/g, " コード ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/[*_~|]/g, " ")
  );

const extractMarkdownPreview = (value: string): string => {
  const lines = value
    .replace(/```[\s\S]*?```/g, "\n")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim());
  const paragraph: string[] = [];

  for (const line of lines) {
    if (!line) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }

    if (/^#{1,6}\s+/.test(line) || /^-{3,}$/.test(line)) {
      continue;
    }

    paragraph.push(line);
  }

  return stripMarkdownForPreview(paragraph.join(" "));
};

const clipMessagePreview = (value: string): string => {
  const preview = collapseWhitespace(value);

  if (preview.length <= MESSAGE_PREVIEW_CHAR_LIMIT) {
    return preview || "詳細を確認";
  }

  return `${preview.slice(0, MESSAGE_PREVIEW_CHAR_LIMIT).trimEnd()}...`;
};

const firstContentLine = (value: string): string =>
  value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

const buildMessageSummary = (
  message: MessageRow,
  patchProposal: PatchProposalSummary | null
): { preview: string; meta: string | null } => {
  const lineCount = countTextLines(message.body);

  if (message.message_type === "code") {
    return {
      preview: clipMessagePreview(firstContentLine(message.body) || "コード"),
      meta: `${lineCount}行`
    };
  }

  if (message.message_type === "patch") {
    return {
      preview: clipMessagePreview(
        patchProposal?.explanation ??
          patchProposal?.target_file_path ??
          firstContentLine(message.body) ??
          "パッチ提案"
      ),
      meta: patchProposal?.target_file_path ?? `${lineCount}行`
    };
  }

  const plainText = extractMarkdownPreview(message.body);
  return {
    preview: clipMessagePreview(plainText),
    meta: lineCount > 4 ? `${lineCount}行` : null
  };
};

const isMessageOwnForViewer = (
  message: MessageRow,
  profileId: string | null | undefined
): boolean =>
  message.sender_type !== "ai" &&
  message.sender_type !== "system" &&
  message.message_type !== "ai_summary" &&
  message.sender_user_id === profileId;

const getMessageDisplayName = (
  message: MessageRow,
  senderName: string | null | undefined,
  isOwnMessage: boolean
): string | null => {
  if (isOwnMessage) {
    return null;
  }

  if (message.sender_type === "ai" || message.message_type === "ai_summary") {
    return senderLabels.ai;
  }

  return senderName ?? senderLabels[message.sender_type];
};

const THREAD_AI_MESSAGE_CHAR_LIMIT = 1_000;

const unique = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value)))
];

const clipThreadAiText = (value: string): string => {
  if (value.length <= THREAD_AI_MESSAGE_CHAR_LIMIT) {
    return value;
  }

  return `${value.slice(0, THREAD_AI_MESSAGE_CHAR_LIMIT).trimEnd()}\n[長いため一部省略]`;
};

const initialPatchReviewState: PatchReviewState = {
  validating: false,
  applying: false,
  reverting: false,
  dismissing: false,
  validation: null,
  applyResult: null,
  revertResult: null,
  error: null
};

const extractExpectedBaseCommit = (messageBody: string): string | null => {
  const match =
    /(?:^|\n)\s*(?:Base-Commit|Base commit|base commit|base_commit)\s*:\s*([a-f0-9]{7,64})\b/i.exec(
      messageBody
    );

  return match?.[1] ?? null;
};

const shortCommit = (commit: string | null): string => {
  return commit ? commit.slice(0, 12) : "未取得";
};

const validationMessageClass = (
  validation: PatchValidateResponse
): "error" | "success" | "warning" => {
  if (validation.canApply) {
    return "success";
  }

  return validation.status === "dirty" ||
    validation.status === "conflict" ||
    validation.status === "base_mismatch" ||
    validation.status === "git_timeout" ||
    validation.status === "permission_denied"
    ? "warning"
    : "error";
};

const applyMessageClass = (applyResult: PatchApplyResponse): "error" | "success" | "warning" => {
  if (applyResult.applied) {
    return "success";
  }

  return applyResult.status === "dirty" ||
    applyResult.status === "conflict" ||
    applyResult.status === "stale" ||
    applyResult.status === "git_timeout"
    ? "warning"
    : "error";
};

const revertMessageClass = (revertResult: PatchRevertResponse): "error" | "success" | "warning" => {
  if (revertResult.reverted) {
    return "success";
  }

  return revertResult.status === "dirty" ||
    revertResult.status === "stale" ||
    revertResult.status === "git_timeout"
    ? "warning"
    : "error";
};

export const ThreadDetailPage = (): ReactElement => {
  const { threadId } = useParams();
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<ThreadDetailState>(initialState);
  const [messageType, setMessageType] = useState<ManualMessageType>("text");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [detailMessageId, setDetailMessageId] = useState<string | null>(null);
  const [patchReviews, setPatchReviews] = useState<Record<string, PatchReviewState>>({});
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPatchGenerating, setAiPatchGenerating] = useState(false);
  const [aiPatchError, setAiPatchError] = useState<string | null>(null);
  const [teacherPatchTargetFilePath, setTeacherPatchTargetFilePath] = useState("");
  const [teacherPatchBaseCommitSha, setTeacherPatchBaseCommitSha] = useState("");
  const [teacherPatchExplanation, setTeacherPatchExplanation] = useState("");
  const [teacherPatchText, setTeacherPatchText] = useState("");
  const [teacherPatchSaving, setTeacherPatchSaving] = useState(false);
  const [teacherPatchError, setTeacherPatchError] = useState<string | null>(null);
  const [teacherPatchNotice, setTeacherPatchNotice] = useState<string | null>(null);
  const [lifecycleUpdating, setLifecycleUpdating] = useState(false);
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
  const [lifecycleMessageStatus, setLifecycleMessageStatus] =
    useState<LifecycleMessageStatus>("success");
  const [aiEscalationConfirmation, setAiEscalationConfirmation] = useState("");
  const [aiEscalationReviewOpen, setAiEscalationReviewOpen] = useState(false);
  const [aiEscalating, setAiEscalating] = useState(false);
  const [aiEscalationMessage, setAiEscalationMessage] = useState<string | null>(null);
  const [aiEscalationMessageStatus, setAiEscalationMessageStatus] =
    useState<LifecycleMessageStatus>("success");
  const [aiEscalationAllowedFindingIds, setAiEscalationAllowedFindingIds] = useState<string[]>([]);
  const canUseTeacherLifecycleControls = profile?.role === "teacher" || profile?.role === "admin";
  const canUseStudentLifecycleControls =
    profile?.role === "student" && state.thread?.created_by === profile.id;
  const canUseLifecycleControls = canUseTeacherLifecycleControls || canUseStudentLifecycleControls;
  const canEscalateAiToTeacher =
    profile?.role === "student" && state.thread?.created_by === profile.id;

  useEffect(() => {
    let mounted = true;

    const loadThread = async (): Promise<void> => {
      if (!supabase || !threadId) {
        setState({
          ...initialState,
          loading: false,
          error: "スレッドを確認できませんでした。"
        });
        return;
      }

      try {
        const [threadResult, messagesResult] = await Promise.all([
          supabase
            .from("threads")
            .select("id,project_id,created_by,title,status,priority,ai_used,created_at,updated_at")
            .eq("id", threadId)
            .single(),
          supabase
            .from("messages")
            .select(
              "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
            )
            .eq("thread_id", threadId)
            .order("created_at", { ascending: true })
        ]);

        if (threadResult.error || messagesResult.error) {
          throw threadResult.error ?? messagesResult.error;
        }

        const messages = messagesResult.data ?? [];
        const messageIds = messages.map((message) => message.id);
        const senderIds = unique(messages.map((message) => message.sender_user_id));
        const [usersResult, projectResult, patchProposalsResult] = await Promise.all([
          senderIds.length > 0
            ? supabase.from("users").select("id,display_name,email,role").in("id", senderIds)
            : Promise.resolve({ data: [], error: null }),
          supabase
            .from("projects")
            .select("id,name,local_path_hash")
            .eq("id", threadResult.data.project_id)
            .single(),
          messageIds.length > 0
            ? supabase
                .from("patch_proposals")
                .select(
                  "id,message_id,status,target_file_path,base_commit_sha,explanation,created_by_type"
                )
                .in("message_id", messageIds)
            : Promise.resolve({ data: [], error: null })
        ]);

        if (usersResult.error) {
          throw usersResult.error;
        }

        if (projectResult.error) {
          console.warn("Failed to load thread project summary", projectResult.error);
        }

        if (patchProposalsResult.error) {
          console.warn("Failed to load thread patch proposals", patchProposalsResult.error);
        }

        if (mounted) {
          setState({
            loading: false,
            error: null,
            thread: threadResult.data,
            project: projectResult.error ? null : projectResult.data,
            messages,
            patchProposalsByMessageId: new Map(
              (patchProposalsResult.error ? [] : (patchProposalsResult.data ?? [])).map(
                (proposal) => [proposal.message_id, proposal]
              )
            ),
            usersById: new Map((usersResult.data ?? []).map((user) => [user.id, user]))
          });
        }
      } catch (error) {
        console.error("Failed to load thread detail", error);

        if (mounted) {
          setState({
            ...initialState,
            loading: false,
            error: "スレッドを読み込めませんでした。担当外または存在しない可能性があります。"
          });
        }
      }
    };

    void loadThread();

    return () => {
      mounted = false;
    };
  }, [supabase, threadId]);

  useEffect(() => {
    if (!supabase || !threadId) {
      return;
    }

    let active = true;

    const loadSender = async (senderUserId: string | null): Promise<void> => {
      if (!senderUserId) {
        return;
      }

      let alreadyLoaded = false;
      setState((current) => {
        alreadyLoaded = current.usersById.has(senderUserId);
        return current;
      });

      if (alreadyLoaded) {
        return;
      }

      const { data, error } = await supabase
        .from("users")
        .select("id,display_name,email,role")
        .eq("id", senderUserId)
        .maybeSingle();

      if (!active || error || !data) {
        return;
      }

      setState((current) => {
        if (current.usersById.has(data.id)) {
          return current;
        }

        const usersById = new Map(current.usersById);
        usersById.set(data.id, data);
        return { ...current, usersById };
      });
    };

    const loadPatchMessage = async (proposal: PatchProposalSummary): Promise<void> => {
      const { data, error } = await supabase
        .from("messages")
        .select(
          "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
        )
        .eq("id", proposal.message_id)
        .eq("thread_id", threadId)
        .maybeSingle();

      if (!active || error || !data) {
        return;
      }

      setState((current) => ({
        ...current,
        messages: upsertMessage(current.messages, data),
        patchProposalsByMessageId: upsertPatchProposal(current.patchProposalsByMessageId, proposal)
      }));
      void loadSender(data.sender_user_id);
    };

    const channel = supabase
      .channel(`thread-detail-${threadId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `thread_id=eq.${threadId}`
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const messageId = (payload.old as Partial<MessageRow>).id;

            if (!messageId) {
              return;
            }

            setState((current) => ({
              ...current,
              messages: removeMessage(current.messages, messageId),
              patchProposalsByMessageId: removePatchProposal(
                current.patchProposalsByMessageId,
                null,
                messageId
              )
            }));
            return;
          }

          const nextMessage = payload.new as MessageRow;
          setState((current) => ({
            ...current,
            messages: upsertMessage(current.messages, nextMessage)
          }));
          void loadSender(nextMessage.sender_user_id);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "patch_proposals"
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldProposal = payload.old as Partial<PatchProposalRow>;
            setState((current) => ({
              ...current,
              patchProposalsByMessageId: removePatchProposal(
                current.patchProposalsByMessageId,
                oldProposal.id ?? null,
                oldProposal.message_id ?? null
              )
            }));
            return;
          }

          const proposal = payload.new as PatchProposalSummary;
          let messageKnown = false;

          setState((current) => {
            messageKnown = current.messages.some((message) => message.id === proposal.message_id);

            if (!messageKnown) {
              return current;
            }

            return {
              ...current,
              patchProposalsByMessageId: upsertPatchProposal(
                current.patchProposalsByMessageId,
                proposal
              )
            };
          });

          if (!messageKnown) {
            void loadPatchMessage(proposal);
          }
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "threads",
          filter: `id=eq.${threadId}`
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setState((current) => ({
              ...current,
              thread: null,
              error: "スレッドは削除されました。"
            }));
            return;
          }

          const nextThread = payload.new as ThreadRow;
          setState((current) => ({
            ...current,
            thread: nextThread
          }));
        }
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [supabase, threadId]);

  const updatePatchReview = (
    messageId: string,
    updater: (current: PatchReviewState) => PatchReviewState
  ): void => {
    setPatchReviews((current) => ({
      ...current,
      [messageId]: updater(current[messageId] ?? initialPatchReviewState)
    }));
  };

  const updatePatchProposalStatus = async (
    messageId: string,
    status: PatchStatus
  ): Promise<void> => {
    if (!supabase) {
      throw new Error("Supabase client is not configured");
    }

    const proposal = state.patchProposalsByMessageId.get(messageId);

    if (!proposal) {
      return;
    }

    const { error } = await supabase
      .from("patch_proposals")
      .update({ status })
      .eq("id", proposal.id);

    if (error) {
      throw error;
    }

    setState((current) => {
      const currentProposal = current.patchProposalsByMessageId.get(messageId);

      if (!currentProposal) {
        return current;
      }

      const nextPatchProposalsByMessageId = new Map(current.patchProposalsByMessageId);
      nextPatchProposalsByMessageId.set(messageId, {
        ...currentProposal,
        status
      });

      return {
        ...current,
        patchProposalsByMessageId: nextPatchProposalsByMessageId
      };
    });
  };

  const validatePatchMessage = async (message: MessageRow): Promise<void> => {
    if (profile?.role !== "student") {
      return;
    }

    const localPathHash = state.project?.local_path_hash ?? null;

    if (!localPathHash) {
      updatePatchReview(message.id, (current) => ({
        ...current,
        error: "このプロジェクトのローカルフォルダが登録されていません。"
      }));
      return;
    }

    updatePatchReview(message.id, (current) => ({
      ...current,
      validating: true,
      applyResult: null,
      error: null
    }));

    try {
      const result = await window.ask.patch.validate({
        requesterRole: profile.role,
        localPathHash,
        patchText: message.body,
        expectedBaseCommit:
          state.patchProposalsByMessageId.get(message.id)?.base_commit_sha ??
          extractExpectedBaseCommit(message.body),
        patchProposalId: state.patchProposalsByMessageId.get(message.id)?.id ?? null
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      updatePatchReview(message.id, (current) => ({
        ...current,
        validating: false,
        validation: result.data,
        error: null
      }));
    } catch (error) {
      console.error("Failed to validate patch", error);
      updatePatchReview(message.id, (current) => ({
        ...current,
        validating: false,
        error: "パッチを確認できませんでした。"
      }));
    }
  };

  const applyPatchMessage = async (message: MessageRow): Promise<void> => {
    if (profile?.role !== "student") {
      return;
    }

    if (!state.thread) {
      return;
    }

    const validation = patchReviews[message.id]?.validation;

    if (!validation?.patchId || !validation.confirmationToken || !validation.canApply) {
      updatePatchReview(message.id, (current) => ({
        ...current,
        error: "先にパッチの安全確認を完了してください。"
      }));
      return;
    }

    updatePatchReview(message.id, (current) => ({
      ...current,
      applying: true,
      error: null
    }));

    try {
      const result = await window.ask.patch.apply({
        requesterRole: profile.role,
        patchId: validation.patchId,
        confirmationToken: validation.confirmationToken
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      let statusError: string | null = null;

      try {
        await updatePatchProposalStatus(message.id, result.data.applied ? "applied" : "failed");
      } catch (error) {
        console.error("Failed to update patch proposal status", error);
        statusError = "パッチ状態を保存できませんでした。";
      }

      updatePatchReview(message.id, (current) => ({
        ...current,
        applying: false,
        applyResult: result.data,
        error: statusError
      }));
      void trackUsageEvent({
        eventName: result.data.applied ? "patch_applied" : "patch_failed",
        projectId: state.thread.project_id,
        threadId: state.thread.id,
        patchProposalId: validation.patchId,
        success: result.data.applied,
        errorCode: result.data.applied ? null : result.data.status,
        properties: {
          status: result.data.status
        }
      });
    } catch (error) {
      console.error("Failed to apply patch", error);
      updatePatchReview(message.id, (current) => ({
        ...current,
        applying: false,
        error: "パッチを適用できませんでした。"
      }));
      void trackUsageEvent({
        eventName: "patch_failed",
        projectId: state.thread.project_id,
        threadId: state.thread.id,
        patchProposalId: validation.patchId,
        success: false,
        errorCode: "patch_apply_failed"
      });
    }
  };

  const revertPatchMessage = async (message: MessageRow): Promise<void> => {
    if (profile?.role !== "student") {
      return;
    }

    const localPathHash = state.project?.local_path_hash ?? null;
    const proposal = state.patchProposalsByMessageId.get(message.id);
    const appliedPatch = patchReviews[message.id]?.applyResult;
    const patchId = proposal?.id ?? appliedPatch?.patchId ?? null;

    if (!patchId) {
      updatePatchReview(message.id, (current) => ({
        ...current,
        error: "パッチ提案の状態を確認できませんでした。"
      }));
      return;
    }

    updatePatchReview(message.id, (current) => ({
      ...current,
      reverting: true,
      error: null
    }));

    try {
      const backupDirectory =
        appliedPatch?.backupDirectory ?? (proposal ? `.ask/backups/${proposal.id}` : null);
      const result = await window.ask.patch.revert({
        requesterRole: profile.role,
        localPathHash,
        patchId,
        backupDirectory
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      let statusError: string | null = null;

      if (result.data.reverted) {
        try {
          await updatePatchProposalStatus(message.id, "reverted");
        } catch (error) {
          console.error("Failed to update patch proposal status", error);
          statusError = "取り消し状態を保存できませんでした。";
        }
      }

      updatePatchReview(message.id, (current) => ({
        ...current,
        reverting: false,
        revertResult: result.data,
        error: statusError
      }));
      void trackUsageEvent({
        eventName: "patch_reverted",
        projectId: state.thread?.project_id ?? null,
        threadId: state.thread?.id ?? null,
        patchProposalId: patchId,
        success: result.data.reverted,
        errorCode: result.data.reverted ? null : result.data.status,
        properties: {
          status: result.data.status
        }
      });
    } catch (error) {
      console.error("Failed to revert patch", error);
      updatePatchReview(message.id, (current) => ({
        ...current,
        reverting: false,
        error: "パッチを取り消せませんでした。"
      }));
    }
  };

  const dismissPatchMessage = async (message: MessageRow): Promise<void> => {
    if (profile?.role !== "student") {
      return;
    }

    updatePatchReview(message.id, (current) => ({
      ...current,
      dismissing: true,
      error: null
    }));

    try {
      await updatePatchProposalStatus(message.id, "dismissed");
      updatePatchReview(message.id, (current) => ({
        ...current,
        dismissing: false,
        error: null
      }));
      void trackUsageEvent({
        eventName: "patch_dismissed",
        projectId: state.thread?.project_id ?? null,
        threadId: state.thread?.id ?? null,
        patchProposalId: state.patchProposalsByMessageId.get(message.id)?.id ?? null,
        success: true
      });
    } catch (error) {
      console.error("Failed to dismiss patch", error);
      updatePatchReview(message.id, (current) => ({
        ...current,
        dismissing: false,
        error: "パッチを却下済みにできませんでした。"
      }));
    }
  };

  const sendMessage = async (): Promise<void> => {
    if (!supabase || !profile || !state.thread) {
      setSendError("送信に必要な情報を確認できませんでした。");
      return;
    }

    const messageInsert = buildChatMessageInsert({
      threadId: state.thread.id,
      senderUserId: profile.id,
      senderRole: profile.role,
      body,
      messageType
    });

    if (!messageInsert.ok) {
      setSendError(messageInsert.error);
      return;
    }

    setSending(true);
    setSendError(null);

    try {
      const { error } = await supabase.from("messages").insert(messageInsert.message);

      if (error) {
        throw error;
      }

      void trackUsageEvent({
        eventName: "message_sent",
        projectId: state.thread.project_id,
        threadId: state.thread.id,
        success: true,
        properties: {
          message_type: messageType,
          sender_type: messageInsert.senderType
        }
      });
      setBody("");
      setMessageType("text");
    } catch (error) {
      console.error("Failed to send message", error);
      setSendError("メッセージを送信できませんでした。内容は保持しています。");
    } finally {
      setSending(false);
    }
  };

  const updateThreadLifecycleStatus = async (nextStatus: ThreadStatus): Promise<void> => {
    if (!supabase || !profile || !state.thread || nextStatus === state.thread.status) {
      return;
    }

    const canUpdateAsTeacher = profile.role === "teacher" || profile.role === "admin";
    const canUpdateAsStudent =
      profile.role === "student" &&
      state.thread.created_by === profile.id &&
      studentLifecycleStatuses.includes(nextStatus);

    if (!canUpdateAsTeacher && !canUpdateAsStudent) {
      setLifecycleMessageStatus("warning");
      setLifecycleMessage("このスレッドのステータスは変更できません。");
      return;
    }

    const previousThread = state.thread;
    const changedAt = new Date().toISOString();
    const senderType: MessageSenderType = profile.role === "student" ? "student" : "teacher";
    const actorLabel = senderType === "student" ? "生徒" : "先生";

    setLifecycleUpdating(true);
    setLifecycleMessage(null);

    try {
      const { error: updateError } = await supabase
        .from("threads")
        .update({
          status: nextStatus,
          updated_at: changedAt
        })
        .eq("id", previousThread.id);

      if (updateError) {
        throw updateError;
      }

      const { data: lifecycleHistoryMessage, error: messageError } = await supabase
        .from("messages")
        .insert({
          thread_id: previousThread.id,
          sender_user_id: profile.id,
          sender_type: senderType,
          body: `${actorLabel}がステータスを「${statusLabels[previousThread.status]}」から「${statusLabels[nextStatus]}」に変更しました。`,
          message_type: "text"
        })
        .select(
          "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
        )
        .single();

      if (messageError) {
        const { error: rollbackError } = await supabase
          .from("threads")
          .update({
            status: previousThread.status,
            updated_at: previousThread.updated_at
          })
          .eq("id", previousThread.id);

        if (rollbackError) {
          console.error("Failed to rollback thread lifecycle status", rollbackError);
        }

        throw messageError;
      }

      setState((current) => ({
        ...current,
        thread:
          current.thread?.id === previousThread.id
            ? { ...current.thread, status: nextStatus, updated_at: changedAt }
            : current.thread,
        messages: lifecycleHistoryMessage
          ? upsertMessage(current.messages, lifecycleHistoryMessage)
          : current.messages
      }));
      setLifecycleMessageStatus("success");
      setLifecycleMessage("ステータスを更新しました。");
      void trackUsageEvent({
        eventName: "thread_status_changed",
        projectId: previousThread.project_id,
        threadId: previousThread.id,
        success: true,
        properties: {
          previous_status: previousThread.status,
          next_status: nextStatus,
          actor_type: senderType
        }
      });
    } catch (error) {
      console.error("Failed to update thread lifecycle status", error);
      setLifecycleMessageStatus("error");
      setLifecycleMessage("ステータスを更新できませんでした。");
    } finally {
      setLifecycleUpdating(false);
    }
  };

  const buildThreadAiContext = (): AiContextEntry[] => {
    if (!state.thread) {
      return [];
    }

    const threadExcerpt = state.messages
      .slice(-8)
      .map((message) => {
        const sender =
          message.sender_user_id !== null
            ? (state.usersById.get(message.sender_user_id)?.display_name ??
              senderLabels[message.sender_type])
            : senderLabels[message.sender_type];

        return `[${sender} / ${messageTypeLabels[message.message_type]}]\n${clipThreadAiText(message.body)}`;
      })
      .join("\n\n---\n\n");

    const entries: AiContextEntry[] = [
      { label: "スレッドタイトル", kind: "user_text", value: state.thread.title },
      { label: "スレッド状態", kind: "thread_excerpt", value: statusLabels[state.thread.status] },
      { label: "直近メッセージ", kind: "thread_excerpt", value: threadExcerpt }
    ];

    return entries.filter((entry) => entry.value.trim().length > 0);
  };

  const formatEscalationTranscriptMessage = (message: MessageRow): string => {
    const sender =
      message.sender_user_id !== null
        ? (state.usersById.get(message.sender_user_id)?.display_name ??
          senderLabels[message.sender_type])
        : senderLabels[message.sender_type];
    const patchProposal = state.patchProposalsByMessageId.get(message.id);
    const proposalLabel =
      patchProposal?.created_by_type === "ai"
        ? " / AIパッチ提案"
        : patchProposal
          ? " / 先生パッチ提案"
          : "";

    return [
      `### ${sender} / ${messageTypeLabels[message.message_type]}${proposalLabel}`,
      clipThreadAiText(message.body)
    ].join("\n");
  };

  const buildAiEscalationMessageBody = (): string => {
    if (!state.thread) {
      return "";
    }

    const aiMessages = state.messages.filter((message) => {
      const patchProposal = state.patchProposalsByMessageId.get(message.id);
      return (
        message.sender_type === "ai" ||
        message.message_type === "ai_summary" ||
        patchProposal?.created_by_type === "ai"
      );
    });
    const aiTranscript = aiMessages
      .slice(-AI_ESCALATION_MESSAGE_LIMIT)
      .map(formatEscalationTranscriptMessage)
      .join("\n\n---\n\n");
    const recentContext = state.messages
      .slice(-AI_ESCALATION_MESSAGE_LIMIT)
      .map(formatEscalationTranscriptMessage)
      .join("\n\n---\n\n");
    const aiFailureContext = [
      aiError ? `- 原因候補: ${aiError}` : null,
      aiPatchError ? `- パッチ案: ${aiPatchError}` : null
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");

    return [
      "## 先生へのエスカレーション",
      aiEscalationConfirmation.trim(),
      "",
      "## 現在のスレッド",
      `- タイトル: ${state.thread.title}`,
      `- 状態: ${statusLabels[state.thread.status]}`,
      `- メッセージ数: ${state.messages.length}`,
      "",
      "## AI補助コンテキスト",
      aiTranscript || "保存済みの AI 補助メッセージはまだありません。",
      "",
      aiFailureContext ? `## 直近AIエラー\n${aiFailureContext}` : null,
      "",
      "## 直近スレッド文脈",
      recentContext || "まだメッセージがありません。",
      "",
      "## 注意",
      "AI 出力は補助情報です。確定回答ではなく、先生が確認してから判断してください。"
    ]
      .filter((section): section is string => section !== null)
      .join("\n");
  };

  const getEscalatedThreadStatus = (status: ThreadStatus): ThreadStatus => {
    if (status === "resolved" || status === "waiting_student" || status === "patch_proposed") {
      return "reopened";
    }

    return status;
  };

  const openAiEscalationReview = (): void => {
    if (!canEscalateAiToTeacher) {
      setAiEscalationMessageStatus("warning");
      setAiEscalationMessage("先生へのエスカレーションは生徒本人のスレッドで利用できます。");
      return;
    }

    if (!aiEscalationConfirmation.trim()) {
      setAiEscalationMessageStatus("warning");
      setAiEscalationMessage("先生に確認してほしい内容を入力してください。");
      return;
    }

    setAiEscalationAllowedFindingIds([]);
    setAiEscalationMessage(null);
    setAiEscalationReviewOpen(true);
  };

  const setAiEscalationFindingAllowed = (findingId: string, allowed: boolean): void => {
    setAiEscalationAllowedFindingIds((current) => {
      if (allowed) {
        return current.includes(findingId) ? current : [...current, findingId];
      }

      return current.filter((id) => id !== findingId);
    });
  };

  const submitAiEscalationToTeacher = async (): Promise<void> => {
    if (!supabase || !profile || !state.thread) {
      setAiEscalationMessageStatus("error");
      setAiEscalationMessage("エスカレーションに必要な情報を確認できませんでした。");
      return;
    }

    if (!canEscalateAiToTeacher) {
      setAiEscalationMessageStatus("warning");
      setAiEscalationMessage("先生へのエスカレーションは生徒本人のスレッドで利用できます。");
      return;
    }

    if (!aiEscalationReviewOpen) {
      setAiEscalationMessageStatus("warning");
      setAiEscalationMessage("送信前プレビューで内容を確認してください。");
      return;
    }

    if (aiEscalationSecretScan.blocked || aiEscalationSecretScan.hasWarnings) {
      setAiEscalationMessageStatus(aiEscalationSecretScan.blocked ? "error" : "warning");
      setAiEscalationMessage(
        aiEscalationSecretScan.blocked
          ? "秘密情報の可能性がある内容を検出したため送信を止めました。"
          : "低リスクの秘密情報候補を確認し、送信する項目を許可してください。"
      );
      return;
    }

    const previousThread = state.thread;
    const nextStatus = getEscalatedThreadStatus(previousThread.status);
    const changedAt = new Date().toISOString();
    const body = aiEscalationPreviewBody;

    setAiEscalating(true);
    setAiEscalationMessage(null);

    try {
      const { error: threadUpdateError } = await supabase
        .from("threads")
        .update({
          status: nextStatus,
          ai_used: true,
          updated_at: changedAt
        })
        .eq("id", previousThread.id);

      if (threadUpdateError) {
        throw threadUpdateError;
      }

      const { data: escalationMessage, error: messageError } = await supabase
        .from("messages")
        .insert({
          thread_id: previousThread.id,
          sender_user_id: profile.id,
          sender_type: "student",
          body,
          message_type: "ai_summary"
        })
        .select(
          "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
        )
        .single();

      if (messageError) {
        const { error: rollbackError } = await supabase
          .from("threads")
          .update({
            status: previousThread.status,
            ai_used: previousThread.ai_used,
            updated_at: previousThread.updated_at
          })
          .eq("id", previousThread.id);

        if (rollbackError) {
          console.error("Failed to rollback AI escalation thread update", rollbackError);
        }

        throw messageError;
      }

      setState((current) => ({
        ...current,
        thread:
          current.thread?.id === previousThread.id
            ? { ...current.thread, status: nextStatus, ai_used: true, updated_at: changedAt }
            : current.thread,
        messages: escalationMessage
          ? upsertMessage(current.messages, escalationMessage)
          : current.messages
      }));
      setAiEscalationConfirmation("");
      setAiEscalationAllowedFindingIds([]);
      setAiEscalationReviewOpen(false);
      setAiEscalationMessageStatus("success");
      setAiEscalationMessage("AI補助の文脈を先生へ共有しました。");
      void trackUsageEvent({
        eventName: "ai_escalated_to_teacher",
        projectId: previousThread.project_id,
        threadId: previousThread.id,
        success: true,
        properties: {
          next_status: nextStatus
        }
      });
    } catch (error) {
      console.error("Failed to escalate AI context to teacher", error);
      setAiEscalationMessageStatus("error");
      setAiEscalationMessage("先生へのエスカレーションを送信できませんでした。");
    } finally {
      setAiEscalating(false);
    }
  };

  const generateCauseCandidates = async (): Promise<void> => {
    if (!supabase || !profile || !state.thread) {
      setAiError("AI 補助に必要な情報を確認できませんでした。");
      return;
    }

    const context = buildThreadAiContext();
    const inputScan = scanSecrets({
      textEntries: context.map((entry) => ({ label: entry.label, value: entry.value }))
    });

    if (inputScan.blocked) {
      setAiError("秘密情報の可能性がある内容を検出したため、AI には送信しません。");
      return;
    }

    void trackUsageEvent({
      eventName: "ai_cause_requested",
      projectId: state.thread.project_id,
      threadId: state.thread.id
    });

    setAiGenerating(true);
    setAiError(null);

    try {
      const request: AiAssistRequest = {
        task: "cause_candidates",
        threadId: state.thread.id,
        projectId: state.thread.project_id,
        context,
        options: {
          locale: "ja",
          maxOutputChars: 2_200,
          streaming: false
        }
      };
      const result = await window.ask.ai.generate(request);

      if (!result.ok) {
        setAiError(result.error.message);
        return;
      }

      if (result.data.status !== "completed") {
        setAiError(result.data.fallback?.message ?? "AI 応答を取得できませんでした。");
        return;
      }

      const outputText = result.data.output?.text.trim();

      if (!outputText) {
        setAiError("AI 応答が空でした。");
        return;
      }

      const outputScan = scanSecrets({
        textEntries: [{ label: "AI原因候補", value: outputText }]
      });

      if (outputScan.blocked) {
        setAiError("AI 応答に秘密情報候補が含まれるため、チャットには保存しません。");
        return;
      }

      const senderType: MessageSenderType = profile.role === "student" ? "student" : "teacher";
      const { data, error } = await supabase
        .from("messages")
        .insert({
          thread_id: state.thread.id,
          sender_user_id: profile.id,
          sender_type: senderType,
          body: [
            "## AI原因候補と次の確認",
            outputText,
            "",
            "AI 出力は補助情報です。断定ではなく、先生または生徒が確認してから判断してください。"
          ].join("\n"),
          message_type: "ai_summary"
        })
        .select(
          "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
        )
        .single();

      if (error) {
        throw error;
      }

      const { error: threadUpdateError } = await supabase
        .from("threads")
        .update({ ai_used: true })
        .eq("id", state.thread.id);

      if (threadUpdateError) {
        console.error("Failed to mark thread AI usage", threadUpdateError);
      }

      setState((current) => ({
        ...current,
        thread: current.thread ? { ...current.thread, ai_used: true } : current.thread,
        messages: data ? sortMessages([...current.messages, data]) : current.messages
      }));
      void trackUsageEvent({
        eventName: "ai_cause_completed",
        projectId: state.thread.project_id,
        threadId: state.thread.id,
        success: true,
        properties: {
          output_chars: outputText.length
        }
      });
    } catch (error) {
      console.error("Failed to generate cause candidates", error);
      setAiError("AI 原因候補を生成または保存できませんでした。");
      void trackUsageEvent({
        eventName: "ai_cause_completed",
        projectId: state.thread.project_id,
        threadId: state.thread.id,
        success: false,
        errorCode: "ai_cause_failed"
      });
    } finally {
      setAiGenerating(false);
    }
  };

  const createTeacherPatchTemplate = (): void => {
    const normalizedTargetPath = normalizePatchTargetPath(teacherPatchTargetFilePath);

    if (!normalizedTargetPath) {
      setTeacherPatchError("安全な対象ファイルを入力してください。");
      setTeacherPatchNotice(null);
      return;
    }

    setTeacherPatchTargetFilePath(normalizedTargetPath);
    setTeacherPatchText(
      [
        `diff --git a/${normalizedTargetPath} b/${normalizedTargetPath}`,
        `--- a/${normalizedTargetPath}`,
        `+++ b/${normalizedTargetPath}`,
        "@@ -1 +1 @@",
        "-変更前の1行",
        "+変更後の1行"
      ].join("\n")
    );
    setTeacherPatchError(null);
    setTeacherPatchNotice("対象ファイルに合わせた diff ひな形を作成しました。");
  };

  const saveTeacherPatchProposal = async (): Promise<void> => {
    if (!supabase || !profile || !state.thread) {
      setTeacherPatchError("パッチ提案の保存に必要な情報を確認できませんでした。");
      setTeacherPatchNotice(null);
      return;
    }

    if (profile.role !== "teacher") {
      setTeacherPatchError("先生アカウントのみパッチ提案を作成できます。");
      setTeacherPatchNotice(null);
      return;
    }

    const parsed = validatePatchProposalDraft({
      targetFilePath: teacherPatchTargetFilePath,
      baseCommitSha: teacherPatchBaseCommitSha || null,
      explanation: teacherPatchExplanation,
      patchText: teacherPatchText
    });

    if (!parsed.ok) {
      setTeacherPatchError(`送信前に diff を確認してください。${parsed.error.message}`);
      setTeacherPatchNotice(null);
      return;
    }

    const proposal = parsed.proposal;
    const outputScan = scanSecrets({
      textEntries: [
        { label: "先生パッチ本文", value: proposal.patchText },
        { label: "先生パッチ理由", value: proposal.explanation }
      ],
      filePaths: [proposal.targetFilePath]
    });

    if (outputScan.blocked) {
      setTeacherPatchError(
        "パッチ提案に秘密情報候補または保護対象パスが含まれるため保存しません。"
      );
      setTeacherPatchNotice(null);
      return;
    }

    setTeacherPatchSaving(true);
    setTeacherPatchError(null);
    setTeacherPatchNotice(null);

    try {
      const { data: message, error: messageError } = await supabase
        .from("messages")
        .insert({
          thread_id: state.thread.id,
          sender_user_id: profile.id,
          sender_type: "teacher",
          body: proposal.patchText,
          message_type: "patch"
        })
        .select(
          "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
        )
        .single();

      if (messageError) {
        throw messageError;
      }

      if (!message) {
        throw new Error("Teacher patch message insert returned no row.");
      }

      const { data: patchProposal, error: patchProposalError } = await supabase
        .from("patch_proposals")
        .insert({
          thread_id: state.thread.id,
          message_id: message.id,
          created_by: profile.id,
          created_by_type: "teacher",
          target_file_path: proposal.targetFilePath,
          base_commit_sha: proposal.baseCommitSha,
          patch_text: proposal.patchText,
          explanation: proposal.explanation,
          status: "proposed"
        })
        .select("id,message_id,target_file_path,base_commit_sha,explanation,status,created_by_type")
        .single();

      if (patchProposalError) {
        const { error: rollbackError } = await supabase
          .from("messages")
          .delete()
          .eq("id", message.id);

        if (rollbackError) {
          console.error("Failed to rollback orphaned teacher patch message", rollbackError);
        }

        throw patchProposalError;
      }

      if (!patchProposal) {
        throw new Error("Teacher patch proposal insert returned no row.");
      }

      const { error: threadUpdateError } = await supabase
        .from("threads")
        .update({ status: "patch_proposed" })
        .eq("id", state.thread.id);

      if (threadUpdateError) {
        console.error("Failed to mark thread teacher patch proposal status", threadUpdateError);
      }

      setState((current) => {
        const patchProposalsByMessageId = new Map(current.patchProposalsByMessageId);
        patchProposalsByMessageId.set(patchProposal.message_id, patchProposal);

        return {
          ...current,
          thread: current.thread ? { ...current.thread, status: "patch_proposed" } : current.thread,
          messages: current.messages.some((currentMessage) => currentMessage.id === message.id)
            ? current.messages
            : sortMessages([...current.messages, message]),
          patchProposalsByMessageId
        };
      });

      setTeacherPatchTargetFilePath("");
      setTeacherPatchBaseCommitSha("");
      setTeacherPatchExplanation("");
      setTeacherPatchText("");
      setTeacherPatchNotice("パッチ提案をチャットへ追加しました。");
    } catch (error) {
      console.error("Failed to save teacher patch proposal", error);
      setTeacherPatchError("パッチ提案を保存できませんでした。内容は保持しています。");
    } finally {
      setTeacherPatchSaving(false);
    }
  };

  const saveAiPatchProposal = async (proposal: PatchProposalDraft): Promise<void> => {
    if (!supabase || !profile || !state.thread) {
      setAiPatchError("AI パッチ保存に必要な情報を確認できませんでした。");
      return;
    }

    if (profile.role !== "student") {
      setAiPatchError("AI パッチ案の作成は生徒スレッドから実行してください。");
      return;
    }

    const outputScan = scanSecrets({
      textEntries: [
        { label: "AIパッチ本文", value: proposal.patchText },
        { label: "AIパッチ理由", value: proposal.explanation }
      ],
      filePaths: [proposal.targetFilePath]
    });

    if (outputScan.blocked) {
      setAiPatchError("AI パッチ案に秘密情報候補または保護対象パスが含まれるため保存しません。");
      return;
    }

    const { data: message, error: messageError } = await supabase
      .from("messages")
      .insert({
        thread_id: state.thread.id,
        sender_user_id: profile.id,
        sender_type: "student",
        body: proposal.patchText,
        message_type: "patch"
      })
      .select(
        "id,thread_id,sender_user_id,sender_type,body,message_type,reply_to_message_id,created_at"
      )
      .single();

    if (messageError) {
      throw messageError;
    }

    const { data: patchProposal, error: patchProposalError } = await supabase
      .from("patch_proposals")
      .insert({
        thread_id: state.thread.id,
        message_id: message.id,
        created_by: profile.id,
        created_by_type: "ai",
        target_file_path: proposal.targetFilePath,
        base_commit_sha: proposal.baseCommitSha,
        patch_text: proposal.patchText,
        explanation: proposal.explanation,
        status: "proposed"
      })
      .select("id,message_id,target_file_path,base_commit_sha,explanation,status,created_by_type")
      .single();

    if (patchProposalError) {
      const { error: rollbackError } = await supabase
        .from("messages")
        .delete()
        .eq("id", message.id);

      if (rollbackError) {
        console.error("Failed to rollback orphaned AI patch message", rollbackError);
      }

      throw patchProposalError;
    }

    const { error: threadUpdateError } = await supabase
      .from("threads")
      .update({ status: "patch_proposed", ai_used: true })
      .eq("id", state.thread.id);

    if (threadUpdateError) {
      console.error("Failed to mark thread patch proposal status", threadUpdateError);
    }

    setState((current) => {
      const patchProposalsByMessageId = new Map(current.patchProposalsByMessageId);
      patchProposalsByMessageId.set(patchProposal.message_id, patchProposal);

      return {
        ...current,
        thread: current.thread
          ? { ...current.thread, status: "patch_proposed", ai_used: true }
          : current.thread,
        messages: current.messages.some((currentMessage) => currentMessage.id === message.id)
          ? current.messages
          : sortMessages([...current.messages, message]),
        patchProposalsByMessageId
      };
    });
    void trackUsageEvent({
      eventName: "ai_patch_proposed",
      projectId: state.thread.project_id,
      threadId: state.thread.id,
      patchProposalId: patchProposal.id,
      success: true,
      properties: {
        target_file_path_present: Boolean(proposal.targetFilePath),
        base_commit_present: Boolean(proposal.baseCommitSha)
      }
    });
  };

  const generateAiPatchProposal = async (): Promise<void> => {
    if (!supabase || !profile || !state.thread) {
      setAiPatchError("AI パッチ生成に必要な情報を確認できませんでした。");
      return;
    }

    if (profile.role !== "student") {
      setAiPatchError("AI パッチ案の作成は生徒スレッドから実行してください。");
      return;
    }

    const context = buildThreadAiContext();
    const inputScan = scanSecrets({
      textEntries: context.map((entry) => ({ label: entry.label, value: entry.value }))
    });

    if (inputScan.blocked) {
      setAiPatchError("秘密情報の可能性がある内容を検出したため、AI には送信しません。");
      return;
    }

    void trackUsageEvent({
      eventName: "ai_patch_requested",
      projectId: state.thread.project_id,
      threadId: state.thread.id
    });

    setAiPatchGenerating(true);
    setAiPatchError(null);

    try {
      const request: AiAssistRequest = {
        task: "patch_proposal",
        threadId: state.thread.id,
        projectId: state.thread.project_id,
        context: [
          ...context,
          {
            label: "パッチ生成制約",
            kind: "patch",
            value:
              "JSON object only. target_file_path, base_commit_sha, explanation, patch_text を返す。patch_text は単一ファイルの unified diff。ローカル適用はしない。"
          }
        ],
        options: {
          locale: "ja",
          maxOutputChars: 4_000,
          streaming: false
        }
      };
      const result = await window.ask.ai.generate(request);

      if (!result.ok) {
        setAiPatchError(result.error.message);
        return;
      }

      if (result.data.status !== "completed") {
        setAiPatchError(result.data.fallback?.message ?? "AI 応答を取得できませんでした。");
        return;
      }

      const outputText = result.data.output?.text.trim();

      if (!outputText) {
        setAiPatchError("AI 応答が空でした。");
        return;
      }

      const parsed = parseAiPatchProposalOutput(outputText);

      if (!parsed.ok) {
        setAiPatchError(`AI パッチ案が保存できる形式ではありません。${parsed.error.message}`);
        return;
      }

      await saveAiPatchProposal(parsed.proposal);
    } catch (error) {
      console.error("Failed to generate AI patch proposal", error);
      setAiPatchError("AI パッチ案を生成または保存できませんでした。");
      void trackUsageEvent({
        eventName: "ai_patch_proposed",
        projectId: state.thread.project_id,
        threadId: state.thread.id,
        success: false,
        errorCode: "ai_patch_failed"
      });
    } finally {
      setAiPatchGenerating(false);
    }
  };

  const aiEscalationPreviewBody = state.thread ? buildAiEscalationMessageBody() : "";
  const aiEscalationSecretScan = scanSecrets({
    textEntries: [{ label: "AIエスカレーション本文", value: aiEscalationPreviewBody }],
    allowedFindingIds: aiEscalationAllowedFindingIds
  });
  const aiEscalationFindingsForPreview = [
    ...aiEscalationSecretScan.activeFindings,
    ...aiEscalationSecretScan.allowedFindings
  ];

  if (state.loading) {
    return <ThreadStatePage title="読み込み中" body="スレッドを確認しています。" />;
  }

  if (state.error || !state.thread) {
    return <ThreadStatePage title="スレッドが見つかりません" body={state.error ?? ""} />;
  }

  const backTarget = profile?.role === "student" ? "/student" : "/teacher/queue";
  const breadcrumbParentLabel = profile?.role === "student" ? "ホーム" : "質問キュー";
  const detailMessage =
    detailMessageId === null
      ? null
      : (state.messages.find((message) => message.id === detailMessageId) ?? null);

  return (
    <section className="thread-detail">
      <div className="page-header thread-page-header">
        <div>
          <nav className="breadcrumb" aria-label="パンくずリスト">
            <Link to={backTarget}>{breadcrumbParentLabel}</Link>
            <span>{state.project?.name ?? "プロジェクト"}</span>
          </nav>
          <h1>{state.thread.title}</h1>
          <div className="thread-meta">
            <span>{state.project?.name ?? "プロジェクト"}</span>
            <span>{state.messages.length}件</span>
          </div>
        </div>

        <div className="thread-header-actions">
          <div className="thread-status-compact">
            <span>ステータス</span>
            {canUseTeacherLifecycleControls ? (
              <select
                aria-label="ステータス"
                disabled={lifecycleUpdating}
                value={state.thread.status}
                onChange={(event) =>
                  void updateThreadLifecycleStatus(event.target.value as ThreadStatus)
                }
              >
                {threadStatuses.map((option) => (
                  <option key={option} value={option}>
                    {statusLabels[option]}
                  </option>
                ))}
              </select>
            ) : canUseLifecycleControls ? (
              <div className="thread-status-buttons" role="group" aria-label="スレッド状態">
                <button
                  className="secondary-button"
                  disabled={lifecycleUpdating || state.thread.status === "resolved"}
                  type="button"
                  onClick={() => void updateThreadLifecycleStatus("resolved")}
                >
                  解決済みにする
                </button>
                <button
                  className="secondary-button"
                  disabled={lifecycleUpdating || state.thread.status === "reopened"}
                  type="button"
                  onClick={() => void updateThreadLifecycleStatus("reopened")}
                >
                  再オープンする
                </button>
              </div>
            ) : (
              <strong>{statusLabels[state.thread.status]}</strong>
            )}
          </div>
          {lifecycleMessage ? (
            <p
              className={`message ${lifecycleMessageStatus} thread-status-message`}
              role={lifecycleMessageStatus === "error" ? "alert" : "status"}
            >
              {lifecycleMessage}
            </p>
          ) : null}
        </div>
      </div>

      <div className="thread-detail-grid">
        <article className="detail-panel chat-panel">
          <div className="chat-message-list" aria-live="polite">
            {state.messages.length === 0 ? (
              <p className="muted">まだメッセージがありません。</p>
            ) : (
              state.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  senderName={
                    message.sender_user_id
                      ? state.usersById.get(message.sender_user_id)?.display_name
                      : null
                  }
                  patchProposal={state.patchProposalsByMessageId.get(message.id) ?? null}
                  isOwnMessage={isMessageOwnForViewer(message, profile?.id)}
                  onOpenDetails={() => setDetailMessageId(message.id)}
                />
              ))
            )}
          </div>

          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <div className="chat-composer-row">
              <textarea
                aria-label="返信内容"
                placeholder="返信を入力"
                rows={messageType === "code" || messageType === "patch" ? 8 : 4}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <div className="chat-composer-controls">
                <select
                  aria-label="メッセージ形式"
                  value={messageType}
                  onChange={(event) => setMessageType(event.target.value as ManualMessageType)}
                >
                  {manualMessageTypes.map((type) => (
                    <option key={type} value={type}>
                      {messageTypeLabels[type]}
                    </option>
                  ))}
                </select>
                <button className="primary-button" disabled={sending || !body.trim()} type="submit">
                  {sending ? "送信中..." : "送信"}
                </button>
              </div>
            </div>

            {sendError && (
              <p className="message error" role="alert">
                {sendError}
              </p>
            )}
          </form>
        </article>

        <div className="thread-support-tools">
          {profile?.role === "teacher" ? (
            <details className="thread-tool-panel">
              <summary>
                <span>先生パッチ提案</span>
                <small>diffを提案として送信</small>
              </summary>
              <div className="teacher-patch-composer">
                <div>
                  <p className="eyebrow">Patch Composer</p>
                  <h2>先生パッチ提案</h2>
                </div>

                <label>
                  対象ファイル
                  <input
                    value={teacherPatchTargetFilePath}
                    onChange={(event) => setTeacherPatchTargetFilePath(event.target.value)}
                  />
                </label>

                <label>
                  基準コミット
                  <input
                    value={teacherPatchBaseCommitSha}
                    onChange={(event) => setTeacherPatchBaseCommitSha(event.target.value)}
                  />
                </label>

                <label>
                  変更理由
                  <textarea
                    rows={4}
                    value={teacherPatchExplanation}
                    onChange={(event) => setTeacherPatchExplanation(event.target.value)}
                  />
                </label>

                <label>
                  Unified diff
                  <textarea
                    className="diff-textarea"
                    rows={14}
                    value={teacherPatchText}
                    onChange={(event) => setTeacherPatchText(event.target.value)}
                  />
                </label>

                <div className="teacher-patch-actions">
                  <button
                    className="secondary-button"
                    disabled={teacherPatchSaving || !teacherPatchTargetFilePath.trim()}
                    type="button"
                    onClick={createTeacherPatchTemplate}
                  >
                    diffひな形
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      teacherPatchSaving ||
                      !teacherPatchTargetFilePath.trim() ||
                      !teacherPatchExplanation.trim() ||
                      !teacherPatchText.trim()
                    }
                    type="button"
                    onClick={() => void saveTeacherPatchProposal()}
                  >
                    {teacherPatchSaving ? "保存中..." : "パッチ提案を送信"}
                  </button>
                </div>

                <p className="message warning" role="status">
                  先生の提案は proposed として保存され、生徒のローカル環境には直接適用されません。
                </p>
                {teacherPatchNotice ? (
                  <p className="message success" role="status">
                    {teacherPatchNotice}
                  </p>
                ) : null}
                {teacherPatchError ? (
                  <p className="message error" role="alert">
                    {teacherPatchError}
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}

          <details className="thread-tool-panel">
            <summary>
              <span>AI補助</span>
              <small>原因候補やパッチ案を会話に追加</small>
            </summary>
            <div className="ai-thread-assist">
              <div>
                <p className="eyebrow">AI Assist</p>
                <h2>調査とパッチ案</h2>
              </div>
              <div className="ai-assist-actions">
                <button
                  className="secondary-button"
                  disabled={aiGenerating || state.messages.length === 0}
                  type="button"
                  onClick={() => void generateCauseCandidates()}
                >
                  {aiGenerating ? "原因候補を生成中..." : "AIで原因候補を追加"}
                </button>
                {profile?.role === "student" ? (
                  <button
                    className="secondary-button"
                    disabled={aiPatchGenerating || state.messages.length === 0}
                    type="button"
                    onClick={() => void generateAiPatchProposal()}
                  >
                    {aiPatchGenerating ? "パッチ案を生成中..." : "AIでパッチ案を追加"}
                  </button>
                ) : null}
              </div>
              <p className="message warning" role="status">
                AI 出力は提案です。パッチ案は proposed として保存し、承認なしに適用しません。
              </p>
              {canEscalateAiToTeacher ? (
                <div className="ai-escalation-panel">
                  <label>
                    先生への確認メモ
                    <textarea
                      rows={4}
                      value={aiEscalationConfirmation}
                      onChange={(event) => setAiEscalationConfirmation(event.target.value)}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    disabled={aiEscalating || !aiEscalationConfirmation.trim()}
                    type="button"
                    onClick={openAiEscalationReview}
                  >
                    先生にエスカレーション
                  </button>
                </div>
              ) : null}
              {aiEscalationMessage ? (
                <p
                  className={`message ${aiEscalationMessageStatus}`}
                  role={aiEscalationMessageStatus === "error" ? "alert" : "status"}
                >
                  {aiEscalationMessage}
                </p>
              ) : null}
              {aiError ? (
                <p className="message error" role="alert">
                  {aiError}
                </p>
              ) : null}
              {aiPatchError ? (
                <p className="message error" role="alert">
                  {aiPatchError}
                </p>
              ) : null}
            </div>
          </details>
        </div>
      </div>

      {detailMessage ? (
        <MessageDetailModal
          message={detailMessage}
          senderName={
            detailMessage.sender_user_id
              ? state.usersById.get(detailMessage.sender_user_id)?.display_name
              : null
          }
          patchReview={patchReviews[detailMessage.id] ?? initialPatchReviewState}
          patchProposal={state.patchProposalsByMessageId.get(detailMessage.id) ?? null}
          canReviewPatch={profile?.role === "student"}
          projectId={state.project?.id ?? null}
          projectHasLocalRoot={Boolean(state.project?.local_path_hash)}
          projectName={state.project?.name ?? null}
          isOwnMessage={isMessageOwnForViewer(detailMessage, profile?.id)}
          onClose={() => setDetailMessageId(null)}
          onValidatePatch={() => void validatePatchMessage(detailMessage)}
          onApplyPatch={() => void applyPatchMessage(detailMessage)}
          onRevertPatch={() => void revertPatchMessage(detailMessage)}
          onDismissPatch={() => void dismissPatchMessage(detailMessage)}
        />
      ) : null}

      {aiEscalationReviewOpen ? (
        <div className="review-modal-backdrop" role="presentation">
          <div
            aria-labelledby="ai-escalation-review-title"
            aria-modal="true"
            className="review-modal"
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div>
                <p className="eyebrow">Review</p>
                <h2 id="ai-escalation-review-title">送信前プレビュー</h2>
              </div>
              <button
                className="secondary-button"
                disabled={aiEscalating}
                type="button"
                onClick={() => setAiEscalationReviewOpen(false)}
              >
                閉じる
              </button>
            </header>

            <label>
              先生への確認メモ（編集可）
              <textarea
                rows={4}
                value={aiEscalationConfirmation}
                onChange={(event) => setAiEscalationConfirmation(event.target.value)}
              />
            </label>

            <section className="review-section">
              <h3>秘密情報チェック</h3>
              <p
                className={`message ${
                  aiEscalationSecretScan.blocked
                    ? "error"
                    : aiEscalationSecretScan.hasWarnings
                      ? "warning"
                      : "success"
                }`}
              >
                {aiEscalationSecretScan.blocked
                  ? `ブロック: ${aiEscalationSecretScan.blockedFindings.map((finding) => finding.message).join(", ")}`
                  : aiEscalationSecretScan.hasWarnings
                    ? "低リスクの秘密情報候補があります。送信する場合は許可してください。"
                    : "送信対象に秘密情報候補はありません。"}
              </p>
              {aiEscalationFindingsForPreview.length > 0 ? (
                <div
                  className="secret-finding-list"
                  role="group"
                  aria-label="エスカレーション秘密情報チェック結果"
                >
                  {aiEscalationFindingsForPreview.map((finding) =>
                    finding.canAllow ? (
                      <label className="secret-finding-item warning" key={finding.id}>
                        <input
                          checked={aiEscalationAllowedFindingIds.includes(finding.id)}
                          type="checkbox"
                          onChange={(event) =>
                            setAiEscalationFindingAllowed(finding.id, event.target.checked)
                          }
                        />
                        <span>
                          {formatSecretFindingForUi(finding)}
                          <small>{finding.preview}</small>
                        </span>
                      </label>
                    ) : (
                      <div className="secret-finding-item error" key={finding.id}>
                        <strong>{formatSecretFindingForUi(finding)}</strong>
                        <small>{finding.preview}</small>
                      </div>
                    )
                  )}
                </div>
              ) : null}
            </section>

            <section className="review-section">
              <h3>先生に共有する内容</h3>
              <pre className="review-payload-preview">{aiEscalationPreviewBody}</pre>
            </section>

            <footer>
              <button
                className="secondary-button"
                disabled={aiEscalating}
                type="button"
                onClick={() => setAiEscalationReviewOpen(false)}
              >
                戻って編集
              </button>
              <button
                className="primary-button"
                disabled={
                  aiEscalating ||
                  aiEscalationSecretScan.blocked ||
                  aiEscalationSecretScan.hasWarnings ||
                  !aiEscalationConfirmation.trim()
                }
                type="button"
                onClick={() => void submitAiEscalationToTeacher()}
              >
                {aiEscalating ? "送信中..." : "確認して送信"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
};

const MessageBubble = ({
  message,
  senderName,
  patchProposal,
  isOwnMessage,
  onOpenDetails
}: {
  message: MessageRow;
  senderName: string | null | undefined;
  patchProposal: PatchProposalSummary | null;
  isOwnMessage: boolean;
  onOpenDetails: () => void;
}): ReactElement => {
  const showMessageKind = message.message_type !== "text" && message.message_type !== "ai_summary";
  const displayName = getMessageDisplayName(message, senderName, isOwnMessage);
  const summary = buildMessageSummary(message, patchProposal);

  return (
    <article className={`chat-message ${message.sender_type}${isOwnMessage ? " own" : ""}`}>
      <button
        className="chat-summary-button"
        type="button"
        onClick={onOpenDetails}
        aria-label="メッセージ詳細を開く"
      >
        <span className="chat-summary-header">
          {displayName ? <strong>{displayName}</strong> : null}
          {showMessageKind ? <span>{messageTypeLabels[message.message_type]}</span> : null}
          <time dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
        </span>
        <span className="chat-summary-preview">{summary.preview}</span>
        <span className="chat-summary-footer">
          {summary.meta ? <span>{summary.meta}</span> : <span />}
          <span>詳細</span>
        </span>
      </button>
    </article>
  );
};

const MessageDetailModal = ({
  message,
  senderName,
  patchReview,
  patchProposal,
  canReviewPatch,
  projectId,
  projectHasLocalRoot,
  projectName,
  isOwnMessage,
  onClose,
  onValidatePatch,
  onApplyPatch,
  onRevertPatch,
  onDismissPatch
}: {
  message: MessageRow;
  senderName: string | null | undefined;
  patchReview: PatchReviewState;
  patchProposal: PatchProposalSummary | null;
  canReviewPatch: boolean;
  projectId: string | null;
  projectHasLocalRoot: boolean;
  projectName: string | null;
  isOwnMessage: boolean;
  onClose: () => void;
  onValidatePatch: () => void;
  onApplyPatch: () => void;
  onRevertPatch: () => void;
  onDismissPatch: () => void;
}): ReactElement => {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const isCodeLike = message.message_type === "code" || message.message_type === "patch";
  const viewerKind = message.message_type === "patch" ? "diff" : "code";
  const showMessageKind = message.message_type !== "text" && message.message_type !== "ai_summary";
  const displayName = getMessageDisplayName(message, senderName, isOwnMessage) ?? "自分";

  useEffect(() => {
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="message-detail-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby="message-detail-title"
        aria-modal="true"
        className="message-detail-modal"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="message-detail-title">メッセージ詳細</h2>
            <div className="message-detail-meta">
              <strong>{displayName}</strong>
              {showMessageKind ? <span>{messageTypeLabels[message.message_type]}</span> : null}
              <time dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
            </div>
          </div>
          <button ref={closeButtonRef} className="secondary-button" type="button" onClick={onClose}>
            閉じる
          </button>
        </header>

        <div className="message-detail-body">
          {isCodeLike ? (
            <CodeContextViewer content={message.body} kind={viewerKind} />
          ) : (
            <MarkdownMessage>{message.body}</MarkdownMessage>
          )}

          {message.message_type === "patch" ? (
            <PatchReviewPanel
              canReviewPatch={canReviewPatch}
              projectId={projectId}
              projectHasLocalRoot={projectHasLocalRoot}
              projectName={projectName}
              review={patchReview}
              patchProposal={patchProposal}
              patchText={message.body}
              onApplyPatch={onApplyPatch}
              onDismissPatch={onDismissPatch}
              onRevertPatch={onRevertPatch}
              onValidatePatch={onValidatePatch}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

const PatchReviewPanel = ({
  review,
  canReviewPatch,
  projectId,
  projectHasLocalRoot,
  projectName,
  patchProposal,
  patchText,
  onValidatePatch,
  onApplyPatch,
  onRevertPatch,
  onDismissPatch
}: {
  review: PatchReviewState;
  canReviewPatch: boolean;
  projectId: string | null;
  projectHasLocalRoot: boolean;
  projectName: string | null;
  patchProposal: PatchProposalSummary | null;
  patchText: string;
  onValidatePatch: () => void;
  onApplyPatch: () => void;
  onRevertPatch: () => void;
  onDismissPatch: () => void;
}): ReactElement => {
  const validation = review.validation;
  const applyResult = review.applyResult;
  const revertResult = review.revertResult;
  const canApply = Boolean(
    validation?.canApply &&
    validation.patchId &&
    validation.confirmationToken &&
    !applyResult &&
    patchProposal?.status !== "applied" &&
    patchProposal?.status !== "dismissed" &&
    patchProposal?.status !== "reverted"
  );
  const canRevert = Boolean(
    (patchProposal?.status === "applied" || applyResult?.applied) &&
    projectHasLocalRoot &&
    patchProposal?.status !== "dismissed" &&
    patchProposal?.status !== "reverted" &&
    !revertResult?.reverted
  );
  const canDismiss = patchProposal?.status === "proposed" || patchProposal?.status === "failed";
  const shouldShowReconnectLink = Boolean(
    canReviewPatch &&
    projectId &&
    (!projectHasLocalRoot ||
      validation?.status === "root_missing" ||
      revertResult?.status === "root_missing")
  );

  return (
    <section className="patch-review-panel" aria-label="パッチ適用確認">
      <div>
        <p className="eyebrow">Patch Review</p>
        <h3>ローカル適用確認</h3>
        <p className="muted compact">
          {projectName ?? "このプロジェクト"} のファイル状態を確認してから適用します。
        </p>
      </div>

      {patchProposal ? (
        <div className="patch-proposal-summary">
          <div className="patch-review-meta">
            <span>{patchProposal.created_by_type === "ai" ? "AI提案" : "先生提案"}</span>
            <span>{patchProposalStatusLabels[patchProposal.status]}</span>
            <span>{patchProposal.target_file_path}</span>
            {patchProposal.base_commit_sha ? (
              <span>基準 {shortCommit(patchProposal.base_commit_sha)}</span>
            ) : null}
          </div>
          {patchProposal.explanation ? <p>{patchProposal.explanation}</p> : null}
        </div>
      ) : null}

      {!canReviewPatch ? (
        <p className="message warning">パッチ適用は生徒のローカル環境でのみ承認できます。</p>
      ) : null}

      {canReviewPatch && !projectHasLocalRoot ? (
        <p className="message warning">
          ローカルフォルダが未登録です。プロジェクト設定からフォルダを選択してください。
        </p>
      ) : null}

      {shouldShowReconnectLink && projectId ? (
        <Link className="secondary-link" to={`/projects/${projectId}`}>
          プロジェクト詳細でローカルフォルダを再接続
        </Link>
      ) : null}

      {validation ? (
        <div className="patch-review-result">
          <div className="patch-review-meta">
            <span>{patchValidationLabels[validation.status]}</span>
            <span>現在 {shortCommit(validation.currentHead)}</span>
            {validation.expectedBaseCommit ? (
              <span>基準 {shortCommit(validation.expectedBaseCommit)}</span>
            ) : null}
          </div>

          {validation.targetFiles.length > 0 ? (
            <ul className="patch-target-list">
              {validation.targetFiles.map((targetPath) => (
                <li key={targetPath}>{targetPath}</li>
              ))}
            </ul>
          ) : null}

          <p className={`message ${validationMessageClass(validation)}`}>{validation.message}</p>
        </div>
      ) : null}

      {applyResult ? (
        <div className="patch-review-result">
          <div className="patch-review-meta">
            <span>{patchApplyLabels[applyResult.status]}</span>
            {applyResult.backupDirectory ? <span>{applyResult.backupDirectory}</span> : null}
          </div>
          <p className={`message ${applyMessageClass(applyResult)}`}>{applyResult.message}</p>
        </div>
      ) : null}

      {revertResult ? (
        <div className="patch-review-result">
          <div className="patch-review-meta">
            <span>{patchRevertLabels[revertResult.status]}</span>
            {revertResult.backupDirectory ? <span>{revertResult.backupDirectory}</span> : null}
          </div>
          <p className={`message ${revertMessageClass(revertResult)}`}>{revertResult.message}</p>
        </div>
      ) : null}

      <details className="patch-manual-diff">
        <summary>手動適用用diff</summary>
        <pre>{patchText}</pre>
      </details>

      {review.error ? (
        <p className="message error" role="alert">
          {review.error}
        </p>
      ) : null}

      {canReviewPatch ? (
        <div className="patch-review-actions">
          <button
            className="secondary-button"
            disabled={
              review.validating ||
              review.applying ||
              review.reverting ||
              review.dismissing ||
              !projectHasLocalRoot ||
              patchProposal?.status === "dismissed" ||
              patchProposal?.status === "reverted"
            }
            type="button"
            onClick={onValidatePatch}
          >
            {review.validating ? "確認中..." : validation ? "再確認" : "安全確認"}
          </button>
          <button
            className="primary-button"
            disabled={
              !canApply ||
              review.validating ||
              review.applying ||
              review.reverting ||
              review.dismissing
            }
            type="button"
            onClick={onApplyPatch}
          >
            {review.applying ? "適用中..." : applyResult?.applied ? "適用済み" : "承認して適用"}
          </button>
          <button
            className="secondary-button"
            disabled={
              !canRevert ||
              review.validating ||
              review.applying ||
              review.reverting ||
              review.dismissing
            }
            type="button"
            onClick={onRevertPatch}
          >
            {review.reverting ? "取り消し中..." : "元に戻す"}
          </button>
          <button
            className="secondary-button"
            disabled={
              !canDismiss ||
              review.validating ||
              review.applying ||
              review.reverting ||
              review.dismissing
            }
            type="button"
            onClick={onDismissPatch}
          >
            {review.dismissing ? "却下中..." : "却下"}
          </button>
        </div>
      ) : null}
    </section>
  );
};

const ThreadStatePage = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
