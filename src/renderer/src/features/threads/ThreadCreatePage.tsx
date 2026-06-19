import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Database, Json } from "../../../../shared/database.types";
import type { AiAssistRequest, AiAssistTask } from "../../../../shared/aiPipeline";
import type {
  EnvironmentSnapshotRequest,
  EnvironmentSnapshotResponse,
  GitDiffCollectionRequest,
  GitDiffCollectionResponse,
  ProjectGitInspectionResponse,
  ProjectRootSelectionResponse,
  RelatedFileSnippet
} from "../../../../shared/ipc";
import { scanSecrets, type SecretScanFinding } from "../../../../shared/secretScanner";
import { useAuth } from "../auth/AuthProvider";
import { getSupabaseClient } from "../../lib/supabase";
import { trackUsageEvent } from "../../lib/telemetry";
import { CodeContextViewer } from "../../components/CodeContextViewer";
import {
  buildAiAssistContext,
  buildEnvironmentSnapshotMessage,
  buildInitialMessage,
  dedupeRelatedFiles,
  findBlockedRelatedFiles,
  scanAiAssistContextForSecrets,
  splitRelatedFiles
} from "./threadCreateMessage";

type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];

type MessageStatus = "success" | "warning" | "error";

type ThreadCreateAiTask = Extract<
  AiAssistTask,
  "question_rewrite" | "error_summary" | "cause_candidates"
>;

interface ThreadCreateState {
  loading: boolean;
  error: string | null;
  projects: ProjectRow[];
}

interface GitDiffUiState {
  loading: boolean;
  response: GitDiffCollectionResponse | null;
  error: string | null;
  selectedRoot: ProjectRootSelectionResponse | null;
  inspection: ProjectGitInspectionResponse | null;
}

interface EnvironmentSnapshotUiState {
  loading: boolean;
  response: EnvironmentSnapshotResponse | null;
  error: string | null;
}

interface SendReviewState {
  open: boolean;
  draftQuestion: string;
  aiErrorSummary: string;
  aiCauseCandidates: string;
  aiUsed: boolean;
  includeGitDiff: boolean;
  includeEnvironmentSnapshot: boolean;
  excludedRelatedFiles: string[];
}

interface AiAssistUiState {
  loadingTask: ThreadCreateAiTask | null;
}

interface RelatedFileSnippetUiState {
  loading: boolean;
  snippets: RelatedFileSnippet[];
  error: string | null;
  message: string | null;
}

const initialState: ThreadCreateState = {
  loading: true,
  error: null,
  projects: []
};

const initialGitDiffState: GitDiffUiState = {
  loading: false,
  response: null,
  error: null,
  selectedRoot: null,
  inspection: null
};

const initialEnvironmentSnapshotState: EnvironmentSnapshotUiState = {
  loading: false,
  response: null,
  error: null
};

const initialSendReviewState: SendReviewState = {
  open: false,
  draftQuestion: "",
  aiErrorSummary: "",
  aiCauseCandidates: "",
  aiUsed: false,
  includeGitDiff: true,
  includeEnvironmentSnapshot: true,
  excludedRelatedFiles: []
};

const initialAiAssistState: AiAssistUiState = {
  loadingTask: null
};

const initialRelatedFileSnippetState: RelatedFileSnippetUiState = {
  loading: false,
  snippets: [],
  error: null,
  message: null
};

const getAiTaskLabel = (task: ThreadCreateAiTask): string => {
  const labels: Record<ThreadCreateAiTask, string> = {
    question_rewrite: "質問文整理",
    error_summary: "エラー要約",
    cause_candidates: "原因候補"
  };

  return labels[task];
};

const formatSecretFindingForUi = (finding: SecretScanFinding): string => {
  const line = finding.lineNumber ? `:${finding.lineNumber}` : "";
  return `${finding.sourceLabel}${line} - ${finding.message}`;
};

