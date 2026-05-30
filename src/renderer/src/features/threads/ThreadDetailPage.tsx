import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  Database,
  MessageSenderType,
  MessageType,
  ThreadStatus
} from "../../../../shared/database.types";
import type {
  PatchApplyResponse,
  PatchApplyStatus,
  PatchValidateResponse,
  PatchValidationStatus
} from "../../../../shared/ipc";
import { CodeContextViewer } from "../../components/CodeContextViewer";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
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
  usersById: Map<string, Pick<UserRow, "id" | "display_name" | "email" | "role">>;
}

interface PatchReviewState {
  validating: boolean;
  applying: boolean;
  validation: PatchValidateResponse | null;
  applyResult: PatchApplyResponse | null;
  error: string | null;
}

const initialState: ThreadDetailState = {
  loading: true,
  error: null,
  thread: null,
  project: null,
  messages: [],
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
  permission_denied: "権限エラー",
  failed: "失敗"
};

const unique = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value)))
];

const sortMessages = (messages: MessageRow[]): MessageRow[] => {
  return [...messages].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
};

const initialPatchReviewState: PatchReviewState = {
  validating: false,
  applying: false,
  validation: null,
  applyResult: null,
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
    applyResult.status === "stale"
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
        const senderIds = unique(messages.map((message) => message.sender_user_id));
        const [usersResult, projectResult] = await Promise.all([
          senderIds.length > 0
            ? supabase.from("users").select("id,display_name,email,role").in("id", senderIds)
            : Promise.resolve({ data: [], error: null }),
          supabase
            .from("projects")
            .select("id,name,local_path_hash")
            .eq("id", threadResult.data.project_id)
            .single()
        ]);

        if (usersResult.error || projectResult.error) {
          throw usersResult.error ?? projectResult.error;
        }

        if (mounted) {
          setState({
            loading: false,
            error: null,
            thread: threadResult.data,
            project: projectResult.data,
            messages,
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
        localPathHash,
        patchText: message.body,
        expectedBaseCommit: extractExpectedBaseCommit(message.body)
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
        patchId: validation.patchId,
        confirmationToken: validation.confirmationToken
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      updatePatchReview(message.id, (current) => ({
        ...current,
        applying: false,
        applyResult: result.data,
        error: null
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
                  canReviewPatch={profile?.role === "student"}
                  projectHasLocalRoot={Boolean(state.project?.local_path_hash)}
                  projectName={state.project?.name ?? null}
                  onValidatePatch={() => void validatePatchMessage(message)}
                  onApplyPatch={() => void applyPatchMessage(message)}
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
  canReviewPatch,
  projectHasLocalRoot,
  projectName,
  onValidatePatch,
  onApplyPatch
}: {
  message: MessageRow;
  senderName: string | null | undefined;
  patchReview: PatchReviewState;
  canReviewPatch: boolean;
  projectHasLocalRoot: boolean;
  projectName: string | null;
  onValidatePatch: () => void;
  onApplyPatch: () => void;
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
        <p>{message.body}</p>
      )}

      {message.message_type === "patch" ? (
        <PatchReviewPanel
          canReviewPatch={canReviewPatch}
          projectHasLocalRoot={projectHasLocalRoot}
          projectName={projectName}
          review={patchReview}
          onApplyPatch={onApplyPatch}
          onValidatePatch={onValidatePatch}
        />
      ) : null}
    </article>
  );
};

const PatchReviewPanel = ({
  review,
  canReviewPatch,
  projectHasLocalRoot,
  projectName,
  onValidatePatch,
  onApplyPatch
}: {
  review: PatchReviewState;
  canReviewPatch: boolean;
  projectHasLocalRoot: boolean;
  projectName: string | null;
  onValidatePatch: () => void;
  onApplyPatch: () => void;
}): ReactElement => {
  const validation = review.validation;
  const applyResult = review.applyResult;
  const canApply = Boolean(
    validation?.canApply &&
    validation.patchId &&
    validation.confirmationToken &&
    !applyResult?.applied
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

      {!canReviewPatch ? (
        <p className="message warning">パッチ適用は生徒のローカル環境でのみ承認できます。</p>
      ) : null}

      {canReviewPatch && !projectHasLocalRoot ? (
        <p className="message warning">
          ローカルフォルダが未登録です。プロジェクト設定からフォルダを選択してください。
        </p>
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

      {review.error ? (
        <p className="message error" role="alert">
          {review.error}
        </p>
      ) : null}

      {canReviewPatch ? (
        <div className="patch-review-actions">
          <button
            className="secondary-button"
            disabled={review.validating || review.applying || !projectHasLocalRoot}
            type="button"
            onClick={onValidatePatch}
          >
            {review.validating ? "確認中..." : validation ? "再確認" : "安全確認"}
          </button>
          <button
            className="primary-button"
            disabled={!canApply || review.validating || review.applying}
            type="button"
            onClick={onApplyPatch}
          >
            {review.applying ? "適用中..." : applyResult?.applied ? "適用済み" : "承認して適用"}
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
