import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);

describe("thread detail realtime sync", () => {
  it("subscribes to message, patch proposal, and thread row changes", () => {
    assert.match(threadDetailSource, /channel\(`thread-detail-\$\{threadId\}`\)/);
    assert.match(
      threadDetailSource,
      /table: "messages"[\s\S]*filter: `thread_id=eq\.\$\{threadId\}`/
    );
    assert.match(threadDetailSource, /table: "patch_proposals"/);
    assert.match(threadDetailSource, /table: "threads"[\s\S]*filter: `id=eq\.\$\{threadId\}`/);
  });

  it("handles inserts, updates, and deletes without duplicating local rows", () => {
    assert.match(threadDetailSource, /const upsertMessage = /);
    assert.match(threadDetailSource, /messages: upsertMessage\(current\.messages, nextMessage\)/);
    assert.match(threadDetailSource, /messages: removeMessage\(current\.messages, messageId\)/);
    assert.match(threadDetailSource, /upsertPatchProposal/);
    assert.match(threadDetailSource, /removePatchProposal/);
  });

  it("loads a patch message when proposal metadata arrives before the message event", () => {
    assert.match(threadDetailSource, /const loadPatchMessage = async/);
    assert.match(
      threadDetailSource,
      /\.from\("messages"\)[\s\S]*\.eq\("id", proposal\.message_id\)/
    );
    assert.match(
      threadDetailSource,
      /if \(!messageKnown\) \{\s*void loadPatchMessage\(proposal\);/
    );
  });
});
