import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ClassMemberRole,
  Database,
  GithubSshStatus,
  ThreadStatus
} from "../../../../shared/database.types";
import { useAuth } from "../auth/AuthProvider";
import { getPublicAppBaseUrl } from "../../lib/env";
import { getSupabaseClient } from "../../lib/supabase";

type ClassRow = Database["public"]["Tables"]["classes"]["Row"];
type ClassMemberRow = Database["public"]["Tables"]["class_members"]["Row"];
type GithubConnectionRow = Database["public"]["Tables"]["github_connections"]["Row"];
type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];
type ThreadRow = Database["public"]["Tables"]["threads"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];

interface MemberSummary {
  membership: ClassMemberRow;
  user: Pick<UserRow, "id" | "display_name" | "email" | "github_username" | "role"> | null;
  githubConnection: Pick<
    GithubConnectionRow,
    "user_id" | "github_username" | "ssh_status" | "last_checked_at"
  > | null;
}

interface ManagedClassSummary {
  classRow: ClassRow;
  myRole: ClassMemberRole;
  members: MemberSummary[];
  projects: ProjectRow[];
  threads: ThreadRow[];
  statusCounts: Record<ThreadStatus, number>;
}

interface TeacherDashboardState {
  loading: boolean;
  error: string | null;
  classes: ManagedClassSummary[];
}

const threadStatuses: ThreadStatus[] = [
  "open",
  "in_progress",
  "waiting_student",
  "patch_proposed",
  "resolved",
  "reopened"
];

const statusLabels: Record<ThreadStatus, string> = {
  open: "未対応",
  in_progress: "対応中",
  waiting_student: "生徒確認待ち",
  patch_proposed: "パッチ提案中",
  resolved: "解決済み",
  reopened: "再オープン"
};

const sshStatusLabels: Record<GithubSshStatus, string> = {
  unknown: "未確認",
  ok: "SSH OK",
  failed: "SSH要確認"
};

const inviteExpirySeconds = 60 * 60 * 24 * 14;

const initialStatusCounts = (): Record<ThreadStatus, number> =>
  Object.fromEntries(threadStatuses.map((status) => [status, 0])) as Record<ThreadStatus, number>;

const unique = (values: string[]): string[] => [...new Set(values)];

const buildJoinUrl = (token: string): string => {
  return `${getPublicAppBaseUrl()}#/join/${encodeURIComponent(token)}`;
};

