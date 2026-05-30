import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLocalDiagnostics } from "../src/main/localDiagnostics.ts";
import { inspectProjectGitWithDependencies } from "../src/main/projectGitInspector.ts";

const completedCommand = ({ stdout = "", stderr = "", exitCode = 0 } = {}) => ({
  status: "completed",
  exitCode,
  stdout,
  stderr,
  durationMs: 1
});

const missingCommand = () => ({
  status: "missing",
  stdout: "",
  stderr: "",
  durationMs: 1,
  errorCode: "ENOENT"
});

const timeoutCommand = () => ({
  status: "timeout",
  stdout: "",
  stderr: "",
  durationMs: 5_000,
  errorCode: "TIMEOUT"
});

const gitCompleted = ({ stdout = "", stderr = "", exitCode = 0 } = {}) => ({
  status: "completed",
  exitCode,
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false
});

const dirent = (name) => ({
  name,
  isFile: () => true
});

const createLocalDiagnosticsDependencies = ({
  gitVersion = completedCommand({ stdout: "git version 2.45.0" }),
  ghVersion = completedCommand({ stdout: "gh version 2.50.0" }),
  ghAuth = completedCommand({ stderr: "Logged in to github.com account student" }),
  sshConnection = completedCommand({
    stderr:
      "Hi student! You've successfully authenticated, but GitHub does not provide shell access.",
    exitCode: 1
  }),
  sshEntries = [dirent("id_ed25519"), dirent("id_ed25519.pub")]
} = {}) => ({
  runFixedCommand: async (executable, args) => {
    if (executable === "git") {
      return gitVersion;
    }

    if (executable === "gh" && args[0] === "--version") {
      return ghVersion;
    }

    if (executable === "gh") {
      return ghAuth;
    }

    if (executable === "ssh") {
      return sshConnection;
    }

    return completedCommand();
  },
  readDirectory: async () => sshEntries,
  makeTempDir: async () => "/tmp/ask-ssh-test",
  removeDirectory: async () => undefined,
  homeDirectory: () => "/home/student",
  temporaryDirectory: () => "/tmp",
  now: () => new Date("2026-05-30T00:00:00.000Z")
});

const projectRoot = {
  id: "root-1",
  rootPath: "/workspace/app",
  displayName: "app",
  selectedAt: "2026-05-30T00:00:00.000Z"
};

const createProjectInspectionDependencies = (responses, root = projectRoot) => ({
  getSelectedProjectRoot: () => root,
  canonicalizePath: async (path) => path,
  createLocalPathHash: (path) => `hash:${path}`,
  runGit: async (_rootPath, args) => {
    const key = args.join(" ");
    const response = responses[key];

    if (!response) {
      throw new Error(`Missing fake git response for ${key}`);
    }

    return response;
  }
});

describe("GitHub onboarding diagnostics", () => {
  it("reports missing Git and GitHub CLI as blocking checks", async () => {
    const result = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        gitVersion: missingCommand(),
        ghVersion: missingCommand()
      })
    );

    assert.equal(result.git.status, "missing");
    assert.equal(result.githubCli.status, "missing");
    assert.equal(result.summary.ready, false);
    assert.deepEqual(result.summary.blockingChecks.slice(0, 2), ["git", "githubCli"]);
    assert.match(result.git.message, /Git が見つかりません/);
    assert.match(result.githubCli.message, /GitHub CLI が見つかりません/);
  });

  it("reports GitHub CLI unauthenticated without losing installed version", async () => {
    const result = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        ghAuth: completedCommand({
          stderr: "You are not logged into any GitHub hosts. run: gh auth login",
          exitCode: 1
        })
      })
    );

    assert.equal(result.githubCli.status, "unauthenticated");
    assert.equal(result.githubCli.installed, true);
    assert.equal(result.githubCli.authenticated, false);
    assert.equal(result.githubCli.version, "2.50.0");
    assert.deepEqual(result.summary.blockingChecks, ["githubAuth"]);
  });

  it("distinguishes SSH key absence, public key auth failure, network failure, and timeout", async () => {
    const missingKeys = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        sshEntries: []
      })
    );
    const authFailed = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        sshConnection: completedCommand({ stderr: "Permission denied (publickey).", exitCode: 255 })
      })
    );
    const networkFailed = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        sshConnection: completedCommand({
          stderr: "ssh: Could not resolve hostname github.com",
          exitCode: 255
        })
      })
    );
    const timedOut = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        sshConnection: timeoutCommand()
      })
    );

    assert.equal(missingKeys.ssh.keys.status, "missing");
    assert.equal(authFailed.ssh.connection.status, "auth_failed");
    assert.equal(networkFailed.ssh.connection.status, "network_error");
    assert.equal(timedOut.ssh.connection.status, "timeout");
  });
});

