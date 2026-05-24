import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { DeviceType, DeviceKind } from '@regattaone/shared';
import { normalizeDevice, validateDevicePayload } from './devices/device.validation';
import { createNotehubDeviceLifecycleHandler } from './notehub/notehub-device-lifecycle';
import { createNotehubService } from './services/notehub.service';
import { createDevicePresenceSyncHandler, retryPendingPresenceMessages } from './presence/device-presence-sync';
import { createNotehubPresenceAckHandler } from './presence/notehub-presence-ack';
import { OutboundQueueService } from './presence/outbound-queue.service';
import { logFunction } from './logging';

const notehubWebhookToken = defineSecret('NOTEHUB_WEBHOOK_TOKEN');
const notehubPat = defineSecret('NOTEHUB_PAT');
const notehubProjectUid = defineString('NOTEHUB_PROJECT_UID', {
  default: 'product:com.ellph.camkelly:regattaone',
  description: 'Fallback Notehub project/product UID when a device record has no product field.',
});

initializeApp();

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

function createConfiguredNotehubService() {
  return createNotehubService({
    personalAccessToken: notehubPat.value(),
    defaultProjectUid: notehubProjectUid.value() || undefined,
  });
}

export const health = onRequest((_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'regattaone-boat-backend',
    timestamp: new Date().toISOString(),
  });
});

interface CreateDeviceRequest {
  name: string;
  kind: DeviceKind;
  anchorType?: DeviceType;
  position?: { latitude: number; longitude: number };
  active?: boolean;
}

export const createDevice = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }

  const payload = request.data as CreateDeviceRequest;
  const now = new Date().toISOString();
  const deviceData = {
    name: payload.name,
    kind: payload.kind,
    anchorType: payload.anchorType,
    position: payload.position,
    active: payload.active ?? true,
    ownerId: request.auth.uid,
    createdAt: now,
    updatedAt: now,
  };

  const validation = validateDevicePayload(deviceData);
  if (!validation.valid) {
    throw new HttpsError('invalid-argument', validation.errors.join(' '));
  }

  const docRef = db.collection('devices').doc();
  const device = normalizeDevice(docRef.id, deviceData, {
    createdAt: now,
    updatedAt: now,
  });

  await docRef.set(device);

  return { device };
});

export const notehubDeviceLifecycle = onRequest(
  {
    secrets: [notehubWebhookToken],
    invoker: 'public',
  },
  async (req, res) => {
    const handler = createNotehubDeviceLifecycleHandler(db, notehubWebhookToken.value());
    await handler(req, res);
  },
);

export const syncDevicePresence = onDocumentWritten(
  {
    document: 'devices/{deviceId}',
    secrets: [notehubPat],
  },
  async (event) => {
    try {
      const notehub = createConfiguredNotehubService();
      const queue = new OutboundQueueService(db);
      const defaultProjectUid = notehubProjectUid.value() || undefined;
      const handler = createDevicePresenceSyncHandler(db, notehub, queue, defaultProjectUid);
      await handler(event);
    } catch (error) {
      logFunction('syncDevicePresence', 'error', 'Unhandled presence sync failure', {
        deviceId: event.params.deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
);

export const notehubPresenceAck = onRequest(
  {
    secrets: [notehubWebhookToken],
    invoker: 'public',
  },
  async (req, res) => {
    const handler = createNotehubPresenceAckHandler(db, notehubWebhookToken.value());
    await handler(req, res);
  },
);

export const processPresenceMessageRetries = onSchedule(
  {
    schedule: 'every 5 minutes',
    secrets: [notehubPat],
  },
  async () => {
    try {
      const notehub = createConfiguredNotehubService();
      const queue = new OutboundQueueService(db);
      await retryPendingPresenceMessages(notehub, queue);
    } catch (error) {
      logFunction('processPresenceMessageRetries', 'error', 'Retry sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
);
