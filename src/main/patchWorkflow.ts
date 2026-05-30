import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join, relative, resolve } from "node:path";
import type {
  PatchApplyRequest,
  PatchApplyResponse,
  PatchApplyStatus,
  PatchRevertRequest,
  PatchRevertResponse,
  PatchRevertStatus,
  PatchValidateRequest,
  PatchValidateResponse,
  PatchValidationStatus
} from "../shared/ipc";
import { scanSecrets } from "../shared/secretScanner";
import { runGit, type GitCommandResult } from "./gitCommand";
import { findSelectedProjectRootByLocalPathHash } from "./projectRootRegistry";

const PATCH_WORKFLOW_TIMEOUT_MS = 8_000;
const PATCH_WORKFLOW_MAX_PATCH_CHARS = 500_000;
const PATCH_WORKFLOW_MAX_TARGET_FILES = 50;
const PATCH_PENDING_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_PATCHES = 25;
const BACKUP_ROOT_DIRECTORY = ".ask/backups";
const BACKUP_METADATA_FILE = "metadata.json";

const deniedPathSegments = new Set([
  ".ask",
  ".git",
  ".hg",
  ".svn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out"
]);

interface PatchValidationContext {
  rootPath: string;
  displayName: string;
  patchText: string;
  expectedBaseCommit: string | null;
  targetFiles: string[];
  currentHead: string;
}

interface PendingPatch extends PatchValidationContext {
  patchId: string;
  confirmationToken: string;
  expiresAt: number;
}

interface BackupEntry {
  path: string;
  existed: boolean;
  kind: "file" | "directory" | "symlink" | "other" | "missing";
  sha256?: string;
  linkTarget?: string;
}

interface BackupMetadata {
  schemaVersion: 1;
  patchId: string;
  currentHead: string;
  targetFiles: string[];
  entries: BackupEntry[];
  postApplyEntries?: BackupEntry[];
  createdAt: string;
  appliedAt?: string;
}

const pendingPatches = new Map<string, PendingPatch>();

type PatchApplyCheckFailureStatus = Extract<
  PatchValidationStatus,
  "conflict" | "git_missing" | "git_timeout" | "permission_denied"
>;

const trimCommit = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const trimUuid = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && /^[0-9a-f-]{36}$/i.test(trimmed) ? trimmed : null;
};

const createValidateResponse = ({
  status,
  message,
  canApply = false,
  patchId = null,
  confirmationToken = null,
  targetFiles = [],
  currentHead = null,
  expectedBaseCommit = null
}: {
  status: PatchValidationStatus;
  message: string;
  canApply?: boolean;
  patchId?: string | null;
  confirmationToken?: string | null;
  targetFiles?: string[];
  currentHead?: string | null;
  expectedBaseCommit?: string | null;
}): PatchValidateResponse => ({
  contractVersion: "v1",
  status,
  canApply,
  patchId,
  confirmationToken,
  targetFiles,
  currentHead,
  expectedBaseCommit,
  message
});

const createApplyResponse = ({
  request,
  status,
  message,
  applied = false,
  targetFiles = [],
  backupDirectory = null
}: {
  request: PatchApplyRequest;
  status: PatchApplyStatus;
  message: string;
  applied?: boolean;
  targetFiles?: string[];
  backupDirectory?: string | null;
}): PatchApplyResponse => ({
  contractVersion: "v1",
  status,
  applied,
  patchId: request.patchId,
  targetFiles,
  backupDirectory,
  message
});

const createRevertResponse = ({
  request,
  status,
  message,
  reverted = false,
  targetFiles = [],
  backupDirectory = request.backupDirectory
}: {
  request: PatchRevertRequest;
  status: PatchRevertStatus;
  message: string;
  reverted?: boolean;
  targetFiles?: string[];
  backupDirectory?: string | null;
}): PatchRevertResponse => ({
  contractVersion: "v1",
  status,
  reverted,
  patchId: request.patchId,
  targetFiles,
  backupDirectory,
  message
});

const pruneExpiredPatches = (): void => {
  const now = Date.now();

  for (const [patchId, patch] of pendingPatches.entries()) {
    if (patch.expiresAt <= now) {
      pendingPatches.delete(patchId);
    }
  }
};

