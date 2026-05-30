import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { applyPatch, revertPatch, validatePatch } from "../src/main/patchWorkflow.ts";
import { canonicalizePath, createLocalPathHash } from "../src/main/projectPathIdentity.ts";
import { rememberSelectedProjectRoot } from "../src/main/projectRootRegistry.ts";

const execFileAsync = promisify(execFile);
const skipPermissionDeniedTest =
  process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);

const git = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });

  return stdout.trim();
};

const createRepo = async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "ask-patch-workflow-"));
  await git(rootPath, ["init"]);
  await git(rootPath, ["config", "user.email", "student@example.com"]);
  await git(rootPath, ["config", "user.name", "Student"]);
  await writeFile(join(rootPath, "app.txt"), "old\n", "utf8");
  await git(rootPath, ["add", "app.txt"]);
  await git(rootPath, ["commit", "-m", "initial"]);

  const currentHead = await git(rootPath, ["rev-parse", "HEAD"]);
  const canonicalRootPath = await canonicalizePath(rootPath);
  const localPathHash = createLocalPathHash(canonicalRootPath);
  rememberSelectedProjectRoot({
    id: `patch-root-${randomUUID()}`,
    rootPath,
    displayName: "patch app",
    selectedAt: "2026-05-30T00:00:00.000Z"
  });

  return { rootPath, localPathHash, currentHead };
};

const replaceAppPatch = ({ from = "old", to = "new" } = {}) => `diff --git a/app.txt b/app.txt
--- a/app.txt
+++ b/app.txt
@@ -1 +1 @@
-${from}
+${to}
`;

