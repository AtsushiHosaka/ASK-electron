import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAiPatchProposalOutput, parsePatchTargetFiles } from "../src/shared/patchProposal.ts";

const validPatch = [
  "diff --git a/src/calculator.ts b/src/calculator.ts",
  "--- a/src/calculator.ts",
  "+++ b/src/calculator.ts",
  "@@ -1,3 +1,3 @@",
  "-const value = Number(input.value);",
  "+const value = Number(input.value || 0);"
].join("\n");

describe("AI patch proposal parsing", () => {
  it("parses a fenced JSON patch proposal", () => {
    const result = parseAiPatchProposalOutput(
      `\`\`\`json\n${JSON.stringify({
        target_file_path: "src/calculator.ts",
        base_commit_sha: "abcdef1234567890",
        explanation: "Normalize empty input before conversion.",
        patch_text: validPatch
      })}\n\`\`\``
    );

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(result.proposal.targetFilePath, "src/calculator.ts");
    assert.equal(result.proposal.baseCommitSha, "abcdef1234567890");
    assert.match(result.proposal.patchText, /diff --git/);
  });

  it("rejects target files that do not match the diff", () => {
    const result = parseAiPatchProposalOutput(
      JSON.stringify({
        target_file_path: "src/other.ts",
        explanation: "Wrong target.",
        patch_text: validPatch
      })
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.code, "TARGET_MISMATCH");
  });

  it("rejects patch text without a unified diff hunk", () => {
    const result = parseAiPatchProposalOutput(
      JSON.stringify({
        target_file_path: "src/calculator.ts",
        explanation: "Header only.",
        patch_text: "diff --git a/src/calculator.ts b/src/calculator.ts"
      })
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.code, "INVALID_PATCH");
  });

  it("rejects multi-file patch proposals for the MVP schema", () => {
    const secondPatch = [
      validPatch,
      "diff --git a/src/other.ts b/src/other.ts",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");
    const result = parseAiPatchProposalOutput(
      JSON.stringify({
        target_file_path: "src/calculator.ts",
        explanation: "Two files.",
        patch_text: secondPatch
      })
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.code, "MULTI_FILE_PATCH");
  });

  it("rejects protected target paths", () => {
    const result = parsePatchTargetFiles(
      ["diff --git a/.env b/.env", "--- a/.env", "+++ b/.env", "@@ -1 +1 @@", "-A=1", "+A=2"].join(
        "\n"
      )
    );

    assert.equal(result.invalidPath, true);
    assert.deepEqual(result.targetFiles, []);
  });
});
