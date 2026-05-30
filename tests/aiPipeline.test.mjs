import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_PIPELINE_LIMITS,
  minimizeAiAssistRequest,
  runAiAssistPipelineWithProvider,
  scanAiAssistRequestForSecrets
} from "../src/shared/aiPipeline.ts";

describe("AI request pipeline", () => {
  it("minimizes context before building provider payloads", () => {
    const request = {
      task: "cause_candidates",
      context: [
        {
          label: "long diff",
          kind: "diff",
          value: "a".repeat(AI_PIPELINE_LIMITS.maxContextValueCharsByKind.diff + 500)
        },
        ...Array.from({ length: AI_PIPELINE_LIMITS.maxContextEntries + 2 }, (_, index) => ({
          label: `extra ${index}`,
          kind: "user_text",
          value: `context ${index}`
        }))
      ]
    };

    const result = minimizeAiAssistRequest(request);

    assert.equal(result.context.length, AI_PIPELINE_LIMITS.maxContextEntries);
    assert.equal(result.summary.truncated, true);
    assert.equal(result.summary.omittedEntryCount, 3);
    assert.equal(
      result.context[0]?.value.length,
      AI_PIPELINE_LIMITS.maxContextValueCharsByKind.diff
    );
  });

  it("blocks provider calls when secrets are detected", async () => {
    let called = false;
    const provider = {
      id: "test-provider",
      mode: "mock",
      supportsStreaming: true,
      generate: async () => {
        called = true;
        return {
          text: "should not happen",
          usage: { inputChars: 0, outputChars: 0 }
        };
      }
    };

    const response = await runAiAssistPipelineWithProvider(
      {
        task: "error_summary",
        context: [
          {
            label: "error",
            kind: "error",
            value: "OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz"
          }
        ]
      },
      provider
    );

    assert.equal(called, false);
    assert.equal(response.status, "blocked");
    assert.equal(response.fallback?.reason, "secret_detected");
    assert.equal(response.safety.secretScan.blocked, true);
    assert.equal(response.safety.executableOutput, false);
  });

  it("falls back without stopping the caller when a provider fails", async () => {
    const provider = {
      id: "failing-provider",
      mode: "remote",
      supportsStreaming: false,
      generate: async () => {
        throw new Error("remote unavailable");
      }
    };

    const response = await runAiAssistPipelineWithProvider(
      {
        task: "question_rewrite",
        context: [{ label: "situation", kind: "user_text", value: "Vite が起動しません。" }]
      },
      provider
    );

    assert.equal(response.status, "fallback");
    assert.equal(response.canContinue, true);
    assert.equal(response.fallback?.reason, "provider_failed");
    assert.equal(response.output, null);
    assert.equal(response.audit.decision, "failed");
  });

  it("returns suggestion-only output on success", async () => {
    const provider = {
      id: "success-provider",
      mode: "mock",
      supportsStreaming: false,
      generate: async () => ({
        text: "提案のみです。自動適用はしません。",
        usage: { inputChars: 12, outputChars: 18 }
      })
    };

    const response = await runAiAssistPipelineWithProvider(
      {
        task: "patch_proposal",
        options: { streaming: true },
        context: [{ label: "diff", kind: "diff", value: "diff --git a/src/a.ts b/src/a.ts" }]
      },
      provider
    );

    assert.equal(response.status, "completed");
    assert.equal(response.output?.requiresHumanReview, true);
    assert.equal(response.safety.executableOutput, false);
    assert.equal(response.streaming.used, false);
    assert.equal(
      scanAiAssistRequestForSecrets(
        response.output
          ? {
              task: "patch_proposal",
              context: [{ label: "output", kind: "user_text", value: response.output.text }]
            }
          : {
              task: "patch_proposal",
              context: []
            }
      ).blocked,
      false
    );
  });
});
