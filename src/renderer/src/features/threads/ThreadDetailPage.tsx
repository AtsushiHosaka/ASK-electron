import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
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
import { scanSecrets } from "../../../../shared/secretScanner";
import { CodeContextViewer } from "../../components/CodeContextViewer";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type PatchProposalRow = Database["public"]["Tables"]["patch_proposals"]["Row"];
type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];
type ProjectSummary = Pick<ProjectRow, "id" | "local_path_hash" | "name">;
type PatchProposalSummary = Pick<
  PatchProposalRow,
  | "id"
  | "message_id"
  | "status"
  | "target_file_path"
  | "base_commit_sha"
  | "explanation"
  | "created_by_type"
>;

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
  text: "Text",
  code: "Code",
  environment: "Environment",
  ai_summary: "AI Summary",
  patch: "Patch"
};

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

type TextMessagePart =
  | { type: "text"; content: string }
  | { type: "code"; content: string; language: string | null };

const parseTextMessageParts = (body: string): TextMessagePart[] => {
  const parts: TextMessagePart[] = [];
  const fencePattern = /^(`{3,})([a-z0-9_+-]*)\s*$/gim;
  let cursor = 0;
  let openingMatch: RegExpExecArray | null;

  while ((openingMatch = fencePattern.exec(body)) !== null) {
    const openingFence = openingMatch[1];
    const language = openingMatch[2]?.trim() || null;
    const codeStart = fencePattern.lastIndex;
    const closingPattern = new RegExp(`^${openingFence}\\s*$`, "gim");
    closingPattern.lastIndex = codeStart;
    const closingMatch = closingPattern.exec(body);

    if (!closingMatch) {
      break;
    }

    if (openingMatch.index > cursor) {
      parts.push({ type: "text", content: body.slice(cursor, openingMatch.index) });
    }

    parts.push({
      type: "code",
      language,
      content: body
        .slice(codeStart, closingMatch.index)
        .replace(/^\r?\n/, "")
        .replace(/\r?\n$/, "")
    });
    cursor = closingPattern.lastIndex;
    fencePattern.lastIndex = closingPattern.lastIndex;
  }

  if (cursor < body.length) {
    parts.push({ type: "text", content: body.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ type: "text", content: body }];
};

const renderTextWithLineBreaks = (content: string): ReactNode[] =>
  content.split(/\r?\n/).map((line, index, lines) => (
    <span key={`${index}-${line}`}>
      {line}
      {index < lines.length - 1 ? <br /> : null}
    </span>
  ));

const TextMessageBody = ({ body }: { body: string }): ReactElement => {
  const parts = useMemo(() => parseTextMessageParts(body), [body]);

  return (
    <div className="text-message-body">
      {parts.map((part, index) =>
        part.type === "code" ? (
          <CodeContextViewer
            content={part.content}
            kind="code"
            key={`${index}-code`}
            language={part.language}
          />
        ) : part.content.trim().length > 0 ? (
          <p key={`${index}-text`}>{renderTextWithLineBreaks(part.content.trim())}</p>
        ) : null
      )}
    </div>
  );
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

const sortMessages = (messages: MessageRow[]): MessageRow[] => {
  return [...messages].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
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
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
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

    const channel = supabase
      .channel(`thread-messages-${threadId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `thread_id=eq.${threadId}`
        },
        (payload) => {
          const nextMessage = payload.new as MessageRow;
          setState((current) => {
            if (current.messages.some((message) => message.id === nextMessage.id)) {
              return current;
            }

            return {
              ...current,
              messages: sortMessages([...current.messages, nextMessage])
            };
          });
        }
      )
      .subscribe();

    return () => {
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
    } catch (error) {
      console.error("Failed to apply patch", error);
      updatePatchReview(message.id, (current) => ({
        ...current,
        applying: false,
        error: "パッチを適用できませんでした。"
      }));
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

    const trimmedBody = body.trim();

    if (!trimmedBody) {
      setSendError("メッセージを入力してください。");
      return;
    }

    setSending(true);
    setSendError(null);

    try {
      const senderType: MessageSenderType = profile.role === "student" ? "student" : "teacher";
      const { error } = await supabase.from("messages").insert({
        thread_id: state.thread.id,
        sender_user_id: profile.id,
        sender_type: senderType,
        body: trimmedBody,
        message_type: messageType
      });

      if (error) {
        throw error;
      }

      setBody("");
      setMessageType("text");
    } catch (error) {
      console.error("Failed to send message", error);
      setSendError("メッセージを送信できませんでした。内容は保持しています。");
    } finally {
      setSending(false);
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
    } catch (error) {
      console.error("Failed to generate cause candidates", error);
      setAiError("AI 原因候補を生成または保存できませんでした。");
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
    } finally {
      setAiPatchGenerating(false);
    }
  };

  if (state.loading) {
    return <ThreadStatePage title="読み込み中" body="スレッドを確認しています。" />;
  }

  if (state.error || !state.thread) {
    return <ThreadStatePage title="スレッドが見つかりません" body={state.error ?? ""} />;
  }

  return (
    <section className="thread-detail">
      <div className="page-header">
        <div>
          <p className="eyebrow">Thread</p>
          <h1>{state.thread.title}</h1>
          <p className="muted">
            {state.project?.name ?? "プロジェクト"} のメッセージと提案パッチを確認できます。
          </p>
        </div>
        <div className="progress-summary">
          <strong>{statusLabels[state.thread.status]}</strong>
          <span>{state.messages.length} messages</span>
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
                  patchReview={patchReviews[message.id] ?? initialPatchReviewState}
                  patchProposal={state.patchProposalsByMessageId.get(message.id) ?? null}
                  canReviewPatch={profile?.role === "student"}
                  projectId={state.project?.id ?? null}
                  projectHasLocalRoot={Boolean(state.project?.local_path_hash)}
                  projectName={state.project?.name ?? null}
                  onValidatePatch={() => void validatePatchMessage(message)}
                  onApplyPatch={() => void applyPatchMessage(message)}
                  onRevertPatch={() => void revertPatchMessage(message)}
                  onDismissPatch={() => void dismissPatchMessage(message)}
                />
              ))
            )}
          </div>
        </article>

        <aside className="detail-panel composer-panel">
          <div>
            <p className="eyebrow">Reply</p>
            <h2>メッセージ送信</h2>
          </div>

          <label>
            種類
            <select
              value={messageType}
              onChange={(event) => setMessageType(event.target.value as MessageType)}
            >
              {(["text", "code", "environment", "ai_summary", "patch"] as MessageType[]).map(
                (type) => (
                  <option key={type} value={type}>
                    {messageTypeLabels[type]}
                  </option>
                )
              )}
            </select>
          </label>

          <label>
            内容
            <textarea
              rows={messageType === "code" || messageType === "patch" ? 12 : 7}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>

          {sendError && (
            <p className="message error" role="alert">
              {sendError}
            </p>
          )}

          <button
            className="primary-button"
            disabled={sending || !body.trim()}
            type="button"
            onClick={() => void sendMessage()}
          >
            {sending ? "送信中..." : "送信"}
          </button>

          {profile?.role === "teacher" ? (
            <div className="teacher-patch-composer">
              <div>
                <p className="eyebrow">Patch Composer</p>
                <h2>先生パッチ提案</h2>
              </div>

              <label>
                対象ファイル
                <input
                  placeholder="src/calculator.ts"
                  value={teacherPatchTargetFilePath}
                  onChange={(event) => setTeacherPatchTargetFilePath(event.target.value)}
                />
              </label>

              <label>
                Base commit
                <input
                  placeholder="abcdef123456"
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
          ) : null}

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

          <Link
            className="secondary-link"
            to={profile?.role === "student" ? "/student" : "/teacher/queue"}
          >
            {profile?.role === "student" ? "ホームへ戻る" : "キューへ戻る"}
          </Link>
        </aside>
      </div>
    </section>
  );
};

const MessageBubble = ({
  message,
  senderName,
  patchReview,
  patchProposal,
  canReviewPatch,
  projectId,
  projectHasLocalRoot,
  projectName,
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
  onValidatePatch: () => void;
  onApplyPatch: () => void;
  onRevertPatch: () => void;
  onDismissPatch: () => void;
}): ReactElement => {
  const isCodeLike = message.message_type === "code" || message.message_type === "patch";
  const viewerKind = message.message_type === "patch" ? "diff" : "code";

  return (
    <article className={`chat-message ${message.sender_type}`}>
      <header>
        <strong>{senderName ?? senderLabels[message.sender_type]}</strong>
        <span>{messageTypeLabels[message.message_type]}</span>
        <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time>
      </header>

      {isCodeLike ? (
        <CodeContextViewer content={message.body} kind={viewerKind} />
      ) : (
        <TextMessageBody body={message.body} />
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
    </article>
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
    <section className="patch-review-panel" aria-label="Patch review">
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
              <span>Base {shortCommit(patchProposal.base_commit_sha)}</span>
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
            <span>HEAD {shortCommit(validation.currentHead)}</span>
            {validation.expectedBaseCommit ? (
              <span>Base {shortCommit(validation.expectedBaseCommit)}</span>
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
