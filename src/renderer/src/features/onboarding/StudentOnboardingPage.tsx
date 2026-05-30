import { useMemo, useState, type ReactElement } from "react";
import type {
  GitignoreApplyResponse,
  GitignorePreviewResponse,
  LocalDiagnosticsResponse,
  ProjectGitInspectionResponse,
  ProjectRootSelectionResponse
} from "../../../../shared/ipc";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";

type StepStatus = "pending" | "checking" | "success" | "warning" | "error";

interface OnboardingStep {
  id: string;
  title: string;
  goal: string;
  nextAction: string;
  errorText: string;
}

const storageKey = "ask.studentOnboarding.v1";

const steps: OnboardingStep[] = [
  {
    id: "github-account",
    title: "GitHub アカウント",
    goal: "GitHub にログインできるか確認します。",
    nextAction: "GitHub アカウントを用意し、ログインできる状態にします。",
    errorText: "GitHub アカウントが確認できません。先生に相談してアカウントを用意してください。"
  },
  {
    id: "git-installed",
    title: "Git",
    goal: "この PC で Git が使えるか確認します。",
    nextAction: "Git をインストールしてから、もう一度確認します。",
    errorText: "Git が見つかりません。OS に合わせた Git のインストールが必要です。"
  },
  {
    id: "github-cli-auth",
    title: "GitHub CLI",
    goal: "GitHub CLI のログイン状態を確認します。",
    nextAction: "`gh auth login` を実行し、ブラウザで GitHub にログインします。",
    errorText: "GitHub CLI のログインが完了していません。ログイン後に再チェックしてください。"
  },
  {
    id: "ssh",
    title: "SSH 接続",
    goal: "GitHub へ SSH で接続できるか確認します。",
    nextAction: "SSH 鍵を作成し、公開鍵を GitHub に登録します。",
    errorText: "SSH 接続に失敗しました。公開鍵の登録またはネットワーク状態を確認してください。"
  },
  {
    id: "project-root",
    title: "プロジェクトフォルダ",
    goal: "質問したいローカルプロジェクトを選びます。",
    nextAction: "質問したいコードが入っているプロジェクトフォルダを選択します。",
    errorText: "プロジェクトフォルダを選択できませんでした。もう一度選択してください。"
  },
  {
    id: "gitignore",
    title: ".gitignore",
    goal: "プロジェクトに必要な除外設定を確認します。",
    nextAction: "推奨差分を確認し、問題なければ `.gitignore` に追記します。",
    errorText: ".gitignore の確認または更新に失敗しました。手動コピー用の内容を使ってください。"
  },
  {
    id: "repository",
    title: "GitHub リポジトリ",
    goal: "ローカルプロジェクトと GitHub repository を紐付けます。",
    nextAction: "remote origin と GitHub repository が一致しているか確認します。",
    errorText: "remote origin が見つからないか、選択した GitHub repository と一致していません。"
  }
];

type StatusMap = Record<string, StepStatus>;

const createInitialStatuses = (): StatusMap =>
  Object.fromEntries(steps.map((step) => [step.id, "pending" satisfies StepStatus]));

