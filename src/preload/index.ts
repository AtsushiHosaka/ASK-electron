import { contextBridge, ipcRenderer } from "electron";
import {
  IpcChannel,
  type IpcChannelName,
  type IpcRequestMap,
  type IpcResponseMap,
  type RendererApi
} from "../shared/ipc";

const invoke = <TChannel extends IpcChannelName>(
  channel: TChannel,
  ...args: IpcRequestMap[TChannel]
): Promise<IpcResponseMap[TChannel]> => {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResponseMap[TChannel]>;
};

const api: RendererApi = {
  app: {
    getRuntimeInfo: () => invoke(IpcChannel.AppGetRuntimeInfo)
  },
  diagnostics: {
    runLocal: () => invoke(IpcChannel.DiagnosticsRunLocal)
  },
  project: {
    selectRoot: () => invoke(IpcChannel.ProjectSelectRoot)
  },
  gitignore: {
    preview: (input) => invoke(IpcChannel.GitignorePreview, input),
    apply: (input) => invoke(IpcChannel.GitignoreApply, input)
  }
};

contextBridge.exposeInMainWorld("ask", api);