const envPatch = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+TOKEN=example
`;

describe("patch workflow", () => {
  it("validates, backs up, and applies an approved patch", async () => {
    const repo = await createRepo();

    try {
      const patchProposalId = randomUUID();
      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch(),
        expectedBaseCommit: repo.currentHead,
        patchProposalId
      });

      assert.equal(validation.status, "ready");
      assert.equal(validation.canApply, true);
      assert.deepEqual(validation.targetFiles, ["app.txt"]);
      assert.equal(validation.patchId, patchProposalId);
      assert.ok(validation.confirmationToken);

      const applyResult = await applyPatch({
        patchId: validation.patchId,
        confirmationToken: validation.confirmationToken
      });

      assert.equal(applyResult.status, "applied");
      assert.equal(applyResult.applied, true);
      assert.equal(await readFile(join(repo.rootPath, "app.txt"), "utf8"), "new\n");
      assert.ok(applyResult.backupDirectory?.startsWith(".ask/backups/"));
      assert.equal(applyResult.backupDirectory, `.ask/backups/${patchProposalId}`);
      assert.equal(
        await readFile(join(repo.rootPath, applyResult.backupDirectory, "app.txt"), "utf8"),
        "old\n"
      );

      const metadata = JSON.parse(
        await readFile(join(repo.rootPath, applyResult.backupDirectory, "metadata.json"), "utf8")
      );
      assert.equal(metadata.schemaVersion, 1);
      assert.deepEqual(metadata.targetFiles, ["app.txt"]);
      assert.equal(metadata.currentHead, repo.currentHead);
      assert.equal(metadata.postApplyEntries.length, 1);
      assert.equal(metadata.postApplyEntries[0].kind, "file");
      assert.match(metadata.postApplyEntries[0].sha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

  it("reverts an applied patch from its local backup", async () => {
    const repo = await createRepo();

    try {
      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch(),
        expectedBaseCommit: repo.currentHead,
        patchProposalId: randomUUID()
      });

      assert.equal(validation.status, "ready");

      const applyResult = await applyPatch({
        patchId: validation.patchId,
        confirmationToken: validation.confirmationToken
      });

      assert.equal(applyResult.status, "applied");
      assert.equal(await readFile(join(repo.rootPath, "app.txt"), "utf8"), "new\n");

      const revertResult = await revertPatch({
        localPathHash: repo.localPathHash,
        patchId: validation.patchId,
        backupDirectory: applyResult.backupDirectory
      });

      assert.equal(revertResult.status, "reverted");
      assert.equal(revertResult.reverted, true);
      assert.deepEqual(revertResult.targetFiles, ["app.txt"]);
      assert.equal(await readFile(join(repo.rootPath, "app.txt"), "utf8"), "old\n");
      assert.equal(await git(repo.rootPath, ["status", "--porcelain", "--", "app.txt"]), "");
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

  it("does not revert when files changed after patch apply", async () => {
    const repo = await createRepo();

    try {
      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch(),
        expectedBaseCommit: repo.currentHead,
        patchProposalId: randomUUID()
      });

      const applyResult = await applyPatch({
        patchId: validation.patchId,
        confirmationToken: validation.confirmationToken
      });

      assert.equal(applyResult.status, "applied");
      await writeFile(join(repo.rootPath, "app.txt"), "manual change\n", "utf8");

      const revertResult = await revertPatch({
        localPathHash: repo.localPathHash,
        patchId: validation.patchId,
        backupDirectory: applyResult.backupDirectory
      });

      assert.equal(revertResult.status, "dirty");
      assert.equal(revertResult.reverted, false);
      assert.equal(await readFile(join(repo.rootPath, "app.txt"), "utf8"), "manual change\n");
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

  it(
    "returns permission_denied when revert cannot write project root",
    { skip: skipPermissionDeniedTest },
    async () => {
      const repo = await createRepo();

      try {
        const validation = await validatePatch({
          localPathHash: repo.localPathHash,
          patchText: replaceAppPatch(),
          expectedBaseCommit: repo.currentHead,
          patchProposalId: randomUUID()
        });

        const applyResult = await applyPatch({
          patchId: validation.patchId,
          confirmationToken: validation.confirmationToken
        });

        assert.equal(applyResult.status, "applied");
        await chmod(repo.rootPath, 0o500);

        const revertResult = await revertPatch({
          localPathHash: repo.localPathHash,
          patchId: validation.patchId,
          backupDirectory: applyResult.backupDirectory
        });

        assert.equal(revertResult.status, "permission_denied");
        assert.equal(revertResult.reverted, false);
        assert.equal(revertResult.backupDirectory, null);
      } finally {
        await chmod(repo.rootPath, 0o700).catch(() => undefined);
        await rm(repo.rootPath, { recursive: true, force: true });
      }
    }
  );

  it("does not apply patches when target files are dirty", async () => {
    const repo = await createRepo();

    try {
      await writeFile(join(repo.rootPath, "app.txt"), "local change\n", "utf8");

      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch()
      });

      assert.equal(validation.status, "dirty");
      assert.equal(validation.canApply, false);
      assert.equal(await readFile(join(repo.rootPath, "app.txt"), "utf8"), "local change\n");
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

  it("denies patches targeting protected paths", async () => {
    const repo = await createRepo();

    try {
      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: envPatch
      });

      assert.equal(validation.status, "denied_path");
      assert.equal(validation.canApply, false);
      assert.deepEqual(validation.targetFiles, [".env"]);
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

  it("distinguishes apply conflicts from dirty files", async () => {
    const repo = await createRepo();

    try {
      await writeFile(join(repo.rootPath, "app.txt"), "different\n", "utf8");
      await git(repo.rootPath, ["add", "app.txt"]);
      await git(repo.rootPath, ["commit", "-m", "change app"]);

      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch()
      });

      assert.equal(validation.status, "conflict");
      assert.equal(validation.canApply, false);
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

  it("rejects patches created for a different base commit", async () => {
    const repo = await createRepo();

    try {
      await writeFile(join(repo.rootPath, "app.txt"), "different\n", "utf8");
      await git(repo.rootPath, ["add", "app.txt"]);
      await git(repo.rootPath, ["commit", "-m", "change app"]);

      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch(),
        expectedBaseCommit: repo.currentHead
      });

      assert.equal(validation.status, "base_mismatch");
      assert.equal(validation.canApply, false);
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });
});