const readStoredStatuses = (): StatusMap => {
  const fallback = createInitialStatuses();

  try {
    const rawValue = window.localStorage.getItem(storageKey);

    if (!rawValue) {
      return fallback;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<StatusMap>;
    return Object.fromEntries(
      steps.map((step) => {
        const value = parsedValue[step.id];
        return [
          step.id,
          value === "checking" || value === "success" || value === "warning" || value === "error"
            ? value
            : "pending"
        ];
      })
    );
  } catch {
    return fallback;
  }
};

const statusLabel: Record<StepStatus, string> = {
  pending: "未確認",
  checking: "確認中",
  success: "完了",
  warning: "注意",
  error: "失敗"
};

const diagnosticStepIds = ["github-account", "git-installed", "github-cli-auth", "ssh"] as const;

const isDiagnosticStep = (stepId: string): boolean => {
  return diagnosticStepIds.some((diagnosticStepId) => diagnosticStepId === stepId);
};

const resolveGithubUsername = (diagnostics: LocalDiagnosticsResponse): string | null => {
  return diagnostics.githubCli.account ?? diagnostics.ssh.connection.account;
};

const mapDiagnosticsToSteps = (
  diagnostics: LocalDiagnosticsResponse
): { statuses: Partial<StatusMap>; messages: Record<string, string> } => {
  const githubUsername = resolveGithubUsername(diagnostics);
  const statuses: Partial<StatusMap> = {
    "github-account": githubUsername ? "success" : "error",
    "git-installed":
      diagnostics.git.status === "ok" && diagnostics.git.installed ? "success" : "error",
    "github-cli-auth":
      diagnostics.githubCli.status === "ok" && diagnostics.githubCli.authenticated
        ? "success"
        : "error",
    ssh:
      diagnostics.ssh.keys.status === "ok" &&
      diagnostics.ssh.connection.status === "ok" &&
      diagnostics.ssh.connection.authenticated
        ? "success"
        : "error"
  };

  return {
    statuses,
    messages: {
      "github-account": githubUsername
        ? `GitHub アカウント ${githubUsername} を確認しました。`
        : "GitHub アカウント名を確認できませんでした。GitHub CLI のログイン状態を確認してください。",
      "git-installed": diagnostics.git.message,
      "github-cli-auth": diagnostics.githubCli.message,
      ssh:
        diagnostics.ssh.keys.status !== "ok"
          ? diagnostics.ssh.keys.message
          : diagnostics.ssh.connection.message
    }
  };
};

export const StudentOnboardingPage = (): ReactElement => {
  const { profile } = useAuth();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [statuses, setStatuses] = useState<StatusMap>(() => readStoredStatuses());
  const [activeStepId, setActiveStepId] = useState(() => {
    return steps.find((step) => readStoredStatuses()[step.id] !== "success")?.id ?? steps[0].id;
  });
  const [selectedProjectRoot, setSelectedProjectRoot] =
    useState<ProjectRootSelectionResponse | null>(null);
  const [repositoryInspection, setRepositoryInspection] =
    useState<ProjectGitInspectionResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<LocalDiagnosticsResponse | null>(null);
  const [stepMessages, setStepMessages] = useState<Record<string, string>>({});
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [gitignorePreview, setGitignorePreview] = useState<GitignorePreviewResponse | null>(null);
  const [gitignoreApplyResult, setGitignoreApplyResult] = useState<GitignoreApplyResponse | null>(
    null
  );
  const [gitignoreBusy, setGitignoreBusy] = useState(false);
  const [gitignoreError, setGitignoreError] = useState<string | null>(null);

  const activeStep = steps.find((step) => step.id === activeStepId) ?? steps[0];
  const completedCount = steps.filter((step) => statuses[step.id] === "success").length;
  const allComplete = completedCount === steps.length;

  const progressText = useMemo(() => {
    return `${completedCount} / ${steps.length} 完了`;
  }, [completedCount]);

  const updateStatuses = (nextStatuses: StatusMap): void => {
    setStatuses(nextStatuses);
    window.localStorage.setItem(storageKey, JSON.stringify(nextStatuses));
  };

  const mergeStatuses = (updates: Partial<StatusMap>): void => {
    setStatuses((current) => {
      const nextStatuses: StatusMap = { ...current };

      for (const [stepId, status] of Object.entries(updates)) {
        if (status) {
          nextStatuses[stepId] = status;
        }
      }

      window.localStorage.setItem(storageKey, JSON.stringify(nextStatuses));
      return nextStatuses;
    });
  };

  const setStepStatus = (stepId: string, status: StepStatus): void => {
    mergeStatuses({ [stepId]: status });
  };

  const resetProgress = (): void => {
    const nextStatuses = createInitialStatuses();
    updateStatuses(nextStatuses);
    setActiveStepId(steps[0].id);
    setSelectedProjectRoot(null);
    setRepositoryInspection(null);
    setDiagnostics(null);
    setStepMessages({});
    setDiagnosticsError(null);
    setGitignorePreview(null);
    setGitignoreApplyResult(null);
    setGitignoreError(null);
  };

  const moveNext = (): void => {
    const currentIndex = steps.findIndex((step) => step.id === activeStep.id);
    const nextStep = steps[currentIndex + 1];

    if (nextStep) {
      setActiveStepId(nextStep.id);
    }
  };

  const persistGithubConnection = async (
    nextDiagnostics: LocalDiagnosticsResponse
  ): Promise<void> => {
    if (!supabase || !profile) {
      setDiagnosticsError("GitHub 連携の保存に必要なプロフィールを確認できませんでした。");
      return;
    }

    const githubUsername = resolveGithubUsername(nextDiagnostics);
    const canPersist =
      githubUsername &&
      nextDiagnostics.githubCli.status === "ok" &&
      nextDiagnostics.githubCli.authenticated &&
      nextDiagnostics.ssh.connection.status === "ok" &&
      nextDiagnostics.ssh.connection.authenticated;

    if (!canPersist) {
      return;
    }

    const { error: connectionError } = await supabase.from("github_connections").upsert(
      {
        user_id: profile.id,
        github_username: githubUsername,
        auth_method: "gh_cli",
        ssh_status: "ok",
        last_checked_at: nextDiagnostics.checkedAt
      },
      { onConflict: "user_id" }
    );

    if (connectionError) {
      setDiagnosticsError("GitHub 連携状態を保存できませんでした。再チェックしてください。");
      return;
    }

    const { error: profileError } = await supabase
      .from("users")
      .update({ github_username: githubUsername })
      .eq("id", profile.id);

    if (profileError) {
      console.warn("Failed to update user GitHub username", profileError);
    }
  };

  const runLocalDiagnostics = async (): Promise<void> => {
    mergeStatuses(
      Object.fromEntries(diagnosticStepIds.map((stepId) => [stepId, "checking" as StepStatus]))
    );
    setDiagnostics(null);
    setDiagnosticsError(null);
    setStepMessages((current) => {
      const nextMessages = { ...current };

      for (const stepId of diagnosticStepIds) {
        delete nextMessages[stepId];
      }

      return nextMessages;
    });

    const result = await window.ask.diagnostics.runLocal();

    if (!result.ok) {
      mergeStatuses(
        Object.fromEntries(diagnosticStepIds.map((stepId) => [stepId, "error" as StepStatus]))
      );
      setDiagnosticsError(result.error.message);
      return;
    }

    setDiagnostics(result.data);

    const mappedDiagnostics = mapDiagnosticsToSteps(result.data);
    mergeStatuses(mappedDiagnostics.statuses);
    setStepMessages((current) => ({
      ...current,
      ...mappedDiagnostics.messages
    }));

    await persistGithubConnection(result.data);
  };

  const inspectRepository = async (): Promise<void> => {
    if (!selectedProjectRoot?.projectRootId) {
      setStepStatus("repository", "error");
      setStepMessages((current) => ({
        ...current,
        repository: "先にプロジェクトフォルダを選択してください。"
      }));
      return;
    }

    setStepStatus("repository", "checking");
    setRepositoryInspection(null);
    setStepMessages((current) => ({
      ...current,
      repository: "remote origin と GitHub repository を確認しています。"
    }));

    const result = await window.ask.project.inspectGit({
      projectRootId: selectedProjectRoot.projectRootId
    });

    if (!result.ok) {
      setStepStatus("repository", "error");
      setStepMessages((current) => ({
        ...current,
        repository: result.error.message
      }));
      return;
    }

    setRepositoryInspection(result.data);
    setStepStatus("repository", result.data.canRegister ? "success" : "error");
    setStepMessages((current) => ({
      ...current,
      repository: result.data.message
    }));
  };

  const selectProjectFolder = async (): Promise<void> => {
    setStepStatus("project-root", "checking");
    setRepositoryInspection(null);
    setGitignorePreview(null);
    setGitignoreApplyResult(null);
    setGitignoreError(null);

    const result = await window.ask.project.selectRoot();

    if (!result.ok) {
      setStepStatus("project-root", "error");
      setGitignoreError(result.error.message);
      return;
    }

    setSelectedProjectRoot(result.data);

    if (!result.data.selected || !result.data.projectRootId) {
      setStepStatus("project-root", "pending");
      return;
    }

    setStepStatus("project-root", "success");
    setActiveStepId("gitignore");
  };

  const previewGitignore = async (): Promise<void> => {
    if (!selectedProjectRoot?.projectRootId) {
      setStepStatus("gitignore", "error");
      setGitignoreError("先にプロジェクトフォルダを選択してください。");
      return;
    }

    setGitignoreBusy(true);
    setGitignoreError(null);
    setGitignoreApplyResult(null);
    setStepStatus("gitignore", "checking");

    const result = await window.ask.gitignore.preview({
      projectRootId: selectedProjectRoot.projectRootId
    });

    setGitignoreBusy(false);

    if (!result.ok) {
      setStepStatus("gitignore", "error");
      setGitignoreError(result.error.message);
      return;
    }

    setGitignorePreview(result.data);
    setStepStatus("gitignore", result.data.canApply ? "warning" : "success");
  };

  const applyGitignore = async (): Promise<void> => {
    if (!selectedProjectRoot?.projectRootId || !gitignorePreview) {
      setStepStatus("gitignore", "error");
      setGitignoreError("適用前に.gitignoreの推奨差分を確認してください。");
      return;
    }

    setGitignoreBusy(true);
    setGitignoreError(null);
    setStepStatus("gitignore", "checking");

    const result = await window.ask.gitignore.apply({
      projectRootId: selectedProjectRoot.projectRootId,
      recommendationHash: gitignorePreview.recommendationHash
    });

    setGitignoreBusy(false);

    if (!result.ok) {
      setStepStatus("gitignore", "error");
      setGitignoreError(result.error.message);
      return;
    }

    setGitignoreApplyResult(result.data);

    if (result.data.status === "applied" || result.data.status === "unchanged") {
      setStepStatus("gitignore", "success");
    } else if (result.data.status === "stale") {
      setStepStatus("gitignore", "warning");
    } else if (result.data.status === "failed") {
      setStepStatus("gitignore", "error");
      setGitignoreError(result.data.message);
    } else {
      setStepStatus("gitignore", "error");
      setGitignoreError(result.data.message);
    }
  };

  const runPrimaryAction = (): void => {
    if (isDiagnosticStep(activeStep.id)) {
      void runLocalDiagnostics();
      return;
    }

    if (activeStep.id === "project-root") {
      void selectProjectFolder();
      return;
    }

    if (activeStep.id === "gitignore") {
      void previewGitignore();
      return;
    }

    if (activeStep.id === "repository") {
      void inspectRepository();
    }
  };

  const primaryActionLabel = isDiagnosticStep(activeStep.id)
    ? statuses[activeStep.id] === "checking"
      ? "確認中..."
      : "接続確認"
    : activeStep.id === "project-root"
      ? "フォルダを選択"
      : activeStep.id === "gitignore"
        ? gitignoreBusy
          ? "確認中..."
          : "推奨差分を確認"
        : activeStep.id === "repository"
          ? statuses.repository === "checking"
            ? "確認中..."
            : "repository を確認"
          : "確認";
  const activeStepMessage = stepMessages[activeStep.id];

  return (
    <section className="onboarding-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Onboarding</p>
          <h1>GitHub とプロジェクト接続</h1>
          <p className="muted">
            GitHub、Git、SSH、プロジェクトフォルダ、repository の順に確認します。
          </p>
        </div>
        <div className="progress-summary" aria-label={progressText}>
          <strong>{progressText}</strong>
          <span>{allComplete ? "質問作成へ進めます" : "未完了の項目があります"}</span>
        </div>
      </div>

      <div className="onboarding-layout">
        <ol className="step-list" aria-label="オンボーディング手順">
          {steps.map((step) => (
            <li key={step.id}>
              <button
                className={step.id === activeStep.id ? "step-button active" : "step-button"}
                type="button"
                onClick={() => setActiveStepId(step.id)}
              >
                <span>{step.title}</span>
                <span className={`status-pill ${statuses[step.id]}`}>
                  {statusLabel[statuses[step.id]]}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <article className="onboarding-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Current Step</p>
              <h2>{activeStep.title}</h2>
            </div>
            <span className={`status-pill ${statuses[activeStep.id]}`}>
              {statusLabel[statuses[activeStep.id]]}
            </span>
          </div>

          <div className="instruction-block">
            <h3>確認すること</h3>
            <p>{activeStep.goal}</p>
          </div>

          <div className="instruction-block">
            <h3>次にすること</h3>
            <p>{activeStep.nextAction}</p>
          </div>

          {statuses[activeStep.id] === "error" && (
            <p className="message error" role="alert">
              {activeStepMessage ?? diagnosticsError ?? activeStep.errorText}
            </p>
          )}

          {statuses[activeStep.id] === "warning" && (
            <p className="message warning" role="status">
              {activeStepMessage ??
                "進める前に先生へ確認してください。設定はあとから再チェックできます。"}
            </p>
          )}

          {statuses[activeStep.id] === "success" && activeStepMessage && (
            <p className="message success" role="status">
              {activeStepMessage}
            </p>
          )}

          {diagnosticsError &&
            isDiagnosticStep(activeStep.id) &&
            statuses[activeStep.id] !== "error" && (
              <p className="message error" role="alert">
                {diagnosticsError}
              </p>
            )}

          {activeStep.id === "project-root" && selectedProjectRoot?.selected && (
            <div className="instruction-block">
              <h3>選択中のフォルダ</h3>
              <p>{selectedProjectRoot.displayName}</p>
            </div>
          )}

          {isDiagnosticStep(activeStep.id) && diagnostics && (
            <div className="project-summary-list">
              <span>Git</span>
              <strong>{diagnostics.git.version ?? diagnostics.git.message}</strong>
              <span>GitHub CLI</span>
              <strong>{diagnostics.githubCli.account ?? diagnostics.githubCli.message}</strong>
              <span>SSH鍵</span>
              <strong>{diagnostics.ssh.keys.message}</strong>
              <span>SSH接続</span>
              <strong>{diagnostics.ssh.connection.message}</strong>
            </div>
          )}

          {activeStep.id === "repository" && repositoryInspection && (
            <div className="project-summary-list">
              <span>remote origin</span>
              <strong>{repositoryInspection.remoteOriginUrl ?? "未設定"}</strong>
              <span>GitHub repository</span>
              <strong>{repositoryInspection.normalizedGithubRepoUrl ?? "未検出"}</strong>
              <span>default branch</span>
              <strong>{repositoryInspection.defaultBranch ?? "未検出"}</strong>
            </div>
          )}

          {activeStep.id === "gitignore" && (
            <div className="gitignore-workflow">
              {!selectedProjectRoot?.projectRootId && (
                <p className="message warning">
                  `.gitignore` の確認前にプロジェクトフォルダを選択してください。
                </p>
              )}

              {gitignoreError && (
                <p className="message error" role="alert">
                  {gitignoreError}
                </p>
              )}

              {gitignorePreview && (
                <>
                  <div className="gitignore-summary">
                    <span>対象: {gitignorePreview.displayName}</span>
                    <span>
                      種別:{" "}
                      {gitignorePreview.detectedKinds
                        .filter((kind) => kind !== "generic")
                        .join(", ") || "generic"}
                    </span>
                    <span>追加候補: {gitignorePreview.missingPatterns.length} 件</span>
                  </div>

                  <div className="gitignore-entry-list" aria-label=".gitignore 推奨候補">
                    {gitignorePreview.entries.map((entry) => (
                      <div key={entry.pattern} className="gitignore-entry">
                        <strong>{entry.pattern}</strong>
                        <span>{entry.alreadyPresent ? "設定済み" : "追加候補"}</span>
                        <p>{entry.reason}</p>
                      </div>
                    ))}
                  </div>

                  <label className="preview-field">
                    追記前の確認差分
                    <pre className="code-preview">{gitignorePreview.previewDiff}</pre>
                  </label>

                  {gitignorePreview.manualCopyText && (
                    <label className="preview-field">
                      手動コピー用
                      <textarea readOnly value={gitignorePreview.manualCopyText} />
                    </label>
                  )}

                  <div className="control-row">
                    <button
                      className="primary-button"
                      disabled={
                        !gitignorePreview.canApply ||
                        gitignoreBusy ||
                        gitignoreApplyResult?.status === "applied" ||
                        gitignoreApplyResult?.status === "unchanged"
                      }
                      type="button"
                      onClick={() => void applyGitignore()}
                    >
                      {gitignoreBusy ? "更新中..." : ".gitignore に追記"}
                    </button>
                  </div>
                </>
              )}

              {gitignoreApplyResult && (
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
              )}
            </div>
          )}

          <div className="control-row">
            <button
              className="primary-button"
              disabled={statuses[activeStep.id] === "checking" || gitignoreBusy}
              type="button"
              onClick={runPrimaryAction}
            >
              {primaryActionLabel}
            </button>
            <button className="secondary-button" type="button" onClick={moveNext}>
              次へ
            </button>
            <button className="secondary-button" type="button" onClick={resetProgress}>
              リセット
            </button>
          </div>
        </article>
      </div>
    </section>
  );
};
