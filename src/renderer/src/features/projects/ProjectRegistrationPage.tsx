import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  GitignoreApplyResponse,
  GitignorePreviewResponse,
  ProjectGitInspectionResponse,
  ProjectRootReconnectResponse,
  ProjectRootSelectionResponse
} from "../../../../shared/ipc";
import type { Database, ThreadStatus } from "../../../../shared/database.types";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";
import { trackUsageEvent } from "../../lib/telemetry";

type ClassRow = Database["public"]["Tables"]["classes"]["Row"];
type ClassMemberRow = Database["public"]["Tables"]["class_members"]["Row"];
type GithubConnectionRow = Database["public"]["Tables"]["github_connections"]["Row"];
type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];

interface StudentClassOption {
  membership: ClassMemberRow;
  classRow: ClassRow;
}

interface ProjectRegistrationState {
  loading: boolean;
  error: string | null;
  classes: StudentClassOption[];
  githubConnection: Pick<GithubConnectionRow, "github_username" | "ssh_status"> | null;
}

interface RegistrationReadinessItem {
  label: string;
  complete: boolean;
  value: string;
}

const initialRegistrationState: ProjectRegistrationState = {
  loading: true,
  error: null,
  classes: [],
  githubConnection: null
};

const highRiskGitignorePatterns = new Set([
  ".DS_Store",
  ".env",
  ".env.*",
  ".ssh/",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.pem",
  "*.key",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "dist-electron/",
  "release/",
  "releases/",
  ".venv/"
]);

const threadStatusLabels: Record<ThreadStatus, string> = {
  open: "未対応",
  in_progress: "対応中",
  waiting_student: "確認待ち",
  patch_proposed: "パッチ提案",
  resolved: "解決済み",
  reopened: "再オープン"
};