const evictOldestPendingPatches = (): void => {
  while (pendingPatches.size >= MAX_PENDING_PATCHES) {
    const oldestPatchId = pendingPatches.keys().next().value;

    if (!oldestPatchId) {
      return;
    }

    pendingPatches.delete(oldestPatchId);
  }
};

const stripGitPathPrefix = (value: string): string => {
  const trimmed = value.trim().replace(/^"|"$/g, "");

  if (trimmed === "/dev/null") {
    return "";
  }

  return trimmed.replace(/^[ab]\//, "");
};

const normalizePatchTargetPath = (rawPath: string): string | null => {
  const strippedPath = stripGitPathPrefix(rawPath);

  if (!strippedPath || strippedPath.includes("\0") || strippedPath.includes("\\")) {
    return null;
  }

  const normalizedPath = path.posix.normalize(strippedPath);
  const segments = normalizedPath.split("/").filter(Boolean);

  if (
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    path.posix.isAbsolute(normalizedPath) ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    return null;
  }

  return segments.join("/");
};

const parseGitDiffLine = (line: string): string[] => {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);

  if (!match) {
    return [];
  }

  return [match[1], match[2]];
};

const parseTargetFiles = (patchText: string): { targetFiles: string[]; invalidPath: boolean } => {
  const targetFiles = new Set<string>();
  let invalidPath = false;

  const addPath = (rawPath: string): void => {
    const normalizedPath = normalizePatchTargetPath(rawPath);

    if (!normalizedPath) {
      invalidPath = true;
      return;
    }

    targetFiles.add(normalizedPath);
  };

  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      for (const rawPath of parseGitDiffLine(line)) {
        addPath(rawPath);
      }
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const rawPath = line.slice(4).split(/\t/)[0]?.trim() ?? "";

      if (rawPath && rawPath !== "/dev/null") {
        addPath(rawPath);
      }
    }
  }

  return { targetFiles: [...targetFiles].sort(), invalidPath };
};

const isDeniedTargetPath = (targetPath: string): boolean => {
  return targetPath
    .split("/")
    .filter(Boolean)
    .some((segment) => deniedPathSegments.has(segment));
};

