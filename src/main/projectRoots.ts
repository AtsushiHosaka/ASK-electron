import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ProjectRootSelectionResponse } from "../shared/ipc";
import { canonicalizePath, createLocalPathHash } from "./projectPathIdentity";

interface ProjectRootRecord {
  id: string;
  rootPath: string;
  canonicalRootPath: string;
  localPathHash: string;
  displayName: string;
  selectedAt: string;
}

const selectedProjectRoots = new Map<string, ProjectRootRecord>();

export const getSelectedProjectRoot = (projectRootId: string): ProjectRootRecord | null => {
  return selectedProjectRoots.get(projectRootId) ?? null;
};

export const getSelectedProjectRootByLocalPathHash = (
  localPathHash: string
): ProjectRootRecord | null => {
  for (const record of selectedProjectRoots.values()) {
    if (record.localPathHash === localPathHash) {
      return record;
    }
  }

  return null;
};

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
  const canonicalRootPath = await canonicalizePath(rootPath);
  const selectedAt = new Date().toISOString();
  const record: ProjectRootRecord = {
    id: randomUUID(),
    rootPath,
    canonicalRootPath,
    localPathHash: createLocalPathHash(canonicalRootPath),
    displayName: basename(rootPath) || "選択したフォルダ",
    selectedAt
  };

  selectedProjectRoots.set(record.id, record);

  return {
    contractVersion: "v1",
    selected: true,
    projectRootId: record.id,
    displayName: record.displayName,
    selectedAt
  };
};
