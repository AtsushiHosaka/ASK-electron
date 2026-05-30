import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { arch, release, type } from "node:os";
import { join } from "node:path";
import type {
  DependencyGroupSummary,
  EnvironmentSnapshotRequest,
  EnvironmentSnapshotResponse,
  ManifestDependencySummary,
  VersionProbe
} from "../shared/ipc";
import {
  findSelectedProjectRootByLocalPathHash,
  getSelectedProjectRoot,
  type ProjectRootRecord
} from "./projectRoots";

const COMMAND_TIMEOUT_MS = 3_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_LENGTH = 1_000;
const DEPENDENCY_SAMPLE_LIMIT = 20;
const MAX_MANIFEST_BYTES = 128 * 1024;

const NODE_LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
];
const PYTHON_MANIFESTS = ["requirements.txt", "requirements-dev.txt", "pyproject.toml"];
const PYTHON_LOCKFILES = ["poetry.lock", "Pipfile.lock"];

interface CommandResult {
  status: "completed" | "missing" | "timeout" | "error";
  stdout: string;
  stderr: string;
}

const sanitizeOutput = (value: string): string => {
  return value
    .split("")
    .filter((char) => {
      const codePoint = char.charCodeAt(0);
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("")
    .slice(0, MAX_COMMAND_OUTPUT_LENGTH)
    .trim();
};

const runCommand = (
  executable: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<CommandResult> => {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const cleanStdout = sanitizeOutput(stdout);
        const cleanStderr = sanitizeOutput(stderr);

        if (!error) {
          resolve({
            status: "completed",
            stdout: cleanStdout,
            stderr: cleanStderr
          });
          return;
        }

        const commandError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
          code?: string | number | null;
        };

        if (commandError.code === "ENOENT") {
          resolve({
            status: "missing",
            stdout: cleanStdout,
            stderr: cleanStderr
          });
          return;
        }

        if (commandError.killed || commandError.signal === "SIGTERM") {
          resolve({
            status: "timeout",
            stdout: cleanStdout,
            stderr: cleanStderr
          });
          return;
        }

        resolve({
          status: "error",
          stdout: cleanStdout,
          stderr: cleanStderr
        });
      }
    );
  });
};

const firstOutputLine = (result: CommandResult): string | null => {
  if (result.status !== "completed") {
    return null;
  }

  return (
    [result.stdout, result.stderr]
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
};

const versionProbeFromCommand = async (
  executable: string,
  args: string[],
  normalize: (line: string) => string | null = (line) => line
): Promise<VersionProbe> => {
  const result = await runCommand(executable, args);
  const line = firstOutputLine(result);
  const version = line ? normalize(line) : null;

  return {
    available: Boolean(version),
    version
  };
};

const normalizePrefixedVersion =
  (prefix: RegExp) =>
  (line: string): string | null => {
    return line.replace(prefix, "").trim() || null;
  };

const summarizeDependencyNames = (value: unknown): DependencyGroupSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { count: 0, sample: [] };
  }

  const names = Object.keys(value).sort((left, right) => left.localeCompare(right));

  return {
    count: names.length,
    sample: names.slice(0, DEPENDENCY_SAMPLE_LIMIT)
  };
};

const safePackageName = (value: unknown): string | null => {
  if (typeof value !== "string" || value.includes("\\") || value.includes("..")) {
    return null;
  }

  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]{1,120}$/i.test(value) ? value : null;
};

const readSmallTextFile = async (
  rootPath: string,
  relativePath: string
): Promise<string | null> => {
  try {
    const text = await readFile(join(rootPath, relativePath), "utf8");
    return text.slice(0, MAX_MANIFEST_BYTES);
  } catch {
    return null;
  }
};

const fileExists = async (rootPath: string, relativePath: string): Promise<boolean> => {
  try {
    await access(join(rootPath, relativePath));
    return true;
  } catch {
    return false;
  }
};

const readPackageJsonSummary = async (
  rootPath: string
): Promise<ManifestDependencySummary | null> => {
  const text = await readSmallTextFile(rootPath, "package.json");

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;

    return {
      file: "package.json",
      kind: "node",
      name: safePackageName(parsed.name),
      dependencies: summarizeDependencyNames(parsed.dependencies),
      devDependencies: summarizeDependencyNames(parsed.devDependencies)
    };
  } catch {
    return {
      file: "package.json",
      kind: "node",
      name: null,
      dependencies: { count: 0, sample: [] },
      devDependencies: { count: 0, sample: [] }
    };
  }
};

const parseRequirementName = (line: string): string | null => {
  const cleaned = line.split("#")[0]?.trim() ?? "";

  if (!cleaned || cleaned.startsWith("-") || cleaned.includes("/") || cleaned.includes("://")) {
    return null;
  }

  return cleaned.match(/^([A-Za-z0-9_.-]+)/)?.[1] ?? null;
};

const readRequirementsSummary = async (
  rootPath: string,
  relativePath: string
): Promise<ManifestDependencySummary | null> => {
  const text = await readSmallTextFile(rootPath, relativePath);

  if (!text) {
    return null;
  }

  const names = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map(parseRequirementName)
        .filter((name): name is string => Boolean(name))
    )
  ].sort((left, right) => left.localeCompare(right));

  return {
    file: relativePath,
    kind: "python",
    name: null,
    dependencies: {
      count: names.length,
      sample: names.slice(0, DEPENDENCY_SAMPLE_LIMIT)
    },
    devDependencies: { count: 0, sample: [] }
  };
};

