import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { reconnectProjectRootWithDependencies } from "../src/main/projectRootReconnect.ts";
import { canonicalizePath, createLocalPathHash } from "../src/main/projectPathIdentity.ts";
import {
  clearProjectRootRegistryForTests,
  findSelectedProjectRootByLocalPathHash,
  persistSelectedProjectRootMapping
} from "../src/main/projectRootRegistry.ts";

const localPathHash = "a".repeat(64);
const githubRepoUrl = "https://github.com/acme/app";

const inspection = (overrides = {}) => ({
  contractVersion: "v1",
  projectRootId: "root-1",
  displayName: "app",
  status: "ready",
  isGitRepository: true,
  remoteOriginUrl: githubRepoUrl,
  normalizedGithubRepoUrl: githubRepoUrl,
  defaultBranch: "main",
  localPathHash,
  canRegister: true,
  message: "GitHub repository と紐付けできます。",
  ...overrides
});

describe("project root reconnect", () => {
  it("persists verified local root mappings in local-only storage", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ask-root-store-"));
    const rootPath = await mkdtemp(join(temporaryDirectory, "repo-"));
    const storePath = join(temporaryDirectory, "roots.json");
    const previousStorePath = process.env.ASK_PROJECT_ROOTS_STORE_PATH;

    process.env.ASK_PROJECT_ROOTS_STORE_PATH = storePath;
    clearProjectRootRegistryForTests();

    try {
      const canonicalRootPath = await canonicalizePath(rootPath);
      const hash = createLocalPathHash(canonicalRootPath);

      await persistSelectedProjectRootMapping(
        {
          id: `root-${randomUUID()}`,
          rootPath,
          displayName: "repo",
          selectedAt: "2026-05-30T00:00:00.000Z"
        },
        hash
      );

      clearProjectRootRegistryForTests();

      const found = await findSelectedProjectRootByLocalPathHash(hash);
      assert.equal(found?.rootPath, canonicalRootPath);
      assert.equal(found?.displayName, "repo");

      const persistedJson = await readFile(storePath, "utf8");
      assert.match(persistedJson, new RegExp(hash));
      assert.doesNotMatch(persistedJson, /github_repo_url|owner_user_id|class_id/);
    } finally {
      clearProjectRootRegistryForTests();

      if (previousStorePath === undefined) {
        delete process.env.ASK_PROJECT_ROOTS_STORE_PATH;
      } else {
        process.env.ASK_PROJECT_ROOTS_STORE_PATH = previousStorePath;
      }

      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent local root mapping writes", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ask-root-store-concurrent-"));
    const firstRootPath = await mkdtemp(join(temporaryDirectory, "repo-a-"));
    const secondRootPath = await mkdtemp(join(temporaryDirectory, "repo-b-"));
    const storePath = join(temporaryDirectory, "roots.json");
    const previousStorePath = process.env.ASK_PROJECT_ROOTS_STORE_PATH;

    process.env.ASK_PROJECT_ROOTS_STORE_PATH = storePath;
    clearProjectRootRegistryForTests();

    try {
      const firstHash = createLocalPathHash(await canonicalizePath(firstRootPath));
      const secondHash = createLocalPathHash(await canonicalizePath(secondRootPath));

      await Promise.all([
        persistSelectedProjectRootMapping(
          {
            id: `root-${randomUUID()}`,
            rootPath: firstRootPath,
            displayName: "repo-a",
            selectedAt: "2026-05-30T00:00:00.000Z"
          },
          firstHash
        ),
        persistSelectedProjectRootMapping(
          {
            id: `root-${randomUUID()}`,
            rootPath: secondRootPath,
            displayName: "repo-b",
            selectedAt: "2026-05-30T00:00:00.000Z"
          },
          secondHash
        )
      ]);

      clearProjectRootRegistryForTests();

      const firstFound = await findSelectedProjectRootByLocalPathHash(firstHash);
      const secondFound = await findSelectedProjectRootByLocalPathHash(secondHash);
      assert.equal(firstFound?.displayName, "repo-a");
      assert.equal(secondFound?.displayName, "repo-b");
    } finally {
      clearProjectRootRegistryForTests();

      if (previousStorePath === undefined) {
        delete process.env.ASK_PROJECT_ROOTS_STORE_PATH;
      } else {
        process.env.ASK_PROJECT_ROOTS_STORE_PATH = previousStorePath;
      }

      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("reconnects only after GitHub remote and local hash both match", async () => {
    let persistedHash = null;
    const result = await reconnectProjectRootWithDependencies(
      {
        projectRootId: "root-1",
        expectedLocalPathHash: localPathHash,
        expectedGithubRepoUrl: githubRepoUrl
      },
      {
        inspectProjectGit: async () => inspection(),
        getSelectedProjectRoot: () => ({
          id: "root-1",
          rootPath: "/workspace/app",
          displayName: "app",
          selectedAt: "2026-05-30T00:00:00.000Z"
        }),
        persistSelectedProjectRootMapping: async (_record, hash) => {
          persistedHash = hash;
        }
      }
    );

    assert.equal(result.status, "reconnected");
    assert.equal(result.persisted, true);
    assert.equal(persistedHash, localPathHash);
  });

  it("rejects reconnect attempts for mismatched GitHub remotes or local hashes", async () => {
    let persistCalls = 0;
    const dependencies = {
      getSelectedProjectRoot: () => ({
        id: "root-1",
        rootPath: "/workspace/app",
        displayName: "app",
        selectedAt: "2026-05-30T00:00:00.000Z"
      }),
      persistSelectedProjectRootMapping: async () => {
        persistCalls += 1;
      }
    };

    const remoteMismatch = await reconnectProjectRootWithDependencies(
      {
        projectRootId: "root-1",
        expectedLocalPathHash: localPathHash,
        expectedGithubRepoUrl: githubRepoUrl
      },
      {
        ...dependencies,
        inspectProjectGit: async () =>
          inspection({ normalizedGithubRepoUrl: "https://github.com/acme/other" })
      }
    );
    const hashMismatch = await reconnectProjectRootWithDependencies(
      {
        projectRootId: "root-1",
        expectedLocalPathHash: localPathHash,
        expectedGithubRepoUrl: githubRepoUrl
      },
      {
        ...dependencies,
        inspectProjectGit: async () => inspection({ localPathHash: "b".repeat(64) })
      }
    );

    assert.equal(remoteMismatch.status, "remote_mismatch");
    assert.equal(hashMismatch.status, "hash_mismatch");
    assert.equal(persistCalls, 0);
  });
});

describe("project root reconnect UI wiring", () => {
  it("wires registration and project detail to the verified reconnect IPC", async () => {
    const source = await readFile(
      "src/renderer/src/features/projects/ProjectRegistrationPage.tsx",
      "utf8"
    );

    assert.match(source, /window\.ask\.project\.reconnectRoot/);
    assert.match(source, /expectedLocalPathHash/);
    assert.match(source, /expectedGithubRepoUrl/);
    assert.match(source, /ローカルフォルダを再接続/);
  });

  it("links patch root-missing recovery back to project detail", async () => {
    const source = await readFile("src/renderer/src/features/threads/ThreadDetailPage.tsx", "utf8");

    assert.match(source, /validation\?\.status === "root_missing"/);
    assert.match(source, /revertResult\?\.status === "root_missing"/);
    assert.match(source, /to=\{`\/projects\/\$\{projectId\}`\}/);
  });
});
