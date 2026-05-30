import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanSecrets } from "../src/shared/secretScanner.ts";

describe("scanSecrets", () => {
  it("blocks .env and SSH private key paths", () => {
    const result = scanSecrets({
      filePaths: [".env", "src/.env.local", ".ssh/id_ed25519", "keys/deploy.pem"]
    });

    assert.equal(result.blocked, true);
    assert.equal(result.blockedFindings.length, 4);
    assert.deepEqual(
      result.blockedFindings.map((finding) => finding.kind),
      ["blocked_path", "blocked_path", "blocked_path", "blocked_path"]
    );
  });

  it("blocks GitHub tokens and redacts preview values", () => {
    const result = scanSecrets({
      textEntries: [
        {
          label: "diff",
          value: "const token = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';"
        }
      ]
    });

    assert.equal(result.blocked, true);
    assert.equal(result.blockedFindings[0]?.kind, "github_token");
    assert.equal(result.blockedFindings[0]?.preview.includes("ghp_1234567890"), false);
  });

  it("blocks private key bodies without exposing key material", () => {
    const result = scanSecrets({
      textEntries: [
        {
          label: "terminal",
          value:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123privatekeymaterial\n-----END OPENSSH PRIVATE KEY-----"
        }
      ]
    });

    assert.equal(result.blocked, true);
    assert.equal(result.blockedFindings[0]?.kind, "private_key");
    assert.equal(result.blockedFindings[0]?.preview, "[redacted private key]");
  });

  it("blocks common API key values", () => {
    const result = scanSecrets({
      textEntries: [
        {
          label: "question",
          value: "OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz"
        }
      ]
    });

    assert.equal(result.blocked, true);
    assert.equal(
      result.blockedFindings.some((finding) => finding.kind === "api_key"),
      true
    );
  });

  it("redacts secret assignment previews", () => {
    const result = scanSecrets({
      textEntries: [
        {
          label: "env",
          value: "PASSWORD=super-secret-password-12345"
        }
      ]
    });

    assert.equal(result.blocked, true);
    assert.equal(
      result.blockedFindings.some((finding) => finding.kind === "secret_assignment"),
      true
    );
    assert.equal(
      result.blockedFindings.some((finding) =>
        finding.preview.includes("super-secret-password-12345")
      ),
      false
    );
  });

  it("allows warning-only false positives when explicitly allowed", () => {
    const firstPass = scanSecrets({
      filePaths: ["src/tokenizer.ts"],
      textEntries: [{ label: "説明", value: "tokenizer の実装を確認しています。" }]
    });

    assert.equal(firstPass.blocked, false);
    assert.equal(firstPass.hasWarnings, true);
    assert.equal(
      firstPass.warningFindings.every((finding) => finding.canAllow),
      true
    );

    const allowedPass = scanSecrets({
      filePaths: ["src/tokenizer.ts"],
      textEntries: [{ label: "説明", value: "tokenizer の実装を確認しています。" }],
      allowedFindingIds: firstPass.warningFindings.map((finding) => finding.id)
    });

    assert.equal(allowedPass.blocked, false);
    assert.equal(allowedPass.hasWarnings, false);
    assert.equal(allowedPass.allowedFindings.length, firstPass.warningFindings.length);
  });
});
