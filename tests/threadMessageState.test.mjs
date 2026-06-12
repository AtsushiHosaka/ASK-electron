import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatMessageInsert,
  removeMessage,
  removePatchProposal,
  sortMessages,
  upsertMessage,
  upsertPatchProposal
} from "../src/renderer/src/features/threads/threadMessageState.ts";

const message = (overrides) => ({
  id: "message-1",
  thread_id: "thread-1",
  sender_user_id: "user-1",
  sender_type: "student",
  body: "body",
  message_type: "text",
  reply_to_message_id: null,
  created_at: "2026-06-01T00:00:00.000Z",
  ...overrides
});

const patchProposal = (overrides) => ({
  id: "proposal-1",
  message_id: "message-1",
  status: "proposed",
  target_file_path: "src/app.ts",
  base_commit_sha: null,
  explanation: "説明",
  created_by_type: "teacher",
  ...overrides
});

describe("thread message state helpers", () => {
  it("builds a trimmed chat insert payload for message sending", () => {
    const result = buildChatMessageInsert({
      threadId: "thread-1",
      senderUserId: "student-1",
      senderRole: "student",
      body: "  質問です\n",
      messageType: "code"
    });

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(result.senderType, "student");
    assert.deepEqual(result.message, {
      thread_id: "thread-1",
      sender_user_id: "student-1",
      sender_type: "student",
      body: "質問です",
      message_type: "code"
    });
  });

  it("maps teacher and admin profiles to teacher chat senders", () => {
    const teacherResult = buildChatMessageInsert({
      threadId: "thread-1",
      senderUserId: "teacher-1",
      senderRole: "teacher",
      body: "確認しました",
      messageType: "text"
    });
    const adminResult = buildChatMessageInsert({
      threadId: "thread-1",
      senderUserId: "admin-1",
      senderRole: "admin",
      body: "管理者から確認",
      messageType: "text"
    });

    assert.equal(teacherResult.ok && teacherResult.senderType, "teacher");
    assert.equal(adminResult.ok && adminResult.senderType, "teacher");
  });

  it("rejects blank chat bodies before inserting", () => {
    const result = buildChatMessageInsert({
      threadId: "thread-1",
      senderUserId: "student-1",
      senderRole: "student",
      body: " \n\t ",
      messageType: "text"
    });

    assert.deepEqual(result, { ok: false, error: "メッセージを入力してください。" });
  });

  it("sorts and upserts messages without mutating the current list", () => {
    const current = [
      message({ id: "new", body: "new", created_at: "2026-06-01T00:02:00.000Z" }),
      message({ id: "old", body: "old", created_at: "2026-06-01T00:00:00.000Z" })
    ];
    const replacement = message({
      id: "new",
      body: "updated",
      created_at: "2026-06-01T00:01:00.000Z"
    });

    const sorted = sortMessages(current);
    const upserted = upsertMessage(current, replacement);

    assert.deepEqual(
      sorted.map((item) => item.id),
      ["old", "new"]
    );
    assert.deepEqual(
      upserted.map((item) => `${item.id}:${item.body}`),
      ["old:old", "new:updated"]
    );
    assert.equal(current[0].body, "new");
  });

  it("removes messages and matching patch proposals", () => {
    const messages = [message({ id: "keep" }), message({ id: "delete" })];
    const proposals = new Map([
      ["keep", patchProposal({ id: "proposal-keep", message_id: "keep" })],
      ["delete", patchProposal({ id: "proposal-delete", message_id: "delete" })]
    ]);

    const nextMessages = removeMessage(messages, "delete");
    const nextProposals = removePatchProposal(proposals, null, "delete");

    assert.deepEqual(
      nextMessages.map((item) => item.id),
      ["keep"]
    );
    assert.deepEqual([...nextProposals.keys()], ["keep"]);
    assert.deepEqual([...proposals.keys()], ["keep", "delete"]);
  });

  it("upserts and removes patch proposals by proposal id when message id is unavailable", () => {
    const proposals = new Map([
      ["message-1", patchProposal({ id: "proposal-1", message_id: "message-1" })]
    ]);

    const upserted = upsertPatchProposal(
      proposals,
      patchProposal({ id: "proposal-2", message_id: "message-2" })
    );
    const removed = removePatchProposal(upserted, "proposal-1", null);

    assert.deepEqual([...upserted.keys()], ["message-1", "message-2"]);
    assert.deepEqual([...removed.keys()], ["message-2"]);
    assert.deepEqual([...proposals.keys()], ["message-1"]);
  });
});