describe("Project Git inspection abnormal paths", () => {
  it("blocks folders without a Git work tree", async () => {
    const result = await inspectProjectGitWithDependencies(
      { projectRootId: projectRoot.id },
      createProjectInspectionDependencies({
        "rev-parse --is-inside-work-tree": gitCompleted({
          stderr: "fatal: not a git repository",
          exitCode: 128
        })
      })
    );

    assert.equal(result.status, "not_git_repository");
    assert.equal(result.canRegister, false);
    assert.match(result.message, /\.git がない/);
  });

  it("blocks nested folders that are not the repository root", async () => {
    const result = await inspectProjectGitWithDependencies(
      { projectRootId: projectRoot.id },
      createProjectInspectionDependencies(
        {
          "rev-parse --is-inside-work-tree": gitCompleted({ stdout: "true" }),
          "rev-parse --show-toplevel": gitCompleted({ stdout: "/workspace/app" })
        },
        {
          ...projectRoot,
          rootPath: "/workspace/app/packages/web",
          displayName: "web"
        }
      )
    );

    assert.equal(result.status, "not_git_root");
    assert.equal(result.isGitRepository, true);
    assert.equal(result.canRegister, false);
  });

  it("blocks repositories without origin remote", async () => {
    const result = await inspectProjectGitWithDependencies(
      { projectRootId: projectRoot.id },
      createProjectInspectionDependencies({
        "rev-parse --is-inside-work-tree": gitCompleted({ stdout: "true" }),
        "rev-parse --show-toplevel": gitCompleted({ stdout: "/workspace/app" }),
        "remote get-url origin": gitCompleted({
          stderr: "error: No such remote 'origin'",
          exitCode: 2
        })
      })
    );

    assert.equal(result.status, "remote_missing");
    assert.equal(result.canRegister, false);
    assert.match(result.message, /remote origin がありません/);
  });

  it("blocks non-GitHub remotes and accepts normalized GitHub remotes", async () => {
    const nonGithub = await inspectProjectGitWithDependencies(
      { projectRootId: projectRoot.id },
      createProjectInspectionDependencies({
        "rev-parse --is-inside-work-tree": gitCompleted({ stdout: "true" }),
        "rev-parse --show-toplevel": gitCompleted({ stdout: "/workspace/app" }),
        "remote get-url origin": gitCompleted({ stdout: "https://gitlab.com/acme/app.git" })
      })
    );
    const github = await inspectProjectGitWithDependencies(
      { projectRootId: projectRoot.id },
      createProjectInspectionDependencies({
        "rev-parse --is-inside-work-tree": gitCompleted({ stdout: "true" }),
        "rev-parse --show-toplevel": gitCompleted({ stdout: "/workspace/app" }),
        "remote get-url origin": gitCompleted({ stdout: "git@github.com:acme/app.git" }),
        "symbolic-ref --short HEAD": gitCompleted({ stdout: "main" })
      })
    );

    assert.equal(nonGithub.status, "remote_not_github");
    assert.equal(nonGithub.canRegister, false);
    assert.equal(github.status, "ready");
    assert.equal(github.canRegister, true);
    assert.equal(github.normalizedGithubRepoUrl, "https://github.com/acme/app");
    assert.equal(github.localPathHash, "hash:/workspace/app");
  });
});
