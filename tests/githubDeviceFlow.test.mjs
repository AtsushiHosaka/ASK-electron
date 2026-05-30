import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGitHubDeviceFlowService } from "../src/main/githubDeviceFlow.ts";

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body
});

describe("GitHub Device Flow fallback", () => {
  it("reports configuration guidance without making a provider request", async () => {
    let called = false;
    const service = createGitHubDeviceFlowService({
      env: {},
      fetchImpl: async () => {
        called = true;
        throw new Error("fetch should not run without client id");
      }
    });

    const response = await service.start();

    assert.equal(called, false);
    assert.equal(response.status, "configuration_missing");
    assert.equal(response.sessionId, null);
    assert.equal(response.userCode, null);
    assert.match(response.message, /ASK_GITHUB_OAUTH_CLIENT_ID/);
  });

  it("starts a browser-code session without exposing the device code", async () => {
    const requests = [];
    const service = createGitHubDeviceFlowService({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-id-123" },
      now: () => new Date("2026-05-31T00:00:00.000Z"),
      createSessionId: () => "session-1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });

        return jsonResponse({
          device_code: "provider-device-code",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5
        });
      }
    });

    const response = await service.start();
    const requestBody = String(requests[0].init.body);

    assert.equal(response.status, "ready");
    assert.equal(response.sessionId, "session-1");
    assert.equal(response.userCode, "ABCD-1234");
    assert.equal(response.verificationUri, "https://github.com/login/device");
    assert.equal(response.expiresAt, "2026-05-31T00:15:00.000Z");
    assert.equal(JSON.stringify(response).includes("provider-device-code"), false);
    assert.equal(requests[0].url, "https://github.com/login/device/code");
    assert.equal(requestBody.includes("client_id=client-id-123"), true);
    assert.equal(requestBody.includes("client_secret"), false);
  });

  it("keeps polling pending sessions without exposing tokens to the renderer response", async () => {
    const service = createGitHubDeviceFlowService({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-id-123" },
      now: () => new Date("2026-05-31T00:00:00.000Z"),
      createSessionId: () => "session-1",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/device/code")) {
          return jsonResponse({
            device_code: "provider-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5
          });
        }

        return jsonResponse({
          error: "authorization_pending",
          error_description: "authorization is pending"
        });
      }
    });

    await service.start();
    const response = await service.poll({ sessionId: "session-1" });

    assert.equal(response.status, "pending");
    assert.equal(response.githubUsername, null);
    assert.equal(response.authMethod, null);
    assert.equal(JSON.stringify(response).includes("provider-device-code"), false);
  });

  it("completes account linkage metadata and discards the access token", async () => {
    const requests = [];
    const service = createGitHubDeviceFlowService({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-id-123" },
      now: () => new Date("2026-05-31T00:00:00.000Z"),
      createSessionId: () => "session-1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });

        if (String(url).endsWith("/device/code")) {
          return jsonResponse({
            device_code: "provider-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5
          });
        }

        if (String(url).endsWith("/access_token")) {
          return jsonResponse({ access_token: "gho_secret_token_for_test" });
        }

        return jsonResponse({ login: "student-user" });
      }
    });

    await service.start();
    const response = await service.poll({ sessionId: "session-1" });

    assert.equal(response.status, "completed");
    assert.equal(response.githubUsername, "student-user");
    assert.equal(response.authMethod, "device_flow");
    assert.equal(JSON.stringify(response).includes("gho_secret_token_for_test"), false);
    assert.equal(requests[1].url, "https://github.com/login/oauth/access_token");
    assert.equal(String(requests[1].init.body).includes("device_code=provider-device-code"), true);
    assert.equal(requests[2].url, "https://api.github.com/user");
    assert.equal(requests[2].init.headers.Authorization, "Bearer gho_secret_token_for_test");

    const afterCompletion = await service.poll({ sessionId: "session-1" });
    assert.equal(afterCompletion.status, "not_found");
  });

  it("redacts token-shaped provider errors", async () => {
    const service = createGitHubDeviceFlowService({
      env: { ASK_GITHUB_OAUTH_CLIENT_ID: "client-id-123" },
      now: () => new Date("2026-05-31T00:00:00.000Z"),
      createSessionId: () => "session-1",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/device/code")) {
          return jsonResponse({
            device_code: "provider-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5
          });
        }

        return jsonResponse({
          error: "bad_verification_code",
          error_description: "access_token=gho_secret_token_for_test was rejected"
        });
      }
    });

    await service.start();
    const response = await service.poll({ sessionId: "session-1" });

    assert.equal(response.status, "provider_error");
    assert.equal(response.message.includes("gho_secret_token_for_test"), false);
    assert.match(response.message, /\[redacted token\]/);
  });
});
