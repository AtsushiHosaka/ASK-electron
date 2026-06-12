import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useRef, type ReactElement } from "react";
import { LoginPage } from "./features/auth/LoginPage";
import { useAuth } from "./features/auth/AuthProvider";
import { StudentOnboardingPage } from "./features/onboarding/StudentOnboardingPage";
import { ProjectDetailPage, ProjectsPage } from "./features/projects/ProjectRegistrationPage";
import { StudentHomePage } from "./features/student/StudentHomePage";
import {
  ClassDetailPage,
  ClassJoinPage,
  TeacherHomePage,
  TeacherQueuePage
} from "./features/teacher/TeacherDashboard";
import { ThreadCreatePage } from "./features/threads/ThreadCreatePage";
import { ThreadDetailPage } from "./features/threads/ThreadDetailPage";
import type { AppRole } from "@shared/domain";
import { trackUsageEvent } from "./lib/telemetry";

const roleHome: Record<AppRole, string> = {
  student: "/student",
  teacher: "/teacher",
  admin: "/teacher"
};

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
  const appOpenedTracked = useRef(false);
  const lastTrackedScreen = useRef<string | null>(null);

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

  if (!profile) {
    return (
      <FullPageState
        title="プロフィールを確認できません"
        body="クラス参加またはユーザー設定が完了していない可能性があります。"
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="メインナビゲーション">
        <div className="brand">
          <span className="brand-mark">ASK</span>
          <span className="brand-subtitle">Question Support</span>
        </div>

        <nav className="nav-list">
          <NavLink to={profile.role === "student" ? "/student" : "/teacher"}>ホーム</NavLink>
          {profile.role === "student" && <NavLink to="/onboarding">初期設定</NavLink>}
          <NavLink to="/classes">クラス</NavLink>
          {profile.role !== "student" && <NavLink to="/teacher/queue">質問キュー</NavLink>}
          <NavLink to="/projects">プロジェクト</NavLink>
          {profile.role === "student" && <NavLink to="/threads/new">質問を作成</NavLink>}
          {profile.role === "student" && <NavLink to="/threads">質問一覧</NavLink>}
        </nav>

        <div className="sidebar-footer">
          <div>
            <strong>{profile.display_name}</strong>
            <span>{profile.role}</span>
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
          <Route path="/teacher/queue" element={<TeacherQueuePage />} />
          <Route path="/onboarding" element={<StudentOnboardingPage />} />
          <Route path="/classes" element={<TeacherHomePage />} />
          <Route path="/classes/:classId" element={<ClassDetailPage />} />
          <Route path="/join/:token" element={<ClassJoinPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route
            path="/threads"
            element={
              profile.role === "student" ? (
                <StudentHomePage />
              ) : (
                <Navigate to="/teacher/queue" replace />
              )
            }
          />
          <Route path="/threads/new" element={<ThreadCreatePage />} />
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
