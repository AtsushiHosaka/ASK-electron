import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitignoreApplyRequest,
  GitignoreApplyResponse,
  GitignorePreviewRequest,
  GitignorePreviewResponse,
  GitignoreProjectKind,
  GitignoreRecommendationEntry
} from "../shared/ipc";
import { getSelectedProjectRoot } from "./projectRoots";

interface RecommendationTemplate {
  pattern: string;
  reason: string;
  required: boolean;
  kinds: GitignoreProjectKind[];
}

interface PackageJsonLike {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

const askHeader = "# ASK recommended ignores";

const recommendationTemplates: RecommendationTemplate[] = [
  {
    pattern: ".DS_Store",
    reason: "macOS のFinderメタデータをGit管理から外します。",
    required: true,
    kinds: ["generic"]
  },
  {
    pattern: ".env",
    reason: "ローカル秘密情報を含む環境変数ファイルを除外します。",
    required: true,
    kinds: ["generic"]
  },
  {
    pattern: ".env.*",
    reason: ".env.local や .env.production などの派生ファイルを除外します。",
    required: true,
    kinds: ["generic"]
  },
  {
    pattern: "!.env.example",
    reason: "共有用テンプレートだけはGit管理できるようにします。",
    required: false,
    kinds: ["generic"]
  },
  {
    pattern: "*.log",
    reason: "実行ログをGit管理から外します。",
    required: false,
    kinds: ["generic"]
  },
  {
    pattern: "logs/",
    reason: "ログ出力ディレクトリを除外します。",
    required: false,
    kinds: ["generic"]
  },
  {
    pattern: ".cache/",
    reason: "ツールのキャッシュ出力を除外します。",
    required: false,
    kinds: ["generic"]
  },
  {
    pattern: "tmp/",
    reason: "一時ファイルを除外します。",
    required: false,
    kinds: ["generic"]
  },
  {
    pattern: "node_modules/",
    reason: "Node.js の依存パッケージをGit管理から外します。",
    required: true,
    kinds: ["node"]
  },
  {
    pattern: "dist/",
    reason: "ビルド成果物を除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "build/",
    reason: "ビルド成果物を除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "out/",
    reason: "Electron/Vite の出力を除外します。",
    required: false,
    kinds: ["node", "electron"]
  },
  {
    pattern: "coverage/",
    reason: "テストカバレッジ出力を除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "*.tsbuildinfo",
    reason: "TypeScript の増分ビルド情報を除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "npm-debug.log*",
    reason: "npm のデバッグログを除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "yarn-debug.log*",
    reason: "Yarn のデバッグログを除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "yarn-error.log*",
    reason: "Yarn のエラーログを除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "pnpm-debug.log*",
    reason: "pnpm のデバッグログを除外します。",
    required: false,
    kinds: ["node"]
  },
  {
    pattern: "dist-electron/",
    reason: "Electron のビルド出力を除外します。",
    required: false,
    kinds: ["electron"]
  },
  {
    pattern: "release/",
    reason: "配布用パッケージ出力を除外します。",
    required: false,
    kinds: ["electron"]
  },
  {
    pattern: "releases/",
    reason: "配布用パッケージ出力を除外します。",
    required: false,
    kinds: ["electron"]
  },
  {
    pattern: "*.asar",
    reason: "Electron パッケージ成果物を除外します。",
    required: false,
    kinds: ["electron"]
  },
  {
    pattern: "__pycache__/",
    reason: "Python のキャッシュディレクトリを除外します。",
    required: false,
    kinds: ["python"]
  },
  {
    pattern: "*.py[cod]",
    reason: "Python のバイトコードを除外します。",
    required: false,
    kinds: ["python"]
  },
  {
    pattern: ".venv/",
    reason: "Python 仮想環境をGit管理から外します。",
    required: true,
    kinds: ["python"]
  },
  {
    pattern: "venv/",
    reason: "Python 仮想環境をGit管理から外します。",
    required: false,
    kinds: ["python"]
  }
];

const normalizeGitignoreLines = (content: string): Set<string> => {
  return new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
};

const readTextIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const readPackageJson = async (rootPath: string): Promise<PackageJsonLike | null> => {
  const content = await readTextIfExists(join(rootPath, "package.json"));

  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content) as PackageJsonLike;
  } catch {
    return null;
  }
};

