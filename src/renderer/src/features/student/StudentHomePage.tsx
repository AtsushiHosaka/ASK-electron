import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type { Database, ThreadStatus } from "../../../../shared/database.types";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type ClassMemberRow = Database["public"]["Tables"]["class_members"]["Row"];
type GithubConnectionRow = Database["public"]["Tables"]["github_connections"]["Row"];
type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];

interface StudentHomeState {
  loading: boolean;
  error: string | null;
  githubConnection: GithubConnectionRow | null;
  memberships: ClassMemberRow[];
  projects: ProjectRow[];
  threads: ThreadRow[];
}

interface SetupItem {
  label: string;
  complete: boolean;
  value: string;
  actionLabel: string | null;
  actionTo: string | null;
}

type ActionableSetupItem = SetupItem & {
  actionLabel: string;
  actionTo: string;
};

const firstRunOnboardingStoragePrefix = "ask.firstRunOnboarding.v1";

const initialState: StudentHomeState = {
  loading: true,
  error: null,
  githubConnection: null,
  memberships: [],
  projects: [],
  threads: []
};

const threadStatusLabels: Record<ThreadStatus, string> = {
  open: "未対応",
  in_progress: "対応中",
  waiting_student: "確認待ち",
  patch_proposed: "パッチ提案",
  resolved: "解決済み",
  reopened: "再オープン"
};

const shortRepoName = (githubRepoUrl: string): string => {
  try {
    const url = new URL(githubRepoUrl);
    return url.pathname.replace(/^\/+/, "") || githubRepoUrl;
  } catch {
    return githubRepoUrl.replace(/^https:\/\/github\.com\//, "");
  }
};

const formatDateTime = (value: string): string => new Date(value).toLocaleString();

const firstRunOnboardingStorageKey = (profileId: string): string =>
  `${firstRunOnboardingStoragePrefix}.${profileId}`;

const readFirstRunOnboardingDismissed = (profileId: string | null | undefined): boolean => {
  if (!profileId) {
    return false;
  }

  try {
    const rawValue = window.localStorage.getItem(firstRunOnboardingStorageKey(profileId));

    if (!rawValue) {
      return false;
    }

    const value = JSON.parse(rawValue) as { dismissed?: unknown; completed?: unknown };
    return value.dismissed === true || value.completed === true;
  } catch {
    return false;
  }
};

const writeFirstRunOnboardingState = (
  profileId: string,
  state: { dismissed?: boolean; completed?: boolean }
): void => {
  window.localStorage.setItem(
    firstRunOnboardingStorageKey(profileId),
    JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString()
    })
  );
};

