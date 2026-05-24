import {
  PRESENCE_ACK_NOTEFILE,
  extractPresenceAckMessageId,
  normalizeNotehubRoutePayload,
} from '@regattaone/shared';
import { Firestore } from 'firebase-admin/firestore';
import type { Change, DocumentSnapshot, FirestoreEvent } from 'firebase-functions/v2/firestore';
import { NotehubService } from '../services/notehub.service';
import { OutboundQueueService } from './outbound-queue.service';
import {
  detectPresenceChange,
  isNewLifecycleEvent,
  processPresenceChange,
} from './presence-sync.handler';
import { logFunction, summarizePresenceState } from '../logging';

const FN_SYNC = 'syncDevicePresence';
const FN_RETRY = 'processPresenceMessageRetries';
const FN_ACK = 'notehubPresenceAck';

/** Fields that alone do not represent a presence transition. */
const PRESENCE_METADATA_FIELDS = new Set([
  'lastUpdatedAt',
  'lastEventTime',
  'lastEventId',
  'lastSeen',
  'updatedAt',
]);

function hasOnlyNonPresenceMetadataChange(
  before: FirebaseFirestore.DocumentData | undefined,
  after: FirebaseFirestore.DocumentData | undefined,
): boolean {
  if (!before || !after) {
    return false;
  }

  // Always run presence detection for a new boat.qo event (boot / set / changed).
  if (isNewLifecycleEvent(before, after)) {
    return false;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (PRESENCE_METADATA_FIELDS.has(key)) {
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

    logFunction(FN_SYNC, 'start', 'Device document write received', {
      deviceId,
      before: summarizePresenceState(beforeData),
      after: summarizePresenceState(afterData),
    });

    if (beforeData && afterData && hasOnlyNonPresenceMetadataChange(beforeData, afterData)) {
      logFunction(FN_SYNC, 'skip', 'Metadata-only change ignored', { deviceId });
      return;
    }

    const change = detectPresenceChange(beforeData, afterData, deviceId);
    if (!change) {
      logFunction(FN_SYNC, 'skip', 'No presence transition detected', {
        deviceId,
        before: summarizePresenceState(beforeData),
        after: summarizePresenceState(afterData),
      });
      return;
    }

    if (!change.device.product && !defaultProjectUid && change.kind !== 'removed') {
      logFunction(FN_SYNC, 'warn', 'Skipping sync — device missing Notehub product UID', {
        deviceId,
        kind: change.kind,
        deviceUid: change.device.notehubDeviceUid,
      });
      return;
    }

    logFunction(FN_SYNC, 'start', 'Processing presence transition', {
      deviceId,
      kind: change.kind,
      deviceUid: change.device.notehubDeviceUid,
      deviceIdLogical: change.device.deviceId,
      online: change.device.online,
      product: change.device.product ?? defaultProjectUid,
    });

    const deliveryCount = await processPresenceChange(db, notehub, queue, change, defaultProjectUid);

    logFunction(FN_SYNC, 'success', 'Presence sync completed', {
      deviceId,
      kind: change.kind,
      deliveryCount,
    });
  };
}

export async function handlePresenceAckWebhook(
  queue: OutboundQueueService,
  rawPayload: unknown,
): Promise<{ ok: boolean; messageId?: string; ignored?: boolean }> {
  const payload = normalizeNotehubRoutePayload(rawPayload);
  const notefile = String(payload.file ?? '').trim();

  if (notefile !== PRESENCE_ACK_NOTEFILE) {
    logFunction(FN_ACK, 'skip', 'Ignoring non-presence-ack payload', { file: notefile });
    return { ok: true, ignored: true };
  }

  const deviceUid = payload.device;
  const body = payload.body ?? {};
  const messageId = extractPresenceAckMessageId(body);

  logFunction(FN_ACK, 'start', 'Processing presence ack webhook', {
    device: deviceUid,
    messageId,
    ackOk: body['ok'] !== false,
    body,
  });

  if (!deviceUid || !messageId) {
    logFunction(FN_ACK, 'warn', 'Ack payload missing device or message id', {
      device: deviceUid,
      body,
    });
    return { ok: true, ignored: true };
  }

  const message = await queue.getMessage(deviceUid, messageId);
  if (!message) {
    logFunction(FN_ACK, 'warn', 'Ack received for unknown queue message', { deviceUid, messageId });
    return { ok: true, ignored: true };
  }

  if (body['ok'] === false) {
    await queue.markRetry(deviceUid, messageId, message.attemptCount + 1, 'Device reported ack failure');
    logFunction(FN_ACK, 'warn', 'Device reported delivery failure — scheduled retry', {
      deviceUid,
      messageId,
      attemptCount: message.attemptCount + 1,
      eventType: message.eventType,
    });
    return { ok: true, messageId };
  }

  await queue.markAcked(deviceUid, messageId);
  logFunction(FN_ACK, 'success', 'Presence message acknowledged', {
    deviceUid,
    messageId,
    eventType: message.eventType,
    previousStatus: message.status,
  });
  return { ok: true, messageId };
}

export async function retryPendingPresenceMessages(
  notehub: NotehubService,
  queue: OutboundQueueService,
): Promise<number> {
  logFunction(FN_RETRY, 'start', 'Scanning outbound queue for retries');

  const messages = await queue.listRetryableMessages();

  logFunction(FN_RETRY, 'start', 'Retry candidates loaded', {
    candidateCount: messages.length,
    messageIds: messages.map((message) => message.id),
  });

  let sent = 0;
  let acked = 0;
  let failed = 0;

  for (const message of messages) {
    logFunction(FN_RETRY, 'start', 'Retrying presence message', {
      messageId: message.id,
      targetDeviceUid: message.targetNotehubDeviceUid,
      status: message.status,
      attemptCount: message.attemptCount,
      eventType: message.eventType,
      compactPayload: message.compactPayload,
    });

    const result = await notehub.sendPresenceNotification(
      message.projectUid,
      message.targetNotehubDeviceUid,
      message.compactPayload,
    );

    if (result.success) {
      await queue.markSent(message.targetNotehubDeviceUid, message.id);
      sent += 1;

      const ack = await notehub.fetchLatestPresenceAck(
        message.projectUid,
        message.targetNotehubDeviceUid,
        message.id,
      );

      if (ack?.ok) {
        await queue.markAcked(message.targetNotehubDeviceUid, message.id);
        acked += 1;
        logFunction(FN_RETRY, 'success', 'Retry send succeeded and ack found', {
          messageId: message.id,
          targetDeviceUid: message.targetNotehubDeviceUid,
        });
      } else {
        logFunction(FN_RETRY, 'success', 'Retry send succeeded — awaiting device ack', {
          messageId: message.id,
          targetDeviceUid: message.targetNotehubDeviceUid,
        });
      }

      continue;
    }

    await queue.markRetry(
      message.targetNotehubDeviceUid,
      message.id,
      message.attemptCount + 1,
      result.error ?? 'Retry send failed',
    );
    failed += 1;

    logFunction(FN_RETRY, 'warn', 'Retry send failed', {
      messageId: message.id,
      targetDeviceUid: message.targetNotehubDeviceUid,
      attemptCount: message.attemptCount + 1,
      error: result.error,
    });
  }

  logFunction(FN_RETRY, 'success', 'Retry sweep completed', {
    candidateCount: messages.length,
    sent,
    acked,
    failed,
  });

  return messages.length;
}