const hasDependency = (packageJson: PackageJsonLike | null, name: string): boolean => {
  return Boolean(packageJson?.dependencies?.[name] || packageJson?.devDependencies?.[name]);
};

const detectProjectKinds = async (rootPath: string): Promise<GitignoreProjectKind[]> => {
  const [entries, packageJson] = await Promise.all([readdir(rootPath), readPackageJson(rootPath)]);
  const names = new Set(entries);
  const kinds = new Set<GitignoreProjectKind>(["generic"]);

  if (packageJson || names.has("node_modules") || names.has("vite.config.ts")) {
    kinds.add("node");
  }

  if (
    hasDependency(packageJson, "electron") ||
    hasDependency(packageJson, "electron-vite") ||
    names.has("electron.vite.config.ts") ||
    names.has("electron-builder.yml")
  ) {
    kinds.add("electron");
    kinds.add("node");
  }

  if (
    names.has("requirements.txt") ||
    names.has("pyproject.toml") ||
    names.has("Pipfile") ||
    names.has("poetry.lock")
  ) {
    kinds.add("python");
  }

  return [...kinds];
};

const buildEntries = (
  detectedKinds: GitignoreProjectKind[],
  existingContent: string
): GitignoreRecommendationEntry[] => {
  const kindSet = new Set(detectedKinds);
  const existingPatterns = normalizeGitignoreLines(existingContent);
  const seenPatterns = new Set<string>();

  return recommendationTemplates
    .filter((template) => template.kinds.some((kind) => kindSet.has(kind)))
    .filter((template) => {
      if (seenPatterns.has(template.pattern)) {
        return false;
      }

      seenPatterns.add(template.pattern);
      return true;
    })
    .map((template) => ({
      pattern: template.pattern,
      reason: template.reason,
      required: template.required,
      alreadyPresent: existingPatterns.has(template.pattern)
    }));
};

const buildAppendBlock = (missingPatterns: string[]): string => {
  if (missingPatterns.length === 0) {
    return "";
  }

  return `${askHeader}\n${missingPatterns.join("\n")}\n`;
};

const createRecommendationHash = (
  projectRootId: string,
  existingContent: string,
  appendBlock: string
): string => {
  return createHash("sha256")
    .update(projectRootId)
    .update("\n")
    .update(existingContent)
    .update("\n")
    .update(appendBlock)
    .digest("hex");
};

const buildPreviewDiff = (gitignoreExists: boolean, appendBlock: string): string => {
  if (!appendBlock) {
    return "追加が必要な.gitignore候補はありません。";
  }

  const currentLabel = gitignoreExists ? ".gitignore" : ".gitignore (new file)";
  const addedLines = appendBlock
    .trimEnd()
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");

  return `--- ${currentLabel}\n+++ .gitignore\n@@ append ASK recommendations\n${addedLines}`;
};

export const previewGitignore = async (
  input: GitignorePreviewRequest
): Promise<GitignorePreviewResponse> => {
  const record = getSelectedProjectRoot(input.projectRootId);

  if (!record) {
    throw new Error("PROJECT_ROOT_NOT_FOUND");
  }

  const gitignorePath = join(record.rootPath, ".gitignore");
  const existingGitignore = await readTextIfExists(gitignorePath);
  const existingContent = existingGitignore ?? "";
  const gitignoreExists = existingGitignore !== null;
  const detectedKinds = await detectProjectKinds(record.rootPath);
  const entries = buildEntries(detectedKinds, existingContent);
  const missingPatterns = entries
    .filter((entry) => !entry.alreadyPresent)
    .map((entry) => entry.pattern);
  const appendBlock = buildAppendBlock(missingPatterns);
  const recommendationHash = createRecommendationHash(
    input.projectRootId,
    existingContent,
    appendBlock
  );

  return {
    contractVersion: "v1",
    projectRootId: input.projectRootId,
    displayName: record.displayName,
    detectedKinds,
    gitignoreExists,
    existingLineCount: existingContent ? existingContent.split(/\r?\n/).length : 0,
    recommendationHash,
    entries,
    missingPatterns,
    appendBlock,
    previewDiff: buildPreviewDiff(gitignoreExists, appendBlock),
    manualCopyText: appendBlock,
    canApply: missingPatterns.length > 0
  };
};

