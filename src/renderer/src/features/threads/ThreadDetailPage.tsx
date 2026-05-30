import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import type { AiAssistRequest, AiContextEntry } from "../../../../shared/aiPipeline";
import type {
  Database,
  MessageSenderType,
  MessageType,
  ThreadStatus
} from "../../../../shared/database.types";
import { scanSecrets } from "../../../../shared/secretScanner";
import { CodeContextViewer } from "../../components/CodeContextViewer";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];

interface ThreadDetailState {
  loading: boolean;
  error: string | null;
  thread: ThreadRow | null;
  messages: MessageRow[];
  usersById: Map<string, Pick<UserRow, "id" | "display_name" | "email" | "role">>;
}

const initialState: ThreadDetailState = {
  loading: true,
  error: null,
  thread: null,
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

export const ThreadDetailPage = (): ReactElement => {
  const { threadId } = useParams();
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<ThreadDetailState>(initialState);
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

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

        const senderIds = unique(
          (messagesResult.data ?? []).map((message) => message.sender_user_id)
        );
        const usersResult =
          senderIds.length > 0
            ? await supabase.from("users").select("id,display_name,email,role").in("id", senderIds)
            : { data: [], error: null };

        if (usersResult.error) {
          throw usersResult.error;
        }

        if (mounted) {
          setState({
            loading: false,
            error: null,
            thread: threadResult.data,
            messages: messagesResult.data ?? [],
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
            リアルタイムでメッセージを確認し、テキストやコードを送信できます。
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
              rows={messageType === "code" ? 12 : 7}
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

          <div className="ai-thread-assist">
            <div>
              <p className="eyebrow">AI Assist</p>
              <h2>原因候補</h2>
            </div>
            <button
              className="secondary-button"
              disabled={aiGenerating || state.messages.length === 0}
              type="button"
              onClick={() => void generateCauseCandidates()}
            >
              {aiGenerating ? "原因候補を生成中..." : "AIで原因候補を追加"}
            </button>
            <p className="message warning" role="status">
              AI 出力は断定ではありません。次に確認する項目としてチャットに保存します。
            </p>
            {aiError ? (
              <p className="message error" role="alert">
                {aiError}
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
  senderName
}: {
  message: MessageRow;
  senderName: string | null | undefined;
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
    </article>
  );
};

const ThreadStatePage = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
