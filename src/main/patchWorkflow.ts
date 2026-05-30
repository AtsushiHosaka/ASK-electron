import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join, relative, resolve } from "node:path";
import type {
  PatchApplyRequest,
  PatchApplyResponse,
  PatchApplyStatus,
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
const BACKUP_ROOT_DIRECTORY = ".ask/backups";

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
  linkTarget?: string;
}

const pendingPatches = new Map<string, PendingPatch>();

const trimCommit = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

const pruneExpiredPatches = (): void => {
  const now = Date.now();

  for (const [patchId, patch] of pendingPatches.entries()) {
    if (patch.expiresAt <= now) {
      pendingPatches.delete(patchId);
    }
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
): Promise<{ ok: true } | { ok: false; status: PatchValidationStatus; message: string }> => {
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

const createBackup = async (
  rootPath: string,
  patchId: string,
  targetFiles: string[],
  currentHead: string
): Promise<string> => {
  const backupRelativeDirectory = `${BACKUP_ROOT_DIRECTORY}/${patchId}`;
  const backupDirectory = join(rootPath, backupRelativeDirectory);
  const entries: BackupEntry[] = [];

  await mkdir(backupDirectory, { recursive: true });

  for (const targetPath of targetFiles) {
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

    if (kind === "file" || kind === "directory") {
      const backupPath = join(backupDirectory, ...targetPath.split("/"));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await cp(absoluteTargetPath, backupPath, { recursive: kind === "directory", force: true });
    }

    if (kind === "symlink") {
      entry.linkTarget = await readlink(absoluteTargetPath);
    }

    entries.push(entry);
  }

  await writeFile(
    join(backupDirectory, "metadata.json"),
    `${JSON.stringify(
      {
        patchId,
        currentHead,
        targetFiles,
        entries,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return backupRelativeDirectory;
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

    if (result.status === "timeout") {
      return { ok: false, status: "failed" };
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

  const patchId = randomUUID();
  const confirmationToken = randomUUID();
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

  if (headResult.status !== "ok" || headResult.head !== pendingPatch.currentHead) {
    pendingPatches.delete(input.patchId);
    return createApplyResponse({
      request: input,
      status: "stale",
      targetFiles: pendingPatch.targetFiles,
      message: "確認後に HEAD が変更されました。もう一度パッチを確認してください。"
    });
  }

  const dirtyResult = await checkDirtyTargets(pendingPatch.rootPath, pendingPatch.targetFiles);

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
      status: applyCheck.status === "permission_denied" ? "permission_denied" : "conflict",
      targetFiles: pendingPatch.targetFiles,
      message: applyCheck.message
    });
  }

  let backupDirectory: string;

  try {
    backupDirectory = await createBackup(
      pendingPatch.rootPath,
      pendingPatch.patchId,
      pendingPatch.targetFiles,
      pendingPatch.currentHead
    );
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

  const applyResult = await applyPatchText(pendingPatch.rootPath, pendingPatch.patchText);

  if (!applyResult.ok) {
    return createApplyResponse({
      request: input,
      status: applyResult.status,
      targetFiles: pendingPatch.targetFiles,
      backupDirectory,
      message:
        applyResult.status === "permission_denied"
          ? "パッチ適用時に権限エラーが発生しました。"
          : "パッチを適用できませんでした。バックアップは作成済みです。"
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
