import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import {
  IpcChannel,
  type AppRuntimeInfoResponse,
  type EnvironmentSnapshotRequest,
  type EnvironmentSnapshotResponse,
  type GitDiffCollectionRequest,
  type GitDiffCollectionResponse,
  type GitignoreApplyRequest,
  type GitignoreApplyResponse,
  type GitignorePreviewRequest,
  type GitignorePreviewResponse,
  type IpcAuditMetadata,
  type IpcChannelName,
  type IpcResult,
  type LocalDiagnosticsResponse,
  type PatchApplyRequest,
  type PatchApplyResponse,
  type PatchRevertRequest,
  type PatchRevertResponse,
  type PatchValidateRequest,
  type PatchValidateResponse,
  type ProjectGitInspectionRequest,
  type ProjectGitInspectionResponse,
  type ProjectRootReconnectRequest,
  type ProjectRootReconnectResponse,
  type ProjectRootSelectionResponse,
  type RelatedFileSelectionRequest,
  type RelatedFileSelectionResponse
} from "../shared/ipc";
import {
  AI_PIPELINE_LIMITS,
  getAiAssistRequestLimitViolation,
  isAiAssistTask,
  isAiContextKind,
  type AiAssistRequest,
  type AiAssistResponse
} from "../shared/aiPipeline";
import { runAiAssistPipeline } from "./aiPipeline";
import { collectEnvironmentSnapshot } from "./environmentSnapshotCollector";
import { collectGitDiff } from "./gitDiffCollector";
import { applyGitignore, previewGitignore } from "./gitignoreWorkflow";
import { runLocalDiagnostics } from "./localDiagnostics";
import { applyPatch, revertPatch, validatePatch } from "./patchWorkflow";
import { inspectProjectGit } from "./projectGitInspector";
import { reconnectProjectRoot } from "./projectRootReconnect";
import { selectProjectRoot } from "./projectRoots";
import {
  collectRelatedFileSnippets,
  createRelatedFileCanceledResponse,
  resolveRelatedFileProjectRoot
} from "./relatedFileSnippets";

const createMetadata = (channel: IpcChannelName): IpcAuditMetadata => ({
  channel,
  requestedAt: new Date().toISOString(),
  requestId: randomUUID()
});

const ok = <T>(channel: IpcChannelName, data: T): IpcResult<T> => ({
  ok: true,
  data,
  meta: createMetadata(channel)
});

const fail = <T>(channel: IpcChannelName, code: string, message: string): IpcResult<T> => ({
  ok: false,
  error: {
    code,
    message,
    retryable: false
  },
  meta: createMetadata(channel)
});

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getSafeErrorFields = (error: unknown): { code?: string; message: string } => {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : "Unknown error";

  return code ? { code, message } : { message };
};

const isGitignorePreviewRequest = (value: unknown): value is GitignorePreviewRequest => {
  return (
    isRecord(value) && typeof value.projectRootId === "string" && value.projectRootId.length > 0
  );
};

const isAiAssistRequest = (value: unknown): value is AiAssistRequest => {
  if (!isRecord(value) || !isAiAssistTask(value.task) || !Array.isArray(value.context)) {
    return false;
  }

  const options = value.options;
  const hasValidOptions =
    options === undefined ||
    (isRecord(options) &&
      (options.locale === undefined || options.locale === "ja" || options.locale === "en") &&
      (options.maxOutputChars === undefined ||
        (typeof options.maxOutputChars === "number" &&
          Number.isFinite(options.maxOutputChars) &&
          options.maxOutputChars > 0 &&
          options.maxOutputChars <= AI_PIPELINE_LIMITS.maxOutputChars)) &&
      (options.streaming === undefined || typeof options.streaming === "boolean"));
  const hasValidIds =
    (value.projectId === undefined ||
      value.projectId === null ||
      typeof value.projectId === "string") &&
    (value.threadId === undefined || value.threadId === null || typeof value.threadId === "string");

  if (!hasValidOptions || !hasValidIds) {
    return false;
  }

  const hasValidContext = value.context.every((entry) => {
    return (
      isRecord(entry) &&
      typeof entry.label === "string" &&
      entry.label.trim().length > 0 &&
      isAiContextKind(entry.kind) &&
      typeof entry.value === "string"
    );
  });

  if (!hasValidContext) {
    return false;
  }

  return (
    getAiAssistRequestLimitViolation({
      task: value.task,
      context: value.context as AiAssistRequest["context"],
      options: value.options as AiAssistRequest["options"],
      projectId: value.projectId as AiAssistRequest["projectId"],
      threadId: value.threadId as AiAssistRequest["threadId"]
    }) === null
  );
};

const isProjectGitInspectionRequest = (value: unknown): value is ProjectGitInspectionRequest => {
  return (
    isRecord(value) &&
    typeof value.projectRootId === "string" &&
    value.projectRootId.trim().length > 0
  );
};