export const applyGitignore = async (
  input: GitignoreApplyRequest
): Promise<GitignoreApplyResponse> => {
  const preview = await previewGitignore({ projectRootId: input.projectRootId });

  if (preview.recommendationHash !== input.recommendationHash) {
    return {
      contractVersion: "v1",
      projectRootId: input.projectRootId,
      displayName: preview.displayName,
      status: "stale",
      recommendationHash: preview.recommendationHash,
      appendedLineCount: 0,
      manualCopyText: preview.manualCopyText,
      message: ".gitignore が変更されています。内容を再確認してください。"
    };
  }

  if (!preview.canApply) {
    return {
      contractVersion: "v1",
      projectRootId: input.projectRootId,
      displayName: preview.displayName,
      status: "unchanged",
      recommendationHash: preview.recommendationHash,
      appendedLineCount: 0,
      manualCopyText: "",
      message: "追加が必要な.gitignore候補はありません。"
    };
  }

  const record = getSelectedProjectRoot(input.projectRootId);

  if (!record) {
    throw new Error("PROJECT_ROOT_NOT_FOUND");
  }

  const gitignorePath = join(record.rootPath, ".gitignore");

  try {
    const currentContent = await readTextIfExists(gitignorePath);
    const currentExistingContent = currentContent ?? "";
    const currentDetectedKinds = await detectProjectKinds(record.rootPath);
    const currentEntries = buildEntries(currentDetectedKinds, currentExistingContent);
    const currentMissingPatterns = currentEntries
      .filter((entry) => !entry.alreadyPresent)
      .map((entry) => entry.pattern);
    const currentAppendBlock = buildAppendBlock(currentMissingPatterns);
    const currentRecommendationHash = createRecommendationHash(
      input.projectRootId,
      currentExistingContent,
      currentAppendBlock
    );

    if (!currentAppendBlock || currentContent?.includes(preview.appendBlock.trimEnd())) {
      return {
        contractVersion: "v1",
        projectRootId: input.projectRootId,
        displayName: preview.displayName,
        status: "unchanged",
        recommendationHash: currentRecommendationHash,
        appendedLineCount: 0,
        manualCopyText: "",
        message: "追加が必要な.gitignore候補はありません。"
      };
    }

    if (currentRecommendationHash !== preview.recommendationHash) {
      return {
        contractVersion: "v1",
        projectRootId: input.projectRootId,
        displayName: preview.displayName,
        status: "stale",
        recommendationHash: currentRecommendationHash,
        appendedLineCount: 0,
        manualCopyText: currentAppendBlock,
        message: ".gitignore が変更されています。内容を再確認してください。"
      };
    }

    const prefix = currentContent ? (currentContent.endsWith("\n") ? "\n" : "\n\n") : "";

    if (currentContent !== null && currentContent.length > 0) {
      await appendFile(gitignorePath, `${prefix}${currentAppendBlock}`, "utf8");
    } else {
      await writeFile(gitignorePath, currentAppendBlock, "utf8");
    }

    return {
      contractVersion: "v1",
      projectRootId: input.projectRootId,
      displayName: preview.displayName,
      status: "applied",
      recommendationHash: currentRecommendationHash,
      appendedLineCount: currentAppendBlock.trimEnd().split("\n").length,
      manualCopyText: currentAppendBlock,
      message: ".gitignore に推奨内容を追記しました。"
    };
  } catch {
    return {
      contractVersion: "v1",
      projectRootId: input.projectRootId,
      displayName: preview.displayName,
      status: "failed",
      recommendationHash: preview.recommendationHash,
      appendedLineCount: 0,
      manualCopyText: preview.manualCopyText,
      message: ".gitignore を更新できませんでした。手動コピー用の内容を使ってください。"
    };
  }
};
