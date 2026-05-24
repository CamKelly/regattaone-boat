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
    logger.warn('Ignoring Notehub payload', {
      device: normalized.device,
      file: normalized.file,
      reason: normalized.body?.['reason'],
    });
    return null;
  }

  const docRef = db.collection('devices').doc(normalized.device!);
  const snap = await docRef.get();
  const now = new Date().toISOString();

  if (!snap.exists) {
    const record = buildNotehubDeviceCreateRecord(normalized, {
      createdAt: now,
      lastUpdatedAt: now,
    });

    await docRef.set(toFirestoreDevice(record));
    logger.info('Created Notehub device document', {
      path: docRef.path,
      reason: record.reason,
    });
    return record;
  }

  const update = buildNotehubDeviceUpdate(normalized, now);

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

  logger.info('Updated Notehub device document', {
    path: docRef.path,
    reason: update.reason,
    boatId: update.boatId,
    deviceType: update.deviceType,
    online: update.online,
  });

  const existing = snap.data() as NotehubDeviceRecord;
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

    try {
      const device = await upsertNotehubDevice(db, payload);

      if (!device) {
        res.status(202).json({ ignored: true });
        return;
      }

      res.status(200).json({ ok: true, device });
    } catch (error) {
      logger.error('Failed to upsert Notehub device', error);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}
