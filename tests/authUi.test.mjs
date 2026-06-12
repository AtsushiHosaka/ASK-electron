import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const loginSource = readFileSync("src/renderer/src/features/auth/LoginPage.tsx", "utf8");
const styleSource = readFileSync("src/renderer/src/styles.css", "utf8");

describe("auth UI hierarchy", () => {
  it("uses an explicit segmented control for auth mode selection", () => {
    assert.match(loginSource, /className="auth-mode-control"/);
    assert.match(loginSource, /aria-label="認証モード"/);
    assert.match(loginSource, /aria-pressed=\{mode === "signIn"\}/);
    assert.match(loginSource, /aria-pressed=\{mode === "signUp"\}/);
    assert.doesNotMatch(loginSource, /className="link-button"/);
    assert.match(styleSource, /\.auth-mode-control/);
    assert.match(styleSource, /\.auth-mode-control button\.active/);
  });
});