export const ProjectsPage = (): ReactElement => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<ProjectRegistrationState>(initialRegistrationState);
  const [selectedRoot, setSelectedRoot] = useState<ProjectRootSelectionResponse | null>(null);
  const [inspection, setInspection] = useState<ProjectGitInspectionResponse | null>(null);
  const [projectName, setProjectName] = useState("");
  const [selectedClassId, setSelectedClassId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<"success" | "warning" | "error">("warning");
  const [gitignorePreview, setGitignorePreview] = useState<GitignorePreviewResponse | null>(null);
  const [gitignoreApplyResult, setGitignoreApplyResult] = useState<GitignoreApplyResponse | null>(
    null
  );
  const [gitignoreBusy, setGitignoreBusy] = useState(false);
  const [gitignoreError, setGitignoreError] = useState<string | null>(null);
  const [confirmHighRiskGitignore, setConfirmHighRiskGitignore] = useState(false);

  useEffect(() => {
    let mounted = true;

    const load = async (): Promise<void> => {
      if (!supabase || !profile) {
        setState({
          loading: false,
          error: "Supabase 設定またはプロフィールを確認できませんでした。",
          classes: [],
          githubConnection: null
        });
        return;
      }

      try {
        const { data: memberships, error: membershipsError } = await supabase
          .from("class_members")
          .select("id,class_id,user_id,role,joined_at")
          .eq("user_id", profile.id)
          .eq("role", "student");

        if (membershipsError) {
          throw membershipsError;
        }

        const classIds = [...new Set((memberships ?? []).map((membership) => membership.class_id))];
        const classesResult =
          classIds.length > 0
            ? await supabase
                .from("classes")
                .select("id,organization_id,name,description,created_by,created_at")
                .in("id", classIds)
            : { data: [], error: null };

        if (classesResult.error) {
          throw classesResult.error;
        }

        const { data: githubConnection, error: githubConnectionError } = await supabase
          .from("github_connections")
          .select("github_username,ssh_status")
          .eq("user_id", profile.id)
          .maybeSingle();

        if (githubConnectionError) {
          throw githubConnectionError;
        }

        const classesById = new Map(
          (classesResult.data ?? []).map((classRow) => [classRow.id, classRow])
        );
        const classOptions = (memberships ?? [])
          .map((membership) => {
            const classRow = classesById.get(membership.class_id);

            if (!classRow) {
              return null;
            }

            return { membership, classRow } satisfies StudentClassOption;
          })
          .filter((option): option is StudentClassOption => option !== null);

        if (mounted) {
          setState({
            loading: false,
            error: null,
            classes: classOptions,
            githubConnection: githubConnection ?? null
          });
          setSelectedClassId((current) => current || classOptions[0]?.classRow.id || "");
        }
      } catch (error) {
        console.error("Failed to load project registration prerequisites", error);

        if (mounted) {
          setState({
            loading: false,
            error: "プロジェクト登録に必要な情報を読み込めませんでした。",
            classes: [],
            githubConnection: null
          });
        }
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [profile, supabase]);

  const selectFolder = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setInspection(null);
    setGitignorePreview(null);
    setGitignoreApplyResult(null);
    setGitignoreError(null);
    setConfirmHighRiskGitignore(false);

    try {
      const result = await window.ask.project.selectRoot();

      if (!result.ok) {
        setMessageStatus("error");
        setMessage(result.error.message);
        return;
      }

      if (!result.data.selected || !result.data.projectRootId) {
        setSelectedRoot(null);
        setMessageStatus("warning");
        setMessage("フォルダ選択をキャンセルしました。");
        return;
      }

      setSelectedRoot(result.data);
      setProjectName((current) => current || result.data.displayName || "");

      const inspectionResult = await window.ask.project.inspectGit({
        projectRootId: result.data.projectRootId
      });

      if (!inspectionResult.ok) {
        setMessageStatus("error");
        setMessage(inspectionResult.error.message);
        return;
      }

      setInspection(inspectionResult.data);
      setMessageStatus(inspectionResult.data.canRegister ? "success" : "warning");
      setMessage(inspectionResult.data.message);

      if (inspectionResult.data.canRegister) {
        await previewGitignore(result.data.projectRootId);
      }
    } catch (error) {
      setMessageStatus("error");
      setMessage(
        error instanceof Error ? error.message : "プロジェクトフォルダを確認できませんでした。"
      );
    } finally {
      setBusy(false);
    }
  };

  const previewGitignore = async (
    projectRootId = selectedRoot?.projectRootId ?? ""
  ): Promise<void> => {
    if (!projectRootId) {
      setGitignoreError("先にプロジェクトフォルダを選択してください。");
      return;
    }

    setGitignoreBusy(true);
    setGitignoreError(null);
    setGitignoreApplyResult(null);
    setConfirmHighRiskGitignore(false);

    try {
      const result = await window.ask.gitignore.preview({ projectRootId });

      if (!result.ok) {
        setGitignoreError(result.error.message);
        return;
      }

      setGitignorePreview(result.data);
    } catch (error) {
      setGitignoreError(
        error instanceof Error ? error.message : ".gitignore の推奨内容を確認できませんでした。"
      );
    } finally {
      setGitignoreBusy(false);
    }
  };

  const applyGitignore = async (): Promise<void> => {
    if (!selectedRoot?.projectRootId || !gitignorePreview) {
      setGitignoreError("適用前に.gitignoreの推奨差分を確認してください。");
      return;
    }

    setGitignoreBusy(true);
    setGitignoreError(null);

    try {
      const result = await window.ask.gitignore.apply({
        projectRootId: selectedRoot.projectRootId,
        recommendationHash: gitignorePreview.recommendationHash
      });

      if (!result.ok) {
        setGitignoreError(result.error.message);
        return;
      }

      setGitignoreApplyResult(result.data);

      if (result.data.status === "applied" || result.data.status === "unchanged") {
        setConfirmHighRiskGitignore(false);
        await previewGitignore(selectedRoot.projectRootId);
        return;
      }

      if (result.data.status === "failed" || result.data.status === "stale") {
        setGitignoreError(result.data.message);
      }
    } catch (error) {
      setGitignoreError(
        error instanceof Error ? error.message : ".gitignore を更新できませんでした。"
      );
    } finally {
      setGitignoreBusy(false);
    }
  };

  const registerProject = async (): Promise<void> => {
    if (!supabase || !profile) {
      setMessageStatus("error");
      setMessage("Supabase 設定またはプロフィールを確認できませんでした。");
      return;
    }

    if (!state.githubConnection) {
      setMessageStatus("warning");
      setMessage("GitHub 連携が未完了のため、プロジェクト登録できません。");
      return;
    }

    if (
      !inspection?.canRegister ||
      !inspection.normalizedGithubRepoUrl ||
      !inspection.localPathHash
    ) {
      setMessageStatus("warning");
      setMessage("登録前にGitHubリポジトリへ接続済みのローカルGitフォルダを選択してください。");
      return;
    }

    if (!selectedRoot?.projectRootId) {
      setMessageStatus("warning");
      setMessage("登録前にローカルフォルダを選択してください。");
      return;
    }

    if (!gitignoreCheckedForSelectedRoot) {
      setMessageStatus("warning");
      setMessage("登録前に .gitignore の推奨内容を確認してください。");
      return;
    }

    if (requiresGitignoreConfirmation) {
      setMessageStatus("warning");
      setMessage("高リスクの .gitignore 不足を適用するか、確認チェックを入れてください。");
      return;
    }

    const selectedClass = state.classes.find((option) => option.classRow.id === selectedClassId);

    if (!selectedClass) {
      setMessageStatus("warning");
      setMessage("登録先クラスを選択してください。");
      return;
    }

    const trimmedProjectName = projectName.trim();

    if (!trimmedProjectName) {
      setMessageStatus("warning");
      setMessage("プロジェクト名を入力してください。");
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const reconnectResult = await window.ask.project.reconnectRoot({
        projectRootId: selectedRoot.projectRootId,
        expectedLocalPathHash: inspection.localPathHash,
        expectedGithubRepoUrl: inspection.normalizedGithubRepoUrl
      });

      if (!reconnectResult.ok || !reconnectResult.data.persisted) {
        setMessageStatus("warning");
        setMessage(
          reconnectResult.ok ? reconnectResult.data.message : reconnectResult.error.message
        );
        return;
      }

      const { data, error } = await supabase
        .from("projects")
        .insert({
          owner_user_id: profile.id,
          class_id: selectedClass.classRow.id,
          name: trimmedProjectName,
          local_path_hash: inspection.localPathHash,
          github_repo_url: inspection.normalizedGithubRepoUrl,
          default_branch: inspection.defaultBranch
        })
        .select("id")
        .single();

      if (error) {
        setMessageStatus("error");
        setMessage(
          "プロジェクトを登録できませんでした。GitHub連携とクラス参加状態を確認してください。"
        );
        return;
      }

      void trackUsageEvent({
        eventName: "project_registered",
        classId: selectedClass.classRow.id,
        projectId: data.id,
        success: true,
        properties: {
          default_branch_present: Boolean(inspection.defaultBranch),
          gitignore_checked: gitignoreCheckedForSelectedRoot,
          high_risk_gitignore_missing_count: missingHighRiskEntries.length
        }
      });

      navigate(`/projects/${data.id}`);
    } catch (error) {
      setMessageStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "プロジェクトを登録できませんでした。GitHub連携とクラス参加状態を確認してください。"
      );
    } finally {
      setBusy(false);
    }
  };

  const gitignoreCheckedForSelectedRoot = Boolean(
    selectedRoot?.projectRootId &&
    gitignorePreview &&
    gitignorePreview.projectRootId === selectedRoot.projectRootId
  );
  const missingHighRiskEntries =
    gitignorePreview?.entries.filter(
      (entry) =>
        !entry.alreadyPresent && (entry.required || highRiskGitignorePatterns.has(entry.pattern))
    ) ?? [];
  const gitignoreAppliedOrUnchanged =
    gitignoreApplyResult?.status === "applied" || gitignoreApplyResult?.status === "unchanged";
  const requiresGitignoreConfirmation =
    missingHighRiskEntries.length > 0 && !gitignoreAppliedOrUnchanged && !confirmHighRiskGitignore;
  const repositoryReady = Boolean(
    selectedRoot?.projectRootId &&
    inspection?.canRegister &&
    inspection.normalizedGithubRepoUrl &&
    inspection.localPathHash
  );
  const gitignoreReady =
    Boolean(gitignoreCheckedForSelectedRoot) && !gitignoreBusy && !requiresGitignoreConfirmation;
  const classReady = state.classes.length > 0;
  const registrationReadinessItems: RegistrationReadinessItem[] = [
    {
      label: "GitHub連携",
      complete: Boolean(state.githubConnection),
      value: state.githubConnection?.github_username ?? "未連携"
    },
    {
      label: "フォルダ検証",
      complete: repositoryReady,
      value: selectedRoot?.displayName ?? "未選択"
    },
    {
      label: ".gitignore",
      complete: gitignoreReady,
      value: gitignoreReady ? "確認済み" : "未確認"
    },
    {
      label: "クラス参加",
      complete: classReady,
      value: classReady ? `${state.classes.length} クラス` : "未参加"
    }
  ];
  const readyForRegistrationDetails = registrationReadinessItems.every((item) => item.complete);
  const canRegister =
    readyForRegistrationDetails &&
    state.classes.some((option) => option.classRow.id === selectedClassId) &&
    Boolean(projectName.trim());

  if (state.loading) {
    return (
      <ProjectPageState title="読み込み中" body="プロジェクト登録に必要な情報を確認しています。" />
    );
  }

  if (state.error) {
    return <ProjectPageState title="読み込みに失敗しました" body={state.error} />;
  }

  return (
    <section className="project-registration">
      <div className="page-header">
        <div>
          <p className="eyebrow">Projects</p>
          <h1>プロジェクト登録</h1>
          <p className="muted">GitHubリポジトリへ接続済みのローカルGitフォルダを登録します。</p>
        </div>
        <div className="progress-summary">
          <strong>{state.githubConnection ? "GitHub連携済み" : "GitHub未連携"}</strong>
          <span>
            {state.githubConnection?.github_username ?? "先にGitHub連携を完了してください"}
          </span>
        </div>
      </div>

      <div className="project-registration-grid">
        <article className="detail-panel project-registration-panel">
          <div>
            <p className="eyebrow">Local Repository</p>
            <h2>フォルダ検証</h2>
          </div>
          <button
            className="primary-button"
            disabled={busy}
            type="button"
            onClick={() => void selectFolder()}
          >
            {busy ? "確認中..." : "フォルダを選択して検証"}
          </button>

          {selectedRoot?.selected && (
            <div className="project-summary-list">
              <span>選択フォルダ</span>
              <strong>{selectedRoot.displayName}</strong>
            </div>
          )}

          {inspection && (
            <div className="project-summary-list">
              <span>Git接続先</span>
              <strong>{inspection.remoteOriginUrl ?? "未設定"}</strong>
              <span>GitHubリポジトリ</span>
              <strong>{inspection.normalizedGithubRepoUrl ?? "未検出"}</strong>
              <span>既定ブランチ</span>
              <strong>{inspection.defaultBranch ?? "未検出"}</strong>
              <span>ローカル識別子</span>
              <strong>{inspection.localPathHash?.slice(0, 12) ?? "未生成"}</strong>
            </div>
          )}

          {selectedRoot?.projectRootId && (
            <div className="gitignore-workflow">
              <div>
                <p className="eyebrow">.gitignore</p>
                <h3>登録前の除外設定</h3>
              </div>

              {gitignoreBusy ? (
                <p className="message warning" role="status">
                  .gitignore の推奨内容を確認しています。
                </p>
              ) : null}

              {gitignoreError ? (
                <p className="message error" role="alert">
                  {gitignoreError}
                </p>
              ) : null}

              {gitignorePreview ? (
                <>
                  <div className="gitignore-summary">
                    <span>{gitignorePreview.gitignoreExists ? "既存あり" : "未作成"}</span>
                    <span>追加候補: {gitignorePreview.missingPatterns.length} 件</span>
                    <span>高リスク不足: {missingHighRiskEntries.length} 件</span>
                  </div>

                  <div className="gitignore-entry-list" aria-label=".gitignore 登録前確認">
                    {gitignorePreview.entries.map((entry) => (
                      <div key={entry.pattern} className="gitignore-entry">
                        <strong>{entry.pattern}</strong>
                        <span>
                          {entry.alreadyPresent
                            ? "設定済み"
                            : entry.required || highRiskGitignorePatterns.has(entry.pattern)
                              ? "高リスク不足"
                              : "追加候補"}
                        </span>
                        <p>{entry.reason}</p>
                      </div>
                    ))}
                  </div>

                  {gitignorePreview.canApply ? (
                    <label className="preview-field">
                      追記前の確認差分
                      <pre className="code-preview">{gitignorePreview.previewDiff}</pre>
                    </label>
                  ) : (
                    <p className="message success" role="status">
                      追加が必要な.gitignore候補はありません。
                    </p>
                  )}

                  {missingHighRiskEntries.length > 0 && !gitignoreAppliedOrUnchanged ? (
                    <label className="confirmation-checkbox">
                      <input
                        checked={confirmHighRiskGitignore}
                        type="checkbox"
                        onChange={(event) => setConfirmHighRiskGitignore(event.target.checked)}
                      />
                      <span>
                        高リスクの不足を確認しました。登録前に適用しない理由を把握しています。
                      </span>
                    </label>
                  ) : null}

                  <div className="control-row">
                    <button
                      className="secondary-button"
                      disabled={gitignoreBusy}
                      type="button"
                      onClick={() => void previewGitignore()}
                    >
                      再確認
                    </button>
                    <button
                      className="primary-button"
                      disabled={!gitignorePreview.canApply || gitignoreBusy}
                      type="button"
                      onClick={() => void applyGitignore()}
                    >
                      {gitignoreBusy ? "更新中..." : ".gitignore に追記"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="control-row">
                  <button
                    className="secondary-button"
                    disabled={gitignoreBusy}
                    type="button"
                    onClick={() => void previewGitignore()}
                  >
                    .gitignore を確認
                  </button>
                </div>
              )}

              {gitignoreApplyResult ? (
                <p
                  className={
                    gitignoreApplyResult.status === "applied" ||
                    gitignoreApplyResult.status === "unchanged"
                      ? "message success"
                      : gitignoreApplyResult.status === "stale"
                        ? "message warning"
                        : "message error"
                  }
                  role="status"
                >
                  {gitignoreApplyResult.message}
                </p>
              ) : null}
            </div>
          )}
        </article>

        <article className="detail-panel project-registration-panel">
          <div>
            <p className="eyebrow">ASK Project</p>
            <h2>{readyForRegistrationDetails ? "登録内容" : "登録準備"}</h2>
          </div>

          {readyForRegistrationDetails ? (
            <>
              <label>
                プロジェクト名
                <input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </label>

              <label>
                登録先クラス
                <select
                  value={selectedClassId}
                  onChange={(event) => setSelectedClassId(event.target.value)}
                >
                  {state.classes.map((classOption) => (
                    <option key={classOption.classRow.id} value={classOption.classRow.id}>
                      {classOption.classRow.name}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="primary-button"
                disabled={busy || !canRegister}
                type="button"
                onClick={() => void registerProject()}
              >
                {busy ? "登録中..." : "プロジェクトを登録"}
              </button>
            </>
          ) : (
            <div className="registration-readiness-list" aria-label="登録準備">
              {registrationReadinessItems.map((item) => (
                <div
                  className={`registration-readiness-row ${item.complete ? "complete" : "pending"}`}
                  key={item.label}
                >
                  <span className={`status-pill ${item.complete ? "success" : "warning"}`}>
                    {item.complete ? "完了" : "未完了"}
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.value}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      {message && (
        <p
          className={`message ${messageStatus}`}
          role={messageStatus === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      )}
    </section>
  );
};

export const ProjectDetailPage = (): ReactElement => {
  const { projectId } = useParams();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [reconnectResult, setReconnectResult] = useState<ProjectRootReconnectResponse | null>(null);
  const [reconnectBusy, setReconnectBusy] = useState(false);
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(null);
  const [reconnectStatus, setReconnectStatus] = useState<"success" | "warning" | "error">(
    "warning"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadProject = async (): Promise<void> => {
      if (!supabase || !projectId) {
        setLoading(false);
        setError("プロジェクトを確認できませんでした。");
        return;
      }

      const { data, error: projectError } = await supabase
        .from("projects")
        .select(
          "id,owner_user_id,class_id,name,local_path_hash,github_repo_url,default_branch,created_at"
        )
        .eq("id", projectId)
        .single();

      const threadsResult = await supabase
        .from("threads")
        .select("id,project_id,created_by,title,status,priority,ai_used,created_at,updated_at")
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false });

      if (!mounted) {
        return;
      }

      if (projectError || threadsResult.error) {
        setLoading(false);
        setError("プロジェクトを読み込めませんでした。");
        return;
      }

      setProject(data);
      setThreads(threadsResult.data ?? []);
      setLoading(false);
      setError(null);
    };

    void loadProject();

    return () => {
      mounted = false;
    };
  }, [projectId, supabase]);

  const reconnectLocalFolder = async (): Promise<void> => {
    if (!project?.local_path_hash) {
      setReconnectStatus("warning");
      setReconnectMessage("ローカル識別子が未設定のため、プロジェクトを再登録してください。");
      return;
    }

    setReconnectBusy(true);
    setReconnectResult(null);
    setReconnectMessage(null);

    try {
      const rootResult = await window.ask.project.selectRoot();

      if (!rootResult.ok) {
        setReconnectStatus("error");
        setReconnectMessage(rootResult.error.message);
        return;
      }

      if (!rootResult.data.selected || !rootResult.data.projectRootId) {
        setReconnectStatus("warning");
        setReconnectMessage("フォルダ選択をキャンセルしました。");
        return;
      }

      const result = await window.ask.project.reconnectRoot({
        projectRootId: rootResult.data.projectRootId,
        expectedLocalPathHash: project.local_path_hash,
        expectedGithubRepoUrl: project.github_repo_url
      });

      if (!result.ok) {
        setReconnectStatus("error");
        setReconnectMessage(result.error.message);
        return;
      }

      setReconnectResult(result.data);
      setReconnectStatus(result.data.persisted ? "success" : "warning");
      setReconnectMessage(result.data.message);
    } catch (error) {
      setReconnectStatus("error");
      setReconnectMessage(
        error instanceof Error ? error.message : "ローカルフォルダを再接続できませんでした。"
      );
    } finally {
      setReconnectBusy(false);
    }
  };

  if (loading) {
    return <ProjectPageState title="読み込み中" body="プロジェクト詳細を確認しています。" />;
  }

  if (error || !project) {
    return <ProjectPageState title="プロジェクトが見つかりません" body={error ?? ""} />;
  }

  return (
    <section className="workspace-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Project Detail</p>
          <h1>{project.name}</h1>
          <p className="muted">GitHubリポジトリとローカルフォルダの登録情報です。</p>
        </div>
        <div className="page-actions">
          <Link className="primary-button" to={`/projects/${project.id}/threads/new`}>
            質問を作成
          </Link>
        </div>
      </div>

      <article className="detail-panel thread-list-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Threads</p>
            <h2>質問一覧</h2>
          </div>
          <span className="status-pill pending">{threads.length} 件</span>
        </div>

        {threads.length === 0 ? (
          <div className="empty-inline-state">
            <p className="muted">質問はまだありません。</p>
          </div>
        ) : (
          <div className="student-thread-list">
            {threads.map((thread) => (
              <Link className="student-thread-row" key={thread.id} to={`/threads/${thread.id}`}>
                <div>
                  <strong>{thread.title}</strong>
                  <span>{new Date(thread.created_at).toLocaleDateString()}</span>
                </div>
                <span className="status-pill pending">{threadStatusLabels[thread.status]}</span>
                <time dateTime={thread.updated_at}>
                  {new Date(thread.updated_at).toLocaleString()}
                </time>
              </Link>
            ))}
          </div>
        )}
      </article>

      <div className="project-summary-list detail-panel">
        <span>GitHubリポジトリ</span>
        <strong>{project.github_repo_url}</strong>
        <span>既定ブランチ</span>
        <strong>{project.default_branch ?? "未設定"}</strong>
        <span>ローカル識別子</span>
        <strong>{project.local_path_hash?.slice(0, 12) ?? "未設定"}</strong>
        <span>登録日</span>
        <strong>{new Date(project.created_at).toLocaleString()}</strong>
      </div>
      <div className="control-row">
        <button
          className="primary-button"
          disabled={reconnectBusy || !project.local_path_hash}
          type="button"
          onClick={() => void reconnectLocalFolder()}
        >
          {reconnectBusy ? "再接続中..." : "ローカルフォルダを再接続"}
        </button>
      </div>
      {reconnectResult ? (
        <div className="project-summary-list detail-panel">
          <span>再接続状態</span>
          <strong>{reconnectResult.persisted ? "保存済み" : reconnectResult.status}</strong>
          <span>GitHubリポジトリ</span>
          <strong>{reconnectResult.normalizedGithubRepoUrl ?? "未検出"}</strong>
          <span>ローカル識別子</span>
          <strong>{reconnectResult.localPathHash?.slice(0, 12) ?? "未検出"}</strong>
        </div>
      ) : null}
      {reconnectMessage ? (
        <p
          className={`message ${reconnectStatus}`}
          role={reconnectStatus === "error" ? "alert" : "status"}
        >
          {reconnectMessage}
        </p>
      ) : null}
      <Link className="secondary-link" to="/projects">
        プロジェクト一覧へ
      </Link>
    </section>
  );
};

const ProjectPageState = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
