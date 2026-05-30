import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalizePath, createLocalPathHash } from "./projectPathIdentity";

export interface ProjectRootRecord {
  id: string;
  rootPath: string;
  displayName: string;
  selectedAt: string;
}

const selectedProjectRoots = new Map<string, ProjectRootRecord>();

let storageFilePath: string | null = null;
let hydratedStoragePath: string | null = null;
let hydratePromise: Promise<void> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isProjectRootRecord = (value: unknown): value is ProjectRootRecord => {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.rootPath === "string" &&
    value.rootPath.length > 0 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    typeof value.selectedAt === "string" &&
    value.selectedAt.length > 0
  );
};

const loadPersistedProjectRoots = async (filePath: string): Promise<void> => {
  let rawContent: string;

  try {
    rawContent = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  let parsedContent: unknown;

  try {
    parsedContent = JSON.parse(rawContent);
  } catch {
    return;
  }

  if (!isRecord(parsedContent) || parsedContent.schemaVersion !== 1) {
    return;
  }

  const roots = parsedContent.roots;

  if (!Array.isArray(roots)) {
    return;
  }

  roots.filter(isProjectRootRecord).forEach((record) => {
    selectedProjectRoots.set(record.id, record);
  });
};

const ensureHydrated = async (): Promise<void> => {
  if (!storageFilePath || hydratedStoragePath === storageFilePath) {
    return;
  }

  if (!hydratePromise) {
    const targetStorageFilePath = storageFilePath;
    hydratePromise = loadPersistedProjectRoots(targetStorageFilePath)
      .then(() => {
        hydratedStoragePath = targetStorageFilePath;
      })
      .finally(() => {
        hydratePromise = null;
      });
  }

  await hydratePromise;
};

const persistSelectedProjectRoots = async (): Promise<void> => {
  if (!storageFilePath) {
    return;
  }

  const payload = {
    schemaVersion: 1,
    roots: [...selectedProjectRoots.values()]
  };
  const temporaryPath = `${storageFilePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(storageFilePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, storageFilePath);
};

export const configureProjectRootRegistryStorage = async (filePath: string): Promise<void> => {
  storageFilePath = filePath;
  hydratedStoragePath = null;
  hydratePromise = null;
  await ensureHydrated();
};

export const clearProjectRootRegistryForTest = (): void => {
  selectedProjectRoots.clear();
  storageFilePath = null;
  hydratedStoragePath = null;
  hydratePromise = null;
};

export const rememberSelectedProjectRoot = async (record: ProjectRootRecord): Promise<void> => {
  selectedProjectRoots.set(record.id, record);
  await persistSelectedProjectRoots();
};

export const getSelectedProjectRoot = (projectRootId: string): ProjectRootRecord | null => {
  return selectedProjectRoots.get(projectRootId) ?? null;
};

export const findSelectedProjectRootByLocalPathHash = async (
  localPathHash: string
): Promise<ProjectRootRecord | null> => {
  await ensureHydrated();

  for (const record of selectedProjectRoots.values()) {
    let canonicalRootPath: string;

    try {
      canonicalRootPath = await canonicalizePath(record.rootPath);
    } catch {
      continue;
    }

    if (createLocalPathHash(canonicalRootPath) === localPathHash) {
      return record;
    }
  }

  return null;
};