export const StudentHomePage = (): ReactElement => {
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<StudentHomeState>(initialState);
  const [firstRunOnboardingDismissed, setFirstRunOnboardingDismissed] = useState(() =>
    readFirstRunOnboardingDismissed(profile?.id)
  );

  useEffect(() => {
    let mounted = true;

    const load = async (): Promise<void> => {
      if (!supabase || !profile) {
        setState({
          ...initialState,
          loading: false,
          error: "Supabase 設定またはプロフィールを確認できませんでした。"
        });
        return;
      }

      setState((current) => ({ ...current, loading: true, error: null }));

      try {
        const [connectionResult, membershipsResult, projectsResult] = await Promise.all([
          supabase
            .from("github_connections")
            .select("id,user_id,github_username,auth_method,ssh_status,last_checked_at")
            .eq("user_id", profile.id)
            .maybeSingle(),
          supabase
            .from("class_members")
            .select("id,class_id,user_id,role,joined_at")
            .eq("user_id", profile.id),
          supabase
            .from("projects")
            .select(
              "id,owner_user_id,class_id,name,local_path_hash,github_repo_url,default_branch,created_at"
            )
            .eq("owner_user_id", profile.id)
            .order("created_at", { ascending: false })
        ]);

        if (connectionResult.error || membershipsResult.error || projectsResult.error) {
          throw connectionResult.error ?? membershipsResult.error ?? projectsResult.error;
        }

        const projects = projectsResult.data ?? [];
        const projectIds = projects.map((project) => project.id);
        const threadsResult =
          projectIds.length > 0
            ? await supabase
                .from("threads")
                .select(
                  "id,project_id,created_by,title,status,priority,ai_used,created_at,updated_at"
                )
                .eq("created_by", profile.id)
                .in("project_id", projectIds)
                .order("updated_at", { ascending: false })
                .limit(8)
            : { data: [], error: null };

        if (threadsResult.error) {
          throw threadsResult.error;
        }

        if (mounted) {
          setState({
            loading: false,
            error: null,
            githubConnection: connectionResult.data ?? null,
            memberships: membershipsResult.data ?? [],
            projects,
            threads: threadsResult.data ?? []
          });
        }
      } catch (error) {
        console.error("Failed to load student home", error);

        if (mounted) {
          setState({
            ...initialState,
            loading: false,
            error: "ホームに必要なデータを読み込めませんでした。"
          });
        }
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [profile, supabase]);

  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const setupItems: SetupItem[] = [
    {
      label: "GitHub / SSH",
      complete: Boolean(state.githubConnection),
      value: state.githubConnection
        ? `${state.githubConnection.github_username} / SSH ${state.githubConnection.ssh_status}`
        : "未連携",
      actionLabel: state.githubConnection ? null : "初期設定へ",
      actionTo: state.githubConnection ? null : "/onboarding"
    },
    {
      label: "クラス参加",
      complete: state.memberships.length > 0,
      value: state.memberships.length > 0 ? `${state.memberships.length} クラスに参加中` : "未参加",
      actionLabel: null,
      actionTo: null
    },
    {
      label: "プロジェクト登録",
      complete: state.projects.length > 0,
      value: state.projects.length > 0 ? `${state.projects.length} 件登録済み` : "未登録",
      actionLabel: state.projects.length > 0 ? null : "プロジェクト登録へ",
      actionTo: state.projects.length > 0 ? null : "/projects"
    }
  ];
  const completedSetupCount = setupItems.filter((item) => item.complete).length;
  const setupComplete = completedSetupCount === setupItems.length;
  const nextSetupAction = setupItems.find(
    (item): item is ActionableSetupItem =>
      !item.complete && Boolean(item.actionLabel) && Boolean(item.actionTo)
  );
  const canCreateQuestion = state.projects.length > 0;
  const homePrimaryAction = nextSetupAction
    ? { label: nextSetupAction.actionLabel, to: nextSetupAction.actionTo }
    : { label: "質問を作成", to: "/threads/new" };

  useEffect(() => {
    if (!profile?.id || !setupComplete) {
      return;
    }

    writeFirstRunOnboardingState(profile.id, { completed: true });
  }, [profile?.id, setupComplete]);

  const dismissFirstRunOnboarding = (): void => {
    if (profile?.id) {
      writeFirstRunOnboardingState(profile.id, { dismissed: true });
    }

    setFirstRunOnboardingDismissed(true);
  };

  if (state.loading) {
    return <StudentHomeStatePage title="読み込み中" body="ホームのデータを確認しています。" />;
  }

  if (state.error) {
    return <StudentHomeStatePage title="読み込みに失敗しました" body={state.error} />;
  }

  if (profile?.role === "student" && !setupComplete && !firstRunOnboardingDismissed) {
    return (
      <FirstRunOnboardingPage
        completedSetupCount={completedSetupCount}
        setupItems={setupItems}
        onDismiss={dismissFirstRunOnboarding}
      />
    );
  }

  return (
    <section className="student-dashboard">
      <div className="page-header">
        <div>
          <p className="eyebrow">Student</p>
          <h1>ホーム</h1>
        </div>
        <div className="page-actions home-actions">
          <Link className="primary-button home-primary-action" to={homePrimaryAction.to}>
            {homePrimaryAction.label}
          </Link>
          {nextSetupAction && canCreateQuestion ? (
            <Link className="secondary-button" to="/threads/new">
              質問を作成
            </Link>
          ) : null}
        </div>
        <div className="progress-summary learning-summary">
          <strong>{state.threads.length} 件の質問</strong>
          <span>
            初期設定 {completedSetupCount} / {setupItems.length}
          </span>
        </div>
      </div>

      <div className="student-home-grid">
        <article className="detail-panel setup-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Setup</p>
              <h2>初期設定</h2>
            </div>
            <span
              className={`status-pill ${completedSetupCount === setupItems.length ? "success" : "warning"}`}
            >
              {completedSetupCount}/{setupItems.length}
            </span>
          </div>

          <div className="setup-check-list">
            {setupItems.map((item) => (
              <div
                className={`setup-check-row ${item.complete ? "complete" : "needs-action"}`}
                key={item.label}
              >
                <span className={`status-pill ${item.complete ? "success" : "warning"}`}>
                  {item.complete ? "完了" : "未完了"}
                </span>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.value}</span>
                </div>
                {item.actionTo && item.actionLabel ? (
                  <Link className="setup-action-link" to={item.actionTo}>
                    {item.actionLabel}
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </article>

        <article className="detail-panel project-list-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Projects</p>
              <h2>登録済みプロジェクト</h2>
            </div>
            <Link className="secondary-link" to="/projects">
              すべて見る
            </Link>
          </div>

          {state.projects.length === 0 ? (
            <div className="empty-inline-state">
              <p className="muted">プロジェクトはまだありません。</p>
            </div>
          ) : (
            <div className="student-project-list">
              {state.projects.slice(0, 4).map((project) => (
                <Link
                  className="student-project-row"
                  key={project.id}
                  to={`/projects/${project.id}`}
                >
                  <div>
                    <strong>{project.name}</strong>
                    <span>{shortRepoName(project.github_repo_url)}</span>
                  </div>
                  <span
                    className={`status-pill ${project.local_path_hash ? "success" : "warning"}`}
                  >
                    {project.local_path_hash ? "ローカル接続済み" : "再接続"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </article>

        <article className="detail-panel student-thread-panel" id="threads">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Threads</p>
              <h2>最近の質問</h2>
            </div>
          </div>

          {state.threads.length === 0 ? (
            <div className="empty-inline-state">
              <p className="muted">質問はまだありません。</p>
            </div>
          ) : (
            <div className="student-thread-list">
              {state.threads.map((thread) => {
                const project = projectsById.get(thread.project_id);

                return (
                  <Link className="student-thread-row" key={thread.id} to={`/threads/${thread.id}`}>
                    <div>
                      <strong>{thread.title}</strong>
                      <span>{project?.name ?? "プロジェクト不明"}</span>
                    </div>
                    <span className="status-pill pending">{threadStatusLabels[thread.status]}</span>
                    <time dateTime={thread.updated_at}>{formatDateTime(thread.updated_at)}</time>
                  </Link>
                );
              })}
            </div>
          )}
        </article>
      </div>
    </section>
  );
};

const FirstRunOnboardingPage = ({
  setupItems,
  completedSetupCount,
  onDismiss
}: {
  setupItems: SetupItem[];
  completedSetupCount: number;
  onDismiss: () => void;
}): ReactElement => {
  const nextAction = setupItems.find((item) => !item.complete && item.actionTo);

  return (
    <section className="first-run-onboarding" aria-labelledby="first-run-onboarding-title">
      <div className="first-run-panel">
        <header className="first-run-header">
          <div>
            <p className="eyebrow">Start</p>
            <h1 id="first-run-onboarding-title">はじめる準備</h1>
          </div>
          <span className="status-pill pending">
            {completedSetupCount}/{setupItems.length}
          </span>
        </header>

        <ol className="first-run-step-list" aria-label="初回準備">
          {setupItems.map((item) => (
            <li className="first-run-step" key={item.label}>
              <span className={`status-pill ${item.complete ? "success" : "warning"}`}>
                {item.complete ? "完了" : "未完了"}
              </span>
              <div>
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </div>
            </li>
          ))}
        </ol>

        <footer className="first-run-actions">
          {nextAction?.actionTo && nextAction.actionLabel ? (
            <Link className="primary-button" to={nextAction.actionTo} onClick={onDismiss}>
              {nextAction.actionLabel}
            </Link>
          ) : (
            <button className="primary-button" type="button" onClick={onDismiss}>
              ホームへ
            </button>
          )}
          <button className="secondary-button" type="button" onClick={onDismiss}>
            閉じる
          </button>
        </footer>
      </div>
    </section>
  );
};

const StudentHomeStatePage = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
