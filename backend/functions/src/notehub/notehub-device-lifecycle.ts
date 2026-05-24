import { timingSafeEqual } from 'node:crypto';
import {
  NotehubDeviceRecord,
  NotehubRoutePayload,
  buildNotehubDeviceCreateRecord,
  buildNotehubDeviceUpdate,
  isNotehubBoatIdPayload,
  normalizeNotehubRoutePayload,
} from '@regattaone/shared';
import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { logFunction } from '../logging';

const FN = 'notehubDeviceLifecycle';

function readAuthToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  if (!trimmed) {
    return null;
  }

  const [scheme, token] = trimmed.split(/\s+/);
  if (token && scheme.toLowerCase() === 'bearer') {
    return token.trim();
  }

  return trimmed;
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function parseRequestPayload(req: Request): NotehubRoutePayload {
  const body = req.body as unknown;

  if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
    return normalizeNotehubRoutePayload(body);
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody && rawBody.length > 0) {
    try {
      return normalizeNotehubRoutePayload(JSON.parse(rawBody.toString('utf8')));
    } catch (error) {
      logger.error('Unable to parse Notehub rawBody JSON', error);
    }
  }

  return {};
}

function toFirestoreDevice(record: NotehubDeviceRecord) {
  return {
    ...record,
    createdAt: Timestamp.fromDate(new Date(record.createdAt)),
    lastUpdatedAt: Timestamp.fromDate(new Date(record.lastUpdatedAt)),
    lastEventTime: Timestamp.fromDate(new Date(record.lastEventTime)),
  };
}

export async function upsertNotehubDevice(
  db: Firestore,
  payload: NotehubRoutePayload,
): Promise<NotehubDeviceRecord | null> {
  const normalized = normalizeNotehubRoutePayload(payload);

  if (!isNotehubBoatIdPayload(normalized)) {
    logFunction(FN, 'skip', 'Ignoring unsupported Notehub payload', {
      device: normalized.device,
      file: normalized.file,
      reason: normalized.body?.['reason'],
    });
    return null;
  }

  logFunction(FN, 'start', 'Processing boat.qo lifecycle event', {
    device: normalized.device,
    file: normalized.file,
    reason: normalized.body?.['reason'],
    boatId: normalized.body?.['id'],
    deviceType: normalized.body?.['type'] ?? normalized.body?.['deviceType'],
    product: normalized.product,
  });

  const docRef = db.collection('devices').doc(normalized.device!);
  const snap = await docRef.get();
  const now = new Date().toISOString();

  if (!snap.exists) {
    const record = buildNotehubDeviceCreateRecord(normalized, {
      createdAt: now,
      lastUpdatedAt: now,
    });

    await docRef.set(toFirestoreDevice(record));
    logFunction(FN, 'success', 'Created device document', {
      path: docRef.path,
      reason: record.reason,
      boatId: record.boatId,
      deviceId: record.deviceId,
      deviceType: record.deviceType,
      online: record.online,
      lastSeen: record.lastSeen,
      product: record.product,
    });
    return record;
  }

  const update = buildNotehubDeviceUpdate(normalized, now);
  const existing = snap.data() as NotehubDeviceRecord;

  await docRef.set(
    {
      reason: update.reason,
      boatId: update.boatId,
      deviceId: update.deviceId,
      online: update.online,
      lastSeen: update.lastSeen,
      ...(update.deviceType ? { deviceType: update.deviceType } : {}),
      lastEventTime: Timestamp.fromDate(new Date(update.lastEventTime)),
      lastEventId: update.lastEventId,
      lastUpdatedAt: Timestamp.fromDate(new Date(update.lastUpdatedAt)),
    },
    { merge: true },
  );

  logFunction(FN, 'success', 'Updated device document', {
    path: docRef.path,
    reason: update.reason,
    boatId: update.boatId,
    deviceId: update.deviceId,
    deviceType: update.deviceType,
    online: update.online,
    lastSeen: update.lastSeen,
    wasOnline: (existing as NotehubDeviceRecord).online === true,
  });

  return {
    ...existing,
    reason: update.reason,
    boatId: update.boatId,
    deviceId: update.deviceId,
    online: update.online,
    lastSeen: update.lastSeen,
    ...(update.deviceType ? { deviceType: update.deviceType } : {}),
    lastEventTime: update.lastEventTime,
    lastEventId: update.lastEventId,
    lastUpdatedAt: update.lastUpdatedAt,
  };
}

export function createNotehubDeviceLifecycleHandler(db: Firestore, expectedToken: string) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const providedToken = readAuthToken(req.get('Authorization'));
    if (!providedToken || !tokensMatch(expectedToken, providedToken)) {
      logger.warn('Rejected Notehub webhook: invalid authorization token');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const payload = parseRequestPayload(req);

    logFunction(FN, 'start', 'Received Notehub webhook', {
      file: payload.file,
      device: payload.device,
      reason: payload.body?.['reason'],
    });

    try {
      const device = await upsertNotehubDevice(db, payload);

      if (!device) {
        logFunction(FN, 'skip', 'Webhook completed with ignored payload', {
          file: payload.file,
          device: payload.device,
        });
        res.status(202).json({ ignored: true });
        return;
      }

      logFunction(FN, 'success', 'Webhook processed', {
        device: device.notehubDeviceUid,
        boatId: device.boatId,
        online: device.online,
      });
      res.status(200).json({ ok: true, device });
    } catch (error) {
      logFunction(FN, 'error', 'Failed to upsert device', {
        device: payload.device,
        file: payload.file,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Internal error' });
    }
  };
}