const resolveTargetPath = (rootPath: string, targetPath: string): string | null => {
  const absolutePath = resolve(rootPath, ...targetPath.split("/"));
  const relativePath = relative(rootPath, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  return absolutePath;
};

const withPatchFile = async <T>(
  patchText: string,
  callback: (patchPath: string) => Promise<T>
): Promise<T> => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "ask-patch-"));
  const patchPath = join(tempDirectory, "change.patch");

  try {
    await writeFile(patchPath, patchText, "utf8");
    return await callback(patchPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
};

const checkCurrentHead = async (
  rootPath: string
): Promise<
  { status: "ok"; head: string } | { status: "missing" | "timeout" | "failed"; message: string }
> => {
  const result = await runGit(rootPath, ["rev-parse", "HEAD"], {
    timeoutMs: PATCH_WORKFLOW_TIMEOUT_MS,
    maxOutputLength: 200
  });

  if (result.status === "missing") {
    return { status: "missing", message: "Git が見つかりません。Git をインストールしてください。" };
  }

  if (result.status === "timeout") {
    return {
      status: "timeout",
      message: "Git の確認がタイムアウトしました。もう一度試してください。"
    };
  }

  if (result.status !== "completed" || result.exitCode !== 0 || !result.stdout) {
    return {
      status: "failed",
      message:
        "Git リポジトリの HEAD を確認できませんでした。プロジェクトフォルダを確認してください。"
    };
  }

  return { status: "ok", head: result.stdout.trim() };
};

const checkDirtyTargets = async (
  rootPath: string,
  targetFiles: string[]
): Promise<{ dirty: boolean; status: GitCommandResult["status"] }> => {
  const result = await runGit(
    rootPath,
    ["status", "--porcelain", "--untracked-files=all", "--", ...targetFiles],
    {
      timeoutMs: PATCH_WORKFLOW_TIMEOUT_MS,
      maxOutputLength: 4_000
    }
  );

  return {
    dirty: result.status === "completed" && result.exitCode === 0 && result.stdout.length > 0,
    status: result.status
  };
};

const hasPermissionDeniedOutput = (result: GitCommandResult): boolean => {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();

  return (
    output.includes("permission denied") || output.includes("eacces") || output.includes("eperm")
  );
};

const checkPatchApplies = async (
  rootPath: string,
  patchText: string
): Promise<{ ok: true } | { ok: false; status: PatchApplyCheckFailureStatus; message: string }> => {
  return withPatchFile(patchText, async (patchPath) => {
    const result = await runGit(rootPath, ["apply", "--check", "--whitespace=nowarn", patchPath], {
      timeoutMs: PATCH_WORKFLOW_TIMEOUT_MS,
      maxOutputLength: 4_000
    });

    if (result.status === "missing") {
      return { ok: false, status: "git_missing", message: "Git が見つかりません。" };
    }

    if (result.status === "timeout") {
      return { ok: false, status: "git_timeout", message: "パッチ確認がタイムアウトしました。" };
    }

    if (result.status !== "completed" || result.exitCode !== 0) {
      if (hasPermissionDeniedOutput(result)) {
        return {
          ok: false,
          status: "permission_denied",
          message: "対象ファイルまたはプロジェクトフォルダの権限によりパッチを確認できません。"
        };
      }

      return {
        ok: false,
        status: "conflict",
        message:
          "現在のファイルにはこのパッチをそのまま適用できません。競合または文脈差分の不一致があります。"
      };
    }

    return { ok: true };
  });
};

const createValidationContext = async (
  input: PatchValidateRequest
): Promise<
  { ok: true; context: PatchValidationContext } | { ok: false; response: PatchValidateResponse }
> => {
  const patchText = input.patchText.endsWith("\n") ? input.patchText : `${input.patchText}\n`;
  const expectedBaseCommit = trimCommit(input.expectedBaseCommit);
  const localPathHash = input.localPathHash?.trim();

  if (!localPathHash) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "root_missing",
        message:
          "ローカルプロジェクトフォルダが登録されていません。プロジェクト設定から選択し直してください。",
        expectedBaseCommit
      })
    };
  }

  if (!patchText.trim() || patchText.length > PATCH_WORKFLOW_MAX_PATCH_CHARS) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "invalid_patch",
        message: "パッチ本文が空、または大きすぎます。",
        expectedBaseCommit
      })
    };
  }

  const record = await findSelectedProjectRootByLocalPathHash(localPathHash);

  if (!record) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "root_missing",
        message:
          "このプロジェクトのローカルフォルダを確認できません。プロジェクト設定から選択し直してください。",
        expectedBaseCommit
      })
    };
  }

  const { targetFiles, invalidPath } = parseTargetFiles(patchText);
  const secretScan = scanSecrets({
    filePaths: targetFiles,
    textEntries: [{ label: "patch", value: patchText }]
  });

  if (
    invalidPath ||
    targetFiles.length === 0 ||
    targetFiles.length > PATCH_WORKFLOW_MAX_TARGET_FILES
  ) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "invalid_patch",
        message: "対象ファイルを安全に特定できないパッチです。",
        expectedBaseCommit
      })
    };
  }

  if (
    targetFiles.some((targetPath) => {
      return isDeniedTargetPath(targetPath) || !resolveTargetPath(record.rootPath, targetPath);
    }) ||
    secretScan.blocked
  ) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "denied_path",
        targetFiles,
        message: "適用対象に保護対象パス、または秘密情報らしき内容が含まれています。",
        expectedBaseCommit
      })
    };
  }

  const headResult = await checkCurrentHead(record.rootPath);

  if (headResult.status !== "ok") {
    const status =
      headResult.status === "missing"
        ? "git_missing"
        : headResult.status === "timeout"
          ? "git_timeout"
          : "invalid_patch";

    return {
      ok: false,
      response: createValidateResponse({
        status,
        targetFiles,
        message: headResult.message,
        expectedBaseCommit
      })
    };
  }

  const currentHead = headResult.head;

  if (expectedBaseCommit && currentHead !== expectedBaseCommit) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "base_mismatch",
        targetFiles,
        currentHead,
        expectedBaseCommit,
        message:
          "パッチ作成時のベースコミットと現在の HEAD が一致しません。最新状態を確認してください。"
      })
    };
  }

  const dirtyResult = await checkDirtyTargets(record.rootPath, targetFiles);

  if (dirtyResult.status === "missing") {
    return {
      ok: false,
      response: createValidateResponse({
        status: "git_missing",
        targetFiles,
        currentHead,
        expectedBaseCommit,
        message: "Git が見つかりません。"
      })
    };
  }

  if (dirtyResult.status === "timeout") {
    return {
      ok: false,
      response: createValidateResponse({
        status: "git_timeout",
        targetFiles,
        currentHead,
        expectedBaseCommit,
        message: "作業ツリーの確認がタイムアウトしました。"
      })
    };
  }

  if (dirtyResult.dirty) {
    return {
      ok: false,
      response: createValidateResponse({
        status: "dirty",
        targetFiles,
        currentHead,
        expectedBaseCommit,
        message: "対象ファイルに未コミットの変更があります。先に保存または退避してください。"
      })
    };
  }

  const applyCheck = await checkPatchApplies(record.rootPath, patchText);

  if (!applyCheck.ok) {
    return {
      ok: false,
      response: createValidateResponse({
        status: applyCheck.status,
        targetFiles,
        currentHead,
        expectedBaseCommit,
        message: applyCheck.message
      })
    };
  }

  return {
    ok: true,
    context: {
      rootPath: record.rootPath,
      displayName: record.displayName,
      patchText,
      expectedBaseCommit,
      targetFiles,
      currentHead
    }
  };
};

