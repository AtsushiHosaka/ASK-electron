import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  IpcChannel,
  type AppRuntimeInfoResponse,
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

const isGitignorePreviewRequest = (value: unknown): value is GitignorePreviewRequest => {
  return (
    isRecord(value) && typeof value.projectRootId === "string" && value.projectRootId.length > 0
  );
};

const isProjectGitInspectionRequest = (value: unknown): value is ProjectGitInspectionRequest => {
  return (
    isRecord(value) &&
    typeof value.projectRootId === "string" &&
    value.projectRootId.trim().length > 0
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
