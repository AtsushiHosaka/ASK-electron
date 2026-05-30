import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { applyPatch, validatePatch } from "../src/main/patchWorkflow.ts";
import { canonicalizePath, createLocalPathHash } from "../src/main/projectPathIdentity.ts";
import { rememberSelectedProjectRoot } from "../src/main/projectRootRegistry.ts";

const execFileAsync = promisify(execFile);

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
      const validation = await validatePatch({
        localPathHash: repo.localPathHash,
        patchText: replaceAppPatch(),
        expectedBaseCommit: repo.currentHead
      });

      assert.equal(validation.status, "ready");
      assert.equal(validation.canApply, true);
      assert.deepEqual(validation.targetFiles, ["app.txt"]);
      assert.ok(validation.patchId);
      assert.ok(validation.confirmationToken);

      const applyResult = await applyPatch({
        patchId: validation.patchId,
        confirmationToken: validation.confirmationToken
      });

      assert.equal(applyResult.status, "applied");
      assert.equal(applyResult.applied, true);
      assert.equal(await readFile(join(repo.rootPath, "app.txt"), "utf8"), "new\n");
      assert.ok(applyResult.backupDirectory?.startsWith(".ask/backups/"));
      assert.equal(
        await readFile(join(repo.rootPath, applyResult.backupDirectory, "app.txt"), "utf8"),
        "old\n"
      );

      const metadata = JSON.parse(
        await readFile(join(repo.rootPath, applyResult.backupDirectory, "metadata.json"), "utf8")
      );
      assert.deepEqual(metadata.targetFiles, ["app.txt"]);
      assert.equal(metadata.currentHead, repo.currentHead);
    } finally {
      await rm(repo.rootPath, { recursive: true, force: true });
    }
  });

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