const getPathKind = async (absolutePath: string): Promise<BackupEntry["kind"]> => {
  try {
    const stats = await lstat(absolutePath);

    if (stats.isSymbolicLink()) {
      return "symlink";
    }

    if (stats.isFile()) {
      return "file";
    }

    if (stats.isDirectory()) {
      return "directory";
    }

    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }

    throw error;
  }
};

const hashFile = async (absolutePath: string): Promise<string> => {
  const content = await readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
};

const collectBackupEntry = async (rootPath: string, targetPath: string): Promise<BackupEntry> => {
  const absoluteTargetPath = resolveTargetPath(rootPath, targetPath);

  if (!absoluteTargetPath) {
    throw new Error("TARGET_PATH_ESCAPED_ROOT");
  }

  const kind = await getPathKind(absoluteTargetPath);
  const entry: BackupEntry = {
    path: targetPath,
    existed: kind !== "missing",
    kind
  };

  if (kind === "file") {
    entry.sha256 = await hashFile(absoluteTargetPath);
  }

  if (kind === "symlink") {
    entry.linkTarget = await readlink(absoluteTargetPath);
  }

  return entry;
};

const backupEntriesMatch = (current: BackupEntry, expected: BackupEntry): boolean => {
  return (
    current.path === expected.path &&
    current.existed === expected.existed &&
    current.kind === expected.kind &&
    current.sha256 === expected.sha256 &&
    current.linkTarget === expected.linkTarget
  );
};

const writeBackupMetadata = async (
  backupDirectory: string,
  metadata: BackupMetadata
): Promise<void> => {
  await writeFile(
    join(backupDirectory, BACKUP_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );
};

const isBackupEntry = (value: unknown): value is BackupEntry => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as BackupEntry;
  return (
    typeof entry.path === "string" &&
    typeof entry.existed === "boolean" &&
    (entry.kind === "file" ||
      entry.kind === "directory" ||
      entry.kind === "symlink" ||
      entry.kind === "other" ||
      entry.kind === "missing") &&
    (entry.sha256 === undefined || typeof entry.sha256 === "string") &&
    (entry.linkTarget === undefined || typeof entry.linkTarget === "string")
  );
};

const readBackupMetadata = async (backupDirectory: string): Promise<BackupMetadata | null> => {
  try {
    const rawMetadata = JSON.parse(
      await readFile(join(backupDirectory, BACKUP_METADATA_FILE), "utf8")
    ) as Partial<BackupMetadata>;

    if (
      rawMetadata.schemaVersion !== 1 ||
      typeof rawMetadata.patchId !== "string" ||
      typeof rawMetadata.currentHead !== "string" ||
      !Array.isArray(rawMetadata.targetFiles) ||
      !rawMetadata.targetFiles.every((targetPath) => typeof targetPath === "string") ||
      !Array.isArray(rawMetadata.entries) ||
      !rawMetadata.entries.every(isBackupEntry) ||
      (rawMetadata.postApplyEntries !== undefined &&
        (!Array.isArray(rawMetadata.postApplyEntries) ||
          !rawMetadata.postApplyEntries.every(isBackupEntry))) ||
      typeof rawMetadata.createdAt !== "string"
    ) {
      return null;
    }

    return rawMetadata as BackupMetadata;
  } catch {
    return null;
  }
};

