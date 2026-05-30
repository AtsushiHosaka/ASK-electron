import { execFile } from "node:child_process";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitDiagnostic,
  GitHubCliDiagnostic,
  LocalDiagnosticsResponse,
  SshConnectionDiagnostic,
  SshKeyCandidate,
  SshKeyDiagnostic
} from "../shared/ipc";

const DEFAULT_TIMEOUT_MS = 5_000;
const SSH_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_LENGTH = 4_000;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type CommandResult =
  | {
      status: "completed";
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | {
      status: "missing" | "timeout" | "error";
      stdout: string;
      stderr: string;
      durationMs: number;
      errorCode: string | null;
    };

type FixedCommandRunner = (
  executable: string,
  args: string[],
  timeoutMs?: number
) => Promise<CommandResult>;

export interface DirectoryEntryLike {
  name: string;
  isFile: () => boolean;
}

export interface LocalDiagnosticsDependencies {
  runFixedCommand?: FixedCommandRunner;
  readDirectory?: (path: string) => Promise<DirectoryEntryLike[]>;
  makeTempDir?: (prefix: string) => Promise<string>;
  removeDirectory?: (path: string) => Promise<void>;
  homeDirectory?: () => string;
  temporaryDirectory?: () => string;
  now?: () => Date;
}

interface ResolvedLocalDiagnosticsDependencies {
  runFixedCommand: FixedCommandRunner;
  readDirectory: (path: string) => Promise<DirectoryEntryLike[]>;
  makeTempDir: (prefix: string) => Promise<string>;
  removeDirectory: (path: string) => Promise<void>;
  homeDirectory: () => string;
  temporaryDirectory: () => string;
  now: () => Date;
}

const sanitizeOutput = (value: string): string => {
  return value
    .replace(ansiEscapePattern, "")
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
    .slice(0, MAX_OUTPUT_LENGTH)
    .trim();
};

const runFixedCommand = (
  executable: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CommandResult> => {
  const startedAt = Date.now();

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
        const durationMs = Date.now() - startedAt;
        const cleanStdout = sanitizeOutput(stdout);
        const cleanStderr = sanitizeOutput(stderr);

        if (!error) {
          resolve({
            status: "completed",
            exitCode: 0,
            stdout: cleanStdout,
            stderr: cleanStderr,
            durationMs
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
            stderr: cleanStderr,
            durationMs,
            errorCode: "ENOENT"
          });
          return;
        }

        if (commandError.killed || commandError.signal === "SIGTERM") {
          resolve({
            status: "timeout",
            stdout: cleanStdout,
            stderr: cleanStderr,
            durationMs,
            errorCode: "TIMEOUT"
          });
          return;
        }

        if (typeof commandError.code === "number") {
          resolve({
            status: "completed",
            exitCode: commandError.code,
            stdout: cleanStdout,
            stderr: cleanStderr,
            durationMs
          });
          return;
        }

        resolve({
          status: "error",
          stdout: cleanStdout,
          stderr: cleanStderr,
          durationMs,
          errorCode: typeof commandError.code === "string" ? commandError.code : null
        });
      }
    );
  });
};

const resolveDependencies = (
  dependencies: LocalDiagnosticsDependencies
): ResolvedLocalDiagnosticsDependencies => ({
  runFixedCommand: dependencies.runFixedCommand ?? runFixedCommand,
  readDirectory: dependencies.readDirectory ?? ((path) => readdir(path, { withFileTypes: true })),
  makeTempDir: dependencies.makeTempDir ?? mkdtemp,
  removeDirectory:
    dependencies.removeDirectory ??
    ((path) => rm(path, { recursive: true, force: true }).then(() => undefined)),
  homeDirectory: dependencies.homeDirectory ?? homedir,
  temporaryDirectory: dependencies.temporaryDirectory ?? tmpdir,
  now: dependencies.now ?? (() => new Date())
});

const commandOutput = (result: CommandResult): string => {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
};

const isNetworkFailure = (output: string): boolean => {
  return /could not resolve|network is unreachable|no route to host|connection timed out|operation timed out|connection refused|i\/o timeout|tls handshake timeout|temporary failure/i.test(
    output
  );
};

const detectKeyType = (name: string): SshKeyCandidate["keyType"] => {
  if (name.includes("ed25519")) {
    return "ed25519";
  }

  if (name.includes("ecdsa")) {
    return "ecdsa";
  }

  if (name.includes("rsa")) {
    return "rsa";
  }

  if (name.includes("dsa")) {
    return "dsa";
  }

  return "unknown";
};

