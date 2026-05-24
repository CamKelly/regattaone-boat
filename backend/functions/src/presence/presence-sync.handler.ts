import { randomUUID } from 'node:crypto';
import {
  DevicePresenceDocument,
  DevicePresenceEventType,
  buildDevicePresenceEvent,
  readDevicePresenceDocument,
  shouldNotifyPeer,
  toCompactPresencePayload,
} from '@regattaone/shared';
import { Firestore } from 'firebase-admin/firestore';
import { NotehubService } from '../services/notehub.service';
import { EnqueuePresenceMessageInput, OutboundQueueService } from './outbound-queue.service';
import { logFunction } from '../logging';

const FN = 'syncDevicePresence';

export type PresenceChangeKind =
  | 'came_online'
  | 'went_offline'
  | 'device_id_changed'
  | 'removed';

export interface PresenceChangeContext {
  kind: PresenceChangeKind;
  device: DevicePresenceDocument;
  before?: DevicePresenceDocument;
  after?: DevicePresenceDocument;
}

export interface PendingPresenceDelivery extends EnqueuePresenceMessageInput {}

function createMessageId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export async function fetchOnlinePeers(
  db: Firestore,
  source: DevicePresenceDocument,
): Promise<DevicePresenceDocument[]> {
  const snapshot = await db.collection('devices').where('online', '==', true).get();

  return snapshot.docs
    .map((doc) => readDevicePresenceDocument(doc.data(), doc.id))
    .filter((peer): peer is DevicePresenceDocument => {
      return peer !== null && shouldNotifyPeer(peer, source);
    });
}

/** Notehub lifecycle reasons that should be evaluated for presence even when online stays true. */
const LIFECYCLE_PRESENCE_REASONS = new Set(['boot', 'set', 'changed']);

export function isNewLifecycleEvent(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData,
): boolean {
  const beforeEventId = String(before['lastEventId'] ?? '');
  const afterEventId = String(after['lastEventId'] ?? '');
  const reason = String(after['reason'] ?? '');

  return (
    afterEventId.length > 0 &&
    afterEventId !== beforeEventId &&
    LIFECYCLE_PRESENCE_REASONS.has(reason)
  );
}

export function detectPresenceChange(
  beforeData: FirebaseFirestore.DocumentData | undefined,
  afterData: FirebaseFirestore.DocumentData | undefined,
  docId: string,
): PresenceChangeContext | null {
  const before = beforeData ? readDevicePresenceDocument(beforeData, docId) : null;
  const after = afterData ? readDevicePresenceDocument(afterData, docId) : null;

  if (!before && !after) {
    return null;
  }

  if (!after && before) {
    return { kind: 'removed', device: before, before, after: undefined };
  }

  if (after && !before) {
    if (after.online) {
      return { kind: 'came_online', device: after, before: undefined, after };
    }

    return null;
  }

  if (!before || !after) {
    return null;
  }

  const wasOnline = before.online === true;
  const isOnline = after.online === true;

  if (!wasOnline && isOnline) {
    return { kind: 'came_online', device: after, before, after };
  }

  if (wasOnline && !isOnline) {
    return { kind: 'went_offline', device: after, before, after };
  }

  if (before.deviceId !== after.deviceId && after.deviceId.trim().length > 0) {
    return { kind: 'device_id_changed', device: after, before, after };
  }

  // Device already online — re-announce on each new boot note from Notehub.
  if (
    isOnline &&
    wasOnline &&
    afterData &&
    beforeData &&
    isNewLifecycleEvent(beforeData, afterData) &&
    String(afterData['reason'] ?? '') === 'boot'
  ) {
    return { kind: 'came_online', device: after, before, after };
  }

  return null;
}

