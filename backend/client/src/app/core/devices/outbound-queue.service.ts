import { Injectable, inject } from '@angular/core';
import {
  CompactPresencePayload,
  DevicePresenceEventType,
  OutboundMessageStatus,
  OutboundPresenceMessage,
} from '@regattaone/shared';
import {
  Timestamp,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  writeBatch,
} from 'firebase/firestore';
import { Observable } from 'rxjs';
import { firebaseDb } from '../firebase/firebase.providers';

const OUTBOUND_QUEUE_COLLECTION = 'deviceOutboundQueue';
const OUTBOUND_MESSAGES_SUBCOLLECTION = 'messages';

function toIsoString(value: unknown): string | undefined {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  return undefined;
}

function mapOutboundMessage(
  docId: string,
  data: Record<string, unknown>,
): OutboundPresenceMessage {
  return {
    id: String(data['id'] ?? docId),
    targetNotehubDeviceUid: String(data['targetNotehubDeviceUid'] ?? ''),
    projectUid: String(data['projectUid'] ?? ''),
    eventType: data['eventType'] as DevicePresenceEventType,
    compactPayload: data['compactPayload'] as CompactPresencePayload,
    status: data['status'] as OutboundMessageStatus,
    attemptCount: Number(data['attemptCount'] ?? 0),
    maxAttempts: Number(data['maxAttempts'] ?? 5),
    nextRetryAt: toIsoString(data['nextRetryAt']) ?? new Date().toISOString(),
    createdAt: toIsoString(data['createdAt']) ?? new Date().toISOString(),
    sentAt: toIsoString(data['sentAt']),
    ackedAt: toIsoString(data['ackedAt']),
    lastError: typeof data['lastError'] === 'string' ? data['lastError'] : undefined,
    raceId: typeof data['raceId'] === 'string' ? data['raceId'] : undefined,
    fleetId: typeof data['fleetId'] === 'string' ? data['fleetId'] : undefined,
    sourceDeviceUid:
      typeof data['sourceDeviceUid'] === 'string' ? data['sourceDeviceUid'] : undefined,
  };
}

function messageSortTime(message: OutboundPresenceMessage): number {
  const candidate = message.sentAt ?? message.createdAt;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable({ providedIn: 'root' })
export class OutboundQueueService {
  private readonly db = inject(firebaseDb);

  watchDeviceMessages(deviceUid: string): Observable<OutboundPresenceMessage[]> {
    return new Observable((subscriber) => {
      const messagesQuery = query(
        collection(this.db, OUTBOUND_QUEUE_COLLECTION, deviceUid, OUTBOUND_MESSAGES_SUBCOLLECTION),
        orderBy('createdAt', 'desc'),
      );

      const unsubscribe = onSnapshot(
        messagesQuery,
        (snapshot) => {
          const messages = snapshot.docs
            .map((doc) => mapOutboundMessage(doc.id, doc.data()))
            .sort((a, b) => messageSortTime(b) - messageSortTime(a));
          subscriber.next(messages);
        },
        (error) => subscriber.error(error),
      );

      return () => unsubscribe();
    });
  }

  async deleteMessages(deviceUid: string, messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const batch = writeBatch(this.db);
    for (const messageId of messageIds) {
      batch.delete(
        doc(this.db, OUTBOUND_QUEUE_COLLECTION, deviceUid, OUTBOUND_MESSAGES_SUBCOLLECTION, messageId),
      );
    }
    await batch.commit();
  }
}