const resolveBackupDirectory = (
  rootPath: string,
  patchId: string,
  backupDirectory: string | null
): { relativeDirectory: string; absoluteDirectory: string } | null => {
  const relativeDirectory = backupDirectory?.trim() || `${BACKUP_ROOT_DIRECTORY}/${patchId}`;
  const normalizedDirectory = path.posix.normalize(relativeDirectory);

  if (normalizedDirectory !== `${BACKUP_ROOT_DIRECTORY}/${patchId}`) {
    return null;
  }

  return {
    relativeDirectory: normalizedDirectory,
    absoluteDirectory: join(rootPath, ...normalizedDirectory.split("/"))
  };
};

const createBackup = async (
  rootPath: string,
  patchId: string,
  targetFiles: string[],
  currentHead: string
): Promise<string> => {
  const backupRelativeDirectory = `${BACKUP_ROOT_DIRECTORY}/${patchId}`;
  const backupDirectory = join(rootPath, backupRelativeDirectory);
  const entries: BackupEntry[] = [];

  await rm(backupDirectory, { recursive: true, force: true });
  await mkdir(backupDirectory, { recursive: true });

  for (const targetPath of targetFiles) {
    const entry = await collectBackupEntry(rootPath, targetPath);
    const absoluteTargetPath = resolveTargetPath(rootPath, targetPath);

    if (!absoluteTargetPath) {
      throw new Error("TARGET_PATH_ESCAPED_ROOT");
    }

    if (entry.kind === "file" || entry.kind === "directory") {
      const backupPath = join(backupDirectory, ...targetPath.split("/"));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await cp(absoluteTargetPath, backupPath, {
        recursive: entry.kind === "directory",
        force: true
      });
    }

    entries.push(entry);
  }

  await writeBackupMetadata(backupDirectory, {
    schemaVersion: 1,
    patchId,
    currentHead,
    targetFiles,
    entries,
    createdAt: new Date().toISOString()
  });

  return backupRelativeDirectory;
};

const recordPostApplyState = async (
  rootPath: string,
  backupRelativeDirectory: string,
  metadata: BackupMetadata
): Promise<BackupMetadata> => {
  const backupDirectory = join(rootPath, ...backupRelativeDirectory.split("/"));
  const nextMetadata: BackupMetadata = {
    ...metadata,
    postApplyEntries: await Promise.all(
      metadata.targetFiles.map((targetPath) => collectBackupEntry(rootPath, targetPath))
    ),
    appliedAt: new Date().toISOString()
  };

  await writeBackupMetadata(backupDirectory, nextMetadata);
  return nextMetadata;
};

const restoreBackupEntries = async (
  rootPath: string,
  backupDirectory: string,
  entries: BackupEntry[]
): Promise<{ ok: true } | { ok: false; status: "permission_denied" | "failed" }> => {
  try {
    for (const entry of entries) {
      const absoluteTargetPath = resolveTargetPath(rootPath, entry.path);

      if (!absoluteTargetPath) {
        return { ok: false, status: "failed" };
      }

      if (entry.kind === "other") {
        return { ok: false, status: "failed" };
      }

      await mkdir(path.dirname(absoluteTargetPath), { recursive: true });

      if (entry.kind === "missing") {
        await rm(absoluteTargetPath, { recursive: true, force: true });
        continue;
      }

      if (entry.kind === "symlink") {
        if (!entry.linkTarget) {
          return { ok: false, status: "failed" };
        }

        await rm(absoluteTargetPath, { recursive: true, force: true });
        await symlink(entry.linkTarget, absoluteTargetPath);
        continue;
      }

      const backupPath = join(backupDirectory, ...entry.path.split("/"));
      await rm(absoluteTargetPath, { recursive: true, force: true });
      await cp(backupPath, absoluteTargetPath, {
        recursive: entry.kind === "directory",
        force: true
      });
    }

    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      status: code === "EACCES" || code === "EPERM" ? "permission_denied" : "failed"
    };
  }
};

