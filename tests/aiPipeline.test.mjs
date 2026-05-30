import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_ASSIST_REQUEST_LIMITS,
  AI_PIPELINE_LIMITS,
  buildAiProviderRequest,
  getAiAssistRequestLimitViolation,
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
    assert.match(response.fallback?.message ?? "", /AI には送信していません/);
    assert.equal(response.safety.secretScan.blocked, true);
    assert.equal(response.safety.executableOutput, false);
  });

  it("scans context labels before provider prompts are built", () => {
    const result = scanAiAssistRequestForSecrets({
      task: "error_summary",
      context: [
        {
          label: "OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz",
          kind: "user_text",
          value: "label contains the sensitive value"
        }
      ]
    });

    assert.equal(result.blocked, true);
    assert.equal(result.blockedFindingCount, 1);
    assert.equal(result.findings[0]?.sourceLabel, "user_text label");
  });

  it("reports oversized AI request payloads before expensive processing", () => {
    assert.equal(
      getAiAssistRequestLimitViolation({
        task: "question_rewrite",
        context: Array.from(
          { length: AI_ASSIST_REQUEST_LIMITS.maxContextItems + 1 },
          (_, index) => ({
            label: `context ${index}`,
            kind: "user_text",
            value: "small"
          })
        )
      })?.code,
      "TOO_MANY_CONTEXT_ITEMS"
    );
  });

  it("falls back without stopping the caller when a provider fails", async () => {
    let observedProviderId = "";
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
      provider,
      {
        onProviderError: (_error, failedProvider) => {
          observedProviderId = failedProvider.id;
        }
      }
    );

    assert.equal(response.status, "fallback");
    assert.equal(response.canContinue, true);
    assert.equal(response.fallback?.reason, "provider_failed");
    assert.match(response.fallback?.message ?? "", /質問作成は継続できます/);
    assert.equal(response.output, null);
    assert.equal(response.audit.decision, "failed");
    assert.equal(observedProviderId, "failing-provider");
  });

  for (const scenario of [
    { code: "ETIMEDOUT", message: "provider timed out" },
    { code: "RATE_LIMITED", message: "rate limit exceeded" },
    { code: "ENOTFOUND", message: "network lookup failed" }
  ]) {
    it(`falls back for AI provider ${scenario.code}`, async () => {
      const provider = {
        id: `provider-${scenario.code.toLowerCase()}`,
        mode: "remote",
        supportsStreaming: false,
        generate: async () => {
          const error = new Error(scenario.message);
          error.code = scenario.code;
          throw error;
        }
      };

      const response = await runAiAssistPipelineWithProvider(
        {
          task: "error_summary",
          context: [{ label: "error", kind: "error", value: "TypeError: failed to fetch" }]
        },
        provider
      );

      assert.equal(response.status, "fallback");
      assert.equal(response.canContinue, true);
      assert.equal(response.fallback?.reason, "provider_failed");
      assert.equal(response.audit.decision, "failed");
      assert.equal(response.audit.metadata.providerId, provider.id);
    });
  }

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
      scanAiAssistRequestForSecrets({
        task: "patch_proposal",
        context: [{ label: "output", kind: "user_text", value: response.output.text }]
      }).blocked,
      false
    );
  });

  it("prompts patch proposals as JSON review artifacts", () => {
    const request = {
      task: "patch_proposal",
      context: [
        {
          label: "thread",
          kind: "thread_excerpt",
          value: "src/calculator.ts の空文字入力で NaN になります。"
        }
      ]
    };
    const { context } = minimizeAiAssistRequest(request);
    const providerRequest = buildAiProviderRequest(request, context);

    assert.match(providerRequest.prompt.system, /JSON object/);
    assert.match(providerRequest.prompt.system, /target_file_path/);
    assert.match(providerRequest.prompt.system, /base_commit_sha/);
    assert.match(providerRequest.prompt.system, /patch_text/);
    assert.match(providerRequest.prompt.system, /単一ファイル/);
    assert.match(providerRequest.prompt.system, /ローカル適用/);
  });

  it("prompts cause candidates with confidence, next checks, and uncertainty", () => {
    const request = {
      task: "cause_candidates",
      context: [
        {
          label: "thread",
          kind: "thread_excerpt",
          value: "npm run dev fails with EADDRINUSE"
        }
      ]
    };
    const { context } = minimizeAiAssistRequest(request);
    const providerRequest = buildAiProviderRequest(request, context);

    assert.match(providerRequest.prompt.system, /複数件/);
    assert.match(providerRequest.prompt.system, /確度/);
    assert.match(providerRequest.prompt.system, /コマンドやファイル/);
    assert.match(providerRequest.prompt.system, /断定できない理由/);
  });
});
