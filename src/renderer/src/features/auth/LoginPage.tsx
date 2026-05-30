import { FormEvent, useState } from "react";
import type { ReactElement } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export const LoginPage = (): ReactElement => {
  const { authError, configError, loading, session, signIn, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [submitting, setSubmitting] = useState(false);

  if (!loading && session) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);

    try {
      if (mode === "signIn") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="login-title">
        <div>
          <p className="eyebrow">ASK Electron</p>
          <h1 id="login-title">学習中の質問を、調べやすい形で先生へ送る</h1>
          <p className="muted">
            GitHub、コード差分、環境情報をそろえて、質問対応を始めやすくします。
          </p>
        </div>

        <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            メールアドレス
            <input
              autoComplete="email"
              inputMode="email"
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label>
            パスワード
            <input
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              minLength={8}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          {(configError || authError) && (
            <p className="message error" role="alert">
              {configError ?? authError}
            </p>
          )}

          <button
            className="primary-button"
            disabled={submitting || Boolean(configError)}
            type="submit"
          >
            {submitting ? "確認中..." : mode === "signIn" ? "ログイン" : "アカウント作成"}
          </button>
        </form>

        <button
          className="link-button"
          type="button"
          onClick={() => setMode((current) => (current === "signIn" ? "signUp" : "signIn"))}
        >
          {mode === "signIn" ? "アカウントを作成する" : "ログインに戻る"}
        </button>
      </section>
    </main>
  );
};
