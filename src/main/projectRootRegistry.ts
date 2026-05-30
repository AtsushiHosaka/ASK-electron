import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizePath, createLocalPathHash } from "./projectPathIdentity";

export interface ProjectRootRecord {
  id: string;
  rootPath: string;
  displayName: string;
  selectedAt: string;
}

interface PersistedProjectRootRecord {
  localPathHash: string;
  rootPath: string;
  displayName: string;
  selectedAt: string;
}

const selectedProjectRoots = new Map<string, ProjectRootRecord>();
const localPathHashPattern = /^[a-f0-9]{64}$/;
let persistedProjectRootWriteQueue: Promise<void> = Promise.resolve();

const getProjectRootStorePath = (): string => {
  return process.env.ASK_PROJECT_ROOTS_STORE_PATH
    ? process.env.ASK_PROJECT_ROOTS_STORE_PATH
    : join(homedir(), ".ask", "project-roots.v1.json");
};

const createPersistedProjectRootId = (localPathHash: string): string => {
  return `persisted-${localPathHash.slice(0, 16)}`;
};

const isPersistedProjectRootRecord = (value: unknown): value is PersistedProjectRootRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.localPathHash === "string" &&
    localPathHashPattern.test(record.localPathHash) &&
    typeof record.rootPath === "string" &&
    record.rootPath.trim().length > 0 &&
    typeof record.displayName === "string" &&
    record.displayName.trim().length > 0 &&
    typeof record.selectedAt === "string" &&
    record.selectedAt.trim().length > 0
  );
};

const readPersistedProjectRoots = async (): Promise<PersistedProjectRootRecord[]> => {
  try {
    const rawValue = await readFile(getProjectRootStorePath(), "utf8");
    const parsedValue = JSON.parse(rawValue) as {
      schemaVersion?: unknown;
      roots?: unknown;
    };

    if (parsedValue.schemaVersion !== 1 || !Array.isArray(parsedValue.roots)) {
      return [];
    }

    return parsedValue.roots.filter(isPersistedProjectRootRecord);
  } catch {
    return [];
  }
};

const writePersistedProjectRoots = async (roots: PersistedProjectRootRecord[]): Promise<void> => {
  const storePath = getProjectRootStorePath();
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify({ schemaVersion: 1, roots }, null, 2)}\n`;

  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
};

const runWithPersistedProjectRootWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const pendingOperation = persistedProjectRootWriteQueue.then(operation, operation);
  persistedProjectRootWriteQueue = pendingOperation.then(
    () => undefined,
    () => undefined
  );
  return pendingOperation;
};

export const rememberSelectedProjectRoot = (record: ProjectRootRecord): void => {
  selectedProjectRoots.set(record.id, record);
};

export const getSelectedProjectRoot = (projectRootId: string): ProjectRootRecord | null => {
  return selectedProjectRoots.get(projectRootId) ?? null;
};

export const forgetSelectedProjectRoot = (projectRootId: string): void => {
  selectedProjectRoots.delete(projectRootId);
};

export const persistSelectedProjectRootMapping = async (
  record: ProjectRootRecord,
  localPathHash: string
): Promise<void> => {
  if (!localPathHashPattern.test(localPathHash)) {
    throw new Error("LOCAL_PATH_HASH_INVALID");
  }

  const canonicalRootPath = await canonicalizePath(record.rootPath);
  const actualLocalPathHash = createLocalPathHash(canonicalRootPath);

  if (actualLocalPathHash !== localPathHash) {
    throw new Error("LOCAL_PATH_HASH_MISMATCH");
  }

  await runWithPersistedProjectRootWriteLock(async () => {
    const currentRoots = await readPersistedProjectRoots();
    const nextRecord: PersistedProjectRootRecord = {
      localPathHash,
      rootPath: canonicalRootPath,
      displayName: record.displayName,
      selectedAt: record.selectedAt
    };
    const nextRoots = [
      nextRecord,
      ...currentRoots.filter((root) => root.localPathHash !== localPathHash)
    ];

    await writePersistedProjectRoots(nextRoots);
    selectedProjectRoots.set(record.id, {
      ...record,
      rootPath: canonicalRootPath
    });
  });
};

export const findSelectedProjectRootByLocalPathHash = async (
  localPathHash: string
): Promise<ProjectRootRecord | null> => {
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

  const persistedRoots = await readPersistedProjectRoots();

  for (const persistedRoot of persistedRoots) {
    if (persistedRoot.localPathHash !== localPathHash) {
      continue;
    }

    let canonicalRootPath: string;

    try {
      canonicalRootPath = await canonicalizePath(persistedRoot.rootPath);
    } catch {
      continue;
    }

    if (createLocalPathHash(canonicalRootPath) !== localPathHash) {
      continue;
    }

    const record: ProjectRootRecord = {
      id: createPersistedProjectRootId(localPathHash),
      rootPath: canonicalRootPath,
      displayName: persistedRoot.displayName,
      selectedAt: persistedRoot.selectedAt
    };

    rememberSelectedProjectRoot(record);
    return record;
  }

  return null;
};

export const clearProjectRootRegistryForTests = (): void => {
  selectedProjectRoots.clear();
};
