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
  ai: {
    generate: (input) => invoke(IpcChannel.AiGenerate, input)
  },
  project: {
    selectRoot: () => invoke(IpcChannel.ProjectSelectRoot),
    inspectGit: (input) => invoke(IpcChannel.ProjectInspectGit, input),
    reconnectRoot: (input) => invoke(IpcChannel.ProjectReconnectRoot, input)
  },
  gitDiff: {
    collect: (input) => invoke(IpcChannel.GitDiffCollect, input)
  },
  relatedFiles: {
    select: (input) => invoke(IpcChannel.RelatedFilesSelect, input)
  },
  environment: {
    collectSnapshot: (input) => invoke(IpcChannel.EnvironmentSnapshotCollect, input)
  },
  patch: {
    validate: (input) => invoke(IpcChannel.PatchValidate, input),
    apply: (input) => invoke(IpcChannel.PatchApply, input),
    revert: (input) => invoke(IpcChannel.PatchRevert, input)
  },
  gitignore: {
    preview: (input) => invoke(IpcChannel.GitignorePreview, input),
    apply: (input) => invoke(IpcChannel.GitignoreApply, input)
  }
};

contextBridge.exposeInMainWorld("ask", api);
