import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const threadDetailSource = readFileSync(
  "src/renderer/src/features/threads/ThreadDetailPage.tsx",
  "utf8"
);

describe("thread detail realtime sync wiring", () => {
  it("subscribes the open thread to message inserts, updates, and deletes", () => {
    assert.match(threadDetailSource, /\.channel\(`thread-detail-\$\{threadId\}`\)/);
    assert.match(
      threadDetailSource,
      /event: "\*"[\s\S]*table: "messages"[\s\S]*filter: `thread_id=eq\.\$\{threadId\}`/
    );
    assert.match(threadDetailSource, /payload\.eventType === "DELETE"[\s\S]*removeMessage/);
    assert.match(threadDetailSource, /upsertMessage\(current\.messages, nextMessage\)/);
  });

  it("subscribes patch proposals so patch review metadata stays current", () => {
    assert.match(
      threadDetailSource,
      /event: "\*"[\s\S]*table: "patch_proposals"[\s\S]*filter: `thread_id=eq\.\$\{threadId\}`/
    );
    assert.match(threadDetailSource, /upsertPatchProposal\(/);
    assert.match(threadDetailSource, /removePatchProposal\(/);
  });

  it("subscribes the thread row so header status stays current", () => {
    assert.match(
      threadDetailSource,
      /event: "UPDATE"[\s\S]*table: "threads"[\s\S]*filter: `id=eq\.\$\{threadId\}`/
    );
    assert.match(threadDetailSource, /\.\.\.current\.thread,[\s\S]*\.\.\.nextThread/);
  });
});