const classifyApplyFailure = (result: GitCommandResult): PatchApplyStatus => {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();

  if (hasPermissionDeniedOutput(result)) {
    return "permission_denied";
  }

  if (
    output.includes("patch failed") ||
    output.includes("does not apply") ||
    output.includes("already exists in working directory")
  ) {
    return "conflict";
  }

  return "failed";
};

const applyPatchText = async (
  rootPath: string,
  patchText: string
): Promise<{ ok: true } | { ok: false; status: PatchApplyStatus }> => {
  return withPatchFile(patchText, async (patchPath) => {
    const result = await runGit(rootPath, ["apply", "--whitespace=nowarn", patchPath], {
      timeoutMs: PATCH_WORKFLOW_TIMEOUT_MS,
      maxOutputLength: 4_000
    });

    if (result.status === "completed" && result.exitCode === 0) {
      return { ok: true };
    }

    if (result.status === "missing") {
      return { ok: false, status: "git_missing" };
    }

    if (result.status === "timeout") {
      return { ok: false, status: "git_timeout" };
    }

    return { ok: false, status: classifyApplyFailure(result) };
  });
};

export const validatePatch = async (
  input: PatchValidateRequest
): Promise<PatchValidateResponse> => {
  pruneExpiredPatches();

  const validation = await createValidationContext(input);

  if (!validation.ok) {
    return validation.response;
  }

  const patchId = trimUuid(input.patchProposalId) ?? randomUUID();
  const confirmationToken = randomUUID();
  evictOldestPendingPatches();
  pendingPatches.set(patchId, {
    ...validation.context,
    patchId,
    confirmationToken,
    expiresAt: Date.now() + PATCH_PENDING_TTL_MS
  });

  return createValidateResponse({
    status: "ready",
    canApply: true,
    patchId,
    confirmationToken,
    targetFiles: validation.context.targetFiles,
    currentHead: validation.context.currentHead,
    expectedBaseCommit: validation.context.expectedBaseCommit,
    message: `${validation.context.displayName} の対象ファイルを確認しました。承認するとバックアップを作成してから適用します。`
  });
};

