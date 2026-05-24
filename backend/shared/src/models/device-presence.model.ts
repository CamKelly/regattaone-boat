import { DeviceType } from './device.model';

/** Inbound notefile on Notecard for presence delta events. */
export const PRESENCE_INBOUND_NOTEFILE = 'presence.qi';

/** Outbound notefile from Notecard acknowledging delivery. */
export const PRESENCE_ACK_NOTEFILE = 'presence_ack.qo';

export type DevicePresenceEventType =
  | 'DEVICE_ONLINE'
  | 'DEVICE_OFFLINE'
  | 'DEVICE_ID_CHANGED'
  | 'DEVICE_REMOVED'
  | 'ONLINE_DEVICE_SNAPSHOT';

export type OutboundMessageStatus = 'pending' | 'sent' | 'acked' | 'failed';

export interface DevicePresencePeer {
  deviceId: string;
  deviceType?: DeviceType;
}

export interface DevicePresenceDocument {
  deviceId: string;
  notehubDeviceUid: string;
  online: boolean;
  lastSeen?: string;
  deviceType?: DeviceType;
  raceId?: string;
  fleetId?: string;
  product?: string;
  source?: string;
}

export interface DevicePresenceEvent {
  id: string;
  type: DevicePresenceEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface CompactPresencePayload {
  t: string;
  mid: string;
  ts: number;
  id?: string;
  dt?: string;
  oid?: string;
  nid?: string;
  d?: Array<{ id: string; dt?: string }>;
}

export interface OutboundPresenceMessage {
  id: string;
  targetNotehubDeviceUid: string;
  projectUid: string;
  eventType: DevicePresenceEventType;
  compactPayload: CompactPresencePayload;
  status: OutboundMessageStatus;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string;
  createdAt: string;
  sentAt?: string;
  ackedAt?: string;
  lastError?: string;
  raceId?: string;
  fleetId?: string;
  sourceDeviceUid?: string;
}

const EVENT_TYPE_CODES: Record<DevicePresenceEventType, string> = {
  DEVICE_ONLINE: 'on',
  DEVICE_OFFLINE: 'off',
  DEVICE_ID_CHANGED: 'id',
  DEVICE_REMOVED: 'rm',
  ONLINE_DEVICE_SNAPSHOT: 'snap',
};

const CODE_TO_EVENT_TYPE = Object.fromEntries(
  Object.entries(EVENT_TYPE_CODES).map(([type, code]) => [code, type]),
) as Record<string, DevicePresenceEventType>;

export function isPresenceTrackedDevice(
  data: Record<string, unknown> | undefined,
  docId?: string,
): boolean {
  if (docId?.startsWith('dev:')) {
    return true;
  }

  if (!data) {
    return false;
  }

  return (
    data['source'] === 'notehub' ||
    Boolean(data['notehubDeviceUid']) ||
    Boolean(data['notehubDeviceUID'])
  );
}

export function readDevicePresenceDocument(
  data: Record<string, unknown> | undefined,
  docId: string,
): DevicePresenceDocument | null {
  if (!isPresenceTrackedDevice(data, docId)) {
    return null;
  }

  const notehubDeviceUid = String(
    data?.['notehubDeviceUid'] ?? data?.['notehubDeviceUID'] ?? docId,
  );
  const deviceType = data?.['deviceType'];

  return {
    deviceId: String(data?.['deviceId'] ?? data?.['boatId'] ?? ''),
    notehubDeviceUid,
    online: data?.['online'] === true,
    lastSeen:
      typeof data?.['lastSeen'] === 'string'
        ? data['lastSeen']
        : undefined,
    deviceType:
      typeof deviceType === 'string' && deviceType.trim().length > 0
        ? (deviceType as DeviceType)
        : undefined,
    raceId:
      typeof data?.['raceId'] === 'string' && data['raceId'].trim().length > 0
        ? data['raceId']
        : undefined,
    fleetId: String(data?.['fleetId'] ?? data?.['fleet'] ?? ''),
    product: typeof data?.['product'] === 'string' ? data['product'] : undefined,
    source: typeof data?.['source'] === 'string' ? data['source'] : undefined,
  };
}

/** Race/fleet filter hook — extend when race-scoped sync is required. */
export function shouldNotifyPeer(
  target: DevicePresenceDocument,
  source: Pick<DevicePresenceDocument, 'notehubDeviceUid' | 'raceId' | 'fleetId'>,
): boolean {
  if (target.notehubDeviceUid === source.notehubDeviceUid) {
    return false;
  }

  if (!target.online) {
    return false;
  }

  if (source.raceId && target.raceId && source.raceId !== target.raceId) {
    return false;
  }

  if (source.fleetId && target.fleetId && source.fleetId !== target.fleetId) {
    return false;
  }

  return true;
}

export function buildDevicePresenceEvent(
  type: DevicePresenceEventType,
  payload: Record<string, unknown>,
  messageId: string,
  timestamp = Date.now(),
): DevicePresenceEvent {
  return {
    id: messageId,
    type,
    timestamp,
    payload,
  };
}

export function toCompactPresencePayload(event: DevicePresenceEvent): CompactPresencePayload {
  const compact: CompactPresencePayload = {
    t: EVENT_TYPE_CODES[event.type],
    mid: event.id,
    ts: event.timestamp,
  };

  switch (event.type) {
    case 'DEVICE_ONLINE':
      compact.id = String(event.payload['deviceId'] ?? '');
      if (event.payload['deviceType']) {
        compact.dt = String(event.payload['deviceType']);
      }
      break;
    case 'DEVICE_OFFLINE':
    case 'DEVICE_REMOVED':
      compact.id = String(event.payload['deviceId'] ?? '');
      break;
    case 'DEVICE_ID_CHANGED':
      compact.oid = String(event.payload['oldDeviceId'] ?? '');
      compact.nid = String(event.payload['newDeviceId'] ?? '');
      break;
    case 'ONLINE_DEVICE_SNAPSHOT': {
      const devices = Array.isArray(event.payload['devices'])
        ? (event.payload['devices'] as DevicePresencePeer[])
        : [];
      compact.d = devices.map((device) => ({
        id: device.deviceId,
        ...(device.deviceType ? { dt: device.deviceType } : {}),
      }));
      break;
    }
  }

  return compact;
}

export function parseCompactPresencePayload(body: Record<string, unknown>): DevicePresenceEvent | null {
  const typeCode = String(body['t'] ?? '');
  const type = CODE_TO_EVENT_TYPE[typeCode];
  const messageId = String(body['mid'] ?? body['id'] ?? '');

  if (!type || !messageId) {
    return null;
  }

  const timestamp =
    typeof body['ts'] === 'number' && Number.isFinite(body['ts'])
      ? body['ts']
      : Date.now();

  switch (type) {
    case 'DEVICE_ONLINE':
      return buildDevicePresenceEvent(
        type,
        {
          deviceId: String(body['id'] ?? ''),
          deviceType: body['dt'] ? String(body['dt']) : undefined,
        },
        messageId,
        timestamp,
      );
    case 'DEVICE_OFFLINE':
    case 'DEVICE_REMOVED':
      return buildDevicePresenceEvent(type, { deviceId: String(body['id'] ?? '') }, messageId, timestamp);
    case 'DEVICE_ID_CHANGED':
      return buildDevicePresenceEvent(
        type,
        {
          oldDeviceId: String(body['oid'] ?? ''),
          newDeviceId: String(body['nid'] ?? ''),
        },
        messageId,
        timestamp,
      );
    case 'ONLINE_DEVICE_SNAPSHOT':
      return buildDevicePresenceEvent(
        type,
        {
          devices: Array.isArray(body['d'])
            ? body['d'].map((entry) => {
                const record = entry as Record<string, unknown>;
                return {
                  deviceId: String(record['id'] ?? ''),
                  deviceType: record['dt'] ? (String(record['dt']) as DeviceType) : undefined,
                };
              })
            : [],
        },
        messageId,
        timestamp,
      );
    default:
      return null;
  }
}

export function extractPresenceAckMessageId(body: Record<string, unknown>): string | null {
  const candidates = [body['mid'], body['id'], body['messageId']];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

export function presenceStateKey(device: DevicePresenceDocument): string {
  return [
    device.online ? '1' : '0',
    device.deviceId,
    device.deviceType ?? '',
    device.raceId ?? '',
  ].join('|');
}
