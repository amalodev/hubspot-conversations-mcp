import type { MessageParticipant, PublicMessage } from "./hubspot-types.js";

function timestamp(value?: string): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Derive reply recipients from a thread's message history: the senders of the
 * most recent INCOMING message become the recipients of the reply, in the
 * shape the create-message endpoint expects (`deliveryIdentifiers` array).
 */
export function deriveReplyRecipients(
  messages: PublicMessage[],
): MessageParticipant[] | undefined {
  const newestFirst = [...messages].sort(
    (a, b) => timestamp(b.createdAt) - timestamp(a.createdAt),
  );

  for (const message of newestFirst) {
    if (message.type !== "MESSAGE" || message.direction !== "INCOMING") continue;

    const recipients = (message.senders ?? [])
      .map((sender) => {
        const identifiers =
          sender.deliveryIdentifiers ??
          (sender.deliveryIdentifier ? [sender.deliveryIdentifier] : []);
        const recipient: MessageParticipant = {};
        if (sender.actorId) recipient.actorId = sender.actorId;
        if (sender.name) recipient.name = sender.name;
        if (identifiers.length > 0) recipient.deliveryIdentifiers = identifiers;
        return recipient;
      })
      .filter(
        (recipient) =>
          recipient.actorId !== undefined ||
          (recipient.deliveryIdentifiers?.length ?? 0) > 0,
      );

    if (recipients.length > 0) return recipients;
  }
  return undefined;
}
