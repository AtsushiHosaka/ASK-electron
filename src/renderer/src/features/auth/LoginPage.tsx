import { FormEvent, useState } from "react";
import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

interface LoginLocationState {
  from?: {
    pathname: string;
    search: string;
    hash: string;
  };
}

export const LoginPage = (): ReactElement => {
  const { authError, configError, loading, session, signIn, signUp } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [submitting, setSubmitting] = useState(false);
  const from = (location.state as LoginLocationState | null)?.from;
  const redirectTo = from ? `${from.pathname}${from.search}${from.hash}` : "/";

  if (!loading && session) {
    return <Navigate to={redirectTo} replace />;
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
          <p className="eyebrow">ASK</p>
          <h1 id="login-title">{mode === "signIn" ? "ログイン" : "アカウント作成"}</h1>
        </div>

        <div className="auth-mode-control" aria-label="認証モード">
          <button
            className={mode === "signIn" ? "active" : ""}
            type="button"
            aria-pressed={mode === "signIn"}
            onClick={() => setMode("signIn")}
          >
            ログイン
          </button>
          <button
            className={mode === "signUp" ? "active" : ""}
            type="button"
            aria-pressed={mode === "signUp"}
            onClick={() => setMode("signUp")}
          >
            作成
          </button>
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
      </section>
    </main>
  );
};