const useTeacherDashboard = (): TeacherDashboardState => {
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<TeacherDashboardState>({
    loading: true,
    error: null,
    classes: []
  });

  useEffect(() => {
    let mounted = true;

    const load = async (): Promise<void> => {
      if (!supabase || !profile) {
        setState({
          loading: false,
          error: "Supabase 設定またはプロフィールを確認できませんでした。",
          classes: []
        });
        return;
      }

      setState((current) => ({ ...current, loading: true, error: null }));

      try {
        const { data: ownMemberships, error: membershipError } = await supabase
          .from("class_members")
          .select("id,class_id,user_id,role,joined_at")
          .eq("user_id", profile.id)
          .in("role", ["teacher", "mentor"]);

        if (membershipError) {
          throw membershipError;
        }

        const classIds = unique((ownMemberships ?? []).map((membership) => membership.class_id));

        if (classIds.length === 0) {
          if (mounted) {
            setState({ loading: false, error: null, classes: [] });
          }
          return;
        }

        const [classesResult, membersResult, projectsResult] = await Promise.all([
          supabase
            .from("classes")
            .select("id,organization_id,name,description,created_by,created_at")
            .in("id", classIds)
            .order("created_at", { ascending: false }),
          supabase
            .from("class_members")
            .select("id,class_id,user_id,role,joined_at")
            .in("class_id", classIds),
          supabase
            .from("projects")
            .select(
              "id,owner_user_id,class_id,name,local_path_hash,github_repo_url,default_branch,created_at"
            )
            .in("class_id", classIds)
        ]);

        if (classesResult.error || membersResult.error || projectsResult.error) {
          throw classesResult.error ?? membersResult.error ?? projectsResult.error;
        }

        const members = membersResult.data ?? [];
        const projects = projectsResult.data ?? [];
        const userIds = unique(members.map((member) => member.user_id));
        const projectIds = projects.map((project) => project.id);

        const [usersResult, githubConnectionsResult, threadsResult] = await Promise.all([
          userIds.length > 0
            ? supabase
                .from("users")
                .select("id,email,display_name,role,github_username,created_at,updated_at")
                .in("id", userIds)
            : Promise.resolve({ data: [], error: null }),
          userIds.length > 0
            ? supabase
                .from("github_connections")
                .select("user_id,github_username,ssh_status,last_checked_at")
                .in("user_id", userIds)
            : Promise.resolve({ data: [], error: null }),
          projectIds.length > 0
            ? supabase
                .from("threads")
                .select(
                  "id,project_id,created_by,title,status,priority,ai_used,created_at,updated_at"
                )
                .in("project_id", projectIds)
                .order("updated_at", { ascending: false })
            : Promise.resolve({ data: [], error: null })
        ]);

        if (usersResult.error || githubConnectionsResult.error || threadsResult.error) {
          throw usersResult.error ?? githubConnectionsResult.error ?? threadsResult.error;
        }

        const usersById = new Map((usersResult.data ?? []).map((user) => [user.id, user]));
        const connectionsByUserId = new Map(
          (githubConnectionsResult.data ?? []).map((connection) => [connection.user_id, connection])
        );
        const projectsByClassId = new Map<string, ProjectRow[]>();
        const threadsByProjectId = new Map<string, ThreadRow[]>();

        for (const project of projects) {
          const classProjects = projectsByClassId.get(project.class_id) ?? [];
          classProjects.push(project);
          projectsByClassId.set(project.class_id, classProjects);
        }

        for (const thread of threadsResult.data ?? []) {
          const projectThreads = threadsByProjectId.get(thread.project_id) ?? [];
          projectThreads.push(thread);
          threadsByProjectId.set(thread.project_id, projectThreads);
        }

        const managedClasses = (classesResult.data ?? []).map((classRow) => {
          const classMembers = members.filter((member) => member.class_id === classRow.id);
          const classProjects = projectsByClassId.get(classRow.id) ?? [];
          const classThreads = classProjects.flatMap(
            (project) => threadsByProjectId.get(project.id) ?? []
          );
          const statusCounts = initialStatusCounts();

          for (const thread of classThreads) {
            statusCounts[thread.status] += 1;
          }

          return {
            classRow,
            myRole:
              ownMemberships?.find((membership) => membership.class_id === classRow.id)?.role ??
              "teacher",
            members: classMembers.map((membership) => ({
              membership,
              user: usersById.get(membership.user_id) ?? null,
              githubConnection: connectionsByUserId.get(membership.user_id) ?? null
            })),
            projects: classProjects,
            threads: classThreads,
            statusCounts
          } satisfies ManagedClassSummary;
        });

        if (mounted) {
          setState({ loading: false, error: null, classes: managedClasses });
        }
      } catch (error) {
        console.error("Failed to load teacher dashboard", error);

        if (mounted) {
          setState({
            loading: false,
            error: "担当クラスを読み込めませんでした。",
            classes: []
          });
        }
      }
    };

    void load();

    return () => {
      mounted = false;
    };
  }, [profile, supabase]);

  return state;
};