const readPyprojectSummary = async (
  rootPath: string
): Promise<ManifestDependencySummary | null> => {
  const text = await readSmallTextFile(rootPath, "pyproject.toml");

  if (!text) {
    return null;
  }

  const name = text.match(/^\s*name\s*=\s*"([^"]{1,120})"/m)?.[1] ?? null;

  return {
    file: "pyproject.toml",
    kind: "python",
    name: safePackageName(name),
    dependencies: { count: 0, sample: [] },
    devDependencies: { count: 0, sample: [] }
  };
};

const collectDependencySummary = async (
  record: ProjectRootRecord | null
): Promise<EnvironmentSnapshotResponse["dependenciesSummary"]> => {
  if (!record) {
    return {
      projectDetected: false,
      manifests: [],
      lockfiles: [],
      warnings: ["ローカルフォルダ未選択のため依存関係概要は未収集です。"]
    };
  }

  const [packageJson, pyproject, requirementSummaries, lockfileChecks] = await Promise.all([
    readPackageJsonSummary(record.rootPath),
    readPyprojectSummary(record.rootPath),
    Promise.all(
      PYTHON_MANIFESTS.filter((file) => file !== "pyproject.toml").map((file) =>
        readRequirementsSummary(record.rootPath, file)
      )
    ),
    Promise.all(
      [...NODE_LOCKFILES, ...PYTHON_LOCKFILES].map(async (file) => ({
        file,
        exists: await fileExists(record.rootPath, file)
      }))
    )
  ]);
  const manifests = [packageJson, pyproject, ...requirementSummaries].filter(
    (summary): summary is ManifestDependencySummary => Boolean(summary)
  );

  return {
    projectDetected: true,
    manifests,
    lockfiles: lockfileChecks.filter((entry) => entry.exists).map((entry) => entry.file),
    warnings: []
  };
};

const detectEditor = async (): Promise<EnvironmentSnapshotResponse["editor"]> => {
  if (process.env.TERM_PROGRAM === "vscode") {
    return {
      name: "Visual Studio Code",
      version: process.env.TERM_PROGRAM_VERSION ?? null
    };
  }

  const [code, cursor] = await Promise.all([
    runCommand("code", ["--version"], 2_000),
    runCommand("cursor", ["--version"], 2_000)
  ]);
  const codeLine = firstOutputLine(code);

  if (codeLine) {
    return {
      name: "Visual Studio Code",
      version: codeLine
    };
  }

  const cursorLine = firstOutputLine(cursor);

  if (cursorLine) {
    return {
      name: "Cursor",
      version: cursorLine
    };
  }

  return {
    name: null,
    version: null
  };
};

const resolveProjectRoot = async (
  input: EnvironmentSnapshotRequest
): Promise<ProjectRootRecord | null> => {
  const projectRootId = input.projectRootId?.trim();

  if (projectRootId) {
    return getSelectedProjectRoot(projectRootId);
  }

  const localPathHash = input.localPathHash?.trim();

  if (localPathHash) {
    return findSelectedProjectRootByLocalPathHash(localPathHash);
  }

  return null;
};

export const collectEnvironmentSnapshot = async (
  input: EnvironmentSnapshotRequest
): Promise<EnvironmentSnapshotResponse> => {
  const record = await resolveProjectRoot(input);
  const [git, npm, pnpm, yarn, python3, python, pip3, pip, editor, dependenciesSummary] =
    await Promise.all([
      versionProbeFromCommand("git", ["--version"], normalizePrefixedVersion(/^git version\s+/i)),
      versionProbeFromCommand("npm", ["--version"]),
      versionProbeFromCommand("pnpm", ["--version"]),
      versionProbeFromCommand("yarn", ["--version"]),
      versionProbeFromCommand("python3", ["--version"], normalizePrefixedVersion(/^python\s+/i)),
      versionProbeFromCommand("python", ["--version"], normalizePrefixedVersion(/^python\s+/i)),
      versionProbeFromCommand(
        "pip3",
        ["--version"],
        (line) => line.match(/^pip\s+([^\s]+)/i)?.[1] ?? null
      ),
      versionProbeFromCommand(
        "pip",
        ["--version"],
        (line) => line.match(/^pip\s+([^\s]+)/i)?.[1] ?? null
      ),
      detectEditor(),
      collectDependencySummary(record)
    ]);
  const pythonProbe = python3.available ? python3 : python;
  const pipProbe = pip3.available ? pip3 : pip;
  const warnings = [...dependenciesSummary.warnings];

  if (!record) {
    warnings.push("ローカルフォルダ未選択のためプロジェクト固有情報は未収集です。");
  }

  return {
    contractVersion: "v1",
    status: warnings.length > 0 ? "partial" : "ready",
    collectedAt: new Date().toISOString(),
    canContinue: true,
    projectRootId: record?.id ?? null,
    displayName: record?.displayName ?? null,
    os: {
      name: type(),
      version: release(),
      arch: arch()
    },
    gitVersion: git.version,
    editor,
    runtimes: {
      node: {
        available: true,
        version: process.version.replace(/^v/, "")
      },
      python: pythonProbe
    },
    packageManagers: {
      npm,
      pnpm,
      yarn,
      pip: pipProbe
    },
    dependenciesSummary,
    warnings,
    limits: {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      dependencySampleLimit: DEPENDENCY_SAMPLE_LIMIT
    },
    message:
      warnings.length > 0
        ? "環境情報を一部収集しました。未収集項目があっても質問作成は継続できます。"
        : "環境情報を収集しました。"
  };
};
