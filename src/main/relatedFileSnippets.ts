import electron, { type BrowserWindow, type OpenDialogOptions } from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import type {
  RelatedFileOmission,
  RelatedFileOmissionReason,
  RelatedFileSecretFinding,
  RelatedFileSnippet,
  RelatedFilesSelectRequest,
  RelatedFilesSelectResponse
} from "../shared/ipc";
import { scanSecrets, type SecretScanFinding } from "../shared/secretScanner";
import { canonicalizePath } from "./projectPathIdentity";
import {
  findSelectedProjectRootByLocalPathHash,
  type ProjectRootRecord
} from "./projectRootRegistry";

const { dialog } = electron;

const RELATED_FILE_LIMITS = {
  maxFiles: 8,
  maxBytesPerFile: 24 * 1024,
  maxTotalBytes: 80 * 1024,
  maxLineCount: 260
};

const allowedExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
]);

const allowedFilenames = new Set([
  ".gitignore",
  "Dockerfile",
  "Makefile",
  "Pipfile",
  "README",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "electron.vite.config.ts"
]);

const lockfileNames = new Set([
  "Cargo.lock",
  "Pipfile.lock",
  "bun.lockb",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock"
]);

const languageByExtension = new Map<string, string>([
  [".c", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".go", "go"],
  [".h", "c"],
  [".hpp", "cpp"],
  [".html", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "jsx"],
  [".kt", "kotlin"],
  [".md", "markdown"],
  [".mdx", "mdx"],
  [".mjs", "javascript"],
  [".php", "php"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".swift", "swift"],
  [".toml", "toml"],
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".txt", "text"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".zsh", "shell"]
]);

interface RelatedFileDependencies {
  findProjectRootByLocalPathHash?: (localPathHash: string) => Promise<ProjectRootRecord | null>;
  canonicalizePath?: (path: string) => Promise<string>;
  readFileBytes?: (path: string) => Promise<Buffer>;
  statFile?: typeof stat;
  now?: () => Date;
}

const createLimits = (): RelatedFilesSelectResponse["limits"] => ({
  maxFiles: RELATED_FILE_LIMITS.maxFiles,
  maxBytesPerFile: RELATED_FILE_LIMITS.maxBytesPerFile,
  maxTotalBytes: RELATED_FILE_LIMITS.maxTotalBytes,
  allowedExtensions: [...allowedExtensions].sort(),
  allowedFilenames: [...allowedFilenames].sort()
});

const toRelatedFileFinding = (finding: SecretScanFinding): RelatedFileSecretFinding => ({
  severity: finding.severity,
  sourceLabel: finding.sourceLabel,
  message: finding.message,
  preview: finding.preview,
  lineNumber: finding.lineNumber,
  canAllow: finding.canAllow
});

const createOmission = ({
  path,
  reason,
  message,
  byteLength = null,
  findings = []
}: {
  path: string;
  reason: RelatedFileOmissionReason;
  message: string;
  byteLength?: number | null;
  findings?: RelatedFileSecretFinding[];
}): RelatedFileOmission => ({
  path,
  reason,
  message,
  byteLength,
  findings
});

const normalizeRelativePath = (path: string): string => {
  return path.split(sep).join("/");
};

const isBinaryBuffer = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) {
    return true;
  }

  const decoded = buffer.toString("utf8");
  const replacementCount = [...decoded].filter((character) => character === "\uFFFD").length;
  return replacementCount > Math.max(1, decoded.length * 0.01);
};

const getLanguage = (relativePath: string): string | null => {
  const extension = extname(relativePath).toLowerCase();
  return languageByExtension.get(extension) ?? null;
};

const canReadAsSnippet = (relativePath: string): boolean => {
  const fileName = basename(relativePath);
  const extension = extname(relativePath).toLowerCase();
  return allowedFilenames.has(fileName) || allowedExtensions.has(extension);
};

const resolveProjectRelativePath = async (
  rootPath: string,
  selectedPath: string,
  canonicalizePathInput: (path: string) => Promise<string>
): Promise<{ canonicalPath: string; relativePath: string } | null> => {
  const canonicalRootPath = await canonicalizePathInput(rootPath);
  const canonicalFilePath = await canonicalizePathInput(selectedPath);
  const relativePath = relative(canonicalRootPath, canonicalFilePath);

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return {
    canonicalPath: canonicalFilePath,
    relativePath: normalizeRelativePath(relativePath)
  };
};

