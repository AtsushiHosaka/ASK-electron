import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  ProjectGitInspectionResponse,
  ProjectRootSelectionResponse
} from "../../../../shared/ipc";
import type { Database } from "../../../../shared/database.types";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type ClassRow = Database["public"]["Tables"]["classes"]["Row"];
type ClassMemberRow = Database["public"]["Tables"]["class_members"]["Row"];
type GithubConnectionRow = Database["public"]["Tables"]["github_connections"]["Row"];
type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];

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

const initialRegistrationState: ProjectRegistrationState = {
  loading: true,
  error: null,
  classes: [],
  githubConnection: null
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

    const result = await window.ask.project.selectRoot();

    if (!result.ok) {
      setBusy(false);
      setMessageStatus("error");
      setMessage(result.error.message);
      return;
    }

    if (!result.data.selected || !result.data.projectRootId) {
      setBusy(false);
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

    setBusy(false);

    if (!inspectionResult.ok) {
      setMessageStatus("error");
      setMessage(inspectionResult.error.message);
      return;
    }

    setInspection(inspectionResult.data);
    setMessageStatus(inspectionResult.data.canRegister ? "success" : "warning");
    setMessage(inspectionResult.data.message);
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
      setMessage("登録前に GitHub remote を持つGit repositoryを選択してください。");
      return;
    }

    if (!selectedClassId) {
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

    const { data, error } = await supabase
      .from("projects")
      .insert({
        owner_user_id: profile.id,
        class_id: selectedClassId,
        name: trimmedProjectName,
        local_path_hash: inspection.localPathHash,
        github_repo_url: inspection.normalizedGithubRepoUrl,
        default_branch: inspection.defaultBranch
      })
      .select("id")
      .single();

    setBusy(false);

    if (error) {
      setMessageStatus("error");
      setMessage(
        "プロジェクトを登録できませんでした。GitHub連携とクラス参加状態を確認してください。"
      );
      return;
    }

    navigate(`/projects/${data.id}`);
  };

  const canRegister =
    Boolean(state.githubConnection) &&
    Boolean(selectedClassId) &&
    Boolean(projectName.trim()) &&
    Boolean(inspection?.canRegister);

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
          <p className="muted">GitHub remote を持つローカルGit repositoryをASKに登録します。</p>
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
              <span>remote origin</span>
              <strong>{inspection.remoteOriginUrl ?? "未設定"}</strong>
              <span>GitHub repository</span>
              <strong>{inspection.normalizedGithubRepoUrl ?? "未検出"}</strong>
              <span>default branch</span>
              <strong>{inspection.defaultBranch ?? "未検出"}</strong>
              <span>local_path_hash</span>
              <strong>{inspection.localPathHash?.slice(0, 12) ?? "未生成"}</strong>
            </div>
          )}
        </article>

        <article className="detail-panel project-registration-panel">
          <div>
            <p className="eyebrow">ASK Project</p>
            <h2>登録内容</h2>
          </div>

          <label>
            プロジェクト名
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} />
          </label>

          <label>
            登録先クラス
            <select
              value={selectedClassId}
              onChange={(event) => setSelectedClassId(event.target.value)}
            >
              {state.classes.length === 0 ? (
                <option value="">参加中のクラスがありません</option>
              ) : (
                state.classes.map((classOption) => (
                  <option key={classOption.classRow.id} value={classOption.classRow.id}>
                    {classOption.classRow.name}
                  </option>
                ))
              )}
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
        </article>
      </div>

      {message && (
        <p className={`message ${messageStatus}`} role="status">
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

      if (!mounted) {
        return;
      }

      if (projectError) {
        setLoading(false);
        setError("プロジェクトを読み込めませんでした。");
        return;
      }

      setProject(data);
      setLoading(false);
      setError(null);
    };

    void loadProject();

    return () => {
      mounted = false;
    };
  }, [projectId, supabase]);

  if (loading) {
    return <ProjectPageState title="読み込み中" body="プロジェクト詳細を確認しています。" />;
  }

  if (error || !project) {
    return <ProjectPageState title="プロジェクトが見つかりません" body={error ?? ""} />;
  }

  return (
    <section className="workspace-page">
      <p className="eyebrow">Project Detail</p>
      <h1>{project.name}</h1>
      <p className="muted">GitHub repository とローカルフォルダの登録情報です。</p>
      <div className="project-summary-list detail-panel">
        <span>GitHub repository</span>
        <strong>{project.github_repo_url}</strong>
        <span>default branch</span>
        <strong>{project.default_branch ?? "未設定"}</strong>
        <span>local_path_hash</span>
        <strong>{project.local_path_hash?.slice(0, 12) ?? "未設定"}</strong>
        <span>created</span>
        <strong>{new Date(project.created_at).toLocaleString()}</strong>
      </div>
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
