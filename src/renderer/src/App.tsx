import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { LoginPage } from "./features/auth/LoginPage";
import { useAuth } from "./features/auth/AuthProvider";
import { StudentOnboardingPage } from "./features/onboarding/StudentOnboardingPage";
import { ProjectDetailPage, ProjectsPage } from "./features/projects/ProjectRegistrationPage";
import {
  ClassDetailPage,
  ClassJoinPage,
  TeacherHomePage
} from "./features/teacher/TeacherDashboard";
import type { AppRole } from "@shared/domain";

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
          <NavLink to="/projects">プロジェクト</NavLink>
          <NavLink to="/threads/new">質問を作成</NavLink>
          <NavLink to="/threads/demo">スレッド</NavLink>
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
          <Route path="/student" element={<StudentHome />} />
          <Route path="/teacher" element={<TeacherHomePage />} />
          <Route path="/onboarding" element={<StudentOnboardingPage />} />
          <Route path="/classes" element={<TeacherHomePage />} />
          <Route path="/classes/:classId" element={<ClassDetailPage />} />
          <Route path="/join/:token" element={<ClassJoinPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
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

const StudentHome = (): ReactElement => (
  <WorkspacePage
    eyebrow="Student"
    title="質問の準備"
    body="GitHub 接続、プロジェクト登録、質問作成の導線をここに集約します。"
    items={["GitHub / SSH オンボーディング", "登録済みプロジェクト", "最近の質問スレッド"]}
  />
);

const ThreadCreatePage = (): ReactElement => (
  <WorkspacePage
    eyebrow="Question"
    title="質問を作成"
    body="状況説明、エラー文、実行コマンド、関連ファイル、送信前プレビューを扱う画面です。"
    items={["入力フォーム", "Git 差分", "環境情報", "秘密情報チェック"]}
  />
);

const ThreadDetailPage = (): ReactElement => (
  <WorkspacePage
    eyebrow="Thread"
    title="スレッド詳細"
    body="チャット、コードブロック、差分、環境情報、パッチ提案を表示します。"
    items={["チャット", "コード表示", "パッチ確認", "ステータス変更"]}
  />
);

const WorkspacePage = ({
  eyebrow,
  title,
  body,
  items
}: {
  eyebrow: string;
  title: string;
  body: string;
  items: string[];
}): ReactElement => (
  <section className="workspace-page">
    <p className="eyebrow">{eyebrow}</p>
    <h1>{title}</h1>
    <p className="muted">{body}</p>
    <div className="placeholder-grid">
      {items.map((item) => (
        <article className="placeholder-panel" key={item}>
          <span>{item}</span>
        </article>
      ))}
    </div>
  </section>
);

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
