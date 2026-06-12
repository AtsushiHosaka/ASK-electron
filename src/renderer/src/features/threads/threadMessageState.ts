import type { AppRole } from "../../../../shared/domain";
import type { Database, MessageSenderType, MessageType } from "../../../../shared/database.types";

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
export type MessageInsert = Database["public"]["Tables"]["messages"]["Insert"];
export type PatchProposalRow = Database["public"]["Tables"]["patch_proposals"]["Row"];
export type PatchProposalSummary = Pick<
  PatchProposalRow,
  | "id"
  | "message_id"
  | "status"
  | "target_file_path"
  | "base_commit_sha"
  | "explanation"
  | "created_by_type"
>;

type BuildChatMessageInsertInput = {
  threadId: string;
  senderUserId: string;
  senderRole: AppRole;
  body: string;
  messageType: MessageType;
};

export type ChatMessageInsertResult =
  | {
      ok: true;
      message: MessageInsert;
      senderType: MessageSenderType;
    }
  | {
      ok: false;
      error: string;
    };

export const resolveProfileMessageSender = (role: AppRole): MessageSenderType => {
  return role === "student" ? "student" : "teacher";
};

export const buildChatMessageInsert = ({
  threadId,
  senderUserId,
  senderRole,
  body,
  messageType
}: BuildChatMessageInsertInput): ChatMessageInsertResult => {
  const trimmedBody = body.trim();

  if (!trimmedBody) {
    return { ok: false, error: "メッセージを入力してください。" };
  }

  const senderType = resolveProfileMessageSender(senderRole);

  return {
    ok: true,
    senderType,
    message: {
      thread_id: threadId,
      sender_user_id: senderUserId,
      sender_type: senderType,
      body: trimmedBody,
      message_type: messageType
    }
  };
};

export const sortMessages = (messages: MessageRow[]): MessageRow[] => {
  return [...messages].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
};

export const upsertMessage = (messages: MessageRow[], nextMessage: MessageRow): MessageRow[] => {
  const withoutCurrent = messages.filter((message) => message.id !== nextMessage.id);
  return sortMessages([...withoutCurrent, nextMessage]);
};

export const removeMessage = (messages: MessageRow[], messageId: string): MessageRow[] => {
  return messages.filter((message) => message.id !== messageId);
};

export const upsertPatchProposal = (
  proposals: Map<string, PatchProposalSummary>,
  proposal: PatchProposalSummary
): Map<string, PatchProposalSummary> => {
  const nextProposals = new Map(proposals);
  nextProposals.set(proposal.message_id, proposal);
  return nextProposals;
};

export const removePatchProposal = (
  proposals: Map<string, PatchProposalSummary>,
  patchProposalId: string | null,
  messageId: string | null
): Map<string, PatchProposalSummary> => {
  const nextProposals = new Map(proposals);

  if (messageId) {
    nextProposals.delete(messageId);
    return nextProposals;
  }

  if (patchProposalId) {
    for (const [proposalMessageId, proposal] of nextProposals.entries()) {
      if (proposal.id === patchProposalId) {
        nextProposals.delete(proposalMessageId);
      }
    }
  }

  return nextProposals;
};