export const applyPatch = async (input: PatchApplyRequest): Promise<PatchApplyResponse> => {
  pruneExpiredPatches();

  const pendingPatch = pendingPatches.get(input.patchId);

  if (!pendingPatch || pendingPatch.confirmationToken !== input.confirmationToken) {
    return createApplyResponse({
      request: input,
      status: "stale",
      message: "パッチ確認の有効期限が切れています。もう一度確認してください。"
    });
  }

  try {
    await access(pendingPatch.rootPath, constants.R_OK | constants.W_OK);
  } catch {
    return createApplyResponse({
      request: input,
      status: "permission_denied",
      targetFiles: pendingPatch.targetFiles,
      message: "プロジェクトフォルダに書き込む権限がありません。"
    });
  }

  const headResult = await checkCurrentHead(pendingPatch.rootPath);

  if (headResult.status !== "ok") {
    return createApplyResponse({
      request: input,
      status:
        headResult.status === "missing"
          ? "git_missing"
          : headResult.status === "timeout"
            ? "git_timeout"
            : "failed",
      targetFiles: pendingPatch.targetFiles,
      message: headResult.message
    });
  }

  if (headResult.head !== pendingPatch.currentHead) {
    pendingPatches.delete(input.patchId);
    return createApplyResponse({
      request: input,
      status: "stale",
      targetFiles: pendingPatch.targetFiles,
      message: "確認後に HEAD が変更されました。もう一度パッチを確認してください。"
    });
  }

  const dirtyResult = await checkDirtyTargets(pendingPatch.rootPath, pendingPatch.targetFiles);

  if (dirtyResult.status === "missing") {
    return createApplyResponse({
      request: input,
      status: "git_missing",
      targetFiles: pendingPatch.targetFiles,
      message: "Git が見つかりません。"
    });
  }

  if (dirtyResult.status === "timeout") {
    return createApplyResponse({
      request: input,
      status: "git_timeout",
      targetFiles: pendingPatch.targetFiles,
      message: "作業ツリーの確認がタイムアウトしました。"
    });
  }

  if (dirtyResult.dirty) {
    return createApplyResponse({
      request: input,
      status: "dirty",
      targetFiles: pendingPatch.targetFiles,
      message: "対象ファイルに未コミットの変更があります。先に保存または退避してください。"
    });
  }

  const applyCheck = await checkPatchApplies(pendingPatch.rootPath, pendingPatch.patchText);

  if (!applyCheck.ok) {
    return createApplyResponse({
      request: input,
      status: applyCheck.status,
      targetFiles: pendingPatch.targetFiles,
      message: applyCheck.message
    });
  }

  let backupDirectory: string;
  let backupMetadata: BackupMetadata | null;

  try {
    backupDirectory = await createBackup(
      pendingPatch.rootPath,
      pendingPatch.patchId,
      pendingPatch.targetFiles,
      pendingPatch.currentHead
    );
    backupMetadata = await readBackupMetadata(join(pendingPatch.rootPath, backupDirectory));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return createApplyResponse({
      request: input,
      status: code === "EACCES" || code === "EPERM" ? "permission_denied" : "failed",
      targetFiles: pendingPatch.targetFiles,
      message:
        code === "EACCES" || code === "EPERM"
          ? "バックアップ作成の権限がありません。"
          : "バックアップを作成できませんでした。"
    });
  }

  if (!backupMetadata) {
    return createApplyResponse({
      request: input,
      status: "failed",
      targetFiles: pendingPatch.targetFiles,
      backupDirectory,
      message: "バックアップ情報を確認できませんでした。パッチは適用していません。"
    });
  }

  const applyResult = await applyPatchText(pendingPatch.rootPath, pendingPatch.patchText);

  if (!applyResult.ok) {
    const restoreResult = await restoreBackupEntries(
      pendingPatch.rootPath,
      join(pendingPatch.rootPath, backupDirectory),
      backupMetadata.entries
    );
    pendingPatches.delete(input.patchId);

    return createApplyResponse({
      request: input,
      status: restoreResult.ok ? applyResult.status : restoreResult.status,
      targetFiles: pendingPatch.targetFiles,
      backupDirectory,
      message: restoreResult.ok
        ? applyResult.status === "permission_denied"
          ? "パッチ適用時に権限エラーが発生しました。変更はバックアップから戻しました。"
          : "パッチを適用できませんでした。変更はバックアップから戻しました。"
        : "パッチ適用に失敗し、バックアップからの復元も完了できませんでした。対象ファイルを確認してください。"
    });
  }

  try {
    await recordPostApplyState(pendingPatch.rootPath, backupDirectory, backupMetadata);
  } catch (error) {
    const restoreResult = await restoreBackupEntries(
      pendingPatch.rootPath,
      join(pendingPatch.rootPath, backupDirectory),
      backupMetadata.entries
    );
    const code = (error as NodeJS.ErrnoException).code;
    pendingPatches.delete(input.patchId);

    return createApplyResponse({
      request: input,
      status: code === "EACCES" || code === "EPERM" ? "permission_denied" : "failed",
      targetFiles: pendingPatch.targetFiles,
      backupDirectory,
      message: restoreResult.ok
        ? "適用後の復元情報を保存できなかったため、変更をバックアップから戻しました。"
        : "適用後の復元情報を保存できず、バックアップからの復元も完了できませんでした。対象ファイルを確認してください。"
    });
  }

  pendingPatches.delete(input.patchId);

  return createApplyResponse({
    request: input,
    status: "applied",
    applied: true,
    targetFiles: pendingPatch.targetFiles,
    backupDirectory,
    message: "パッチをローカルファイルに適用しました。"
  });
};

