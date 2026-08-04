export interface DeliveryIdentifier {
  type: string;
  value: string;
}

/**
 * Participant on a message. HubSpot uses `deliveryIdentifier` (singular) on
 * message senders/recipients it returns, and `deliveryIdentifiers` (array) on
 * recipients you send — both are modeled here so the same shape works for read
 * and write paths.
 */
export interface MessageParticipant {
  actorId?: string;
  name?: string;
  deliveryIdentifier?: DeliveryIdentifier;
  deliveryIdentifiers?: DeliveryIdentifier[];
  recipientField?: string;
  [key: string]: unknown;
}

export interface PublicMessage {
  id: string;
  type: string;
  createdAt?: string;
  direction?: "INCOMING" | "OUTGOING" | string;
  senders?: MessageParticipant[];
  recipients?: MessageParticipant[];
  text?: string;
  richText?: string;
  subject?: string;
  channelId?: string;
  channelAccountId?: string;
  [key: string]: unknown;
}

export interface PublicThread {
  id: string;
  status?: "OPEN" | "CLOSED" | string;
  archived?: boolean;
  spam?: boolean;
  inboxId?: string;
  associatedContactId?: string;
  originalChannelId?: string;
  originalChannelAccountId?: string;
  assignedTo?: string;
  createdAt?: string;
  closedAt?: string;
  latestMessageTimestamp?: string;
  [key: string]: unknown;
}

export interface Paged<T> {
  results: T[];
  paging?: { next?: { after?: string } };
  [key: string]: unknown;
}
