import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Database } from "../../../../shared/database.types";
import type {
  GitDiffCollectionRequest,
  GitDiffCollectionResponse,
  ProjectGitInspectionResponse,
  ProjectRootSelectionResponse
} from "../../../../shared/ipc";
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

interface GitDiffUiState {
  loading: boolean;
  response: GitDiffCollectionResponse | null;
  error: string | null;
  selectedRoot: ProjectRootSelectionResponse | null;
  inspection: ProjectGitInspectionResponse | null;
}

const initialState: ThreadCreateState = {
  loading: true,
  error: null,
  projects: []
};

const initialGitDiffState: GitDiffUiState = {
  loading: false,
  response: null,
  error: null,
  selectedRoot: null,
  inspection: null
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
  secretScan,
  gitDiff
}: {
  situation: string;
  errorText: string;
  commandText: string;
  relatedFiles: string[];
  secretScan: SecretScanResult;
  gitDiff: GitDiffCollectionResponse | null;
}): string => {
  const sections = [
    `## 状況説明\n${situation.trim()}`,
    `## エラー文\n${errorText.trim() || "未入力"}`,
    `## 実行コマンド\n${commandText.trim() || "未入力"}`,
    `## 関連ファイル\n${relatedFiles.length > 0 ? relatedFiles.join("\n") : "未選択"}`,
    buildGitDiffMessage(gitDiff),
    "## 環境情報\n未収集。環境スナップショット機能と連携予定です。",
    `## 秘密情報チェック\n${secretScan.blocked ? `ブロック: ${secretScan.findings.join(", ")}` : "mock チェック通過"}`
  ];

  return sections.join("\n\n");
};

const formatChangedFiles = (gitDiff: GitDiffCollectionResponse): string => {
  if (gitDiff.changedFiles.length === 0) {
    return "未コミット差分なし";
  }

  return gitDiff.changedFiles
    .map((file) => {
      const states = [
        file.staged ? `staged:${file.stagedStatus ?? "changed"}` : null,
        file.unstaged ? `unstaged:${file.unstagedStatus ?? "changed"}` : null
      ].filter(Boolean);
      const flags = [
        file.isBinary ? "binary" : null,
        file.isLockfile ? "lockfile" : null,
        file.requiresSecretScan ? "secret-scan" : null,
        file.omissionReason ? `omitted:${file.omissionReason}` : null
      ].filter(Boolean);

      return `- ${file.path} (${[...states, ...flags].join(", ")})`;
    })
    .join("\n");
};

const formatDiffSection = (
  title: string,
  section: GitDiffCollectionResponse["stagedDiff"]
): string => {
  if (!section.text) {
    return `### ${title}\n差分本文なし`;
  }

  const note = [
    section.truncated ? "一部切り詰め" : null,
    section.omittedFileCount > 0 ? `${section.omittedFileCount} ファイル省略` : null
  ]
    .filter(Boolean)
    .join(" / ");

  return `### ${title}${note ? ` (${note})` : ""}\n\`\`\`diff\n${section.text}\n\`\`\``;
};

