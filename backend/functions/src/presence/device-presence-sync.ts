import {
  PRESENCE_ACK_NOTEFILE,
  extractPresenceAckMessageId,
  normalizeNotehubRoutePayload,
} from '@regattaone/shared';
import { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { Change, DocumentSnapshot, FirestoreEvent } from 'firebase-functions/v2/firestore';
import { NotehubService } from '../services/notehub.service';
import { OutboundQueueService } from './outbound-queue.service';
import {
  detectPresenceChange,
  processPresenceChange,
} from './presence-sync.handler';

function hasOnlyNonPresenceMetadataChange(
  before: FirebaseFirestore.DocumentData | undefined,
  after: FirebaseFirestore.DocumentData | undefined,
): boolean {
  if (!before || !after) {
    return false;
  }

  const ignoredFields = new Set([
    'lastUpdatedAt',
    'lastEventTime',
    'lastEventId',
    'lastSeen',
    'reason',
    'updatedAt',
  ]);

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (ignoredFields.has(key)) {
      continue;
    }

    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      return false;
    }
  }

  return true;
}

export function createDevicePresenceSyncHandler(
  db: Firestore,
  notehub: NotehubService,
  queue: OutboundQueueService,
  defaultProjectUid?: string,
) {
  return async (
    event: FirestoreEvent<Change<DocumentSnapshot> | undefined, { deviceId: string }>,
  ): Promise<void> => {
    const deviceId = event.params.deviceId;
    const beforeSnap = event.data?.before;
    const afterSnap = event.data?.after;
    const beforeData = beforeSnap?.exists ? beforeSnap.data() : undefined;
    const afterData = afterSnap?.exists ? afterSnap.data() : undefined;

    if (beforeData && afterData && hasOnlyNonPresenceMetadataChange(beforeData, afterData)) {
      return;
    }

    const change = detectPresenceChange(beforeData, afterData, deviceId);
    if (!change) {
      return;
    }

  if (!change.device.product && !defaultProjectUid && change.kind !== 'removed') {
      logger.warn('Skipping presence sync — device missing Notehub product UID', {
        deviceId,
        kind: change.kind,
      });
      return;
    }

    await processPresenceChange(db, notehub, queue, change, defaultProjectUid);
  };
}

export async function handlePresenceAckWebhook(
  queue: OutboundQueueService,
  rawPayload: unknown,
): Promise<{ ok: boolean; messageId?: string; ignored?: boolean }> {
  const payload = normalizeNotehubRoutePayload(rawPayload);
  const notefile = String(payload.file ?? '').trim();

  if (notefile !== PRESENCE_ACK_NOTEFILE) {
    logger.warn('Ignoring non-presence-ack Notehub payload', { file: notefile });
    return { ok: true, ignored: true };
  }

  const deviceUid = payload.device;
  const body = payload.body ?? {};
  const messageId = extractPresenceAckMessageId(body);

  if (!deviceUid || !messageId) {
    logger.warn('Presence ack payload missing device or message id', {
      device: deviceUid,
      body,
    });
    return { ok: true, ignored: true };
  }

  const message = await queue.getMessage(deviceUid, messageId);
  if (!message) {
    logger.warn('Presence ack received for unknown message', { deviceUid, messageId });
    return { ok: true, ignored: true };
  }

  if (body['ok'] === false) {
    await queue.markRetry(deviceUid, messageId, message.attemptCount + 1, 'Device reported ack failure');
    logger.warn('Device reported presence delivery failure', { deviceUid, messageId });
    return { ok: true, messageId };
  }

  await queue.markAcked(deviceUid, messageId);
  logger.info('Presence message acknowledged by device', { deviceUid, messageId });
  return { ok: true, messageId };
}

export async function retryPendingPresenceMessages(
  notehub: NotehubService,
  queue: OutboundQueueService,
): Promise<number> {
  const messages = await queue.listRetryableMessages();
  let retried = 0;

  for (const message of messages) {
    const result = await notehub.sendPresenceNotification(
      message.projectUid,
      message.targetNotehubDeviceUid,
      message.compactPayload,
    );

    if (result.success) {
      await queue.markSent(message.targetNotehubDeviceUid, message.id);

      const ack = await notehub.fetchLatestPresenceAck(
        message.projectUid,
        message.targetNotehubDeviceUid,
        message.id,
      );

      if (ack?.ok) {
        await queue.markAcked(message.targetNotehubDeviceUid, message.id);
      }

      retried += 1;
      continue;
    }

    await queue.markRetry(
      message.targetNotehubDeviceUid,
      message.id,
      message.attemptCount + 1,
      result.error ?? 'Retry send failed',
    );
    retried += 1;
  }

  if (retried > 0) {
    logger.info('Processed presence message retries', { retried });
  }

  return retried;
}
