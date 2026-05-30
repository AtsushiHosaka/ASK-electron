import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative } from "node:path";
import type {
  RelatedFileSelectionRequest,
  RelatedFileSelectionResponse,
  RelatedFileSnippet,
  RelatedFileSnippetOmissionReason
} from "../shared/ipc";
import { scanSecrets } from "../shared/secretScanner";
import { canonicalizePath } from "./projectPathIdentity";
import {
  findSelectedProjectRootByLocalPathHash,
  type ProjectRootRecord
} from "./projectRootRegistry";

export const RELATED_FILE_SNIPPET_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 64 * 1024,
  maxSnippetChars: 12_000
} as const;

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "yarn.lock"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".rar",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tiff",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip"
]);

const ALLOWED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".lock.sample",
  ".mjs",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const ALLOWED_FILE_NAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc",
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "Makefile",
  "Procfile",
  "README",
  "Rakefile"
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".c", "c"],
  [".cc", "cpp"],
  [".conf", "conf"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".csv", "csv"],
  [".go", "go"],
  [".h", "c"],
  [".hpp", "cpp"],
  [".html", "html"],
  [".java", "java"],
  [".js", "js"],
  [".json", "json"],
  [".jsx", "jsx"],
  [".kt", "kotlin"],
  [".mjs", "js"],
  [".md", "md"],
  [".php", "php"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".sass", "sass"],
  [".scss", "scss"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".svelte", "svelte"],
  [".swift", "swift"],
  [".toml", "toml"],
  [".ts", "ts"],
  [".tsx", "tsx"],
  [".txt", "text"],
  [".vue", "vue"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"]
]);

interface RelatedFileSnippetDependencies {
  findProjectRootByLocalPathHash: (localPathHash: string) => Promise<ProjectRootRecord | null>;
  now: () => Date;
}

const defaultDependencies: RelatedFileSnippetDependencies = {
  findProjectRootByLocalPathHash: findSelectedProjectRootByLocalPathHash,
  now: () => new Date()
};

const createBaseResponse = (
  status: RelatedFileSelectionResponse["status"],
  message: string,
  overrides: Partial<RelatedFileSelectionResponse> = {}
): RelatedFileSelectionResponse => ({
  contractVersion: "v1",
  status,
  canContinue: true,
  projectRootId: null,
  displayName: null,
  selectedAt: new Date().toISOString(),
  snippets: [],
  limits: RELATED_FILE_SNIPPET_LIMITS,
  message,
  ...overrides
});

const normalizeRelativePath = (path: string): string => path.replaceAll("\\", "/");

const getExtension = (relativePath: string): string => {
  const lowerName = basename(relativePath).toLowerCase();
  if (lowerName.endsWith(".lock.sample")) {
    return ".lock.sample";
  }

  return extname(lowerName);
};

const getLanguage = (relativePath: string): string | null => {
  const name = basename(relativePath);
  if (name === "Dockerfile") {
    return "dockerfile";
  }

  if (name === "Makefile") {
    return "makefile";
  }

  return LANGUAGE_BY_EXTENSION.get(getExtension(relativePath)) ?? null;
};

const isLockfilePath = (relativePath: string): boolean => {
  return LOCKFILE_NAMES.has(basename(relativePath));
};

const isAllowedTextPath = (relativePath: string): boolean => {
  const name = basename(relativePath);
  return ALLOWED_FILE_NAMES.has(name) || ALLOWED_EXTENSIONS.has(getExtension(relativePath));
};

const hasBinaryMarker = (buffer: Buffer): boolean => {
  if (buffer.includes(0)) {
    return true;
  }

  const decoded = buffer.toString("utf8");
  const replacementCount = decoded.match(/\uFFFD/g)?.length ?? 0;
  return replacementCount > 8 && replacementCount / Math.max(decoded.length, 1) > 0.01;
};

const createOmittedSnippet = (
  relativePath: string,
  reason: RelatedFileSnippetOmissionReason,
  message: string,
  overrides: Partial<RelatedFileSnippet> = {}
): RelatedFileSnippet => ({
  relativePath,
  language: getLanguage(relativePath),
  sizeBytes: null,
  status: reason === "blocked_path" || reason === "secret_detected" ? "blocked" : "omitted",
  omissionReason: reason,
  message,
  content: "",
  truncated: false,
  ...overrides
});

const getInsideRootRelativePath = async (
  rootPath: string,
  selectedFilePath: string
): Promise<{ relativePath: string; canonicalFilePath: string } | null> => {
  const [canonicalRootPath, canonicalFilePath] = await Promise.all([
    canonicalizePath(rootPath),
    canonicalizePath(selectedFilePath)
  ]);
  const relativePath = normalizeRelativePath(relative(canonicalRootPath, canonicalFilePath));

  if (
    !relativePath ||
    relativePath.startsWith("../") ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    return null;
  }

  return { relativePath, canonicalFilePath };
};

