import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Database } from "../../../../shared/database.types";
import type { GitDiffContextResponse } from "../../../../shared/ipc";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];

type MessageStatus = "success" | "warning" | "error";

interface ThreadCreateState {
  loading: boolean;
  error: string | null;
  projects: ProjectRow[];
}

interface SecretScanResult {
  blocked: boolean;
  findings: string[];
}

const initialState: ThreadCreateState = {
  loading: true,
  error: null,
  projects: []
};

const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: ".env file", pattern: /(^|\s)\.env(\.|$|\s)/i },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { label: "API key style text", pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token)\b/i },
  { label: "password assignment", pattern: /\b(password|passwd|pwd)\s*[:=]/i }
];

const runMockSecretScan = (values: string[]): SecretScanResult => {
  const source = values.join("\n");
  const findings = secretPatterns
    .filter((entry) => entry.pattern.test(source))
    .map((entry) => entry.label);

  return {
    blocked: findings.length > 0,
    findings
  };
};

const splitRelatedFiles = (value: string): string[] => {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const buildInitialMessage = ({
  situation,
  errorText,
  commandText,
  relatedFiles,
  gitContext,
  gitContextError,
  secretScan
}: {
  situation: string;
  errorText: string;
  commandText: string;
  relatedFiles: string[];
  gitContext: GitDiffContextResponse | null;
  gitContextError: string | null;
  secretScan: SecretScanResult;
}): string => {
  const sections = [
    `## 状況説明\n${situation.trim()}`,
    `## エラー文\n${errorText.trim() || "未入力"}`,
    `## 実行コマンド\n${commandText.trim() || "未入力"}`,
    `## 関連ファイル\n${relatedFiles.length > 0 ? relatedFiles.join("\n") : "未選択"}`,
    `## Git差分\n${formatGitContextForMessage(gitContext, gitContextError)}`,
    "## 環境情報\n未収集。環境スナップショット機能と連携予定です。",
    `## 秘密情報チェック\n${secretScan.blocked ? `ブロック: ${secretScan.findings.join(", ")}` : "mock チェック通過"}`
  ];

  return sections.join("\n\n");
};

const gitContextStatusLabels: Record<GitDiffContextResponse["status"], string> = {
  ready: "収集済み",
  empty: "差分なし",
  partial: "一部収集",
  root_not_selected: "未選択",
  git_missing: "Gitなし",
  git_timeout: "タイムアウト",
  not_git_repository: "Git外",
  error: "失敗"
};

const omissionReasonLabels: Record<
  GitDiffContextResponse["omittedFiles"][number]["reason"],
  string
> = {
  binary: "binary",
  lockfile: "lockfile",
  sensitive_path: "送信禁止候補",
  file_limit: "ファイル数上限"
};

const formatGitContextForMessage = (
  gitContext: GitDiffContextResponse | null,
  gitContextError: string | null
): string => {
  if (gitContextError) {
    return `収集できませんでした: ${gitContextError}\n質問作成は継続されました。`;
  }

  if (!gitContext) {
    return "未収集。ローカルフォルダが未選択、または収集中です。";
  }

  const summary = [
    `収集結果: ${gitContext.message}`,
    `branch: ${gitContext.branch ?? "不明"}`,
    `HEAD: ${gitContext.headCommit ?? "不明"}`,
    `変更ファイル: ${gitContext.files.length} 件`,
    `差分文字数: ${gitContext.totalDiffChars} / ${gitContext.maxDiffChars}`
  ];

  const fileLines =
    gitContext.files.length > 0
      ? gitContext.files
          .map((file) => {
            const states = [
              file.staged ? "staged" : null,
              file.unstaged ? "unstaged" : null,
              file.binary ? "binary" : null,
              file.lockfile ? "lockfile" : null,
              file.sensitivePath ? "送信禁止候補" : null
            ].filter(Boolean);
            return `- ${file.path}${states.length > 0 ? ` (${states.join(", ")})` : ""}`;
          })
          .join("\n")
      : "- なし";

  const omittedLines =
    gitContext.omittedFiles.length > 0
      ? gitContext.omittedFiles
          .map((file) => `- ${file.path} (${file.kind}, ${omissionReasonLabels[file.reason]})`)
          .join("\n")
      : "- なし";

  const diffSections = gitContext.sections
    .filter((section) => section.text.trim().length > 0)
    .map(
      (section) =>
        `### ${section.kind} diff${section.truncated ? " (truncated)" : ""}\n\n\`\`\`diff\n${section.text}\n\`\`\``
    );

  return [
    summary.join("\n"),
    `### 変更ファイル\n${fileLines}`,
    `### 省略ファイル\n${omittedLines}`,
    diffSections.length > 0 ? diffSections.join("\n\n") : "### diff本文\nなし"
  ].join("\n\n");
};

export const ThreadCreatePage = (): ReactElement => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<ThreadCreateState>(initialState);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [situation, setSituation] = useState("");
  const [errorText, setErrorText] = useState("");
  const [commandText, setCommandText] = useState("");
  const [relatedFilesText, setRelatedFilesText] = useState("");
  const [gitContext, setGitContext] = useState<GitDiffContextResponse | null>(null);
  const [gitContextLoading, setGitContextLoading] = useState(false);
  const [gitContextError, setGitContextError] = useState<string | null>(null);
  const [gitContextRequestHash, setGitContextRequestHash] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<MessageStatus>("warning");

  useEffect(() => {
    let mounted = true;

    const loadProjects = async (): Promise<void> => {
      if (!supabase || !profile) {
        setState({
          loading: false,
          error: "Supabase 設定またはプロフィールを確認できませんでした。",
          projects: []
        });
        return;
      }

      try {
        const { data, error } = await supabase
          .from("projects")
          .select(
            "id,owner_user_id,class_id,name,local_path_hash,github_repo_url,default_branch,created_at"
          )
          .eq("owner_user_id", profile.id)
          .order("created_at", { ascending: false });

        if (error) {
          throw error;
        }

        if (mounted) {
          const projects = data ?? [];
          setState({ loading: false, error: null, projects });
          setSelectedProjectId((current) => current || projects[0]?.id || "");
        }
      } catch (error) {
        console.error("Failed to load projects for thread creation", error);

        if (mounted) {
          setState({
            loading: false,
            error: "質問作成に必要なプロジェクトを読み込めませんでした。",
            projects: []
          });
        }
      }
    };

    void loadProjects();

    return () => {
      mounted = false;
    };
  }, [profile, supabase]);

  const selectedProject = state.projects.find((project) => project.id === selectedProjectId);

  useEffect(() => {
    let mounted = true;
    const localPathHash = selectedProject?.local_path_hash;

    if (!localPathHash) {
      return;
    }

    const collect = async (): Promise<void> => {
      setGitContextRequestHash(localPathHash);
      setGitContextLoading(true);
      setGitContextError(null);

      try {
        const result = await window.ask.git.collectDiffContext({ localPathHash });

        if (!mounted) {
          return;
        }

        if (!result.ok) {
          setGitContext(null);
          setGitContextError(result.error.message);
          return;
        }

        setGitContext(result.data);
      } catch (error) {
        if (!mounted) {
          return;
        }

        setGitContext(null);
        setGitContextError(
          error instanceof Error ? error.message : "Git差分を収集できませんでした。"
        );
      } finally {
        if (mounted) {
          setGitContextLoading(false);
        }
      }
    };

    void collect();

    return () => {
      mounted = false;
    };
  }, [selectedProject]);

  const activeLocalPathHash = selectedProject?.local_path_hash ?? null;
  const activeGitContext =
    activeLocalPathHash && gitContext?.localPathHash === activeLocalPathHash ? gitContext : null;
  const activeGitContextLoading = Boolean(
    activeLocalPathHash && gitContextRequestHash === activeLocalPathHash && gitContextLoading
  );
  const activeGitContextError = activeLocalPathHash
    ? gitContextRequestHash === activeLocalPathHash
      ? gitContextError
      : null
    : selectedProject
      ? "このプロジェクトにはローカルパス情報がありません。"
      : null;

  const relatedFiles = splitRelatedFiles(relatedFilesText);
  const secretScan = runMockSecretScan([
    title,
    situation,
    errorText,
    commandText,
    relatedFilesText,
    ...(activeGitContext?.secretScanValues ?? [])
  ]);
  const missingRequiredFields = !selectedProject || !title.trim() || !situation.trim();
  const canSubmit =
    !submitting &&
    profile?.role === "student" &&
    state.projects.length > 0 &&
    !missingRequiredFields &&
    !secretScan.blocked;
  const gitContextLabel = activeGitContextLoading
    ? "収集中"
    : activeGitContext
      ? gitContextStatusLabels[activeGitContext.status]
      : activeGitContextError
        ? "失敗"
        : "未収集";
  const gitBranchHeadLabel = activeGitContext?.branch
    ? `${activeGitContext.branch} / ${activeGitContext.headCommit?.slice(0, 8) ?? "HEAD不明"}`
    : "未確認";

  const refreshGitContext = async (): Promise<void> => {
    const localPathHash = selectedProject?.local_path_hash;

    if (!localPathHash) {
      setGitContext(null);
      setGitContextError("このプロジェクトにはローカルパス情報がありません。");
      return;
    }

    setGitContextRequestHash(localPathHash);
    setGitContextLoading(true);
    setGitContextError(null);

    try {
      const result = await window.ask.git.collectDiffContext({ localPathHash });

      if (!result.ok) {
        setGitContext(null);
        setGitContextError(result.error.message);
        return;
      }

      setGitContext(result.data);
    } catch (error) {
      setGitContext(null);
      setGitContextError(
        error instanceof Error ? error.message : "Git差分を収集できませんでした。"
      );
    } finally {
      setGitContextLoading(false);
    }
  };

  const submitThread = async (): Promise<void> => {
    if (!supabase || !profile) {
      setMessageStatus("error");
      setMessage("Supabase 設定またはプロフィールを確認できませんでした。");
      return;
    }

    if (profile.role !== "student") {
      setMessageStatus("warning");
      setMessage("質問作成は生徒アカウントで利用してください。");
      return;
    }

    if (!selectedProject) {
      setMessageStatus("warning");
      setMessage("先にプロジェクトを登録してください。");
      return;
    }

    if (!title.trim() || !situation.trim()) {
      setMessageStatus("warning");
      setMessage("タイトルと状況説明を入力してください。");
      return;
    }

    if (secretScan.blocked) {
      setMessageStatus("error");
      setMessage("秘密情報の可能性がある内容を検出したため送信を止めました。");
      return;
    }

    setSubmitting(true);
    setMessage(null);

    let createdThreadId: string | null = null;

    try {
      const { data: thread, error: threadError } = await supabase
        .from("threads")
        .insert({
          project_id: selectedProject.id,
          created_by: profile.id,
          title: title.trim(),
          status: "open",
          priority: "normal",
          ai_used: false
        })
        .select("id")
        .single();

      if (threadError) {
        throw threadError;
      }

      createdThreadId = thread.id;

      const body = buildInitialMessage({
        situation,
        errorText,
        commandText,
        relatedFiles,
        gitContext: activeGitContext,
        gitContextError: activeGitContextError,
        secretScan
      });

      const { error: messageError } = await supabase.from("messages").insert({
        thread_id: thread.id,
        sender_user_id: profile.id,
        sender_type: "student",
        body,
        message_type: "text"
      });

      if (messageError) {
        const { error: rollbackError } = await supabase
          .from("threads")
          .delete()
          .eq("id", thread.id);
        if (rollbackError) {
          console.error("Failed to roll back empty question thread", rollbackError);
        } else {
          createdThreadId = null;
        }
        throw messageError;
      }

      navigate(`/threads/${thread.id}`);
    } catch (error) {
      console.error("Failed to create question thread", error);
      if (createdThreadId) {
        const { error: rollbackError } = await supabase
          .from("threads")
          .delete()
          .eq("id", createdThreadId);
        if (rollbackError) {
          console.error("Failed to roll back empty question thread", rollbackError);
        }
      }
      setMessageStatus("error");
      setMessage(
        "質問スレッドを作成できませんでした。入力内容と参加中のクラスを確認してください。"
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (state.loading) {
    return (
      <ThreadCreateStatePage title="読み込み中" body="質問作成に必要な情報を確認しています。" />
    );
  }

  if (state.error) {
    return <ThreadCreateStatePage title="読み込みに失敗しました" body={state.error} />;
  }

  return (
    <section className="thread-create">
      <div className="page-header">
        <div>
          <p className="eyebrow">Question</p>
          <h1>質問を作成</h1>
          <p className="muted">プロジェクト、状況、エラー、実行コマンドをまとめて送信します。</p>
        </div>
        <div className="progress-summary">
          <strong>{state.projects.length} プロジェクト</strong>
          <span>{selectedProject?.name ?? "登録済みプロジェクトが必要です"}</span>
        </div>
      </div>

      {state.projects.length === 0 ? (
        <article className="detail-panel">
          <h2>プロジェクト未登録</h2>
          <p className="muted">
            質問を作成する前に、GitHub repository付きのプロジェクトを登録してください。
          </p>
          <Link className="secondary-link" to="/projects">
            プロジェクト登録へ
          </Link>
        </article>
      ) : (
        <div className="thread-create-grid">
          <article className="detail-panel thread-form-panel">
            <div>
              <p className="eyebrow">Input</p>
              <h2>質問内容</h2>
            </div>

            <label>
              プロジェクト
              <select
                value={selectedProjectId}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                {state.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              タイトル
              <input
                maxLength={120}
                placeholder="例: Vite dev server が起動しない"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>

            <label>
              状況説明
              <textarea
                rows={5}
                placeholder="何をしようとして、どこで止まっているか"
                value={situation}
                onChange={(event) => setSituation(event.target.value)}
              />
            </label>

            <label>
              エラー文
              <textarea
                rows={4}
                placeholder="表示されたエラーやログ"
                value={errorText}
                onChange={(event) => setErrorText(event.target.value)}
              />
            </label>

            <label>
              実行コマンド
              <textarea
                rows={3}
                placeholder="例: npm run dev"
                value={commandText}
                onChange={(event) => setCommandText(event.target.value)}
              />
            </label>

            <label>
              関連ファイル
              <textarea
                rows={4}
                placeholder={"1行に1ファイル\nsrc/main.ts\npackage.json"}
                value={relatedFilesText}
                onChange={(event) => setRelatedFilesText(event.target.value)}
              />
            </label>
          </article>

          <aside className="detail-panel thread-preview-panel">
            <div>
              <p className="eyebrow">Preview</p>
              <h2>送信前チェック</h2>
            </div>

            <div className="project-summary-list">
              <span>Git差分</span>
              <strong>{gitContextLabel}</strong>
              <span>branch / HEAD</span>
              <strong>{gitBranchHeadLabel}</strong>
              <span>変更ファイル</span>
              <strong>{activeGitContext ? `${activeGitContext.files.length} 件` : "未確認"}</strong>
              <span>環境情報</span>
              <strong>未収集</strong>
              <span>秘密情報チェック</span>
              <strong>{secretScan.blocked ? "送信停止" : "通過"}</strong>
              <span>関連ファイル</span>
              <strong>{relatedFiles.length} 件</strong>
            </div>

            <button
              className="secondary-button"
              disabled={activeGitContextLoading || !selectedProject?.local_path_hash}
              type="button"
              onClick={() => void refreshGitContext()}
            >
              {activeGitContextLoading ? "Git差分を収集中..." : "Git差分を再取得"}
            </button>

            {activeGitContext &&
              activeGitContext.status !== "ready" &&
              activeGitContext.status !== "empty" && (
                <p className="message warning" role="status">
                  {activeGitContext.message}
                </p>
              )}

            {activeGitContextError && (
              <p className="message warning" role="status">
                {activeGitContextError}
              </p>
            )}

            {activeGitContext && activeGitContext.omittedFiles.length > 0 && (
              <p className="message warning" role="status">
                省略ファイル:{" "}
                {activeGitContext.omittedFiles
                  .slice(0, 3)
                  .map((file) => `${file.path} (${omissionReasonLabels[file.reason]})`)
                  .join(", ")}
                {activeGitContext.omittedFiles.length > 3 ? " ..." : ""}
              </p>
            )}

            {secretScan.blocked && (
              <p className="message error" role="alert">
                秘密情報候補: {secretScan.findings.join(", ")}
              </p>
            )}

            {missingRequiredFields && (
              <p className="message warning" role="status">
                タイトル、状況説明、プロジェクトを確認してください。
              </p>
            )}

            <button
              className="primary-button"
              disabled={!canSubmit}
              type="button"
              onClick={() => void submitThread()}
            >
              {submitting ? "作成中..." : "質問スレッドを作成"}
            </button>

            {message && (
              <p
                className={`message ${messageStatus}`}
                role={messageStatus === "error" ? "alert" : "status"}
              >
                {message}
              </p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
};

const ThreadCreateStatePage = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
