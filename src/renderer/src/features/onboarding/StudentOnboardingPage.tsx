import { useMemo, useState, type ReactElement } from "react";

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
    nextAction: "`.git` があるプロジェクトフォルダを選択します。",
    errorText: "選択したフォルダに `.git` がありません。Git 管理されたフォルダを選んでください。"
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

export const StudentOnboardingPage = (): ReactElement => {
  const [statuses, setStatuses] = useState<StatusMap>(() => readStoredStatuses());
  const [activeStepId, setActiveStepId] = useState(() => {
    return steps.find((step) => readStoredStatuses()[step.id] !== "success")?.id ?? steps[0].id;
  });

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

  const setStepStatus = (stepId: string, status: StepStatus): void => {
    updateStatuses({
      ...statuses,
      [stepId]: status
    });
  };

  const simulateCheck = (stepId: string): void => {
    setStepStatus(stepId, "checking");
    window.setTimeout(() => {
      setStatuses((current) => {
        const nextStatuses = {
          ...current,
          [stepId]: "success" as StepStatus
        };
        window.localStorage.setItem(storageKey, JSON.stringify(nextStatuses));
        return nextStatuses;
      });
    }, 500);
  };

  const resetProgress = (): void => {
    const nextStatuses = createInitialStatuses();
    updateStatuses(nextStatuses);
    setActiveStepId(steps[0].id);
  };

  const moveNext = (): void => {
    const currentIndex = steps.findIndex((step) => step.id === activeStep.id);
    const nextStep = steps[currentIndex + 1];

    if (nextStep) {
      setActiveStepId(nextStep.id);
    }
  };

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
              {activeStep.errorText}
            </p>
          )}

          {statuses[activeStep.id] === "warning" && (
            <p className="message warning" role="status">
              進める前に先生へ確認してください。設定はあとから再チェックできます。
            </p>
          )}

          <div className="control-row">
            <button
              className="primary-button"
              disabled={statuses[activeStep.id] === "checking"}
              type="button"
              onClick={() => simulateCheck(activeStep.id)}
            >
              {statuses[activeStep.id] === "checking" ? "確認中..." : "接続確認"}
            </button>
            <button className="secondary-button" type="button" onClick={moveNext}>
              次へ
            </button>
            <button className="secondary-button" type="button" onClick={resetProgress}>
              リセット
            </button>
          </div>

          <label className="status-editor">
            開発用ステータス
            <select
              value={statuses[activeStep.id]}
              onChange={(event) => setStepStatus(activeStep.id, event.target.value as StepStatus)}
            >
              <option value="pending">未確認</option>
              <option value="checking">確認中</option>
              <option value="success">完了</option>
              <option value="warning">注意</option>
              <option value="error">失敗</option>
            </select>
          </label>
        </article>
      </div>
    </section>
  );
};
