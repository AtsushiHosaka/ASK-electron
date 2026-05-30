import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ProjectRootSelectionResponse } from "../shared/ipc";
import { rememberSelectedProjectRoot, type ProjectRootRecord } from "./projectRootRegistry";

export {
  findSelectedProjectRootByLocalPathHash,
  getSelectedProjectRoot
} from "./projectRootRegistry";
export type { ProjectRootRecord } from "./projectRootRegistry";

export const selectProjectRoot = async (
  ownerWindow: BrowserWindow | null
): Promise<ProjectRootSelectionResponse> => {
  const dialogOptions: OpenDialogOptions = {
    title: "ASK プロジェクトフォルダを選択",
    buttonLabel: "このフォルダを選択",
    properties: ["openDirectory"]
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return {
      contractVersion: "v1",
      selected: false,
      projectRootId: null,
      displayName: null,
      selectedAt: null
    };
  }

  const rootPath = result.filePaths[0];
  const selectedAt = new Date().toISOString();
  const record: ProjectRootRecord = {
    id: randomUUID(),
    rootPath,
    displayName: basename(rootPath) || "選択したフォルダ",
    selectedAt
  };

  rememberSelectedProjectRoot(record);

  return {
    contractVersion: "v1",
    selected: true,
    projectRootId: record.id,
    displayName: record.displayName,
    selectedAt
  };
};
