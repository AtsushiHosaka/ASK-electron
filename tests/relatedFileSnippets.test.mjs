import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectRelatedFileSnippetsWithDependencies } from "../src/main/relatedFileSnippets.ts";

const localPathHash = "c".repeat(64);
const fixedNow = new Date("2026-05-31T00:00:00.000Z");

const collectForRoot = async (rootPath, selectedFilePaths) =>
  collectRelatedFileSnippetsWithDependencies({ localPathHash }, selectedFilePaths, {
    findProjectRootByLocalPathHash: async () => ({
      id: "root-1",
      rootPath,
      displayName: "app",
      selectedAt: fixedNow.toISOString()
    }),
    now: () => fixedNow
  });

describe("related file snippets", () => {
  it("includes bounded text snippets as project-relative paths", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ask-related-snippets-"));
    const rootPath = join(temporaryDirectory, "app");
    const sourcePath = join(rootPath, "src", "main.ts");

    await mkdir(join(rootPath, "src"), { recursive: true });
    await writeFile(sourcePath, "export const answer = 42;\n", "utf8");

    try {
      const result = await collectForRoot(rootPath, [sourcePath]);

      assert.equal(result.status, "ready");
      assert.equal(result.projectRootId, "root-1");
      assert.equal(result.snippets.length, 1);
      assert.equal(result.snippets[0].relativePath, "src/main.ts");
      assert.equal(result.snippets[0].language, "ts");
      assert.equal(result.snippets[0].status, "included");
      assert.equal(result.snippets[0].content, "export const answer = 42;\n");
      assert.doesNotMatch(JSON.stringify(result.snippets[0]), new RegExp(temporaryDirectory));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("omits blocked paths and token-looking file contents", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ask-related-blocked-"));
    const rootPath = join(temporaryDirectory, "app");
    const envPath = join(rootPath, ".env");
    const tokenPath = join(rootPath, "src", "token.ts");

    await mkdir(join(rootPath, "src"), { recursive: true });
    await writeFile(envPath, "API_KEY=super-secret-value-12345\n", "utf8");
    await writeFile(tokenPath, `const token = "${"ghp_" + "a".repeat(36)}";\n`, "utf8");

    try {
      const result = await collectForRoot(rootPath, [envPath, tokenPath]);
      const snippetsByPath = new Map(
        result.snippets.map((snippet) => [snippet.relativePath, snippet])
      );

      assert.equal(snippetsByPath.get(".env")?.status, "blocked");
      assert.equal(snippetsByPath.get(".env")?.omissionReason, "blocked_path");
      assert.equal(snippetsByPath.get("src/token.ts")?.status, "blocked");
      assert.equal(snippetsByPath.get("src/token.ts")?.omissionReason, "secret_detected");
      assert.equal(snippetsByPath.get("src/token.ts")?.content, "");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("omits outside-root, lockfile, unsupported, binary, and oversized selections", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ask-related-omitted-"));
    const rootPath = join(temporaryDirectory, "app");
    const outsidePath = join(temporaryDirectory, "outside.ts");
    const lockfilePath = join(rootPath, "package-lock.json");
    const unsupportedPath = join(rootPath, "notes.xyz");
    const binaryPath = join(rootPath, "src", "image.png");
    const oversizedPath = join(rootPath, "src", "large.ts");

    await mkdir(join(rootPath, "src"), { recursive: true });
    await writeFile(outsidePath, "export const outside = true;\n", "utf8");
    await writeFile(lockfilePath, "{}\n", "utf8");
    await writeFile(unsupportedPath, "plain text\n", "utf8");
    await writeFile(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(oversizedPath, `${"x".repeat(65 * 1024)}\n`, "utf8");

    try {
      const result = await collectForRoot(rootPath, [
        outsidePath,
        lockfilePath,
        unsupportedPath,
        binaryPath,
        oversizedPath
      ]);
      const reasons = result.snippets.map((snippet) => snippet.omissionReason);

      assert.deepEqual(reasons, [
        "outside_root",
        "lockfile",
        "unsupported_extension",
        "binary",
        "oversized"
      ]);
      assert.equal(
        result.snippets.every((snippet) => snippet.content === ""),
        true
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("returns root_missing without selected local root state", async () => {
    const result = await collectRelatedFileSnippetsWithDependencies({ localPathHash }, [], {
      findProjectRootByLocalPathHash: async () => null,
      now: () => fixedNow
    });

    assert.equal(result.status, "root_missing");
    assert.equal(result.snippets.length, 0);
  });
});

describe("related file snippet UI wiring", () => {
  it("wires thread creation to picker IPC, snippet editing, and code previews", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/renderer/src/features/threads/ThreadCreatePage.tsx", "utf8")
    );

    assert.match(source, /window\.ask\.relatedFiles\.select/);
    assert.match(source, /updateRelatedSnippetContent/);
    assert.match(source, /CodeContextViewer/);
    assert.match(source, /関連ファイルスニペット/);
  });

  it("renders fenced snippets inside text messages with the code viewer", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/renderer/src/features/threads/ThreadDetailPage.tsx", "utf8")
    );

    assert.match(source, /parseTextMessageParts/);
    assert.match(source, /TextMessageBody/);
    assert.match(source, /CodeContextViewer/);
  });
});
