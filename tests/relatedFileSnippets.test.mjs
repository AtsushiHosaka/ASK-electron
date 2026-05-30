import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectRelatedFileSnippetsForPaths } from "../src/main/relatedFileSnippets.ts";
import { canonicalizePath, createLocalPathHash } from "../src/main/projectPathIdentity.ts";
import {
  clearProjectRootRegistryForTests,
  rememberSelectedProjectRoot
} from "../src/main/projectRootRegistry.ts";

const createRegisteredRoot = async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "ask-related-files-"));
  const canonicalRootPath = await canonicalizePath(rootPath);
  const localPathHash = createLocalPathHash(canonicalRootPath);

  rememberSelectedProjectRoot({
    id: "related-root",
    rootPath,
    displayName: "related",
    selectedAt: "2026-05-30T00:00:00.000Z"
  });

  return { rootPath, localPathHash };
};

describe("related file snippets", () => {
  it("reads bounded project snippets and omits unsafe files without returning absolute paths", async () => {
    clearProjectRootRegistryForTests();
    const { rootPath, localPathHash } = await createRegisteredRoot();
    const outsideRoot = await mkdtemp(join(tmpdir(), "ask-related-outside-"));

    try {
      await mkdir(join(rootPath, "src"), { recursive: true });
      await writeFile(join(rootPath, "src", "app.ts"), "export const value = 1;\n", "utf8");
      await writeFile(join(rootPath, ".env"), "TOKEN=secret-value\n", "utf8");
      await writeFile(join(rootPath, "package-lock.json"), "{}", "utf8");
      await writeFile(join(outsideRoot, "other.ts"), "export const outside = true;\n", "utf8");

      const result = await collectRelatedFileSnippetsForPaths({ localPathHash }, [
        join(rootPath, "src", "app.ts"),
        join(rootPath, ".env"),
        join(rootPath, "package-lock.json"),
        join(outsideRoot, "other.ts")
      ]);

      assert.equal(result.status, "partial");
      assert.deepEqual(
        result.snippets.map((snippet) => snippet.path),
        ["src/app.ts"]
      );
      assert.equal(result.snippets[0].content, "export const value = 1;\n");
      assert.equal(result.snippets[0].language, "typescript");
      assert.ok(result.omitted.every((omission) => !omission.path.includes(rootPath)));
      assert.deepEqual(result.omitted.map((omission) => omission.reason).sort(), [
        "blocked_path",
        "lockfile",
        "outside_root"
      ]);
    } finally {
      clearProjectRootRegistryForTests();
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("omits file contents when the snippet body contains blocked secrets", async () => {
    clearProjectRootRegistryForTests();
    const { rootPath, localPathHash } = await createRegisteredRoot();

    try {
      await mkdir(join(rootPath, "src"), { recursive: true });
      await writeFile(
        join(rootPath, "src", "token.ts"),
        "export const token = 'ghp_123456789012345678901234567890123456';\n",
        "utf8"
      );

      const result = await collectRelatedFileSnippetsForPaths({ localPathHash }, [
        join(rootPath, "src", "token.ts")
      ]);

      assert.equal(result.snippets.length, 0);
      assert.equal(result.omitted[0].reason, "secret_detected");
      assert.ok(
        result.omitted[0].findings.some((finding) =>
          /\[redacted github token\]/.test(finding.preview)
        )
      );
    } finally {
      clearProjectRootRegistryForTests();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("wires the renderer to picker snippets instead of manual related-file paths", async () => {
    const source = await readFile("src/renderer/src/features/threads/ThreadCreatePage.tsx", "utf8");

    assert.match(source, /window\.ask\.relatedFiles\.select/);
    assert.match(source, /updateRelatedFileSnippetContent/);
    assert.match(source, /CodeContextViewer/);
    assert.doesNotMatch(source, /relatedFilesText/);
  });
});
