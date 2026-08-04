/** Lifecycle reasons published by Notecard firmware in `boat.qo`. */
import { DEVICE_TYPES, DeviceType } from './device.model';

export type NotehubBoatIdReason = 'boot' | 'set' | 'changed';

export const NOTEHUB_BOAT_ID_NOTEFILE = 'boat.qo';

/** Legacy notefile name; still accepted for older firmware routes. */
export const NOTEHUB_BOAT_ID_NOTEFILE_LEGACY = 'boat_id.qo';

export const NOTEHUB_BOAT_ID_NOTEFILES: readonly string[] = [
  NOTEHUB_BOAT_ID_NOTEFILE,
  NOTEHUB_BOAT_ID_NOTEFILE_LEGACY,
] as const;

/** Hardware device record stored at `devices/{notehubDeviceUid}`. */
export interface NotehubDeviceRecord {
  notehubDeviceUid: string;
  boatId: string;
  deviceType?: DeviceType;
  reason: NotehubBoatIdReason;
  /** ISO timestamp of the last Notehub event (`received`). */
  lastEventTime: string;
  /** ISO timestamp written when the document was first created. */
  createdAt: string;
  /** ISO timestamp of the most recent webhook update. */
  lastUpdatedAt: string;
  transport: string;
  product: string;
  app: string;
  fleet: string;
  fleets: string[];
  lastEventId: string;
  source: 'notehub';
  /** Set true on every `boat.qo` lifecycle note (boot/set/changed). */
  online: boolean;
  /** ISO timestamp of last device activity (same as last event time for lifecycle notes). */
  lastSeen: string;
  /** Logical ID used by presence sync (mirrors boatId when set). */
  deviceId: string;
}

export interface NotehubRoutePayload {
  event?: string;
  file?: string;
  body?: Record<string, unknown>;
  transport?: string;
  best_id?: string;
  device?: string;
  product?: string;
  app?: string;
  received?: number;
  req?: string;
  status?: string;
  fleets?: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }

  return asRecord(value);
}

/** Normalize Notehub route payloads, including string-encoded JSON bodies. */
export function normalizeNotehubRoutePayload(raw: unknown): NotehubRoutePayload {
  const record = parseJsonObject(raw);
  const body = parseJsonObject(record['body']);

  return {
    event: typeof record['event'] === 'string' ? record['event'] : undefined,
    file: typeof record['file'] === 'string' ? record['file'] : undefined,
    body,
    transport: typeof record['transport'] === 'string' ? record['transport'] : undefined,
    best_id: typeof record['best_id'] === 'string' ? record['best_id'] : undefined,
    device:
      typeof record['device'] === 'string'
        ? record['device']
        : typeof record['best_id'] === 'string'
          ? record['best_id']
          : undefined,
    product: typeof record['product'] === 'string' ? record['product'] : undefined,
    app: typeof record['app'] === 'string' ? record['app'] : undefined,
    received:
      typeof record['received'] === 'number' && Number.isFinite(record['received'])
        ? record['received']
        : typeof record['received'] === 'string' && Number.isFinite(Number(record['received']))
          ? Number(record['received'])
          : undefined,
    req: typeof record['req'] === 'string' ? record['req'] : undefined,
    status: typeof record['status'] === 'string' ? record['status'] : undefined,
    fleets: Array.isArray(record['fleets'])
      ? record['fleets'].filter((fleet): fleet is string => typeof fleet === 'string')
      : undefined,
  };
}

export function parseNotehubBoatIdReason(value: unknown): NotehubBoatIdReason | null {
  const reason = String(value ?? '').toLowerCase();

  if (reason === 'boot' || reason === 'set' || reason === 'changed') {
    return reason;
  }

  return null;
}

export function isNotehubBoatIdPayload(payload: NotehubRoutePayload): boolean {
  const normalized = normalizeNotehubRoutePayload(payload);
  const notefile = String(normalized.file ?? '').trim();
  const body = normalized.body ?? {};

  return (
    Boolean(normalized.device) &&
    NOTEHUB_BOAT_ID_NOTEFILES.includes(notefile) &&
    parseNotehubBoatIdReason(body['reason']) !== null
  );
}

export function extractBoatId(body: Record<string, unknown>): string {
  const candidates = [body['id'], body['boat_id'], body['device_id'], body['deviceId']];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return '';
}

