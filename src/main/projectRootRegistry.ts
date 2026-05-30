import { canonicalizePath, createLocalPathHash } from "./projectPathIdentity";

export interface ProjectRootRecord {
  id: string;
  rootPath: string;
  displayName: string;
  selectedAt: string;
}

const selectedProjectRoots = new Map<string, ProjectRootRecord>();

export const rememberSelectedProjectRoot = (record: ProjectRootRecord): void => {
  selectedProjectRoots.set(record.id, record);
};

export const getSelectedProjectRoot = (projectRootId: string): ProjectRootRecord | null => {
  return selectedProjectRoots.get(projectRootId) ?? null;
};

export const findSelectedProjectRootByLocalPathHash = async (
  localPathHash: string
): Promise<ProjectRootRecord | null> => {
  for (const record of selectedProjectRoots.values()) {
    const canonicalRootPath = await canonicalizePath(record.rootPath);

    if (createLocalPathHash(canonicalRootPath) === localPathHash) {
      return record;
    }
  }

  return null;
};
