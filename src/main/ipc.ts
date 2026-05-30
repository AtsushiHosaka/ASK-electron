import { app, BrowserWindow, ipcMain } from "electron";
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
  type ProjectGitInspectionRequest,
  type ProjectGitInspectionResponse,
  type ProjectRootSelectionResponse
} from "../shared/ipc";
import {
  AI_PIPELINE_LIMITS,
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
import { inspectProjectGit } from "./projectGitInspector";
import { selectProjectRoot } from "./projectRoots";

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

const AI_IPC_MAX_CONTEXT_ITEMS = AI_PIPELINE_LIMITS.maxContextEntries * 2;
const AI_IPC_MAX_STRING_LENGTH = 20_000;
const AI_IPC_MAX_TOTAL_CONTEXT_CHARS = 80_000;
const AI_IPC_MAX_ID_LENGTH = 128;

const clipLogValue = (value: string, maxLength: number): string => {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
};

const safeErrorFields = (error: unknown): { message: string; code: string | null } => {
  const errorRecord = typeof error === "object" && error !== null ? error : {};
  const rawCode = "code" in errorRecord ? errorRecord.code : null;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

  return {
    message: clipLogValue(message, 240),
    code: typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : null
  };
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

  if (value.context.length > AI_IPC_MAX_CONTEXT_ITEMS) {
    return false;
  }

  const options = value.options;
  const hasValidOptions =
    options === undefined ||
    (isRecord(options) &&
      (options.locale === undefined || options.locale === "ja" || options.locale === "en") &&
      (options.maxOutputChars === undefined || typeof options.maxOutputChars === "number") &&
      (options.streaming === undefined || typeof options.streaming === "boolean"));
  const hasValidIds =
    (value.projectId === undefined ||
      value.projectId === null ||
      (typeof value.projectId === "string" && value.projectId.length <= AI_IPC_MAX_ID_LENGTH)) &&
    (value.threadId === undefined ||
      value.threadId === null ||
      (typeof value.threadId === "string" && value.threadId.length <= AI_IPC_MAX_ID_LENGTH));
  let totalContextChars = 0;
  const hasValidContext = value.context.every((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.label !== "string" ||
      entry.label.trim().length === 0 ||
      entry.label.length > AI_IPC_MAX_STRING_LENGTH ||
      !isAiContextKind(entry.kind) ||
      typeof entry.value !== "string" ||
      entry.value.length > AI_IPC_MAX_STRING_LENGTH
    ) {
      return false;
    }

    totalContextChars += entry.label.length + entry.value.length;
    return totalContextChars <= AI_IPC_MAX_TOTAL_CONTEXT_CHARS;
  });

  return hasValidOptions && hasValidIds && hasValidContext;
};

const isProjectGitInspectionRequest = (value: unknown): value is ProjectGitInspectionRequest => {
  return (
    isRecord(value) &&
    typeof value.projectRootId === "string" &&
    value.projectRootId.trim().length > 0
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
      console.error(
        `[${IpcChannel.AiGenerate}] AI pipeline failed`,
        JSON.stringify(safeErrorFields(error))
      );

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