export function parseDeviceType(value: unknown): DeviceType | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (normalized === 'port_anchor') {
    return 'port';
  }
  if (normalized === 'starboard_anchor') {
    return 'starboard';
  }
  if (normalized === 'reference_anchor' || normalized === 'ref') {
    return 'reference';
  }
  if (
    normalized === 'waypoint' ||
    normalized === 'waypoint_anchor' ||
    normalized === 'fixed_dgps_mark'
  ) {
    return 'boat';
  }
  if ((DEVICE_TYPES as readonly string[]).includes(normalized)) {
    return normalized as DeviceType;
  }

  return null;
}

export function extractDeviceType(body: Record<string, unknown>): DeviceType | null {
  const candidates = [body['deviceType'], body['device_type'], body['type']];

  for (const candidate of candidates) {
    const parsed = parseDeviceType(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function parseNotehubEventTime(received: unknown, fallback: string): string {
  if (typeof received === 'number' && Number.isFinite(received)) {
    return new Date(received * 1000).toISOString();
  }

  if (typeof received === 'string' && received.trim().length > 0) {
    const numeric = Number(received);
    if (Number.isFinite(numeric)) {
      return new Date(numeric * 1000).toISOString();
    }

    const parsed = Date.parse(received);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return fallback;
}

/** Presence fields applied on every accepted `boat.qo` lifecycle webhook. */
export function buildNotehubLifecyclePresenceFields(
  boatId: string,
  eventTimeIso: string,
): Pick<NotehubDeviceRecord, 'online' | 'lastSeen' | 'deviceId'> {
  const trimmedBoatId = boatId.trim();
  return {
    online: true,
    lastSeen: eventTimeIso,
    deviceId: trimmedBoatId,
  };
}

export function buildNotehubDeviceCreateRecord(
  payload: NotehubRoutePayload,
  timestamps: { createdAt: string; lastUpdatedAt: string },
): NotehubDeviceRecord {
  const normalized = normalizeNotehubRoutePayload(payload);
  const body = normalized.body ?? {};
  const fleets = Array.isArray(normalized.fleets) ? normalized.fleets : [];
  const deviceType = extractDeviceType(body);
  const boatId = extractBoatId(body) || normalized.best_id || '';
  const lastEventTime = parseNotehubEventTime(normalized.received, timestamps.lastUpdatedAt);

  return {
    notehubDeviceUid: normalized.device!,
    boatId,
    ...(deviceType ? { deviceType } : {}),
    reason: parseNotehubBoatIdReason(body['reason'])!,
    lastEventTime,
    createdAt: timestamps.createdAt,
    lastUpdatedAt: timestamps.lastUpdatedAt,
    transport: normalized.transport ?? '',
    product: normalized.product ?? '',
    app: normalized.app ?? '',
    fleet: fleets[0] ?? '',
    fleets,
    lastEventId: normalized.event ?? '',
    source: 'notehub',
    ...buildNotehubLifecyclePresenceFields(boatId, lastEventTime),
  };
}

export function buildNotehubDeviceUpdate(
  payload: NotehubRoutePayload,
  lastUpdatedAt: string,
): Pick<
  NotehubDeviceRecord,
  | 'reason'
  | 'lastUpdatedAt'
  | 'boatId'
  | 'lastEventTime'
  | 'lastEventId'
  | 'deviceType'
  | 'online'
  | 'lastSeen'
  | 'deviceId'
> {
  const normalized = normalizeNotehubRoutePayload(payload);
  const body = normalized.body ?? {};
  const deviceType = extractDeviceType(body);
  const boatId = extractBoatId(body) || normalized.best_id || '';
  const lastEventTime = parseNotehubEventTime(normalized.received, lastUpdatedAt);

  return {
    reason: parseNotehubBoatIdReason(body['reason'])!,
    lastUpdatedAt,
    boatId,
    lastEventTime,
    lastEventId: normalized.event ?? '',
    ...(deviceType ? { deviceType } : {}),
    ...buildNotehubLifecyclePresenceFields(boatId, lastEventTime),
  };
}

export function isNotehubProvisionedDevice(
  data: Record<string, unknown> | undefined,
  deviceId?: string,
): boolean {
  if (deviceId?.startsWith('dev:')) {
    return true;
  }

  if (!data) {
    return false;
  }

  return data['source'] === 'notehub' || (Boolean(data['notehubDeviceUid']) && !data['kind']);
}
