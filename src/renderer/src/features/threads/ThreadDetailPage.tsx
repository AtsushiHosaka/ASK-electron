import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  Database,
  MessageSenderType,
  MessageType,
  ThreadStatus
} from "../../../../shared/database.types";
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

const codeTokenPattern =
  /(\/\/.*|\/\*[\s\S]*?\*\/|(["'`])(?:\\.|(?!\2).)*\2|\b(?:const|let|var|function|return|if|else|for|while|await|async|import|export|from|type|interface|class|extends|new|try|catch|throw)\b|\b\d+(?:\.\d+)?\b)/g;

const unique = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value)))
];

const sortMessages = (messages: MessageRow[]): MessageRow[] => {
  return [...messages].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
};

const tokenClassName = (token: string): string => {
  if (token.startsWith("//") || token.startsWith("/*")) {
    return "syntax-comment";
  }

  if (/^["'`]/.test(token)) {
    return "syntax-string";
  }

  if (/^\d/.test(token)) {
    return "syntax-number";
  }

  return "syntax-keyword";
};

const renderHighlightedCode = (source: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of source.matchAll(codeTokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (index > cursor) {
      nodes.push(source.slice(cursor, index));
    }

    nodes.push(
      <span className={tokenClassName(token)} key={`${index}-${token}`}>
        {token}
      </span>
    );
    cursor = index + token.length;
  }

  if (cursor < source.length) {
    nodes.push(source.slice(cursor));
  }

  return nodes;
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

  return (
    <article className={`chat-message ${message.sender_type}`}>
      <header>
        <strong>{senderName ?? senderLabels[message.sender_type]}</strong>
        <span>{messageTypeLabels[message.message_type]}</span>
        <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time>
      </header>

      {isCodeLike ? (
        <pre className="chat-code-block">
          <code>{renderHighlightedCode(message.body)}</code>
        </pre>
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