const isProjectRootReconnectRequest = (value: unknown): value is ProjectRootReconnectRequest => {
  return (
    isRecord(value) &&
    typeof value.projectRootId === "string" &&
    value.projectRootId.trim().length > 0 &&
    typeof value.expectedLocalPathHash === "string" &&
    /^[a-f0-9]{64}$/i.test(value.expectedLocalPathHash) &&
    typeof value.expectedGithubRepoUrl === "string" &&
    value.expectedGithubRepoUrl.startsWith("https://github.com/") &&
    value.expectedGithubRepoUrl.length <= 300
  );
};

const isRelatedFileSelectionRequest = (value: unknown): value is RelatedFileSelectionRequest => {
  return (
    isRecord(value) &&
    (value.localPathHash === null ||
      (typeof value.localPathHash === "string" && /^[a-f0-9]{64}$/i.test(value.localPathHash)))
  );
};

const isGitDiffCollectionRequest = (value: unknown): value is GitDiffCollectionRequest => {
  return (
    isRecord(value) &&
    (typeof value.projectRootId === "string" ||
      typeof value.localPathHash === "string" ||
      value.localPathHash === null)
  );
};

const isEnvironmentSnapshotRequest = (value: unknown): value is EnvironmentSnapshotRequest => {
  return (
    isRecord(value) &&
    (typeof value.projectRootId === "string" ||
      typeof value.localPathHash === "string" ||
      value.localPathHash === null)
  );
};

const isAppRole = (value: unknown): value is PatchValidateRequest["requesterRole"] => {
  return value === "student" || value === "teacher" || value === "admin";
};

const getPatchRequesterRole = (value: unknown): PatchValidateRequest["requesterRole"] | null => {
  return isRecord(value) && isAppRole(value.requesterRole) ? value.requesterRole : null;
};

const isPatchValidateRequest = (value: unknown): value is PatchValidateRequest => {
  return (
    isRecord(value) &&
    isAppRole(value.requesterRole) &&
    (typeof value.localPathHash === "string" || value.localPathHash === null) &&
    typeof value.patchText === "string" &&
    value.patchText.length > 0 &&
    value.patchText.length <= 500_000 &&
    (value.expectedBaseCommit === undefined ||
      value.expectedBaseCommit === null ||
      (typeof value.expectedBaseCommit === "string" &&
        value.expectedBaseCommit.trim().length <= 64)) &&
    (value.patchProposalId === undefined ||
      value.patchProposalId === null ||
      (typeof value.patchProposalId === "string" && /^[0-9a-f-]{36}$/i.test(value.patchProposalId)))
  );
};

const isPatchApplyRequest = (value: unknown): value is PatchApplyRequest => {
  return (
    isRecord(value) &&
    isAppRole(value.requesterRole) &&
    typeof value.patchId === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.patchId) &&
    typeof value.confirmationToken === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.confirmationToken)
  );
};

const isPatchRevertRequest = (value: unknown): value is PatchRevertRequest => {
  return (
    isRecord(value) &&
    isAppRole(value.requesterRole) &&
    (typeof value.localPathHash === "string" || value.localPathHash === null) &&
    typeof value.patchId === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.patchId) &&
    (typeof value.backupDirectory === "string" || value.backupDirectory === null)
  );
};

const isGitignoreApplyRequest = (value: unknown): value is GitignoreApplyRequest => {
  return (
    isRecord(value) &&
    isGitignorePreviewRequest(value) &&
    typeof value.recommendationHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.recommendationHash)
  );
};