export const TeacherHomePage = (): ReactElement => {
  const { loading, error, classes } = useTeacherDashboard();

  if (loading) {
    return <TeacherPageState title="読み込み中" body="担当クラスを確認しています。" />;
  }

  if (error) {
    return <TeacherPageState title="読み込みに失敗しました" body={error} />;
  }

  if (classes.length === 0) {
    return (
      <TeacherPageState
        title="担当クラスがありません"
        body="先生またはメンターとして参加しているクラスが見つかりません。"
      />
    );
  }

  return (
    <section className="teacher-dashboard">
      <div className="page-header">
        <div>
          <p className="eyebrow">Teacher</p>
          <h1>担当クラス</h1>
          <p className="muted">担当クラスの質問状況、生徒の初期設定、招待導線を確認します。</p>
        </div>
        <div className="progress-summary">
          <strong>{classes.length} クラス</strong>
          <span>自分が担当するクラスのみ表示</span>
        </div>
      </div>

      <div className="teacher-class-grid">
        {classes.map((classSummary) => (
          <article className="teacher-class-card" key={classSummary.classRow.id}>
            <div>
              <p className="eyebrow">{classSummary.myRole}</p>
              <h2>{classSummary.classRow.name}</h2>
              <p>{classSummary.classRow.description ?? "説明は未設定です。"}</p>
            </div>

            <StatusCounters statusCounts={classSummary.statusCounts} />

            <div className="teacher-card-footer">
              <span>{studentMembers(classSummary).length} students</span>
              <Link className="secondary-link" to={`/classes/${classSummary.classRow.id}`}>
                詳細を見る
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

export const ClassDetailPage = (): ReactElement => {
  const { classId } = useParams();
  const { loading, error, classes } = useTeacherDashboard();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [inviteState, setInviteState] = useState<{ classId: string; link: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [copyingInvite, setCopyingInvite] = useState(false);

  useEffect(() => {
    if (!copyMessage) {
      return;
    }

    const timerId = window.setTimeout(() => setCopyMessage(null), 2000);

    return () => window.clearTimeout(timerId);
  }, [copyMessage]);

  if (loading) {
    return <TeacherPageState title="読み込み中" body="クラス詳細を確認しています。" />;
  }

  if (error) {
    return <TeacherPageState title="読み込みに失敗しました" body={error} />;
  }

  const classSummary = classes.find((summary) => summary.classRow.id === classId) ?? null;

  if (!classSummary) {
    return (
      <TeacherPageState
        title="クラスが見つかりません"
        body="担当外のクラス、または存在しないクラスは表示できません。"
      />
    );
  }

  const inviteLink = inviteState?.classId === classSummary.classRow.id ? inviteState.link : "";

  const copyInviteLink = async (): Promise<void> => {
    if (!supabase) {
      setCopyMessage("Supabase 設定を確認できないため、招待リンクを作成できません。");
      return;
    }

    setCopyingInvite(true);
    setCopyMessage(null);

    try {
      const { data, error: inviteError } = await supabase.rpc("create_class_invite", {
        p_class_id: classSummary.classRow.id,
        p_role: "student",
        p_expires_in_seconds: inviteExpirySeconds
      });

      if (inviteError) {
        throw inviteError;
      }

      const invite = data?.[0];

      if (!invite?.token) {
        throw new Error("CLASS_INVITE_TOKEN_MISSING");
      }

      const nextInviteLink = buildJoinUrl(invite.token);
      setInviteState({ classId: classSummary.classRow.id, link: nextInviteLink });
      await navigator.clipboard.writeText(nextInviteLink);
      setCopyMessage("招待リンクをコピーしました。");
    } catch {
      setCopyMessage("招待リンクを作成またはコピーできませんでした。");
    } finally {
      setCopyingInvite(false);
    }
  };

  return (
    <section className="teacher-dashboard">
      <div className="page-header">
        <div>
          <p className="eyebrow">Class Detail</p>
          <h1>{classSummary.classRow.name}</h1>
          <p className="muted">{classSummary.classRow.description ?? "説明は未設定です。"}</p>
        </div>
        <StatusCounters statusCounts={classSummary.statusCounts} compact />
      </div>

      <div className="detail-grid">
        <article className="detail-panel invite-panel">
          <div>
            <p className="eyebrow">Invite</p>
            <h2>招待リンク</h2>
          </div>
          <input
            readOnly
            aria-label="招待リンク"
            placeholder="コピーすると招待リンクを生成します"
            value={inviteLink}
          />
          <button
            className="primary-button"
            disabled={copyingInvite}
            type="button"
            onClick={() => void copyInviteLink()}
          >
            {copyingInvite ? "作成中..." : "コピー"}
          </button>
          <p className="muted invite-status" aria-live="polite" role="status">
            {copyMessage ?? ""}
          </p>
        </article>

        <MemberPanel title="生徒" members={studentMembers(classSummary)} />
        <MemberPanel title="メンター / 先生" members={mentorMembers(classSummary)} />

        <article className="detail-panel thread-list-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Threads</p>
              <h2>質問一覧</h2>
            </div>
            <span className="status-pill pending">{classSummary.threads.length} 件</span>
          </div>

          {classSummary.threads.length === 0 ? (
            <p className="muted">このクラスの質問はまだありません。</p>
          ) : (
            <div className="teacher-thread-list">
              {classSummary.threads.map((thread) => (
                <Link className="teacher-thread-row" key={thread.id} to={`/threads/${thread.id}`}>
                  <span>{thread.title}</span>
                  <span>{statusLabels[thread.status]}</span>
                  <span>{new Date(thread.updated_at).toLocaleDateString()}</span>
                </Link>
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
};

export const ClassJoinPage = (): ReactElement => {
  const { token } = useParams();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [joinState, setJoinState] = useState<{
    loading: boolean;
    message: string;
    error: string | null;
  }>({
    loading: true,
    message: "招待を確認しています。",
    error: null
  });

  useEffect(() => {
    let mounted = true;

    const redeemInvite = async (): Promise<void> => {
      if (!token) {
        setJoinState({
          loading: false,
          message: "",
          error: "招待トークンが見つかりません。"
        });
        return;
      }

      if (!supabase) {
        setJoinState({
          loading: false,
          message: "",
          error: "Supabase 設定を確認できませんでした。"
        });
        return;
      }

      try {
        const { data, error: redeemError } = await supabase.rpc("redeem_class_invite", {
          p_token: token
        });

        if (redeemError) {
          throw redeemError;
        }

        const result = data?.[0];

        if (!result) {
          throw new Error("CLASS_INVITE_REDEEM_RESULT_MISSING");
        }

        if (mounted) {
          setJoinState({
            loading: false,
            message:
              result.status === "already_member"
                ? "すでにこのクラスに参加しています。"
                : "クラスに参加しました。",
            error: null
          });
        }
      } catch (error) {
        console.error("Failed to redeem class invite", error);

        if (mounted) {
          setJoinState({
            loading: false,
            message: "",
            error: "招待を受け付けできませんでした。期限切れまたは権限不足の可能性があります。"
          });
        }
      }
    };

    void redeemInvite();

    return () => {
      mounted = false;
    };
  }, [supabase, token]);

  if (joinState.loading) {
    return <TeacherPageState title="招待を確認中" body={joinState.message} />;
  }

  if (joinState.error) {
    return <TeacherPageState title="クラスに参加できません" body={joinState.error} />;
  }

  return (
    <section className="empty-state">
      <h1>クラス参加が完了しました</h1>
      <p>{joinState.message}</p>
      <Link className="secondary-link" to="/student">
        ホームへ戻る
      </Link>
    </section>
  );
};

const studentMembers = (classSummary: ManagedClassSummary): MemberSummary[] =>
  classSummary.members.filter((member) => member.membership.role === "student");

const mentorMembers = (classSummary: ManagedClassSummary): MemberSummary[] =>
  classSummary.members.filter((member) => member.membership.role !== "student");

const StatusCounters = ({
  statusCounts,
  compact = false
}: {
  statusCounts: Record<ThreadStatus, number>;
  compact?: boolean;
}): ReactElement => (
  <div className={compact ? "status-counter-grid compact" : "status-counter-grid"}>
    {(["open", "in_progress", "waiting_student"] as ThreadStatus[]).map((status) => (
      <div className="status-counter" key={status}>
        <span>{statusLabels[status]}</span>
        <strong>{statusCounts[status]}</strong>
      </div>
    ))}
  </div>
);

const MemberPanel = ({
  title,
  members
}: {
  title: string;
  members: MemberSummary[];
}): ReactElement => (
  <article className="detail-panel member-panel">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Members</p>
        <h2>{title}</h2>
      </div>
      <span className="status-pill pending">{members.length} 人</span>
    </div>

    {members.length === 0 ? (
      <p className="muted">まだメンバーがいません。</p>
    ) : (
      <div className="member-list">
        {members.map((member) => (
          <div className="member-row" key={member.membership.id}>
            <div>
              <strong>{member.user?.display_name ?? "Unknown user"}</strong>
              <span>{member.user?.email ?? "メール未取得"}</span>
            </div>
            <div className="member-setup">
              <span>
                {member.githubConnection?.github_username ??
                  member.user?.github_username ??
                  "GitHub未設定"}
              </span>
              <span>{sshStatusLabels[member.githubConnection?.ssh_status ?? "unknown"]}</span>
            </div>
          </div>
        ))}
      </div>
    )}
  </article>
);

const TeacherPageState = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