const buildResponse = (
  status: RelatedFilesSelectResponse["status"],
  snippets: RelatedFileSnippet[],
  omitted: RelatedFileOmission[],
  selectedAt: string
): RelatedFilesSelectResponse => {
  const message =
    status === "root_missing"
      ? "ローカルフォルダを確認できません。プロジェクト詳細から再接続してください。"
      : status === "cancelled"
        ? "ファイル選択をキャンセルしました。"
        : omitted.length > 0
          ? `${snippets.length} 件を追加し、${omitted.length} 件を除外しました。`
          : `${snippets.length} 件の関連ファイルを追加しました。`;

  return {
    contractVersion: "v1",
    status,
    selectedAt,
    snippets,
    omitted,
    limits: createLimits(),
    message
  };
};

export const collectRelatedFileSnippetsForPaths = async (
  input: RelatedFilesSelectRequest,
  selectedPaths: string[],
  dependencies: RelatedFileDependencies = {}
): Promise<RelatedFilesSelectResponse> => {
  const findProjectRootByLocalPathHash =
    dependencies.findProjectRootByLocalPathHash ?? findSelectedProjectRootByLocalPathHash;
  const canonicalizePathInput = dependencies.canonicalizePath ?? canonicalizePath;
  const readFileBytes = dependencies.readFileBytes ?? readFile;
  const statFile = dependencies.statFile ?? stat;
  const now = dependencies.now ?? (() => new Date());
  const selectedAt = now().toISOString();
  const localPathHash = input.localPathHash?.trim();

  if (!localPathHash) {
    return buildResponse("root_missing", [], [], selectedAt);
  }

  const root = await findProjectRootByLocalPathHash(localPathHash);

  if (!root) {
    return buildResponse("root_missing", [], [], selectedAt);
  }

  const alreadySelectedPaths = new Set(input.alreadySelectedPaths ?? []);
  const seenPaths = new Set<string>();
  const snippets: RelatedFileSnippet[] = [];
  const omitted: RelatedFileOmission[] = [];
  let totalBytes = 0;

  for (const selectedPath of selectedPaths) {
    if (snippets.length >= RELATED_FILE_LIMITS.maxFiles) {
      omitted.push(
        createOmission({
          path: basename(selectedPath) || "unknown",
          reason: "too_many_files",
          message: `関連ファイルは最大 ${RELATED_FILE_LIMITS.maxFiles} 件までです。`
        })
      );
      continue;
    }

    let resolvedPath: { canonicalPath: string; relativePath: string } | null;

    try {
      resolvedPath = await resolveProjectRelativePath(
        root.rootPath,
        selectedPath,
        canonicalizePathInput
      );
    } catch {
      omitted.push(
        createOmission({
          path: basename(selectedPath) || "unknown",
          reason: "read_failed",
          message: "ファイルパスを確認できませんでした。"
        })
      );
      continue;
    }

    if (!resolvedPath) {
      omitted.push(
        createOmission({
          path: basename(selectedPath) || "unknown",
          reason: "outside_root",
          message: "プロジェクト外のファイルは選択できません。"
        })
      );
      continue;
    }

    const { canonicalPath, relativePath } = resolvedPath;

    if (seenPaths.has(relativePath) || alreadySelectedPaths.has(relativePath)) {
      omitted.push(
        createOmission({
          path: relativePath,
          reason: "duplicate",
          message: "すでに追加済みのファイルです。"
        })
      );
      continue;
    }

    seenPaths.add(relativePath);

    const pathScan = scanSecrets({ filePaths: [relativePath] });

    if (pathScan.blocked) {
      omitted.push(
        createOmission({
          path: relativePath,
          reason: "blocked_path",
          message: "送信禁止対象のファイルパスです。",
          findings: pathScan.activeFindings.map(toRelatedFileFinding)
        })
      );
      continue;
    }

    if (lockfileNames.has(basename(relativePath))) {
      omitted.push(
        createOmission({
          path: relativePath,
          reason: "lockfile",
          message: "lockfile は関連ファイル snippet から除外します。"
        })
      );
      continue;
    }

    if (!canReadAsSnippet(relativePath)) {
      omitted.push(
        createOmission({
          path: relativePath,
          reason: "unsupported_extension",
          message: "許可された拡張子またはファイル名ではありません。"
        })
      );
      continue;
    }

    try {
      const fileStat = await statFile(canonicalPath);

      if (!fileStat.isFile()) {
        omitted.push(
          createOmission({
            path: relativePath,
            reason: "not_file",
            message: "通常ファイルではありません。"
          })
        );
        continue;
      }

      if (fileStat.size > RELATED_FILE_LIMITS.maxBytesPerFile) {
        omitted.push(
          createOmission({
            path: relativePath,
            reason: "oversized",
            byteLength: fileStat.size,
            message: `ファイルサイズが ${RELATED_FILE_LIMITS.maxBytesPerFile} bytes を超えています。`
          })
        );
        continue;
      }

      if (totalBytes + fileStat.size > RELATED_FILE_LIMITS.maxTotalBytes) {
        omitted.push(
          createOmission({
            path: relativePath,
            reason: "oversized",
            byteLength: fileStat.size,
            message: `関連ファイル snippet の合計サイズが ${RELATED_FILE_LIMITS.maxTotalBytes} bytes を超えます。`
          })
        );
        continue;
      }

      const fileBuffer = await readFileBytes(canonicalPath);

      if (isBinaryBuffer(fileBuffer)) {
        omitted.push(
          createOmission({
            path: relativePath,
            reason: "binary",
            byteLength: fileStat.size,
            message: "バイナリファイルは関連ファイル snippet から除外します。"
          })
        );
        continue;
      }

      const content = fileBuffer.toString("utf8");
      const lines = content.replace(/\s+$/, "").split(/\r?\n/);
      const truncated = lines.length > RELATED_FILE_LIMITS.maxLineCount;
      const snippetContent = truncated
        ? `${lines.slice(0, RELATED_FILE_LIMITS.maxLineCount).join("\n")}\n`
        : content;
      const contentScan = scanSecrets({
        textEntries: [{ label: relativePath, value: snippetContent }]
      });
      const findings = [...pathScan.activeFindings, ...contentScan.activeFindings].map(
        toRelatedFileFinding
      );

      if (contentScan.blocked) {
        omitted.push(
          createOmission({
            path: relativePath,
            reason: "secret_detected",
            byteLength: fileStat.size,
            message: "ファイル本文に秘密情報候補があるため除外しました。",
            findings
          })
        );
        continue;
      }

      totalBytes += fileStat.size;
      snippets.push({
        path: relativePath,
        language: getLanguage(relativePath),
        content: snippetContent,
        byteLength: fileStat.size,
        lineCount: lines.length,
        truncated,
        warnings: findings.filter((finding) => finding.severity === "warn")
      });
    } catch {
      omitted.push(
        createOmission({
          path: relativePath,
          reason: "read_failed",
          message: "ファイルを読み込めませんでした。"
        })
      );
    }
  }

  return buildResponse(omitted.length > 0 ? "partial" : "ready", snippets, omitted, selectedAt);
};

export const selectRelatedFileSnippets = async (
  ownerWindow: BrowserWindow | null,
  input: RelatedFilesSelectRequest
): Promise<RelatedFilesSelectResponse> => {
  const localPathHash = input.localPathHash?.trim();
  const selectedAt = new Date().toISOString();

  if (!localPathHash) {
    return buildResponse("root_missing", [], [], selectedAt);
  }

  const root = await findSelectedProjectRootByLocalPathHash(localPathHash);

  if (!root) {
    return buildResponse("root_missing", [], [], selectedAt);
  }

  const dialogOptions: OpenDialogOptions = {
    title: "関連ファイルを選択",
    buttonLabel: "snippet に追加",
    defaultPath: root.rootPath,
    properties: ["openFile", "multiSelections"]
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return buildResponse("cancelled", [], [], selectedAt);
  }

  return collectRelatedFileSnippetsForPaths(input, result.filePaths);
};