const buildGitDiffMessage = (gitDiff: GitDiffCollectionResponse | null): string => {
  if (!gitDiff) {
    return "## Git差分\n未収集。ローカルフォルダ未選択または収集中に失敗した場合も質問作成は継続できます。";
  }

  const omittedFiles =
    gitDiff.omittedFiles.length > 0
      ? gitDiff.omittedFiles
          .map((file) => `- ${file.path} (${file.omissionReason ?? "omitted"})`)
          .join("\n")
      : "なし";
  const sensitiveFiles =
    gitDiff.sensitiveFilePaths.length > 0 ? gitDiff.sensitiveFilePaths.join("\n") : "なし";

  return [
    "## Git差分",
    `状態: ${gitDiff.message}`,
    `branch: ${gitDiff.branch ?? "未取得"}`,
    `HEAD: ${gitDiff.headCommit ?? "未取得"}`,
    `対象フォルダ: ${gitDiff.displayName ?? "未選択"}`,
    "### 変更ファイル",
    formatChangedFiles(gitDiff),
    "### 送信前 scanner 候補",
    sensitiveFiles,
    "### 差分本文から省略したファイル",
    omittedFiles,
    formatDiffSection("staged diff", gitDiff.stagedDiff),
    formatDiffSection("unstaged diff", gitDiff.unstagedDiff)
  ].join("\n");
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
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<MessageStatus>("warning");
  const [gitDiffState, setGitDiffState] = useState<GitDiffUiState>(initialGitDiffState);

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

  const relatedFiles = splitRelatedFiles(relatedFilesText);
  const secretScan = runMockSecretScan([
    title,
    situation,
    errorText,
    commandText,
    relatedFilesText
  ]);
  const selectedProject = state.projects.find((project) => project.id === selectedProjectId);
  const missingRequiredFields = !selectedProject || !title.trim() || !situation.trim();
  const canSubmit =
    !submitting &&
    profile?.role === "student" &&
    state.projects.length > 0 &&
    !missingRequiredFields &&
    !secretScan.blocked;

  const collectGitDiff = useCallback(
    async (
      input: GitDiffCollectionRequest,
      options: { silent?: boolean } = {}
    ): Promise<GitDiffCollectionResponse | null> => {
      setGitDiffState((current) => ({
        ...current,
        loading: true,
        error: null
      }));

      try {
        const result = await window.ask.gitDiff.collect(input);

        if (!result.ok) {
          if (!options.silent) {
            setMessageStatus("warning");
            setMessage(result.error.message);
          }

          setGitDiffState((current) => ({
            ...current,
            loading: false,
            response: null,
            error: result.error.message
          }));
          return null;
        }

        setGitDiffState((current) => ({
          ...current,
          loading: false,
          response: result.data,
          error: null
        }));
        return result.data;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Git差分を収集できませんでした。";

        if (!options.silent) {
          setMessageStatus("warning");
          setMessage(`${errorMessage} 質問作成は継続できます。`);
        }

        setGitDiffState((current) => ({
          ...current,
          loading: false,
          response: null,
          error: errorMessage
        }));
        return null;
      }
    },
    []
  );

  const selectGitDiffRoot = async (): Promise<void> => {
    if (!selectedProject) {
      setMessageStatus("warning");
      setMessage("先にプロジェクトを選択してください。");
      return;
    }

    setGitDiffState((current) => ({
      ...current,
      loading: true,
      error: null
    }));

    try {
      const rootResult = await window.ask.project.selectRoot();

      if (!rootResult.ok) {
        setGitDiffState((current) => ({
          ...current,
          loading: false,
          error: rootResult.error.message
        }));
        setMessageStatus("warning");
        setMessage(rootResult.error.message);
        return;
      }

      if (!rootResult.data.selected || !rootResult.data.projectRootId) {
        setGitDiffState((current) => ({
          ...current,
          loading: false
        }));
        setMessageStatus("warning");
        setMessage("フォルダ選択をキャンセルしました。");
        return;
      }

      const inspectionResult = await window.ask.project.inspectGit({
        projectRootId: rootResult.data.projectRootId
      });

      if (!inspectionResult.ok) {
        setGitDiffState((current) => ({
          ...current,
          loading: false,
          selectedRoot: rootResult.data,
          error: inspectionResult.error.message
        }));
        setMessageStatus("warning");
        setMessage(inspectionResult.error.message);
        return;
      }

      const selectedHash = selectedProject.local_path_hash;
      const inspectionHash = inspectionResult.data.localPathHash;
      const repoMatches =
        !inspectionResult.data.normalizedGithubRepoUrl ||
        inspectionResult.data.normalizedGithubRepoUrl === selectedProject.github_repo_url;
      const hashMatches = !selectedHash || !inspectionHash || selectedHash === inspectionHash;

      setGitDiffState((current) => ({
        ...current,
        selectedRoot: rootResult.data,
        inspection: inspectionResult.data
      }));

      if (!inspectionResult.data.canRegister || !repoMatches || !hashMatches) {
        const mismatchMessage = !hashMatches
          ? "選択フォルダが登録済みプロジェクトの local_path_hash と一致しません。"
          : "選択フォルダが登録済みプロジェクトの GitHub repository と一致しません。";
        setGitDiffState((current) => ({
          ...current,
          loading: false,
          error: mismatchMessage
        }));
        setMessageStatus("warning");
        setMessage(mismatchMessage);
        return;
      }

      const diff = await collectGitDiff({
        projectRootId: rootResult.data.projectRootId
      });

      if (diff) {
        setMessageStatus(
          diff.status === "ready" || diff.status === "empty" ? "success" : "warning"
        );
        setMessage(diff.message);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "ローカルフォルダを確認できませんでした。";
      setGitDiffState((current) => ({
        ...current,
        loading: false,
        error: errorMessage
      }));
      setMessageStatus("warning");
      setMessage(`${errorMessage} 質問作成は継続できます。`);
    }
  };

  const ensureGitDiffForSubmit = async (): Promise<GitDiffCollectionResponse | null> => {
    if (gitDiffState.response) {
      return gitDiffState.response;
    }

    if (!selectedProject?.local_path_hash) {
      return null;
    }

    return collectGitDiff(
      {
        localPathHash: selectedProject.local_path_hash
      },
      { silent: true }
    );
  };

  const gitDiffResponse = gitDiffState.response;
  const gitDiffSummary = gitDiffState.loading
    ? "収集中"
    : gitDiffResponse
      ? gitDiffResponse.status === "ready"
        ? `${gitDiffResponse.changedFiles.length} ファイル`
        : gitDiffResponse.status === "empty"
          ? "差分なし"
          : "未収集"
      : "未収集";
  const gitDiffStatusMessage =
    gitDiffState.error ??
    gitDiffResponse?.message ??
    "ローカルフォルダを選択すると Git差分を収集します。";
  const gitDiffStatus = gitDiffState.error
    ? "warning"
    : gitDiffResponse?.status === "ready" || gitDiffResponse?.status === "empty"
      ? "success"
      : "warning";

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
      const gitDiff = await ensureGitDiffForSubmit();
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
        secretScan,
        gitDiff
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
                onChange={(event) => {
                  setSelectedProjectId(event.target.value);
                  setGitDiffState(initialGitDiffState);
                }}
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
              <strong>{gitDiffSummary}</strong>
              <span>branch</span>
              <strong>
                {gitDiffResponse?.branch ?? selectedProject?.default_branch ?? "未取得"}
              </strong>
              <span>HEAD</span>
              <strong>{gitDiffResponse?.headShortCommit ?? "未取得"}</strong>
              <span>環境情報</span>
              <strong>未収集</strong>
              <span>秘密情報チェック</span>
              <strong>{secretScan.blocked ? "送信停止" : "通過"}</strong>
              <span>関連ファイル</span>
              <strong>{relatedFiles.length} 件</strong>
            </div>

            <div className="git-diff-controls">
              <button
                className="secondary-button"
                disabled={gitDiffState.loading || !selectedProject}
                type="button"
                onClick={() => void selectGitDiffRoot()}
              >
                {gitDiffState.loading ? "Git差分を確認中..." : "ローカルフォルダを選択"}
              </button>
              <p className={`message ${gitDiffStatus}`} role="status">
                {gitDiffStatusMessage}
              </p>
              {gitDiffResponse?.sensitiveFilePaths.length ? (
                <p className="message warning" role="status">
                  scanner 候補: {gitDiffResponse.sensitiveFilePaths.join(", ")}
                </p>
              ) : null}
            </div>

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