export const registerIpcHandlers = (): void => {
  ipcMain.handle(IpcChannel.AppGetRuntimeInfo, () => {
    try {
      return ok(IpcChannel.AppGetRuntimeInfo, {
        contractVersion: "v1",
        appVersion: app.getVersion(),
        platform: process.platform,
        isPackaged: app.isPackaged
      } satisfies AppRuntimeInfoResponse);
    } catch {
      return fail(
        IpcChannel.AppGetRuntimeInfo,
        "APP_RUNTIME_INFO_FAILED",
        "アプリ状態を確認できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.DiagnosticsRunLocal, async () => {
    try {
      return ok(
        IpcChannel.DiagnosticsRunLocal,
        (await runLocalDiagnostics()) satisfies LocalDiagnosticsResponse
      );
    } catch {
      return fail(
        IpcChannel.DiagnosticsRunLocal,
        "LOCAL_DIAGNOSTICS_FAILED",
        "ローカル開発環境の診断を実行できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.AiGenerate, async (_event, input) => {
    try {
      if (!isAiAssistRequest(input)) {
        return fail(
          IpcChannel.AiGenerate,
          "VALIDATION_FAILED",
          "AI リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.AiGenerate,
        (await runAiAssistPipeline(input)) satisfies AiAssistResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.AiGenerate}] AI pipeline failed`, {
        event: "ai_pipeline_failed",
        ...getSafeErrorFields(error)
      });

      return fail(
        IpcChannel.AiGenerate,
        "AI_PIPELINE_FAILED",
        "AI 補助を利用できませんでした。質問作成は継続できます。"
      );
    }
  });

  ipcMain.handle(IpcChannel.ProjectSelectRoot, async (event) => {
    try {
      return ok(
        IpcChannel.ProjectSelectRoot,
        (await selectProjectRoot(
          BrowserWindow.fromWebContents(event.sender)
        )) satisfies ProjectRootSelectionResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.ProjectSelectRoot}] project root selection failed`, error);

      return fail(
        IpcChannel.ProjectSelectRoot,
        "PROJECT_ROOT_SELECT_FAILED",
        "プロジェクトフォルダを選択できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.ProjectInspectGit, async (_event, input) => {
    try {
      if (!isProjectGitInspectionRequest(input)) {
        return fail(
          IpcChannel.ProjectInspectGit,
          "VALIDATION_FAILED",
          "プロジェクト検証リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.ProjectInspectGit,
        (await inspectProjectGit(input)) satisfies ProjectGitInspectionResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.ProjectInspectGit}] project git inspection failed`, error);

      if (error instanceof Error && error.message === "PROJECT_ROOT_NOT_FOUND") {
        return fail(
          IpcChannel.ProjectInspectGit,
          "PROJECT_ROOT_NOT_FOUND",
          "プロジェクトフォルダを選択し直してください。"
        );
      }

      return fail(
        IpcChannel.ProjectInspectGit,
        "PROJECT_GIT_INSPECTION_FAILED",
        "プロジェクトフォルダを検証できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.ProjectReconnectRoot, async (_event, input) => {
    try {
      if (!isProjectRootReconnectRequest(input)) {
        return fail(
          IpcChannel.ProjectReconnectRoot,
          "VALIDATION_FAILED",
          "プロジェクト再接続リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.ProjectReconnectRoot,
        (await reconnectProjectRoot(input)) satisfies ProjectRootReconnectResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.ProjectReconnectRoot}] project root reconnect failed`, error);

      return fail(
        IpcChannel.ProjectReconnectRoot,
        "PROJECT_ROOT_RECONNECT_FAILED",
        "ローカルフォルダを再接続できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.RelatedFilesSelect, async (event, input) => {
    try {
      if (!isRelatedFileSelectionRequest(input)) {
        return fail(
          IpcChannel.RelatedFilesSelect,
          "VALIDATION_FAILED",
          "関連ファイル選択リクエストが正しくありません。"
        );
      }

      const root = await resolveRelatedFileProjectRoot(input);

      if (!root) {
        return ok(
          IpcChannel.RelatedFilesSelect,
          (await collectRelatedFileSnippets(input, [])) satisfies RelatedFileSelectionResponse
        );
      }

      const dialogOptions: OpenDialogOptions = {
        title: "ASK 関連ファイルを選択",
        buttonLabel: "スニペット候補に追加",
        defaultPath: root.rootPath,
        properties: ["openFile", "multiSelections"]
      };
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled || result.filePaths.length === 0) {
        return ok(
          IpcChannel.RelatedFilesSelect,
          createRelatedFileCanceledResponse(root) satisfies RelatedFileSelectionResponse
        );
      }

      return ok(
        IpcChannel.RelatedFilesSelect,
        (await collectRelatedFileSnippets(
          input,
          result.filePaths,
          root
        )) satisfies RelatedFileSelectionResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.RelatedFilesSelect}] related file selection failed`, error);

      return fail(
        IpcChannel.RelatedFilesSelect,
        "RELATED_FILES_SELECT_FAILED",
        "関連ファイルを選択できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.GitDiffCollect, async (_event, input) => {
    try {
      if (!isGitDiffCollectionRequest(input)) {
        return fail(
          IpcChannel.GitDiffCollect,
          "VALIDATION_FAILED",
          "Git差分収集リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.GitDiffCollect,
        (await collectGitDiff(input)) satisfies GitDiffCollectionResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.GitDiffCollect}] git diff collection failed`, error);

      return fail(
        IpcChannel.GitDiffCollect,
        "GIT_DIFF_COLLECT_FAILED",
        "Git差分を収集できませんでした。質問作成は継続できます。"
      );
    }
  });

  ipcMain.handle(IpcChannel.EnvironmentSnapshotCollect, async (_event, input) => {
    try {
      if (!isEnvironmentSnapshotRequest(input)) {
        return fail(
          IpcChannel.EnvironmentSnapshotCollect,
          "VALIDATION_FAILED",
          "環境情報収集リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.EnvironmentSnapshotCollect,
        (await collectEnvironmentSnapshot(input)) satisfies EnvironmentSnapshotResponse
      );
    } catch (error) {
      console.error(
        `[${IpcChannel.EnvironmentSnapshotCollect}] environment snapshot collection failed`,
        error
      );

      return fail(
        IpcChannel.EnvironmentSnapshotCollect,
        "ENVIRONMENT_SNAPSHOT_COLLECT_FAILED",
        "環境情報を収集できませんでした。質問作成は継続できます。"
      );
    }
  });

  ipcMain.handle(IpcChannel.PatchValidate, async (_event, input) => {
    try {
      if (getPatchRequesterRole(input) !== "student") {
        return fail(
          IpcChannel.PatchValidate,
          "UNAUTHORIZED",
          "パッチ確認は生徒のローカル環境からのみ実行できます。"
        );
      }

      if (!isPatchValidateRequest(input)) {
        return fail(
          IpcChannel.PatchValidate,
          "VALIDATION_FAILED",
          "パッチ確認リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.PatchValidate,
        (await validatePatch(input)) satisfies PatchValidateResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.PatchValidate}] patch validation failed`, {
        event: "patch_validation_failed",
        ...getSafeErrorFields(error)
      });

      return fail(
        IpcChannel.PatchValidate,
        "PATCH_VALIDATE_FAILED",
        "パッチを確認できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.PatchApply, async (_event, input) => {
    try {
      if (getPatchRequesterRole(input) !== "student") {
        return fail(
          IpcChannel.PatchApply,
          "UNAUTHORIZED",
          "パッチ適用は生徒のローカル環境からのみ実行できます。"
        );
      }

      if (!isPatchApplyRequest(input)) {
        return fail(
          IpcChannel.PatchApply,
          "VALIDATION_FAILED",
          "パッチ適用リクエストが正しくありません。"
        );
      }

      return ok(IpcChannel.PatchApply, (await applyPatch(input)) satisfies PatchApplyResponse);
    } catch (error) {
      console.error(`[${IpcChannel.PatchApply}] patch apply failed`, {
        event: "patch_apply_failed",
        ...getSafeErrorFields(error)
      });

      return fail(IpcChannel.PatchApply, "PATCH_APPLY_FAILED", "パッチを適用できませんでした。");
    }
  });

  ipcMain.handle(IpcChannel.PatchRevert, async (_event, input) => {
    try {
      if (getPatchRequesterRole(input) !== "student") {
        return fail(
          IpcChannel.PatchRevert,
          "UNAUTHORIZED",
          "パッチの取り消しは生徒のローカル環境からのみ実行できます。"
        );
      }

      if (!isPatchRevertRequest(input)) {
        return fail(
          IpcChannel.PatchRevert,
          "VALIDATION_FAILED",
          "パッチ取り消しリクエストが正しくありません。"
        );
      }

      return ok(IpcChannel.PatchRevert, (await revertPatch(input)) satisfies PatchRevertResponse);
    } catch (error) {
      console.error(`[${IpcChannel.PatchRevert}] patch revert failed`, {
        event: "patch_revert_failed",
        ...getSafeErrorFields(error)
      });

      return fail(IpcChannel.PatchRevert, "PATCH_REVERT_FAILED", "パッチを取り消せませんでした。");
    }
  });

  ipcMain.handle(IpcChannel.GitignorePreview, async (_event, input) => {
    try {
      if (!isGitignorePreviewRequest(input)) {
        return fail(
          IpcChannel.GitignorePreview,
          "VALIDATION_FAILED",
          ".gitignore 確認リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.GitignorePreview,
        (await previewGitignore(input)) satisfies GitignorePreviewResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.GitignorePreview}] gitignore preview failed`, error);

      return fail(
        IpcChannel.GitignorePreview,
        "GITIGNORE_PREVIEW_FAILED",
        ".gitignore の推奨内容を確認できませんでした。"
      );
    }
  });

  ipcMain.handle(IpcChannel.GitignoreApply, async (_event, input) => {
    try {
      if (!isGitignoreApplyRequest(input)) {
        return fail(
          IpcChannel.GitignoreApply,
          "VALIDATION_FAILED",
          ".gitignore 更新リクエストが正しくありません。"
        );
      }

      return ok(
        IpcChannel.GitignoreApply,
        (await applyGitignore(input)) satisfies GitignoreApplyResponse
      );
    } catch (error) {
      console.error(`[${IpcChannel.GitignoreApply}] gitignore apply failed`, error);

      return fail(
        IpcChannel.GitignoreApply,
        "GITIGNORE_APPLY_FAILED",
        ".gitignore を更新できませんでした。"
      );
    }
  });
};
