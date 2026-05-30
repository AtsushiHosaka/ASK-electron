import { app, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  IpcChannel,
  type AppRuntimeInfoResponse,
  type IpcAuditMetadata,
  type IpcChannelName,
  type IpcResult,
  type LocalDiagnosticsResponse
} from "../shared/ipc";
import { runLocalDiagnostics } from "./localDiagnostics";

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
};