const standardPrivateKeyNames = new Set(["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"]);

const diagnoseGit = async (
  dependencies: ResolvedLocalDiagnosticsDependencies
): Promise<GitDiagnostic> => {
  const result = await dependencies.runFixedCommand("git", ["--version"]);

  if (result.status === "missing") {
    return {
      status: "missing",
      installed: false,
      version: null,
      message: "Git が見つかりません。"
    };
  }

  if (result.status === "timeout") {
    return {
      status: "timeout",
      installed: false,
      version: null,
      message: "Git の確認がタイムアウトしました。"
    };
  }

  if (result.status !== "completed" || result.exitCode !== 0) {
    return {
      status: "error",
      installed: false,
      version: null,
      message: "Git のバージョンを確認できませんでした。"
    };
  }

  const version = result.stdout.match(/git version\s+(.+)/i)?.[1]?.trim() ?? result.stdout;

  return {
    status: "ok",
    installed: true,
    version,
    message: "Git を利用できます。"
  };
};

const parseGitHubAccount = (output: string): string | null => {
  return output.match(/Logged in to github\.com account ([^\s]+)/i)?.[1] ?? null;
};

const diagnoseGitHubCli = async (
  dependencies: ResolvedLocalDiagnosticsDependencies
): Promise<GitHubCliDiagnostic> => {
  const versionResult = await dependencies.runFixedCommand("gh", ["--version"]);

  if (versionResult.status === "missing") {
    return {
      status: "missing",
      installed: false,
      version: null,
      authenticated: false,
      account: null,
      message: "GitHub CLI が見つかりません。"
    };
  }

  if (versionResult.status === "timeout") {
    return {
      status: "timeout",
      installed: false,
      version: null,
      authenticated: false,
      account: null,
      message: "GitHub CLI の確認がタイムアウトしました。"
    };
  }

  if (versionResult.status !== "completed" || versionResult.exitCode !== 0) {
    return {
      status: "error",
      installed: false,
      version: null,
      authenticated: false,
      account: null,
      message: "GitHub CLI のバージョンを確認できませんでした。"
    };
  }

  const version =
    versionResult.stdout
      .split("\n")[0]
      ?.replace(/^gh version\s+/i, "")
      .trim() || null;
  const authResult = await dependencies.runFixedCommand("gh", [
    "auth",
    "status",
    "--hostname",
    "github.com"
  ]);
  const output = commandOutput(authResult);

  if (authResult.status === "timeout") {
    return {
      status: "timeout",
      installed: true,
      version,
      authenticated: false,
      account: null,
      message: "GitHub CLI の認証確認がタイムアウトしました。"
    };
  }

  if (authResult.status === "missing") {
    return {
      status: "missing",
      installed: false,
      version: null,
      authenticated: false,
      account: null,
      message: "GitHub CLI が見つかりません。"
    };
  }

  if (isNetworkFailure(output)) {
    return {
      status: "network_error",
      installed: true,
      version,
      authenticated: false,
      account: null,
      message: "GitHub CLI はありますが、GitHub への接続確認に失敗しました。"
    };
  }

  if (authResult.status === "completed" && authResult.exitCode === 0) {
    return {
      status: "ok",
      installed: true,
      version,
      authenticated: true,
      account: parseGitHubAccount(output),
      message: "GitHub CLI は認証済みです。"
    };
  }

  if (
    /not logged into|not authenticated|no oauth token|authentication required|run: gh auth login/i.test(
      output
    )
  ) {
    return {
      status: "unauthenticated",
      installed: true,
      version,
      authenticated: false,
      account: null,
      message: "GitHub CLI は未認証です。"
    };
  }

  return {
    status: "unknown",
    installed: true,
    version,
    authenticated: false,
    account: null,
    message: "GitHub CLI の認証状態を判定できませんでした。"
  };
};