export function buildDeliveriesForChange(
  change: PresenceChangeContext,
  peers: DevicePresenceDocument[],
  defaultProjectUid?: string,
): PendingPresenceDelivery[] {
  const deliveries: PendingPresenceDelivery[] = [];
  const projectUid = change.device.product ?? defaultProjectUid ?? '';
  const sourceDeviceUid = change.device.notehubDeviceUid;

  const enqueue = (
    target: DevicePresenceDocument,
    eventType: DevicePresenceEventType,
    payload: Record<string, unknown>,
  ) => {
    const targetProjectUid = target.product ?? projectUid;
    if (!targetProjectUid) {
      logFunction(FN, 'warn', 'Skipped delivery — target missing Notehub product UID', {
        targetDeviceUid: target.notehubDeviceUid,
        eventType,
        sourceDeviceUid,
      });
      return;
    }

    const messageId = createMessageId();
    const event = buildDevicePresenceEvent(eventType, payload, messageId);
    deliveries.push({
      targetNotehubDeviceUid: target.notehubDeviceUid,
      projectUid: targetProjectUid,
      eventType,
      compactPayload: toCompactPresencePayload(event),
      raceId: change.device.raceId,
      fleetId: change.device.fleetId,
      sourceDeviceUid,
    });
  };

  switch (change.kind) {
    case 'came_online': {
      for (const peer of peers) {
        enqueue(peer, 'DEVICE_ONLINE', {
          deviceId: change.device.deviceId,
          deviceType: change.device.deviceType,
        });
      }

      enqueue(change.device, 'ONLINE_DEVICE_SNAPSHOT', {
        devices: peers.map((peer) => ({
          deviceId: peer.deviceId,
          deviceType: peer.deviceType,
        })),
      });
      break;
    }
    case 'went_offline': {
      for (const peer of peers) {
        enqueue(peer, 'DEVICE_OFFLINE', {
          deviceId: change.before?.deviceId ?? change.device.deviceId,
        });
      }
      break;
    }
    case 'device_id_changed': {
      for (const peer of peers) {
        enqueue(peer, 'DEVICE_ID_CHANGED', {
          oldDeviceId: change.before?.deviceId ?? '',
          newDeviceId: change.after?.deviceId ?? change.device.deviceId,
        });
      }
      break;
    }
    case 'removed': {
      for (const peer of peers) {
        enqueue(peer, 'DEVICE_REMOVED', {
          deviceId: change.before?.deviceId ?? change.device.deviceId,
        });
      }
      break;
    }
  }

  return deliveries;
}

export async function deliverPresenceMessage(
  notehub: NotehubService,
  queue: OutboundQueueService,
  delivery: PendingPresenceDelivery,
): Promise<'sent' | 'failed'> {
  logFunction(FN, 'start', 'Delivering presence message', {
    targetDeviceUid: delivery.targetNotehubDeviceUid,
    sourceDeviceUid: delivery.sourceDeviceUid,
    eventType: delivery.eventType,
    projectUid: delivery.projectUid,
    compactPayload: delivery.compactPayload,
  });

  const message = await queue.enqueueMessage(delivery);
  const result = await notehub.sendPresenceNotification(
    delivery.projectUid,
    delivery.targetNotehubDeviceUid,
    delivery.compactPayload,
  );

  if (result.success) {
    await queue.markSent(delivery.targetNotehubDeviceUid, message.id);
    logFunction(FN, 'success', 'Presence message sent to Notehub', {
      messageId: message.id,
      targetDeviceUid: delivery.targetNotehubDeviceUid,
      eventType: delivery.eventType,
      compactPayload: delivery.compactPayload,
    });
    return 'sent';
  }

  await queue.markRetry(
    delivery.targetNotehubDeviceUid,
    message.id,
    1,
    result.error ?? 'Unknown Notehub send error',
  );

  logFunction(FN, 'warn', 'Presence message send failed — queued for retry', {
    messageId: message.id,
    targetDeviceUid: delivery.targetNotehubDeviceUid,
    eventType: delivery.eventType,
    error: result.error,
  });
  return 'failed';
}

export async function processPresenceChange(
  db: Firestore,
  notehub: NotehubService,
  queue: OutboundQueueService,
  change: PresenceChangeContext,
  defaultProjectUid?: string,
): Promise<number> {
  const peers = await fetchOnlinePeers(db, change.device);
  const deliveries = buildDeliveriesForChange(change, peers, defaultProjectUid);

  logFunction(FN, 'start', 'Built presence deliveries', {
    kind: change.kind,
    sourceDeviceUid: change.device.notehubDeviceUid,
    peerCount: peers.length,
    peerDeviceIds: peers.map((peer) => peer.deviceId),
    deliveryCount: deliveries.length,
  });

  if (deliveries.length === 0) {
    logFunction(FN, 'skip', 'No deliveries required for transition', {
      kind: change.kind,
      deviceUid: change.device.notehubDeviceUid,
      peerCount: peers.length,
    });
    return 0;
  }

  const results = await Promise.all(
    deliveries.map((delivery) => deliverPresenceMessage(notehub, queue, delivery)),
  );

  const sentCount = results.filter((result) => result === 'sent').length;
  const failedCount = results.filter((result) => result === 'failed').length;

  logFunction(FN, 'success', 'Finished dispatching presence deliveries', {
    kind: change.kind,
    deviceUid: change.device.notehubDeviceUid,
    deliveryCount: deliveries.length,
    sentCount,
    failedCount,
  });

  return deliveries.length;
}
