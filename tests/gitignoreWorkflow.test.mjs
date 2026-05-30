import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyGitignore, previewGitignore } from "../src/main/gitignoreWorkflow.ts";
import { rememberSelectedProjectRoot } from "../src/main/projectRootRegistry.ts";

const rememberTempRoot = (prefix) => {
  const rootPath = mkdtempSync(join(tmpdir(), prefix));
  const projectRootId = `${prefix}-${Date.now()}-${Math.random()}`;
  rememberSelectedProjectRoot({
    id: projectRootId,
    rootPath,
    displayName: "fixture-project",
    selectedAt: new Date().toISOString()
  });

  return { rootPath, projectRootId };
};

describe("gitignore workflow", () => {
  it("surfaces high-risk local, SSH, dependency, and build patterns", async () => {
    const { rootPath, projectRootId } = rememberTempRoot("ask-gitignore-preview-");
    writeFileSync(join(rootPath, "package.json"), JSON.stringify({ scripts: {} }));
    mkdirSync(join(rootPath, "node_modules"));

    const preview = await previewGitignore({ projectRootId });
    const patterns = new Set(preview.entries.map((entry) => entry.pattern));

    for (const pattern of [
      ".env",
      ".env.*",
      ".ssh/",
      "id_ed25519",
      "*.pem",
      "node_modules/",
      "dist/",
      "build/",
      "out/"
    ]) {
      assert.equal(patterns.has(pattern), true, `${pattern} should be recommended`);
      assert.equal(preview.missingPatterns.includes(pattern), true, `${pattern} should be missing`);
    }
  });

  it("appends the recommendation block without rewriting existing ignores", async () => {
    const { rootPath, projectRootId } = rememberTempRoot("ask-gitignore-apply-");
    writeFileSync(join(rootPath, ".gitignore"), "custom.log\n");
    writeFileSync(join(rootPath, "package.json"), JSON.stringify({ dependencies: {} }));

    const preview = await previewGitignore({ projectRootId });
    const result = await applyGitignore({
      projectRootId,
      recommendationHash: preview.recommendationHash
    });
    const content = readFileSync(join(rootPath, ".gitignore"), "utf8");

    assert.equal(result.status, "applied");
    assert.match(content, /^custom\.log\n\n# ASK recommended ignores/m);
    assert.match(content, /^\.env$/m);
    assert.match(content, /^node_modules\/$/m);
  });
});
