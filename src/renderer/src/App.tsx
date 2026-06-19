import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { LoginPage } from "./features/auth/LoginPage";
import { useAuth } from "./features/auth/AuthProvider";
import { StudentOnboardingPage } from "./features/onboarding/StudentOnboardingPage";
import { ProjectDetailPage, ProjectsPage } from "./features/projects/ProjectRegistrationPage";
import { StudentHomePage } from "./features/student/StudentHomePage";
import {
  ClassDetailPage,
  ClassJoinPage,
  TeacherHomePage
} from "./features/teacher/TeacherDashboard";
import { ThreadCreatePage } from "./features/threads/ThreadCreatePage";
import { ThreadDetailPage } from "./features/threads/ThreadDetailPage";
import type { AppRole } from "@shared/domain";
import { getSupabaseClient } from "./lib/supabase";
import { trackUsageEvent } from "./lib/telemetry";

const roleHome: Record<AppRole, string> = {
  student: "/student",
  teacher: "/teacher",
  admin: "/teacher"
};

const roleLabels: Record<AppRole, string> = {
  student: "生徒",
  teacher: "講師",
  admin: "管理"
};

type StudentSetupStatus = "unknown" | "complete" | "incomplete";

interface StudentSetupState {
  profileId: string | null;
  status: StudentSetupStatus;
}

export const App = (): ReactElement => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      />
    </Routes>
  );
};

const RequireAuth = ({ children }: { children: ReactElement }): ReactElement => {
  const { loading, session } = useAuth();
  const location = useLocation();

  if (loading) {
    return <FullPageState title="読み込み中" body="セッションを確認しています。" />;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
};

const AppShell = (): ReactElement => {
  const { profile, signOut } = useAuth();
  const location = useLocation();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const appOpenedTracked = useRef(false);
  const lastTrackedScreen = useRef<string | null>(null);
  const [studentSetupState, setStudentSetupState] = useState<StudentSetupState>({
    profileId: null,
    status: "unknown"
  });

  useEffect(() => {
    if (!profile) {
      return;
    }

    if (!appOpenedTracked.current) {
      appOpenedTracked.current = true;
      void trackUsageEvent({
        eventName: "app_opened",
        screen: location.pathname,
        properties: {
          role: profile.role
        }
      });
    }

    if (lastTrackedScreen.current === location.pathname) {
      return;
    }

    lastTrackedScreen.current = location.pathname;
    void trackUsageEvent({
      eventName: "screen_viewed",
      screen: location.pathname,
      properties: {
        role: profile.role
      }
    });
  }, [location.pathname, profile]);

  useEffect(() => {
    if (profile?.role !== "student" || !supabase) {
      return;
    }

    let mounted = true;

    const loadStudentSetupStatus = async (): Promise<void> => {
      try {
        const [connectionResult, membershipsResult, projectsResult] = await Promise.all([
          supabase.from("github_connections").select("id").eq("user_id", profile.id).maybeSingle(),
          supabase.from("class_members").select("id").eq("user_id", profile.id).limit(1),
          supabase.from("projects").select("id").eq("owner_user_id", profile.id).limit(1)
        ]);

        if (connectionResult.error || membershipsResult.error || projectsResult.error) {
          throw connectionResult.error ?? membershipsResult.error ?? projectsResult.error;
        }

        if (!mounted) {
          return;
        }

        const setupComplete = Boolean(
          connectionResult.data && membershipsResult.data?.length && projectsResult.data?.length
        );
        setStudentSetupState({
          profileId: profile.id,
          status: setupComplete ? "complete" : "incomplete"
        });
      } catch (error) {
        console.error("Failed to load student setup status", error);

        if (mounted) {
          setStudentSetupState({
            profileId: profile.id,
            status: "unknown"
          });
        }
      }
    };

    void loadStudentSetupStatus();

    return () => {
      mounted = false;
    };
  }, [location.pathname, profile?.id, profile?.role, supabase]);

  if (!profile) {
    return (
      <FullPageState
        title="プロフィールを確認できません"
        body="クラス参加またはユーザー設定が完了していない可能性があります。"
      />
    );
  }

  const studentSetupStatus =
    studentSetupState.profileId === profile.id ? studentSetupState.status : "unknown";
  const showOnboardingShortcut = profile.role === "student" && studentSetupStatus === "incomplete";

  return (
    <div className={`app-shell role-${profile.role}`}>
      <aside className="sidebar" aria-label="メインナビゲーション">
        <div className="brand">
          <span className="brand-mark">ASK</span>
        </div>

        <div className="sidebar-nav-stack">
          <nav className="nav-list">
            <NavLink to={profile.role === "student" ? "/student" : "/teacher"}>ホーム</NavLink>
            <NavLink to="/classes">クラス</NavLink>
            {profile.role === "student" ? <NavLink to="/projects">プロジェクト</NavLink> : null}
          </nav>

          {showOnboardingShortcut ? (
            <div className="sidebar-setup-shortcut">
              <NavLink
                className={({ isActive }) => `sidebar-setup-link${isActive ? " active" : ""}`}
                to="/onboarding"
              >
                初期設定
              </NavLink>
            </div>
          ) : null}
        </div>

        <div className="sidebar-footer">
          <span className="role-badge">{roleLabels[profile.role]}</span>
          <div>
            <strong>{profile.display_name}</strong>
          </div>
          <button className="secondary-button" type="button" onClick={() => void signOut()}>
            ログアウト
          </button>
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to={roleHome[profile.role]} replace />} />
          <Route path="/student" element={<StudentHomePage />} />
          <Route path="/teacher" element={<TeacherHomePage />} />
          <Route path="/onboarding" element={<StudentOnboardingPage />} />
          <Route path="/classes" element={<TeacherHomePage />} />
          <Route path="/classes/:classId" element={<ClassDetailPage />} />
          <Route path="/join/:token" element={<ClassJoinPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId/threads/new" element={<ThreadCreatePage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route
            path="/threads"
            element={
              profile.role === "student" ? (
                <Navigate to="/projects" replace />
              ) : (
                <Navigate to="/classes" replace />
              )
            }
          />
          <Route
            path="/threads/new"
            element={
              profile.role === "student" ? (
                <Navigate to="/projects" replace />
              ) : (
                <Navigate to="/classes" replace />
              )
            }
          />
          <Route path="/projects/:projectId/threads/:threadId" element={<ThreadDetailPage />} />
          <Route path="/threads/:threadId" element={<ThreadDetailPage />} />
          <Route
            path="*"
            element={
              <EmptyState
                title="画面が見つかりません"
                body="左のメニューから選び直してください。"
              />
            }
          />
        </Routes>
      </main>
    </div>
  );
};

const EmptyState = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);

const FullPageState = ({ title, body }: { title: string; body: string }): ReactElement => (
  <main className="full-page-state">
    <div>
      <h1>{title}</h1>
      <p>{body}</p>
    </div>
  </main>
);