export const ThreadCreatePage = (): ReactElement => {
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const supabase = useMemo(() => getSupabaseClient(), []);
  const [state, setState] = useState<ThreadCreateState>(initialState);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [situation, setSituation] = useState("");
  const [errorText, setErrorText] = useState("");
  const [commandText, setCommandText] = useState("");
  const [relatedFilesText, setRelatedFilesText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<MessageStatus>("warning");
  const [gitDiffState, setGitDiffState] = useState<GitDiffUiState>(initialGitDiffState);
  const [environmentSnapshotState, setEnvironmentSnapshotState] =
    useState<EnvironmentSnapshotUiState>(initialEnvironmentSnapshotState);
  const [relatedFileSnippetState, setRelatedFileSnippetState] = useState<RelatedFileSnippetUiState>(
    initialRelatedFileSnippetState
  );
  const [sendReview, setSendReview] = useState<SendReviewState>(initialSendReviewState);
  const [aiAssistState, setAiAssistState] = useState<AiAssistUiState>(initialAiAssistState);
  const [allowedSecretFindingIds, setAllowedSecretFindingIds] = useState<string[]>([]);
  const reviewModalRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadProjects = async (): Promise<void> => {
      if (!supabase || !profile) {
        setState({
          loading: false,
          error: "Supabase 設定またはプロフィールを確認できませんでした。",
          projects: []
        });
        return;
      }

      try {
        const { data, error } = await supabase
          .from("projects")
          .select(
            "id,owner_user_id,class_id,name,local_path_hash,github_repo_url,default_branch,created_at"
          )
          .eq("owner_user_id", profile.id)
          .order("created_at", { ascending: false });

        if (error) {
          throw error;
        }

        if (mounted) {
          const projects = data ?? [];

          if (routeProjectId && !projects.some((project) => project.id === routeProjectId)) {
            setState({
              loading: false,
              error: "プロジェクトを確認できませんでした。",
              projects: []
            });
            return;
          }

          setState({ loading: false, error: null, projects });
          setSelectedProjectId((current) => routeProjectId ?? (current || projects[0]?.id || ""));
        }
      } catch (error) {
        console.error("Failed to load projects for thread creation", error);

        if (mounted) {
          setState({
            loading: false,
            error: "質問作成に必要なプロジェクトを読み込めませんでした。",
            projects: []
          });
        }
      }
    };

    void loadProjects();

    return () => {
      mounted = false;
    };
  }, [profile, routeProjectId, supabase]);

  const selectedProject = state.projects.find((project) => project.id === selectedProjectId);
  const projectLocked = Boolean(routeProjectId);
  const manualRelatedFiles = splitRelatedFiles(relatedFilesText);
  const relatedSnippets = relatedFileSnippetState.snippets;
  const relatedFiles = dedupeRelatedFiles([
    ...manualRelatedFiles,
    ...relatedSnippets.map((snippet) => snippet.relativePath)
  ]);
  const gitDiffResponse = gitDiffState.response;
  const environmentSnapshot = environmentSnapshotState.response;
  const blockedRelatedFiles = findBlockedRelatedFiles(manualRelatedFiles);
  const unavailableRelatedSnippetPaths = relatedSnippets
    .filter((snippet) => snippet.status !== "included")
    .map((snippet) => snippet.relativePath);
  const excludedRelatedFileSet = new Set([
    ...blockedRelatedFiles,
    ...unavailableRelatedSnippetPaths,
    ...sendReview.excludedRelatedFiles
  ]);
  const includedRelatedFiles = relatedFiles.filter((file) => !excludedRelatedFileSet.has(file));
  const includedRelatedSnippets = relatedSnippets.filter(
    (snippet) =>
      snippet.status === "included" &&
      !excludedRelatedFileSet.has(snippet.relativePath) &&
      snippet.content.trim().length > 0
  );
  const editableSecretScan = scanSecrets({
    textEntries: [
      { label: "タイトル", value: title },
      { label: "質問内容", value: situation },
      { label: "エラー文", value: errorText },
      { label: "実行コマンド", value: commandText }
    ],
    allowedFindingIds: allowedSecretFindingIds
  });
  const secretScan = scanSecrets({
    textEntries: [
      { label: "質問文", value: sendReview.draftQuestion },
      { label: "AIエラー要約", value: sendReview.aiErrorSummary },
      { label: "AI原因候補", value: sendReview.aiCauseCandidates },
      { label: "タイトル", value: title },
      { label: "質問内容", value: situation },
      { label: "エラー文", value: errorText },
      { label: "実行コマンド", value: commandText },
      {
        label: "staged diff",
        value: sendReview.includeGitDiff ? (gitDiffResponse?.stagedDiff.text ?? "") : ""
      },
      {
        label: "unstaged diff",
        value: sendReview.includeGitDiff ? (gitDiffResponse?.unstagedDiff.text ?? "") : ""
      },
      {
        label: "環境情報",
        value:
          sendReview.includeEnvironmentSnapshot && environmentSnapshot
            ? buildEnvironmentSnapshotMessage(environmentSnapshot)
            : ""
      },
      ...includedRelatedSnippets.map((snippet) => ({
        label: `関連ファイル ${snippet.relativePath}`,
        value: snippet.content
      }))
    ],
    filePaths: [
      ...includedRelatedFiles,
      ...(sendReview.includeGitDiff
        ? (gitDiffResponse?.changedFiles.map((file) => file.path) ?? [])
        : [])
    ],
    allowedFindingIds: allowedSecretFindingIds
  });
  const missingRequiredFields = !selectedProject || !title.trim() || !situation.trim();
  const canReview =
    !submitting &&
    profile?.role === "student" &&
    state.projects.length > 0 &&
    !missingRequiredFields &&
    !editableSecretScan.blocked;
  const buildDefaultReviewDraft = (): string => {
    const lines = [title.trim(), situation.trim()].filter(Boolean);
    return lines.join("\n\n");
  };
  const closeSendReview = useCallback((): void => {
    setSendReview((current) => ({
      ...current,
      open: false
    }));
  }, []);

  useEffect(() => {
    if (!sendReview.open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const modal = reviewModalRef.current;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])'
    ].join(",");
    const getFocusableElements = (): HTMLElement[] =>
      Array.from(modal?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
        (element) => !element.hasAttribute("disabled") && element.offsetParent !== null
      );

    window.requestAnimationFrame(() => {
      const [firstFocusable] = getFocusableElements();
      (firstFocusable ?? modal)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSendReview();
        return;
      }

      if (event.key !== "Tab" || !modal) {
        return;
      }

      const focusableElements = getFocusableElements();

      if (focusableElements.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements.at(-1);

      if (!firstFocusable || !lastFocusable) {
        return;
      }

      if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        firstFocusable.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [closeSendReview, sendReview.open]);

  const collectGitDiff = useCallback(
    async (
      input: GitDiffCollectionRequest,
      options: { silent?: boolean } = {}
    ): Promise<GitDiffCollectionResponse | null> => {
      setGitDiffState((current) => ({
        ...current,
        loading: true,
        error: null
      }));

      try {
        const result = await window.ask.gitDiff.collect(input);

        if (!result.ok) {
          if (!options.silent) {
            setMessageStatus("warning");
            setMessage(result.error.message);
          }

          setGitDiffState((current) => ({
            ...current,
            loading: false,
            response: null,
            error: result.error.message
          }));
          return null;
        }

        setGitDiffState((current) => ({
          ...current,
          loading: false,
          response: result.data,
          error: null
        }));
        return result.data;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Git差分を収集できませんでした。";

        if (!options.silent) {
          setMessageStatus("warning");
          setMessage(`${errorMessage} 質問作成は継続できます。`);
        }

        setGitDiffState((current) => ({
          ...current,
          loading: false,
          response: null,
          error: errorMessage
        }));
        return null;
      }
    },
    []
  );

  const collectEnvironmentSnapshot = useCallback(
    async (
      input: EnvironmentSnapshotRequest,
      options: { silent?: boolean } = {}
    ): Promise<EnvironmentSnapshotResponse | null> => {
      setEnvironmentSnapshotState((current) => ({
        ...current,
        loading: true,
        error: null
      }));

      try {
        const result = await window.ask.environment.collectSnapshot(input);

        if (!result.ok) {
          if (!options.silent) {
            setMessageStatus("warning");
            setMessage(result.error.message);
          }

          setEnvironmentSnapshotState({
            loading: false,
            response: null,
            error: result.error.message
          });
          return null;
        }

        setEnvironmentSnapshotState({
          loading: false,
          response: result.data,
          error: null
        });
        return result.data;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "環境情報を収集できませんでした。";

        if (!options.silent) {
          setMessageStatus("warning");
          setMessage(`${errorMessage} 質問作成は継続できます。`);
        }

        setEnvironmentSnapshotState({
          loading: false,
          response: null,
          error: errorMessage
        });
        return null;
      }
    },
    []
  );

  const selectGitDiffRoot = async (): Promise<void> => {
    if (!selectedProject) {
      setMessageStatus("warning");
      setMessage("先にプロジェクトを選択してください。");
      return;
    }

    setGitDiffState((current) => ({
      ...current,
      loading: true,
      error: null
    }));

    try {
      const rootResult = await window.ask.project.selectRoot();

      if (!rootResult.ok) {
        setGitDiffState((current) => ({
          ...current,
          loading: false,
          error: rootResult.error.message
        }));
        setMessageStatus("warning");
        setMessage(rootResult.error.message);
        return;
      }

      if (!rootResult.data.selected || !rootResult.data.projectRootId) {
        setGitDiffState((current) => ({
          ...current,
          loading: false
        }));
        setMessageStatus("warning");
        setMessage("フォルダ選択をキャンセルしました。");
        return;
      }

      const inspectionResult = await window.ask.project.inspectGit({
        projectRootId: rootResult.data.projectRootId
      });

      if (!inspectionResult.ok) {
        setGitDiffState((current) => ({
          ...current,
          loading: false,
          selectedRoot: rootResult.data,
          error: inspectionResult.error.message
        }));
        setMessageStatus("warning");
        setMessage(inspectionResult.error.message);
        return;
      }

      const selectedHash = selectedProject.local_path_hash;
      const inspectionHash = inspectionResult.data.localPathHash;
      const repoMatches =
        !inspectionResult.data.normalizedGithubRepoUrl ||
        inspectionResult.data.normalizedGithubRepoUrl === selectedProject.github_repo_url;
      const hashMatches = !selectedHash || !inspectionHash || selectedHash === inspectionHash;

      setGitDiffState((current) => ({
        ...current,
        selectedRoot: rootResult.data,
        inspection: inspectionResult.data
      }));

      if (!inspectionResult.data.canRegister || !repoMatches || !hashMatches) {
        const mismatchMessage = !hashMatches
          ? "選択フォルダが登録済みプロジェクトのローカル識別子と一致しません。"
          : !repoMatches
            ? "選択フォルダが登録済みプロジェクトのGitHubリポジトリと一致しません。"
            : inspectionResult.data.message ||
              "選択フォルダは登録できません。検査結果を確認してください。";
        setGitDiffState((current) => ({
          ...current,
          loading: false,
          error: mismatchMessage
        }));
        setMessageStatus("warning");
        setMessage(mismatchMessage);
        return;
      }

      const diff = await collectGitDiff({
        projectRootId: rootResult.data.projectRootId
      });
      const environmentSnapshot = await collectEnvironmentSnapshot(
        {
          projectRootId: rootResult.data.projectRootId
        },
        { silent: true }
      );

      if (diff || environmentSnapshot) {
        const success =
          (diff?.status === "ready" || diff?.status === "empty" || !diff) &&
          (environmentSnapshot?.status === "ready" || !environmentSnapshot);
        setMessageStatus(success ? "success" : "warning");
        setMessage([diff?.message, environmentSnapshot?.message].filter(Boolean).join(" "));
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "ローカルフォルダを確認できませんでした。";
      setGitDiffState((current) => ({
        ...current,
        loading: false,
        error: errorMessage
      }));
      setMessageStatus("warning");
      setMessage(`${errorMessage} 質問作成は継続できます。`);
    }
  };

  const ensureGitDiffForSubmit = async (): Promise<GitDiffCollectionResponse | null> => {
    if (gitDiffState.response) {
      return gitDiffState.response;
    }

    if (!selectedProject?.local_path_hash) {
      return null;
    }

    return collectGitDiff(
      {
        localPathHash: selectedProject.local_path_hash
      },
      { silent: true }
    );
  };

  const ensureEnvironmentSnapshotForSubmit =
    async (): Promise<EnvironmentSnapshotResponse | null> => {
      if (environmentSnapshotState.response) {
        return environmentSnapshotState.response;
      }

      return collectEnvironmentSnapshot(
        {
          localPathHash: selectedProject?.local_path_hash ?? null
        },
        { silent: true }
      );
    };

  const collectEnvironmentForPreview = async (): Promise<void> => {
    const snapshot = await collectEnvironmentSnapshot({
      localPathHash: selectedProject?.local_path_hash ?? null
    });

    if (snapshot) {
      setMessageStatus(snapshot.status === "ready" ? "success" : "warning");
      setMessage(snapshot.message);
    }
  };

  const selectRelatedFiles = async (): Promise<void> => {
    if (!selectedProject) {
      setMessageStatus("warning");
      setMessage("先にプロジェクトを選択してください。");
      return;
    }

    setRelatedFileSnippetState((current) => ({
      ...current,
      loading: true,
      error: null,
      message: null
    }));

    try {
      const result = await window.ask.relatedFiles.select({
        localPathHash: selectedProject.local_path_hash
      });

      if (!result.ok) {
        setRelatedFileSnippetState((current) => ({
          ...current,
          loading: false,
          error: result.error.message,
          message: null
        }));
        setMessageStatus("warning");
        setMessage(result.error.message);
        return;
      }

      if (result.data.status === "canceled") {
        setRelatedFileSnippetState((current) => ({
          ...current,
          loading: false,
          message: null
        }));
        setMessageStatus("warning");
        setMessage(result.data.message);
        return;
      }

      setRelatedFileSnippetState((current) => {
        const snippetsByPath = new Map(
          current.snippets.map((snippet) => [snippet.relativePath, snippet])
        );

        for (const snippet of result.data.snippets) {
          snippetsByPath.set(snippet.relativePath, snippet);
        }

        return {
          loading: false,
          snippets: [...snippetsByPath.values()],
          error: result.data.status === "root_missing" ? result.data.message : null,
          message: result.data.message
        };
      });

      setSendReview((current) => ({
        ...current,
        excludedRelatedFiles: current.excludedRelatedFiles.filter((file) =>
          relatedFiles.includes(file)
        )
      }));
      setMessageStatus(result.data.status === "root_missing" ? "warning" : "success");
      setMessage(result.data.message);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "関連ファイルを選択できませんでした。";
      setRelatedFileSnippetState((current) => ({
        ...current,
        loading: false,
        error: errorMessage,
        message: null
      }));
      setMessageStatus("warning");
      setMessage(errorMessage);
    }
  };

  const generateAiAssist = async (task: ThreadCreateAiTask): Promise<void> => {
    if (!canReview || !selectedProject) {
      setMessageStatus(editableSecretScan.blocked ? "error" : "warning");
      setMessage(
        editableSecretScan.blocked
          ? "入力欄に秘密情報候補があります。AI には送信できません。"
          : "タイトル、質問内容、プロジェクトを確認してください。"
      );
      return;
    }

    if (task === "error_summary" && !errorText.trim()) {
      setMessageStatus("warning");
      setMessage("エラー要約にはエラー文を入力してください。");
      return;
    }

    void trackUsageEvent({
      eventName: "question_ai_assist_requested",
      projectId: selectedProject.id,
      properties: {
        task
      }
    });

    setAiAssistState({ loadingTask: task });
    setMessage(null);

    try {
      const [gitDiff, snapshot] = await Promise.all([
        ensureGitDiffForSubmit(),
        ensureEnvironmentSnapshotForSubmit()
      ]);
      const context = buildAiAssistContext({
        title,
        situation,
        errorText,
        commandText,
        relatedFiles: includedRelatedFiles,
        relatedSnippets: includedRelatedSnippets,
        gitDiff,
        environmentSnapshot: snapshot
      });
      const aiPayloadScan = scanAiAssistContextForSecrets(context);

      if (aiPayloadScan.blocked) {
        setMessageStatus("error");
        setMessage("秘密情報の可能性がある内容を検出したため、AI には送信しません。");
        return;
      }

      const request: AiAssistRequest = {
        task,
        projectId: selectedProject.id,
        context,
        options: {
          locale: "ja",
          maxOutputChars:
            task === "question_rewrite" ? 1_800 : task === "cause_candidates" ? 2_200 : 1_000,
          streaming: false
        }
      };
      const result = await window.ask.ai.generate(request);

      if (!result.ok) {
        setMessageStatus("warning");
        setMessage(result.error.message);
        return;
      }

      if (result.data.status === "blocked") {
        setMessageStatus("error");
        setMessage(result.data.fallback?.message ?? "AI 送信前の安全確認で停止しました。");
        return;
      }

      if (result.data.status === "fallback") {
        setMessageStatus("warning");
        setMessage(result.data.fallback?.message ?? "AI 応答を取得できませんでした。");
        return;
      }

      const outputText = result.data.output?.text.trim();

      if (!outputText) {
        setMessageStatus("warning");
        setMessage("AI 応答が空でした。手入力で質問作成を続けてください。");
        return;
      }

      setSendReview((current) => ({
        ...current,
        open: true,
        draftQuestion:
          task === "question_rewrite"
            ? outputText
            : current.draftQuestion.trim()
              ? current.draftQuestion
              : buildDefaultReviewDraft(),
        aiErrorSummary: task === "error_summary" ? outputText : current.aiErrorSummary,
        aiCauseCandidates: task === "cause_candidates" ? outputText : current.aiCauseCandidates,
        aiUsed: true,
        includeGitDiff: current.open ? current.includeGitDiff : Boolean(gitDiff),
        includeEnvironmentSnapshot: current.open
          ? current.includeEnvironmentSnapshot
          : Boolean(snapshot),
        excludedRelatedFiles: current.excludedRelatedFiles.filter((file) =>
          relatedFiles.includes(file)
        )
      }));
      setMessageStatus("success");
      setMessage(`${getAiTaskLabel(task)}を生成しました。送信前に内容を確認してください。`);
      void trackUsageEvent({
        eventName: "question_ai_assist_completed",
        projectId: selectedProject.id,
        success: true,
        properties: {
          task,
          output_chars: outputText.length
        }
      });
    } catch (error) {
      console.error("Failed to generate AI assist content", error);
      setMessageStatus("warning");
      setMessage("AI 補助を利用できませんでした。手入力で質問作成を続けてください。");
      void trackUsageEvent({
        eventName: "question_ai_assist_completed",
        projectId: selectedProject.id,
        success: false,
        errorCode: "ai_assist_failed",
        properties: {
          task
        }
      });
    } finally {
      setAiAssistState(initialAiAssistState);
    }
  };

  const gitDiffSummary = gitDiffState.loading
    ? "収集中"
    : gitDiffResponse
      ? gitDiffResponse.status === "ready"
        ? `${gitDiffResponse.changedFiles.length} ファイル`
        : gitDiffResponse.status === "empty"
          ? "差分なし"
          : "未収集"
      : "未収集";
  const gitDiffStatusMessage =
    gitDiffState.error ??
    gitDiffResponse?.message ??
    "ローカルフォルダを選択すると Git差分を収集します。";
  const gitDiffStatus = gitDiffState.error
    ? "warning"
    : gitDiffResponse?.status === "ready" || gitDiffResponse?.status === "empty"
      ? "success"
      : "warning";
  const environmentSummary = environmentSnapshotState.loading
    ? "収集中"
    : environmentSnapshot
      ? environmentSnapshot.status === "ready"
        ? "収集済み"
        : "一部収集"
      : "未収集";
  const environmentStatusMessage =
    environmentSnapshotState.error ??
    environmentSnapshot?.message ??
    "OS、runtime、package manager、依存関係概要を収集します。";
  const environmentStatus = environmentSnapshotState.error
    ? "warning"
    : environmentSnapshot?.status === "ready"
      ? "success"
      : "warning";
  const excludedItems = [
    ...blockedRelatedFiles.map((file) => `関連ファイル: ${file} (秘密情報候補)`),
    ...relatedSnippets
      .filter((snippet) => snippet.status !== "included")
      .map((snippet) => `関連ファイル: ${snippet.relativePath} (${snippet.message})`),
    ...sendReview.excludedRelatedFiles
      .filter((file) => !blockedRelatedFiles.includes(file))
      .map((file) => `関連ファイル: ${file}`),
    gitDiffResponse && !sendReview.includeGitDiff ? "Git差分" : null,
    environmentSnapshot && !sendReview.includeEnvironmentSnapshot ? "環境情報" : null
  ].filter((item): item is string => Boolean(item));
  const reviewPayloadPreview = buildInitialMessage({
    draftQuestion: sendReview.draftQuestion || buildDefaultReviewDraft(),
    aiErrorSummary: sendReview.aiErrorSummary,
    aiCauseCandidates: sendReview.aiCauseCandidates,
    aiUsed: sendReview.aiUsed,
    situation,
    errorText,
    commandText,
    relatedFiles: includedRelatedFiles,
    relatedSnippets: includedRelatedSnippets,
    secretScan,
    gitDiff: sendReview.includeGitDiff ? gitDiffResponse : null,
    environmentSnapshot: sendReview.includeEnvironmentSnapshot ? environmentSnapshot : null,
    excludedItems
  });

  const toggleRelatedFileExclusion = (file: string): void => {
    setSendReview((current) => {
      const excluded = new Set(current.excludedRelatedFiles);

      if (excluded.has(file)) {
        excluded.delete(file);
      } else {
        excluded.add(file);
      }

      return {
        ...current,
        excludedRelatedFiles: [...excluded]
      };
    });
  };

  const updateRelatedSnippetContent = (relativePath: string, content: string): void => {
    setRelatedFileSnippetState((current) => ({
      ...current,
      snippets: current.snippets.map((snippet) =>
        snippet.relativePath === relativePath ? { ...snippet, content } : snippet
      )
    }));
  };

  const openSendReview = async (): Promise<void> => {
    if (!canReview) {
      setMessageStatus(editableSecretScan.blocked ? "error" : "warning");
      setMessage(
        editableSecretScan.blocked
          ? "入力欄に秘密情報候補があります。送信前に本文を編集してください。"
          : "タイトル、質問内容、プロジェクトを確認してください。"
      );
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      const [gitDiff, snapshot] = await Promise.all([
        ensureGitDiffForSubmit(),
        ensureEnvironmentSnapshotForSubmit()
      ]);

      setSendReview((current) => ({
        ...current,
        open: true,
        draftQuestion: current.draftQuestion.trim()
          ? current.draftQuestion
          : buildDefaultReviewDraft(),
        includeGitDiff: Boolean(gitDiff),
        includeEnvironmentSnapshot: Boolean(snapshot),
        excludedRelatedFiles: current.excludedRelatedFiles.filter((file) =>
          relatedFiles.includes(file)
        )
      }));
    } finally {
      setSubmitting(false);
    }
  };
  const secretScanSummary = secretScan.blocked
    ? "送信停止"
    : secretScan.hasWarnings
      ? "確認が必要"
      : "通過";
  const aiAssistSummary = aiAssistState.loadingTask
    ? `${getAiTaskLabel(aiAssistState.loadingTask)}中`
    : sendReview.aiUsed
      ? "生成済み"
      : "未使用";
  const canGenerateAiAssist = canReview && aiAssistState.loadingTask === null;
  const secretFindingsForPreview = [...secretScan.activeFindings, ...secretScan.allowedFindings];

  const setSecretFindingAllowed = (findingId: string, allowed: boolean): void => {
    setAllowedSecretFindingIds((current) => {
      if (allowed) {
        return current.includes(findingId) ? current : [...current, findingId];
      }

      return current.filter((id) => id !== findingId);
    });
  };

  const submitThread = async (): Promise<void> => {
    if (!supabase || !profile) {
      setMessageStatus("error");
      setMessage("Supabase 設定またはプロフィールを確認できませんでした。");
      return;
    }

    if (profile.role !== "student") {
      setMessageStatus("warning");
      setMessage("質問作成は生徒アカウントで利用してください。");
      return;
    }

    if (!selectedProject) {
      setMessageStatus("warning");
      setMessage("先にプロジェクトを登録してください。");
      return;
    }

    if (!title.trim() || !situation.trim()) {
      setMessageStatus("warning");
      setMessage("タイトルと質問内容を入力してください。");
      return;
    }

    if (!sendReview.open) {
      setMessageStatus("warning");
      setMessage("送信前レビューで内容を確認してください。");
      return;
    }

    if (editableSecretScan.blocked || secretScan.blocked) {
      setMessageStatus("error");
      setMessage("秘密情報の可能性がある内容を検出したため送信を止めました。");
      return;
    }

    if (secretScan.hasWarnings) {
      setMessageStatus("warning");
      setMessage("低リスクの秘密情報候補を確認し、除外を許可してください。");
      return;
    }

    setSubmitting(true);
    setMessage(null);

    let createdThreadId: string | null = null;

    try {
      const [gitDiff, environmentSnapshotForSubmit] = await Promise.all([
        sendReview.includeGitDiff ? ensureGitDiffForSubmit() : Promise.resolve(null),
        sendReview.includeEnvironmentSnapshot
          ? ensureEnvironmentSnapshotForSubmit()
          : Promise.resolve(null)
      ]);
      const { data: thread, error: threadError } = await supabase
        .from("threads")
        .insert({
          project_id: selectedProject.id,
          created_by: profile.id,
          title: title.trim(),
          status: "open",
          priority: "normal",
          ai_used: sendReview.aiUsed
        })
        .select("id")
        .single();

      if (threadError) {
        throw threadError;
      }

      createdThreadId = thread.id;

      const body = buildInitialMessage({
        draftQuestion: sendReview.draftQuestion,
        aiErrorSummary: sendReview.aiErrorSummary,
        aiCauseCandidates: sendReview.aiCauseCandidates,
        aiUsed: sendReview.aiUsed,
        situation,
        errorText,
        commandText,
        relatedFiles: includedRelatedFiles,
        relatedSnippets: includedRelatedSnippets,
        secretScan,
        gitDiff,
        environmentSnapshot: environmentSnapshotForSubmit,
        excludedItems
      });

      const { error: messageError } = await supabase.from("messages").insert({
        thread_id: thread.id,
        sender_user_id: profile.id,
        sender_type: "student",
        body,
        message_type: "text"
      });

      if (messageError) {
        const { error: rollbackError } = await supabase
          .from("threads")
          .delete()
          .eq("id", thread.id);
        if (rollbackError) {
          console.error("Failed to roll back empty question thread", rollbackError);
        } else {
          createdThreadId = null;
        }
        throw messageError;
      }

      if (environmentSnapshotForSubmit) {
        const snapshotInsert: Database["public"]["Tables"]["environment_snapshots"]["Insert"] = {
          thread_id: thread.id,
          project_id: selectedProject.id,
          os_name: environmentSnapshotForSubmit.os.name,
          os_version: environmentSnapshotForSubmit.os.version,
          arch: environmentSnapshotForSubmit.os.arch,
          git_version: environmentSnapshotForSubmit.gitVersion,
          editor_name: environmentSnapshotForSubmit.editor.name,
          editor_version: environmentSnapshotForSubmit.editor.version,
          runtimes: environmentSnapshotForSubmit.runtimes as unknown as Json,
          package_managers: environmentSnapshotForSubmit.packageManagers as unknown as Json,
          dependencies_summary: environmentSnapshotForSubmit.dependenciesSummary as unknown as Json
        };
        const { error: snapshotError } = await supabase
          .from("environment_snapshots")
          .insert(snapshotInsert);

        if (snapshotError) {
          console.error("Failed to save environment snapshot", snapshotError);
        }
      }

      void trackUsageEvent({
        eventName: "question_submitted",
        classId: selectedProject.class_id,
        projectId: selectedProject.id,
        threadId: thread.id,
        success: true,
        properties: {
          ai_used: sendReview.aiUsed,
          included_git_diff: Boolean(gitDiff),
          included_environment_snapshot: Boolean(environmentSnapshotForSubmit),
          related_file_count: includedRelatedFiles.length,
          related_snippet_count: includedRelatedSnippets.length
        }
      });

      navigate(`/threads/${thread.id}`);
    } catch (error) {
      console.error("Failed to create question thread", error);
      if (createdThreadId) {
        const { error: rollbackError } = await supabase
          .from("threads")
          .delete()
          .eq("id", createdThreadId);
        if (rollbackError) {
          console.error("Failed to roll back empty question thread", rollbackError);
        }
      }
      setMessageStatus("error");
      setMessage(
        "質問スレッドを作成できませんでした。入力内容と参加中のクラスを確認してください。"
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (state.loading) {
    return (
      <ThreadCreateStatePage title="読み込み中" body="質問作成に必要な情報を確認しています。" />
    );
  }

  if (state.error) {
    return <ThreadCreateStatePage title="読み込みに失敗しました" body={state.error} />;
  }

  return (
    <section className="thread-create">
      <div className="page-header">
        <div>
          <p className="eyebrow">Question</p>
          <h1>質問を作成</h1>
          <p className="muted">必要な内容だけ入力して送信します。</p>
        </div>
        <p className="page-header-meta">
          {selectedProject?.name ?? `${state.projects.length} プロジェクト`}
        </p>
      </div>

      {state.projects.length === 0 ? (
        <article className="detail-panel">
          <h2>プロジェクト未登録</h2>
          <p className="muted">
            質問を作成する前に、GitHubリポジトリ付きのプロジェクトを登録してください。
          </p>
          <Link className="secondary-link" to="/projects">
            プロジェクト登録へ
          </Link>
        </article>
      ) : (
        <div className="thread-create-grid">
          <article className="detail-panel thread-form-panel">
            <div>
              <p className="eyebrow">Input</p>
              <h2>質問内容</h2>
            </div>

            {projectLocked ? null : (
              <label>
                プロジェクト
                <select
                  value={selectedProjectId}
                  onChange={(event) => {
                    setSelectedProjectId(event.target.value);
                    setGitDiffState(initialGitDiffState);
                    setEnvironmentSnapshotState(initialEnvironmentSnapshotState);
                    setRelatedFileSnippetState(initialRelatedFileSnippetState);
                    setSendReview(initialSendReviewState);
                    setAllowedSecretFindingIds([]);
                  }}
                >
                  {state.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label>
              タイトル
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>

            <label>
              質問内容
              <textarea
                rows={5}
                value={situation}
                onChange={(event) => setSituation(event.target.value)}
              />
            </label>

            <label>
              エラー文
              <textarea
                rows={4}
                value={errorText}
                onChange={(event) => setErrorText(event.target.value)}
              />
            </label>

            <label>
              実行コマンド
              <textarea
                rows={3}
                value={commandText}
                onChange={(event) => setCommandText(event.target.value)}
              />
            </label>

            <label>
              関連ファイル
              <textarea
                rows={4}
                value={relatedFilesText}
                onChange={(event) => setRelatedFilesText(event.target.value)}
              />
            </label>
            <div className="related-file-picker">
              <button
                className="secondary-button"
                disabled={relatedFileSnippetState.loading || !selectedProject}
                type="button"
                onClick={() => void selectRelatedFiles()}
              >
                {relatedFileSnippetState.loading ? "関連ファイルを確認中..." : "関連ファイルを選択"}
              </button>
            </div>
          </article>

          <aside className="detail-panel thread-preview-panel">
            <div>
              <p className="eyebrow">Preview</p>
              <h2>送信前チェック</h2>
            </div>

            <div className="project-summary-list">
              <span>Git差分</span>
              <strong>{gitDiffSummary}</strong>
              <span>ブランチ</span>
              <strong>
                {gitDiffResponse?.branch ?? selectedProject?.default_branch ?? "未取得"}
              </strong>
              <span>最新コミット</span>
              <strong>{gitDiffResponse?.headShortCommit ?? "未取得"}</strong>
              <span>環境情報</span>
              <strong>{environmentSummary}</strong>
              <span>OS</span>
              <strong>
                {environmentSnapshot
                  ? `${environmentSnapshot.os.name} ${environmentSnapshot.os.version}`
                  : "未取得"}
              </strong>
              <span>Node</span>
              <strong>{environmentSnapshot?.runtimes.node.version ?? "未取得"}</strong>
              <span>AI補助</span>
              <strong>{aiAssistSummary}</strong>
              <span>秘密情報チェック</span>
              <strong>{secretScanSummary}</strong>
              <span>関連ファイル</span>
              <strong>
                {includedRelatedFiles.length} 件 / 除外 {excludedRelatedFileSet.size} 件
              </strong>
              <span>スニペット</span>
              <strong>
                {includedRelatedSnippets.length} 件 / 除外{" "}
                {relatedSnippets.length - includedRelatedSnippets.length} 件
              </strong>
            </div>

            <div className="git-diff-controls">
              <button
                className="secondary-button"
                disabled={gitDiffState.loading || !selectedProject}
                type="button"
                onClick={() => void selectGitDiffRoot()}
              >
                {gitDiffState.loading ? "Git差分を確認中..." : "ローカルフォルダを選択"}
              </button>
              <p className={`message ${gitDiffStatus}`} role="status">
                {gitDiffStatusMessage}
              </p>
              {gitDiffResponse?.sensitiveFilePaths.length ? (
                <p className="message warning" role="status">
                  秘密情報候補: {gitDiffResponse.sensitiveFilePaths.join(", ")}
                </p>
              ) : null}
            </div>

            <div className="git-diff-controls">
              <button
                className="secondary-button"
                disabled={environmentSnapshotState.loading}
                type="button"
                onClick={() => void collectEnvironmentForPreview()}
              >
                {environmentSnapshotState.loading ? "環境情報を確認中..." : "環境情報を確認"}
              </button>
              <p className={`message ${environmentStatus}`} role="status">
                {environmentStatusMessage}
              </p>
            </div>

            <div className="git-diff-controls">
              <div className="ai-assist-actions">
                <button
                  className="secondary-button"
                  disabled={!canGenerateAiAssist}
                  type="button"
                  onClick={() => void generateAiAssist("question_rewrite")}
                >
                  {aiAssistState.loadingTask === "question_rewrite"
                    ? "質問文を整理中..."
                    : "AIで質問文を整理"}
                </button>
                <button
                  className="secondary-button"
                  disabled={!canGenerateAiAssist || !errorText.trim()}
                  type="button"
                  onClick={() => void generateAiAssist("error_summary")}
                >
                  {aiAssistState.loadingTask === "error_summary"
                    ? "エラー要約を生成中..."
                    : "AIでエラー要約"}
                </button>
                <button
                  className="secondary-button"
                  disabled={!canGenerateAiAssist}
                  type="button"
                  onClick={() => void generateAiAssist("cause_candidates")}
                >
                  {aiAssistState.loadingTask === "cause_candidates"
                    ? "原因候補を生成中..."
                    : "AIで原因候補"}
                </button>
              </div>
              <p className="message warning" role="status">
                AI 出力は補助情報です。送信前に編集してください。
              </p>
            </div>

            {editableSecretScan.blocked && (
              <p className="message error" role="alert">
                送信不可:{" "}
                {editableSecretScan.blockedFindings.map((finding) => finding.message).join(", ")}
              </p>
            )}

            {blockedRelatedFiles.length > 0 && (
              <p className="message warning" role="status">
                送信から除外する関連ファイル: {blockedRelatedFiles.join(", ")}
              </p>
            )}

            {relatedFileSnippetState.error ? (
              <p className="message warning" role="status">
                {relatedFileSnippetState.error}
                {selectedProject ? (
                  <>
                    {" "}
                    <Link to={`/projects/${selectedProject.id}`}>ローカルフォルダを再接続</Link>
                  </>
                ) : null}
              </p>
            ) : relatedFileSnippetState.message ? (
              <p className="message success" role="status">
                {relatedFileSnippetState.message}
              </p>
            ) : null}

            {relatedSnippets.length > 0 ? (
              <div className="related-snippet-list" aria-label="関連ファイルスニペット">
                {relatedSnippets.map((snippet) => {
                  const excluded = excludedRelatedFileSet.has(snippet.relativePath);

                  return (
                    <section
                      className={`related-snippet-card ${snippet.status}`}
                      key={snippet.relativePath}
                    >
                      <div className="related-snippet-header">
                        <strong>{snippet.relativePath}</strong>
                        <span>{excluded ? "除外" : "送信"}</span>
                      </div>
                      <p
                        className={
                          snippet.status === "included" ? "muted compact" : "message warning"
                        }
                      >
                        {snippet.message}
                      </p>
                      {snippet.status === "included" && !excluded ? (
                        <CodeContextViewer
                          content={snippet.content}
                          kind="code"
                          language={snippet.language}
                          maxVisibleLines={30}
                        />
                      ) : null}
                    </section>
                  );
                })}
              </div>
            ) : null}

            {secretFindingsForPreview.length > 0 && (
              <div className="secret-finding-list" role="group" aria-label="秘密情報チェック結果">
                {secretFindingsForPreview.map((finding) =>
                  finding.canAllow ? (
                    <label className="secret-finding-item warning" key={finding.id}>
                      <input
                        checked={allowedSecretFindingIds.includes(finding.id)}
                        type="checkbox"
                        onChange={(event) =>
                          setSecretFindingAllowed(finding.id, event.target.checked)
                        }
                      />
                      <span>
                        {formatSecretFindingForUi(finding)}
                        <small>{finding.preview}</small>
                      </span>
                    </label>
                  ) : (
                    <div className="secret-finding-item error" key={finding.id}>
                      <strong>{formatSecretFindingForUi(finding)}</strong>
                      <small>{finding.preview}</small>
                    </div>
                  )
                )}
              </div>
            )}

            {missingRequiredFields && (
              <p className="message warning" role="status">
                タイトル、質問内容、プロジェクトを確認してください。
              </p>
            )}

            <button
              className="primary-button"
              disabled={!canReview}
              type="button"
              onClick={() => void openSendReview()}
            >
              {submitting ? "確認中..." : "送信前プレビュー"}
            </button>

            {message && (
              <p
                className={`message ${messageStatus}`}
                role={messageStatus === "error" ? "alert" : "status"}
              >
                {message}
              </p>
            )}
          </aside>
        </div>
      )}

      {sendReview.open && (
        <div className="review-modal-backdrop" role="presentation">
          <div
            ref={reviewModalRef}
            aria-labelledby="send-review-title"
            aria-modal="true"
            className="review-modal"
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div>
                <p className="eyebrow">Review</p>
                <h2 id="send-review-title">送信前プレビュー</h2>
              </div>
              <button
                className="secondary-button"
                disabled={submitting}
                type="button"
                onClick={closeSendReview}
              >
                閉じる
              </button>
            </header>

            <label>
              質問文（編集可）
              <textarea
                rows={5}
                value={sendReview.draftQuestion}
                onChange={(event) =>
                  setSendReview((current) => ({
                    ...current,
                    draftQuestion: event.target.value
                  }))
                }
              />
            </label>

            {sendReview.aiErrorSummary.trim() ? (
              <label>
                AIエラー要約（編集可）
                <textarea
                  rows={4}
                  value={sendReview.aiErrorSummary}
                  onChange={(event) =>
                    setSendReview((current) => ({
                      ...current,
                      aiErrorSummary: event.target.value
                    }))
                  }
                />
              </label>
            ) : null}

            {sendReview.aiCauseCandidates.trim() ? (
              <label>
                AI原因候補と次の確認（編集可）
                <textarea
                  rows={6}
                  value={sendReview.aiCauseCandidates}
                  onChange={(event) =>
                    setSendReview((current) => ({
                      ...current,
                      aiCauseCandidates: event.target.value
                    }))
                  }
                />
              </label>
            ) : null}

            <div className="review-grid">
              <section className="review-section">
                <h3>関連ファイル</h3>
                {relatedFiles.length === 0 ? (
                  <p className="muted">未選択</p>
                ) : (
                  <div className="review-check-list">
                    {relatedFiles.map((file) => {
                      const blocked =
                        blockedRelatedFiles.includes(file) ||
                        unavailableRelatedSnippetPaths.includes(file);
                      const excluded = excludedRelatedFileSet.has(file);

                      return (
                        <label className="review-check-row" key={file}>
                          <input
                            checked={!excluded}
                            disabled={blocked}
                            type="checkbox"
                            onChange={() => toggleRelatedFileExclusion(file)}
                          />
                          <span>{file}</span>
                          <strong>{blocked ? "ブロック" : excluded ? "除外" : "送信"}</strong>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="review-section">
                <h3>収集情報</h3>
                <label className="review-check-row">
                  <input
                    checked={sendReview.includeGitDiff}
                    disabled={!gitDiffResponse}
                    type="checkbox"
                    onChange={() =>
                      setSendReview((current) => ({
                        ...current,
                        includeGitDiff: !current.includeGitDiff
                      }))
                    }
                  />
                  <span>Git diff</span>
                  <strong>{gitDiffResponse ? gitDiffSummary : "未収集"}</strong>
                </label>
                <label className="review-check-row">
                  <input
                    checked={sendReview.includeEnvironmentSnapshot}
                    disabled={!environmentSnapshot}
                    type="checkbox"
                    onChange={() =>
                      setSendReview((current) => ({
                        ...current,
                        includeEnvironmentSnapshot: !current.includeEnvironmentSnapshot
                      }))
                    }
                  />
                  <span>環境情報</span>
                  <strong>{environmentSummary}</strong>
                </label>
              </section>

              <section className="review-section">
                <h3>秘密情報チェック</h3>
                <p
                  className={`message ${
                    secretScan.blocked ? "error" : secretScan.hasWarnings ? "warning" : "success"
                  }`}
                >
                  {secretScan.blocked
                    ? `ブロック: ${secretScan.blockedFindings.map((finding) => finding.message).join(", ")}`
                    : secretScan.hasWarnings
                      ? "低リスクの秘密情報候補があります。送信する場合は許可してください。"
                      : "送信対象に秘密情報候補はありません。"}
                </p>
                {secretFindingsForPreview.length > 0 && (
                  <div
                    className="secret-finding-list"
                    role="group"
                    aria-label="送信前秘密情報チェック結果"
                  >
                    {secretFindingsForPreview.map((finding) =>
                      finding.canAllow ? (
                        <label className="secret-finding-item warning" key={finding.id}>
                          <input
                            checked={allowedSecretFindingIds.includes(finding.id)}
                            type="checkbox"
                            onChange={(event) =>
                              setSecretFindingAllowed(finding.id, event.target.checked)
                            }
                          />
                          <span>
                            {formatSecretFindingForUi(finding)}
                            <small>{finding.preview}</small>
                          </span>
                        </label>
                      ) : (
                        <div className="secret-finding-item error" key={finding.id}>
                          <strong>{formatSecretFindingForUi(finding)}</strong>
                          <small>{finding.preview}</small>
                        </div>
                      )
                    )}
                  </div>
                )}
              </section>
            </div>

            {relatedSnippets.length > 0 ? (
              <section className="review-section related-snippet-editor">
                <h3>関連ファイルスニペット</h3>
                <div className="related-snippet-list">
                  {relatedSnippets.map((snippet) => {
                    const excluded = excludedRelatedFileSet.has(snippet.relativePath);

                    return (
                      <article
                        className={`related-snippet-card ${snippet.status}`}
                        key={snippet.relativePath}
                      >
                        <label className="review-check-row">
                          <input
                            checked={!excluded}
                            disabled={snippet.status !== "included"}
                            type="checkbox"
                            onChange={() => toggleRelatedFileExclusion(snippet.relativePath)}
                          />
                          <span>{snippet.relativePath}</span>
                          <strong>
                            {snippet.status === "included" ? (excluded ? "除外" : "送信") : "除外"}
                          </strong>
                        </label>
                        <p
                          className={
                            snippet.status === "included" ? "muted compact" : "message warning"
                          }
                        >
                          {snippet.message}
                        </p>
                        {snippet.status === "included" ? (
                          <textarea
                            aria-label={`${snippet.relativePath} のスニペット本文`}
                            disabled={excluded}
                            rows={8}
                            value={snippet.content}
                            onChange={(event) =>
                              updateRelatedSnippetContent(snippet.relativePath, event.target.value)
                            }
                          />
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section className="review-section">
              <h3>最終 payload</h3>
              <pre className="review-payload-preview">{reviewPayloadPreview}</pre>
            </section>

            <footer>
              <button
                className="secondary-button"
                disabled={submitting}
                type="button"
                onClick={closeSendReview}
              >
                戻って編集
              </button>
              <button
                className="primary-button"
                disabled={
                  submitting ||
                  secretScan.blocked ||
                  secretScan.hasWarnings ||
                  !sendReview.draftQuestion.trim()
                }
                type="button"
                onClick={() => void submitThread()}
              >
                {submitting ? "作成中..." : "確認して送信"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
};

const ThreadCreateStatePage = ({ title, body }: { title: string; body: string }): ReactElement => (
  <section className="empty-state">
    <h1>{title}</h1>
    <p>{body}</p>
  </section>
);
