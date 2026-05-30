import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  ProjectRootReconnectRequest,
  ProjectRootReconnectResponse,
  ProjectRootSelectionResponse
} from "../shared/ipc";
import {
  inspectProjectGitRecordWithDependencies,
  normalizeGithubRepoUrl
} from "./projectGitInspector";
import { rememberSelectedProjectRoot, type ProjectRootRecord } from "./projectRootRegistry";

export {
  findSelectedProjectRootByLocalPathHash,
  getSelectedProjectRoot
} from "./projectRootRegistry";
export type { ProjectRootRecord } from "./projectRootRegistry";

const selectProjectRootRecord = async (
  ownerWindow: BrowserWindow | null
): Promise<ProjectRootRecord | null> => {
  const dialogOptions: OpenDialogOptions = {
    title: "ASK プロジェクトフォルダを選択",
    buttonLabel: "このフォルダを選択",
    properties: ["openDirectory"]
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const rootPath = result.filePaths[0];
  const selectedAt = new Date().toISOString();

  return {
    id: randomUUID(),
    rootPath,
    displayName: basename(rootPath) || "選択したフォルダ",
    selectedAt
  };
};

const createCancelledSelectionResponse = (): ProjectRootSelectionResponse => ({
  contractVersion: "v1",
  selected: false,
  projectRootId: null,
  displayName: null,
  selectedAt: null
});

export const selectProjectRoot = async (
  ownerWindow: BrowserWindow | null
): Promise<ProjectRootSelectionResponse> => {
  const record = await selectProjectRootRecord(ownerWindow);

  if (!record) {
    return createCancelledSelectionResponse();
  }

  await rememberSelectedProjectRoot(record);

  return {
    contractVersion: "v1",
    selected: true,
    projectRootId: record.id,
    displayName: record.displayName,
    selectedAt: record.selectedAt
  };
};

export const reconnectProjectRoot = async (
  ownerWindow: BrowserWindow | null,
  input: ProjectRootReconnectRequest
): Promise<ProjectRootReconnectResponse> => {
  const expectedLocalPathHash = input.localPathHash?.trim();
  const expectedGithubRepoUrl = normalizeGithubRepoUrl(input.githubRepoUrl ?? "");

  if (!expectedLocalPathHash || !expectedGithubRepoUrl) {
    return {
      contractVersion: "v1",
      status: "invalid_request",
      selected: false,
      projectRootId: null,
      displayName: null,
      selectedAt: null,
      inspection: null,
      message: "登録済みプロジェクトの GitHub repository または local_path_hash が不足しています。"
    };
  }

  const record = await selectProjectRootRecord(ownerWindow);

  if (!record) {
    return {
      contractVersion: "v1",
      status: "cancelled",
      selected: false,
      projectRootId: null,
      displayName: null,
      selectedAt: null,
      inspection: null,
      message: "フォルダ選択をキャンセルしました。"
    };
  }

  const inspection = await inspectProjectGitRecordWithDependencies(record);

  if (!inspection.canRegister) {
    return {
      contractVersion: "v1",
      status: "invalid_repository",
      selected: true,
      projectRootId: null,
      displayName: record.displayName,
      selectedAt: record.selectedAt,
      inspection,
      message: inspection.message
    };
  }

  if (inspection.normalizedGithubRepoUrl !== expectedGithubRepoUrl) {
    return {
      contractVersion: "v1",
      status: "repo_mismatch",
      selected: true,
      projectRootId: null,
      displayName: record.displayName,
      selectedAt: record.selectedAt,
      inspection,
      message: "選択フォルダの GitHub repository が登録済みプロジェクトと一致しません。"
    };
  }

  if (inspection.localPathHash !== expectedLocalPathHash) {
    return {
      contractVersion: "v1",
      status: "hash_mismatch",
      selected: true,
      projectRootId: null,
      displayName: record.displayName,
      selectedAt: record.selectedAt,
      inspection,
      message: "選択フォルダの local_path_hash が登録済みプロジェクトと一致しません。"
    };
  }

  await rememberSelectedProjectRoot(record);

  return {
    contractVersion: "v1",
    status: "connected",
    selected: true,
    projectRootId: record.id,
    displayName: record.displayName,
    selectedAt: record.selectedAt,
    inspection,
    message: "ローカルフォルダをこのプロジェクトに再接続しました。"
  };
};
