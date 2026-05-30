import type {
  ProjectGitInspectionRequest,
  ProjectGitInspectionResponse,
  ProjectRootReconnectRequest,
  ProjectRootReconnectResponse,
  ProjectRootReconnectStatus
} from "../shared/ipc";
import { inspectProjectGit as defaultInspectProjectGit } from "./projectGitInspector";
import {
  forgetSelectedProjectRoot as defaultForgetSelectedProjectRoot,
  getSelectedProjectRoot as defaultGetSelectedProjectRoot,
  persistSelectedProjectRootMapping as defaultPersistSelectedProjectRootMapping,
  type ProjectRootRecord
} from "./projectRootRegistry";

export interface ProjectRootReconnectDependencies {
  inspectProjectGit?: (input: ProjectGitInspectionRequest) => Promise<ProjectGitInspectionResponse>;
  getSelectedProjectRoot?: (projectRootId: string) => ProjectRootRecord | null;
  forgetSelectedProjectRoot?: (projectRootId: string) => void;
  persistSelectedProjectRootMapping?: (
    record: ProjectRootRecord,
    localPathHash: string
  ) => Promise<void>;
}

const createResponse = (
  input: ProjectRootReconnectRequest,
  status: ProjectRootReconnectStatus,
  message: string,
  inspection: ProjectGitInspectionResponse | null = null,
  persisted = false
): ProjectRootReconnectResponse => ({
  contractVersion: "v1",
  status,
  persisted,
  projectRootId: input.projectRootId,
  displayName: inspection?.displayName ?? null,
  localPathHash: inspection?.localPathHash ?? null,
  normalizedGithubRepoUrl: inspection?.normalizedGithubRepoUrl ?? null,
  message
});

export const reconnectProjectRoot = async (
  input: ProjectRootReconnectRequest
): Promise<ProjectRootReconnectResponse> => {
  return reconnectProjectRootWithDependencies(input);
};

export const reconnectProjectRootWithDependencies = async (
  input: ProjectRootReconnectRequest,
  dependencies: ProjectRootReconnectDependencies = {}
): Promise<ProjectRootReconnectResponse> => {
  const inspectProjectGit = dependencies.inspectProjectGit ?? defaultInspectProjectGit;
  const getSelectedProjectRoot =
    dependencies.getSelectedProjectRoot ?? defaultGetSelectedProjectRoot;
  const forgetSelectedProjectRoot =
    dependencies.forgetSelectedProjectRoot ?? defaultForgetSelectedProjectRoot;
  const persistSelectedProjectRootMapping =
    dependencies.persistSelectedProjectRootMapping ?? defaultPersistSelectedProjectRootMapping;
  const expectedLocalPathHash = input.expectedLocalPathHash.trim();
  const expectedGithubRepoUrl = input.expectedGithubRepoUrl.trim();

  let inspection: ProjectGitInspectionResponse;

  try {
    inspection = await inspectProjectGit({ projectRootId: input.projectRootId });
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECT_ROOT_NOT_FOUND") {
      return createResponse(
        input,
        "root_missing",
        "選択したローカルフォルダを確認できません。もう一度選択してください。"
      );
    }

    throw error;
  }

  if (!inspection.canRegister || !inspection.localPathHash || !inspection.normalizedGithubRepoUrl) {
    forgetSelectedProjectRoot(input.projectRootId);
    return createResponse(
      input,
      "not_ready",
      inspection.message || "GitHub repository として確認できませんでした。",
      inspection
    );
  }

  if (inspection.normalizedGithubRepoUrl !== expectedGithubRepoUrl) {
    forgetSelectedProjectRoot(input.projectRootId);
    return createResponse(
      input,
      "remote_mismatch",
      "選択フォルダの GitHub repository が登録済みプロジェクトと一致しません。",
      inspection
    );
  }

  if (inspection.localPathHash !== expectedLocalPathHash) {
    forgetSelectedProjectRoot(input.projectRootId);
    return createResponse(
      input,
      "hash_mismatch",
      "選択フォルダの local_path_hash が登録済みプロジェクトと一致しません。",
      inspection
    );
  }

  const record = getSelectedProjectRoot(input.projectRootId);

  if (!record) {
    return createResponse(
      input,
      "root_missing",
      "選択したローカルフォルダを確認できません。もう一度選択してください。",
      inspection
    );
  }

  try {
    await persistSelectedProjectRootMapping(record, expectedLocalPathHash);
  } catch {
    return createResponse(
      input,
      "persist_failed",
      "ローカルフォルダの再接続情報を保存できませんでした。",
      inspection
    );
  }

  return createResponse(
    input,
    "reconnected",
    "ローカルフォルダをこの端末に再接続しました。",
    inspection,
    true
  );
};
