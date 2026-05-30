import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pollGithubDeviceFlow, startGithubDeviceFlow } from "../src/main/githubDeviceFlow.ts";
import { runLocalDiagnostics } from "../src/main/localDiagnostics.ts";
import { inspectProjectGitWithDependencies } from "../src/main/projectGitInspector.ts";
import { canonicalizePath, createLocalPathHash } from "../src/main/projectPathIdentity.ts";
import {
  findSelectedProjectRootByLocalPathHash,
  rememberSelectedProjectRoot
} from "../src/main/projectRootRegistry.ts";

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
  sshEntries = [dirent("id_ed25519"), dirent("id_ed25519.pub")],
  makeTempDir = async () => "/tmp/ask-ssh-test",
  removeDirectory = async () => undefined
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
  makeTempDir,
  removeDirectory,
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
  it("blocks missing Git while allowing GitHub CLI fallback", async () => {
    const result = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        gitVersion: missingCommand(),
        ghVersion: missingCommand()
      })
    );

    assert.equal(result.git.status, "missing");
    assert.equal(result.githubCli.status, "missing");
    assert.equal(result.summary.ready, false);
    assert.deepEqual(result.summary.blockingChecks, ["git"]);
    assert.match(result.git.message, /Git が見つかりません/);
    assert.match(result.githubCli.message, /GitHub CLI が見つかりません/);
  });

  it("continues with fallback guidance when GitHub CLI is missing", async () => {
    const result = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        ghVersion: missingCommand()
      })
    );

    assert.equal(result.githubCli.status, "missing");
    assert.equal(result.summary.ready, true);
    assert.deepEqual(result.summary.blockingChecks, []);
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

  it("keeps SSH diagnostics structured when temp directory hooks fail", async () => {
    const tempDirFailure = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        makeTempDir: async () => {
          throw new Error("tmp unavailable");
        }
      })
    );
    const cleanupFailure = await runLocalDiagnostics(
      createLocalDiagnosticsDependencies({
        removeDirectory: async () => {
          throw new Error("cleanup failed");
        }
      })
    );

    assert.equal(tempDirFailure.ssh.connection.status, "unknown");
    assert.deepEqual(tempDirFailure.summary.blockingChecks, ["sshConnection"]);
    assert.equal(cleanupFailure.ssh.connection.status, "ok");
    assert.equal(cleanupFailure.summary.ready, true);
  });
});

describe("GitHub Device Flow fallback", () => {
  it("reports clear fallback guidance when no OAuth client is configured", async () => {
    let called = false;
    const result = await startGithubDeviceFlow({
      env: {},
      fetchImpl: async () => {
        called = true;
        throw new Error("should not call GitHub without client id");
      }
    });

    assert.equal(called, false);
    assert.equal(result.status, "not_configured");
    assert.equal(result.flowId, null);
    assert.match(result.message, /ASK_GITHUB_OAUTH_CLIENT_ID/);
  });

  it("starts without exposing the device code to the renderer response", async () => {
    const result = await startGithubDeviceFlow({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-123" },
      createId: () => "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-05-30T00:00:00.000Z"),
      fetchImpl: async (_url, init) => {
        const body = String(init.body);

        assert.match(body, /client_id=client-123/);
        assert.match(body, /scope=read%3Auser/);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "device-code-that-stays-main-only",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5
          })
        };
      }
    });

    assert.equal(result.status, "started");
    assert.equal(result.flowId, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.userCode, "ABCD-1234");
    assert.equal(result.verificationUri, "https://github.com/login/device");
    assert.equal(JSON.stringify(result).includes("device-code-that-stays-main-only"), false);
  });

  it("polls to authorization, fetches the account name, and never returns tokens", async () => {
    const flowId = "22222222-2222-4222-8222-222222222222";
    await startGithubDeviceFlow({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-123" },
      createId: () => flowId,
      now: () => new Date("2026-05-30T00:00:00.000Z"),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "device-code-main-only",
          user_code: "WXYZ-9999",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5
        })
      })
    });

    const result = await pollGithubDeviceFlow(
      { flowId },
      {
        now: () => new Date("2026-05-30T00:01:00.000Z"),
        fetchImpl: async (url, init) => {
          if (String(url).includes("/login/oauth/access_token")) {
            assert.match(String(init.body), /device_code=device-code-main-only/);

            return {
              ok: true,
              status: 200,
              json: async () => ({
                access_token: "gho_secret-token-that-must-not-return",
                token_type: "bearer",
                scope: "read:user"
              })
            };
          }

          assert.equal(String(url), "https://api.github.com/user");
          assert.equal(init.headers.Authorization, "Bearer gho_secret-token-that-must-not-return");

          return {
            ok: true,
            status: 200,
            json: async () => ({ login: "student" })
          };
        }
      }
    );

    assert.equal(result.status, "authorized");
    assert.equal(result.githubUsername, "student");
    assert.equal(JSON.stringify(result).includes("gho_secret"), false);
    assert.equal(JSON.stringify(result).includes("device-code-main-only"), false);
  });

  it("keeps polling authorization_pending without returning credentials", async () => {
    const flowId = "33333333-3333-4333-8333-333333333333";
    await startGithubDeviceFlow({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-123" },
      createId: () => flowId,
      now: () => new Date("2026-05-30T00:00:00.000Z"),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "pending-device-code",
          user_code: "CODE-0000",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5
        })
      })
    });

    const result = await pollGithubDeviceFlow(
      { flowId },
      {
        now: () => new Date("2026-05-30T00:00:20.000Z"),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ error: "authorization_pending" })
        })
      }
    );

    assert.equal(result.status, "pending");
    assert.equal(result.githubUsername, null);
    assert.equal(result.retryAfterSeconds, 5);
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

describe("Project root registry", () => {
  it("skips stale selected roots while matching by local path hash", async () => {
    const liveRoot = await mkdtemp(join(tmpdir(), "ask-live-root-"));

    try {
      rememberSelectedProjectRoot({
        id: "stale-root",
        rootPath: join(liveRoot, "missing"),
        displayName: "missing",
        selectedAt: "2026-05-30T00:00:00.000Z"
      });
      rememberSelectedProjectRoot({
        id: "live-root",
        rootPath: liveRoot,
        displayName: "live",
        selectedAt: "2026-05-30T00:00:00.000Z"
      });

      const canonicalLiveRoot = await canonicalizePath(liveRoot);
      const result = await findSelectedProjectRootByLocalPathHash(
        createLocalPathHash(canonicalLiveRoot)
      );

      assert.equal(result?.id, "live-root");
    } finally {
      await rm(liveRoot, { recursive: true, force: true });
    }
  });
});
