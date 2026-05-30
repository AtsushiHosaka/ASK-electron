export const IpcChannel = {
  AppGetRuntimeInfo: "ask:v1:app:get-runtime-info"
} as const;

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

export interface IpcAuditMetadata {
  channel: IpcChannelName;
  requestedAt: string;
  requestId: string;
}

export interface IpcError {
  code: string;
  message: string;
  retryable: boolean;
}

export type IpcResult<T> =
  | {
      ok: true;
      data: T;
      meta: IpcAuditMetadata;
    }
  | {
      ok: false;
      error: IpcError;
      meta: IpcAuditMetadata;
    };

export interface AppRuntimeInfoResponse {
  contractVersion: "v1";
  appVersion: string;
  platform:
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
  isPackaged: boolean;
}

export interface IpcRequestMap {
  [IpcChannel.AppGetRuntimeInfo]: [];
}

export interface IpcResponseMap {
  [IpcChannel.AppGetRuntimeInfo]: IpcResult<AppRuntimeInfoResponse>;
}

export interface RendererApi {
  app: {
    getRuntimeInfo: () => Promise<IpcResponseMap[typeof IpcChannel.AppGetRuntimeInfo]>;
  };
}
