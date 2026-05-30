/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from "react";
import type { Session } from "@supabase/supabase-js";
import type { UserProfile } from "@shared/domain";
import { getPublicEnv } from "../../lib/env";
import { getSupabaseClient } from "../../lib/supabase";

interface AuthContextValue {
  loading: boolean;
  configError: string | null;
  authError: string | null;
  session: Session | null;
  profile: UserProfile | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }): ReactElement => {
  const envResult = useMemo(() => getPublicEnv(), []);
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [authError, setAuthError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const configError = envResult.ok ? null : envResult.message;

  const loadProfile = useCallback(
    async (activeSession: Session | null): Promise<void> => {
      if (!supabase || !activeSession) {
        setProfile(null);
        return;
      }

      const { data, error } = await supabase
        .from("users")
        .select("id,email,display_name,role,github_username,created_at,updated_at")
        .eq("id", activeSession.user.id)
        .maybeSingle();

      if (error) {
        setAuthError("プロフィールを取得できませんでした。");
        setProfile(null);
        return;
      }

      setAuthError(null);
      setProfile(data);
    },
    [supabase]
  );

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) {
        return;
      }

      setSession(data.session);
      await loadProfile(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      void loadProfile(nextSession);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile, supabase]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      if (!supabase) {
        setAuthError(configError);
        return;
      }

      setAuthError(null);
      const { error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        setAuthError("メールアドレスまたはパスワードを確認してください。");
      }
    },
    [configError, supabase]
  );

  const signUp = useCallback(
    async (email: string, password: string): Promise<void> => {
      if (!supabase) {
        setAuthError(configError);
        return;
      }

      setAuthError(null);
      const displayName = email.split("@")[0] || "ASK user";
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: displayName
          }
        }
      });

      if (error) {
        setAuthError("アカウントを作成できませんでした。入力内容を確認してください。");
      }
    },
    [configError, supabase]
  );

  const signOut = useCallback(async (): Promise<void> => {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
  }, [supabase]);

  const refreshProfile = useCallback(async (): Promise<void> => {
    await loadProfile(session);
  }, [loadProfile, session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      configError,
      authError,
      session,
      profile,
      signIn,
      signUp,
      signOut,
      refreshProfile
    }),
    [authError, configError, loading, profile, refreshProfile, session, signIn, signOut, signUp]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return value;
};