const collectSingleSnippet = async (
  rootPath: string,
  selectedFilePath: string
): Promise<RelatedFileSnippet> => {
  const fallbackName = basename(selectedFilePath) || "選択ファイル";
  const insideRoot = await getInsideRootRelativePath(rootPath, selectedFilePath);

  if (!insideRoot) {
    return createOmittedSnippet(
      `project外:${fallbackName}`,
      "outside_root",
      "プロジェクトフォルダ外のため除外しました。"
    );
  }

  const { relativePath, canonicalFilePath } = insideRoot;
  const pathScan = scanSecrets({ filePaths: [relativePath] });

  if (pathScan.blocked) {
    return createOmittedSnippet(
      relativePath,
      "blocked_path",
      "送信禁止対象のファイルパスのため除外しました。"
    );
  }

  if (isLockfilePath(relativePath)) {
    return createOmittedSnippet(relativePath, "lockfile", "lockfile のため除外しました。");
  }

  if (BINARY_EXTENSIONS.has(getExtension(relativePath))) {
    return createOmittedSnippet(relativePath, "binary", "binary file のため除外しました。");
  }

  if (!isAllowedTextPath(relativePath)) {
    return createOmittedSnippet(
      relativePath,
      "unsupported_extension",
      "許可されていない拡張子のため除外しました。"
    );
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;

  try {
    fileStat = await stat(canonicalFilePath);
  } catch {
    return createOmittedSnippet(relativePath, "read_failed", "ファイルを読み込めませんでした。");
  }

  if (!fileStat.isFile()) {
    return createOmittedSnippet(
      relativePath,
      "read_failed",
      "通常ファイルではないため除外しました。"
    );
  }

  if (fileStat.size > RELATED_FILE_SNIPPET_LIMITS.maxFileBytes) {
    return createOmittedSnippet(
      relativePath,
      "oversized",
      "サイズ上限を超えたため本文を除外しました。",
      { sizeBytes: fileStat.size }
    );
  }

  let buffer: Buffer;

  try {
    buffer = await readFile(canonicalFilePath);
  } catch {
    return createOmittedSnippet(relativePath, "read_failed", "ファイルを読み込めませんでした。", {
      sizeBytes: fileStat.size
    });
  }

  if (hasBinaryMarker(buffer)) {
    return createOmittedSnippet(relativePath, "binary", "binary file のため除外しました。", {
      sizeBytes: fileStat.size
    });
  }

  const fullContent = buffer.toString("utf8");
  const truncated = fullContent.length > RELATED_FILE_SNIPPET_LIMITS.maxSnippetChars;
  const content = truncated
    ? `${fullContent.slice(0, RELATED_FILE_SNIPPET_LIMITS.maxSnippetChars)}\n\n[snippet truncated at ${RELATED_FILE_SNIPPET_LIMITS.maxSnippetChars} chars]`
    : fullContent;
  const contentScan = scanSecrets({
    filePaths: [relativePath],
    textEntries: [{ label: relativePath, value: content }]
  });

  if (contentScan.blocked) {
    return createOmittedSnippet(
      relativePath,
      "secret_detected",
      "秘密情報候補を検出したため本文を除外しました。",
      { sizeBytes: fileStat.size }
    );
  }

  return {
    relativePath,
    language: getLanguage(relativePath),
    sizeBytes: fileStat.size,
    status: "included",
    omissionReason: null,
    message: truncated ? "本文を上限内に切り詰めました。" : "本文を送信候補に追加しました。",
    content,
    truncated
  };
};

const resolveProjectRoot = async (
  input: RelatedFileSelectionRequest,
  dependencies: RelatedFileSnippetDependencies
): Promise<ProjectRootRecord | null> => {
  const localPathHash = input.localPathHash?.trim();

  if (!localPathHash) {
    return null;
  }

  return dependencies.findProjectRootByLocalPathHash(localPathHash);
};

export const createRelatedFileCanceledResponse = (
  root: ProjectRootRecord,
  now = new Date()
): RelatedFileSelectionResponse =>
  createBaseResponse("canceled", "関連ファイルの選択をキャンセルしました。", {
    projectRootId: root.id,
    displayName: root.displayName,
    selectedAt: now.toISOString()
  });

export const resolveRelatedFileProjectRoot = async (
  input: RelatedFileSelectionRequest,
  dependencies: RelatedFileSnippetDependencies = defaultDependencies
): Promise<ProjectRootRecord | null> => resolveProjectRoot(input, dependencies);

export const collectRelatedFileSnippetsWithDependencies = async (
  input: RelatedFileSelectionRequest,
  selectedFilePaths: string[],
  dependencies: RelatedFileSnippetDependencies = defaultDependencies,
  rootOverride?: ProjectRootRecord | null
): Promise<RelatedFileSelectionResponse> => {
  const selectedAt = dependencies.now().toISOString();
  const root = rootOverride ?? (await resolveProjectRoot(input, dependencies));

  if (!root) {
    return createBaseResponse("root_missing", "ローカルフォルダが未接続です。", {
      selectedAt
    });
  }

  const uniquePaths = [...new Set(selectedFilePaths)];
  const limitedPaths = uniquePaths.slice(0, RELATED_FILE_SNIPPET_LIMITS.maxFiles);
  const snippets = await Promise.all(
    limitedPaths.map((path) => collectSingleSnippet(root.rootPath, path))
  );
  const omittedByCount = uniquePaths
    .slice(RELATED_FILE_SNIPPET_LIMITS.maxFiles)
    .map((path) =>
      createOmittedSnippet(
        basename(path) || "選択ファイル",
        "too_many_files",
        "選択数の上限を超えたため除外しました。"
      )
    );
  const allSnippets = [...snippets, ...omittedByCount];
  const includedCount = allSnippets.filter((snippet) => snippet.status === "included").length;
  const omittedCount = allSnippets.length - includedCount;

  return createBaseResponse(
    "ready",
    `関連ファイル ${includedCount} 件を送信候補に追加しました。除外 ${omittedCount} 件。`,
    {
      projectRootId: root.id,
      displayName: root.displayName,
      selectedAt,
      snippets: allSnippets
    }
  );
};

export const collectRelatedFileSnippets = async (
  input: RelatedFileSelectionRequest,
  selectedFilePaths: string[],
  rootOverride?: ProjectRootRecord | null
): Promise<RelatedFileSelectionResponse> =>
  collectRelatedFileSnippetsWithDependencies(
    input,
    selectedFilePaths,
    defaultDependencies,
    rootOverride
  );