const diagnoseSshKeys = async (
  dependencies: ResolvedLocalDiagnosticsDependencies
): Promise<SshKeyDiagnostic> => {
  try {
    const entries = await dependencies.readDirectory(join(dependencies.homeDirectory(), ".ssh"));
    const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const candidates = new Map<string, SshKeyCandidate>();

    for (const fileName of fileNames) {
      if (fileName.endsWith(".pub")) {
        const privateName = fileName.slice(0, -4);
        candidates.set(privateName, {
          name: privateName,
          keyType: detectKeyType(privateName),
          hasPublicKey: true,
          hasPrivateKeyCandidate: fileNames.has(privateName)
        });
        continue;
      }

      if (standardPrivateKeyNames.has(fileName)) {
        candidates.set(fileName, {
          name: fileName,
          keyType: detectKeyType(fileName),
          hasPublicKey: fileNames.has(`${fileName}.pub`),
          hasPrivateKeyCandidate: true
        });
      }
    }

    const sortedCandidates = [...candidates.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );

    if (sortedCandidates.length === 0) {
      return {
        status: "missing",
        candidateCount: 0,
        candidates: [],
        message: "SSH 鍵候補が見つかりません。"
      };
    }

    return {
      status: "ok",
      candidateCount: sortedCandidates.length,
      candidates: sortedCandidates,
      message: "SSH 鍵候補が見つかりました。"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        candidateCount: 0,
        candidates: [],
        message: "SSH 設定ディレクトリが見つかりません。"
      };
    }

    return {
      status: "error",
      candidateCount: 0,
      candidates: [],
      message: "SSH 鍵候補を確認できませんでした。"
    };
  }
};

const diagnoseSshConnection = async (
  dependencies: ResolvedLocalDiagnosticsDependencies
): Promise<SshConnectionDiagnostic> => {
  const tempDir = await dependencies.makeTempDir(
    join(dependencies.temporaryDirectory(), "ask-ssh-")
  );
  const knownHostsPath = join(tempDir, "known_hosts");

  try {
    const result = await dependencies.runFixedCommand(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "git@github.com"
      ],
      SSH_TIMEOUT_MS
    );
    const output = commandOutput(result);

    if (result.status === "missing") {
      return {
        status: "missing",
        authenticated: false,
        account: null,
        message: "ssh コマンドが見つかりません。"
      };
    }

    if (result.status === "timeout") {
      return {
        status: "timeout",
        authenticated: false,
        account: null,
        message: "GitHub SSH 接続確認がタイムアウトしました。"
      };
    }

    if (/successfully authenticated/i.test(output)) {
      return {
        status: "ok",
        authenticated: true,
        account: output.match(/Hi ([^!]+)!/)?.[1] ?? null,
        message: "GitHub SSH 認証に成功しました。"
      };
    }

    if (/host key verification failed/i.test(output)) {
      return {
        status: "host_key_failed",
        authenticated: false,
        account: null,
        message: "GitHub SSH のホスト鍵確認に失敗しました。"
      };
    }

    if (isNetworkFailure(output)) {
      return {
        status: "network_error",
        authenticated: false,
        account: null,
        message: "GitHub SSH へのネットワーク接続に失敗しました。"
      };
    }

    if (/permission denied|publickey/i.test(output)) {
      return {
        status: "auth_failed",
        authenticated: false,
        account: null,
        message: "GitHub SSH 認証に失敗しました。"
      };
    }

    return {
      status: "unknown",
      authenticated: false,
      account: null,
      message: "GitHub SSH 接続状態を判定できませんでした。"
    };
  } finally {
    await dependencies.removeDirectory(tempDir);
  }
};

export const runLocalDiagnostics = async (
  dependenciesInput: LocalDiagnosticsDependencies = {}
): Promise<LocalDiagnosticsResponse> => {
  const dependencies = resolveDependencies(dependenciesInput);
  const [git, githubCli, sshKeys, sshConnection] = await Promise.all([
    diagnoseGit(dependencies),
    diagnoseGitHubCli(dependencies),
    diagnoseSshKeys(dependencies),
    diagnoseSshConnection(dependencies)
  ]);

  const blockingChecks: LocalDiagnosticsResponse["summary"]["blockingChecks"] = [];

  if (git.status !== "ok") {
    blockingChecks.push("git");
  }

  if (githubCli.status === "missing") {
    blockingChecks.push("githubCli");
  } else if (!githubCli.authenticated) {
    blockingChecks.push("githubAuth");
  }

  if (sshKeys.status !== "ok") {
    blockingChecks.push("sshKeys");
  }

  if (sshConnection.status !== "ok") {
    blockingChecks.push("sshConnection");
  }

  return {
    contractVersion: "v1",
    checkedAt: dependencies.now().toISOString(),
    timeoutMs: SSH_TIMEOUT_MS,
    git,
    githubCli,
    ssh: {
      keys: sshKeys,
      connection: sshConnection
    },
    summary: {
      ready: blockingChecks.length === 0,
      blockingChecks
    }
  };
};