export const revertPatch = async (input: PatchRevertRequest): Promise<PatchRevertResponse> => {
  const localPathHash = input.localPathHash?.trim();

  if (!localPathHash) {
    return createRevertResponse({
      request: input,
      status: "root_missing",
      backupDirectory: null,
      message:
        "ローカルプロジェクトフォルダが登録されていません。プロジェクト設定から選択し直してください。"
    });
  }

  const record = await findSelectedProjectRootByLocalPathHash(localPathHash);

  if (!record) {
    return createRevertResponse({
      request: input,
      status: "root_missing",
      backupDirectory: null,
      message:
        "このプロジェクトのローカルフォルダを確認できません。プロジェクト設定から選択し直してください。"
    });
  }

  try {
    await access(record.rootPath, constants.R_OK | constants.W_OK);
  } catch {
    return createRevertResponse({
      request: input,
      status: "permission_denied",
      backupDirectory: null,
      message: "プロジェクトフォルダに書き込む権限がありません。"
    });
  }

  const backupDirectory = resolveBackupDirectory(
    record.rootPath,
    input.patchId,
    input.backupDirectory
  );

  if (!backupDirectory) {
    return createRevertResponse({
      request: input,
      status: "backup_missing",
      backupDirectory: null,
      message: "取り消し用バックアップの場所を安全に確認できませんでした。"
    });
  }

  const metadata = await readBackupMetadata(backupDirectory.absoluteDirectory);

  if (!metadata || metadata.patchId !== input.patchId) {
    return createRevertResponse({
      request: input,
      status: "backup_missing",
      backupDirectory: backupDirectory.relativeDirectory,
      message: "取り消し用バックアップ情報を確認できませんでした。"
    });
  }

  if (
    metadata.targetFiles.some((targetPath) => {
      return isDeniedTargetPath(targetPath) || !resolveTargetPath(record.rootPath, targetPath);
    }) ||
    metadata.entries.some((entry) => !metadata.targetFiles.includes(entry.path)) ||
    metadata.postApplyEntries?.some((entry) => !metadata.targetFiles.includes(entry.path))
  ) {
    return createRevertResponse({
      request: input,
      status: "failed",
      targetFiles: metadata.targetFiles,
      backupDirectory: backupDirectory.relativeDirectory,
      message: "バックアップ情報の対象ファイルを安全に確認できませんでした。"
    });
  }

  const headResult = await checkCurrentHead(record.rootPath);

  if (headResult.status !== "ok") {
    return createRevertResponse({
      request: input,
      status:
        headResult.status === "missing"
          ? "git_missing"
          : headResult.status === "timeout"
            ? "git_timeout"
            : "failed",
      targetFiles: metadata.targetFiles,
      backupDirectory: backupDirectory.relativeDirectory,
      message: headResult.message
    });
  }

  if (headResult.head !== metadata.currentHead) {
    return createRevertResponse({
      request: input,
      status: "stale",
      targetFiles: metadata.targetFiles,
      backupDirectory: backupDirectory.relativeDirectory,
      message: "パッチ適用後に HEAD が変更されています。手動で差分を確認してください。"
    });
  }

  if (!metadata.postApplyEntries) {
    return createRevertResponse({
      request: input,
      status: "backup_missing",
      targetFiles: metadata.targetFiles,
      backupDirectory: backupDirectory.relativeDirectory,
      message: "適用後の状態情報がないため、自動で取り消せません。"
    });
  }

  for (const expectedEntry of metadata.postApplyEntries) {
    let currentEntry: BackupEntry;

    try {
      currentEntry = await collectBackupEntry(record.rootPath, expectedEntry.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return createRevertResponse({
        request: input,
        status: code === "EACCES" || code === "EPERM" ? "permission_denied" : "failed",
        targetFiles: metadata.targetFiles,
        backupDirectory: backupDirectory.relativeDirectory,
        message: "対象ファイルの現在状態を確認できませんでした。"
      });
    }

    if (!backupEntriesMatch(currentEntry, expectedEntry)) {
      return createRevertResponse({
        request: input,
        status: "dirty",
        targetFiles: metadata.targetFiles,
        backupDirectory: backupDirectory.relativeDirectory,
        message:
          "パッチ適用後に対象ファイルが変更されています。上書き防止のため自動取り消しを停止しました。"
      });
    }
  }

  const restoreResult = await restoreBackupEntries(
    record.rootPath,
    backupDirectory.absoluteDirectory,
    metadata.entries
  );

  if (!restoreResult.ok) {
    return createRevertResponse({
      request: input,
      status: restoreResult.status,
      targetFiles: metadata.targetFiles,
      backupDirectory: backupDirectory.relativeDirectory,
      message:
        restoreResult.status === "permission_denied"
          ? "バックアップから戻す権限がありません。"
          : "バックアップから元に戻せませんでした。対象ファイルを確認してください。"
    });
  }

  return createRevertResponse({
    request: input,
    status: "reverted",
    reverted: true,
    targetFiles: metadata.targetFiles,
    backupDirectory: backupDirectory.relativeDirectory,
    message: "バックアップからパッチ適用前の状態に戻しました。"
  });
};
