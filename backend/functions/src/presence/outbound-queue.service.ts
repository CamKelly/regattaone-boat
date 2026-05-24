import {
  CompactPresencePayload,
  DevicePresenceEventType,
  OutboundMessageStatus,
  OutboundPresenceMessage,
} from '@regattaone/shared';
import { Firestore, Timestamp } from 'firebase-admin/firestore';

export const OUTBOUND_QUEUE_COLLECTION = 'deviceOutboundQueue';
export const OUTBOUND_MESSAGES_SUBCOLLECTION = 'messages';

export const MAX_PRESENCE_MESSAGE_ATTEMPTS = 5;
export const PRESENCE_RETRY_BASE_DELAY_MS = 60_000;

export interface EnqueuePresenceMessageInput {
  targetNotehubDeviceUid: string;
  projectUid: string;
  eventType: DevicePresenceEventType;
  compactPayload: CompactPresencePayload;
  raceId?: string;
  fleetId?: string;
  sourceDeviceUid?: string;
}

function toIso(value: Timestamp | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  return value;
}

export function computeNextRetryAt(attemptCount: number, from = Date.now()): string {
  const delayMs = PRESENCE_RETRY_BASE_DELAY_MS * Math.max(1, attemptCount);
  return new Date(from + delayMs).toISOString();
}

export function mapOutboundMessage(
  data: FirebaseFirestore.DocumentData,
): OutboundPresenceMessage {
  return {
    id: String(data['id'] ?? ''),
    targetNotehubDeviceUid: String(data['targetNotehubDeviceUid'] ?? ''),
    projectUid: String(data['projectUid'] ?? ''),
    eventType: data['eventType'] as DevicePresenceEventType,
    compactPayload: data['compactPayload'] as CompactPresencePayload,
    status: data['status'] as OutboundMessageStatus,
    attemptCount: Number(data['attemptCount'] ?? 0),
    maxAttempts: Number(data['maxAttempts'] ?? MAX_PRESENCE_MESSAGE_ATTEMPTS),
    nextRetryAt: toIso(data['nextRetryAt']) ?? new Date().toISOString(),
    createdAt: toIso(data['createdAt']) ?? new Date().toISOString(),
    sentAt: toIso(data['sentAt']),
    ackedAt: toIso(data['ackedAt']),
    lastError: typeof data['lastError'] === 'string' ? data['lastError'] : undefined,
    raceId: typeof data['raceId'] === 'string' ? data['raceId'] : undefined,
    fleetId: typeof data['fleetId'] === 'string' ? data['fleetId'] : undefined,
    sourceDeviceUid:
      typeof data['sourceDeviceUid'] === 'string' ? data['sourceDeviceUid'] : undefined,
  };
}

export class OutboundQueueService {
  constructor(private readonly db: Firestore) {}

  private messageRef(deviceUid: string, messageId: string) {
    return this.db
      .collection(OUTBOUND_QUEUE_COLLECTION)
      .doc(deviceUid)
      .collection(OUTBOUND_MESSAGES_SUBCOLLECTION)
      .doc(messageId);
  }

  async enqueueMessage(input: EnqueuePresenceMessageInput): Promise<OutboundPresenceMessage> {
    const now = new Date().toISOString();
    const messageId = input.compactPayload.mid;
    const record: OutboundPresenceMessage = {
      id: messageId,
      targetNotehubDeviceUid: input.targetNotehubDeviceUid,
      projectUid: input.projectUid,
      eventType: input.eventType,
      compactPayload: input.compactPayload,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: MAX_PRESENCE_MESSAGE_ATTEMPTS,
      nextRetryAt: now,
      createdAt: now,
      raceId: input.raceId,
      fleetId: input.fleetId,
      sourceDeviceUid: input.sourceDeviceUid,
    };

    await this.messageRef(input.targetNotehubDeviceUid, messageId).set({
      ...record,
      nextRetryAt: Timestamp.fromDate(new Date(record.nextRetryAt)),
      createdAt: Timestamp.fromDate(new Date(record.createdAt)),
    });

    return record;
  }

  async markSent(deviceUid: string, messageId: string): Promise<void> {
    const sentAt = new Date().toISOString();
    await this.messageRef(deviceUid, messageId).set(
      {
        status: 'sent',
        sentAt: Timestamp.fromDate(new Date(sentAt)),
        nextRetryAt: Timestamp.fromDate(
          new Date(computeNextRetryAt(1, Date.parse(sentAt))),
        ),
      },
      { merge: true },
    );
  }

  async markAcked(deviceUid: string, messageId: string): Promise<void> {
    const ackedAt = new Date().toISOString();
    await this.messageRef(deviceUid, messageId).set(
      {
        status: 'acked',
        ackedAt: Timestamp.fromDate(new Date(ackedAt)),
      },
      { merge: true },
    );
  }

  async markRetry(
    deviceUid: string,
    messageId: string,
    attemptCount: number,
    error: string,
  ): Promise<void> {
    const nextRetryAt = computeNextRetryAt(attemptCount);
    const status: OutboundMessageStatus =
      attemptCount >= MAX_PRESENCE_MESSAGE_ATTEMPTS ? 'failed' : 'pending';

    await this.messageRef(deviceUid, messageId).set(
      {
        status,
        attemptCount,
        lastError: error,
        nextRetryAt: Timestamp.fromDate(new Date(nextRetryAt)),
      },
      { merge: true },
    );
  }

  async getMessage(
    deviceUid: string,
    messageId: string,
  ): Promise<OutboundPresenceMessage | null> {
    const snap = await this.messageRef(deviceUid, messageId).get();
    if (!snap.exists) {
      return null;
    }

    return mapOutboundMessage(snap.data()!);
  }

  async listRetryableMessages(limit = 50): Promise<OutboundPresenceMessage[]> {
    const now = Timestamp.now();
    const pendingSnap = await this.db
      .collectionGroup(OUTBOUND_MESSAGES_SUBCOLLECTION)
      .where('status', '==', 'pending')
      .where('nextRetryAt', '<=', now)
      .limit(limit)
      .get();

    const sentSnap = await this.db
      .collectionGroup(OUTBOUND_MESSAGES_SUBCOLLECTION)
      .where('status', '==', 'sent')
      .where('nextRetryAt', '<=', now)
      .limit(limit)
      .get();

    const messages = new Map<string, OutboundPresenceMessage>();
    for (const doc of [...pendingSnap.docs, ...sentSnap.docs]) {
      messages.set(`${doc.ref.parent.parent!.id}:${doc.id}`, mapOutboundMessage(doc.data()));
    }

    return [...messages.values()].filter((message) => message.attemptCount < message.maxAttempts);
  }
}
