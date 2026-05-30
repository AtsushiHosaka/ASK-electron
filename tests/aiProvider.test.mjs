import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConfiguredAiProvider } from "../src/main/aiProvider.ts";
import {
  buildAiProviderRequest,
  minimizeAiAssistRequest,
  runAiAssistPipelineWithProvider
} from "../src/shared/aiPipeline.ts";

const createProviderRequest = () => {
  const request = {
    task: "question_rewrite",
    context: [{ label: "situation", kind: "user_text", value: "Vite が起動しません。" }],
    options: { maxOutputChars: 600 }
  };
  const { context } = minimizeAiAssistRequest(request);

  return buildAiProviderRequest(request, context);
};

describe("configured AI provider", () => {
  it("calls a configured OpenAI-compatible endpoint from main-process configuration", async () => {
    let observedUrl = "";
    let observedInit = null;
    const provider = createConfiguredAiProvider({
      env: {
        ASK_AI_PROVIDER_API_KEY: "test-provider-key",
        ASK_AI_PROVIDER_MODEL: "test-model",
        ASK_AI_PROVIDER_URL: "https://ai.example.test/v1/chat/completions"
      },
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "先生に共有しやすい形へ整理しました。" } }],
            usage: { prompt_tokens: 42, completion_tokens: 12 }
          })
        };
      }
    });

    const result = await provider.generate(createProviderRequest());
    assert.ok(observedInit);
    const requestBody = JSON.parse(String(observedInit.body));

    assert.equal(provider.id, "configured-openai-compatible");
    assert.equal(provider.mode, "remote");
    assert.equal(observedUrl, "https://ai.example.test/v1/chat/completions");
    assert.equal(observedInit.headers.Authorization, "Bearer test-provider-key");
    assert.equal(requestBody.model, "test-model");
    assert.equal(requestBody.messages[0].role, "system");
    assert.equal(requestBody.messages[1].role, "user");
    assert.equal(String(observedInit.body).includes("test-provider-key"), false);
    assert.equal(result.text, "先生に共有しやすい形へ整理しました。");
    assert.deepEqual(result.usage, { inputChars: 42, outputChars: 12 });
  });

  it("falls back without blocking manual work when the provider is not configured", async () => {
    let called = false;
    const provider = createConfiguredAiProvider({
      env: {},
      fetchImpl: async () => {
        called = true;
        throw new Error("should not fetch without configuration");
      }
    });

    const response = await runAiAssistPipelineWithProvider(
      {
        task: "question_rewrite",
        context: [{ label: "situation", kind: "user_text", value: "npm test が失敗します。" }]
      },
      provider
    );

    assert.equal(called, false);
    assert.equal(response.status, "fallback");
    assert.equal(response.canContinue, true);
    assert.equal(response.fallback?.reason, "provider_failed");
    assert.equal(response.provider.id, "configured-openai-compatible");
  });

  it("does not call the configured provider when blocked secrets are present", async () => {
    let called = false;
    const provider = createConfiguredAiProvider({
      env: {
        ASK_AI_PROVIDER_API_KEY: "test-provider-key",
        ASK_AI_PROVIDER_MODEL: "test-model"
      },
      fetchImpl: async () => {
        called = true;
        throw new Error("blocked payload should not reach provider");
      }
    });

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
  });

  it("rejects non-local HTTP provider URLs", async () => {
    const provider = createConfiguredAiProvider({
      env: {
        ASK_AI_PROVIDER_API_KEY: "test-provider-key",
        ASK_AI_PROVIDER_MODEL: "test-model",
        ASK_AI_PROVIDER_URL: "http://ai.example.test/v1/chat/completions"
      },
      fetchImpl: async () => {
        throw new Error("should not fetch invalid URL");
      }
    });

    await assert.rejects(provider.generate(createProviderRequest()), /https URL/);
  });
});
