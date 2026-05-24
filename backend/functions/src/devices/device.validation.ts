import {
  AnchorDevice,
  DeviceType,
  Device,
  DeviceKind,
  anchorTypeRequiresPosition,
  isValidGeoPoint,
} from '@regattaone/shared';

export interface DeviceValidationResult {
  valid: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAnchorType(value: unknown): value is DeviceType {
  return (
    value === 'port' ||
    value === 'starboard' ||
    value === 'fixed_dgps_mark' ||
    value === 'waypoint' ||
    value === 'boat'
  );
}

function isDeviceKind(value: unknown): value is DeviceKind {
  return value === 'anchor' || value === 'tag';
}

export function validateDevicePayload(data: unknown): DeviceValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Device payload must be an object.'] };
  }

  const record = data as Record<string, unknown>;

  if (!isNonEmptyString(record['name'])) {
    errors.push('Device name is required.');
  }

  if (!isDeviceKind(record['kind'])) {
    errors.push('Device kind must be "anchor" or "tag".');
  }

  if (typeof record['active'] !== 'boolean') {
    errors.push('Device active flag must be a boolean.');
  }

  if (!isNonEmptyString(record['ownerId'])) {
    errors.push('Device ownerId is required.');
  }

  if (record['kind'] === 'anchor') {
    if (!isAnchorType(record['anchorType'])) {
      errors.push('Anchor devices require a valid anchorType.');
    } else if (anchorTypeRequiresPosition(record['anchorType'])) {
      if (!isValidGeoPoint(record['position'] as AnchorDevice['position'])) {
        errors.push('fixed_dgps_mark anchors require a valid latitude and longitude.');
      }
    }
  }

  if (record['kind'] === 'tag' && record['anchorType'] !== undefined) {
    errors.push('Tag devices must not include anchorType.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function normalizeDevice(
  id: string,
  data: Record<string, unknown>,
  timestamps: { createdAt: string; updatedAt: string },
): Device {
  const base = {
    id,
    name: String(data['name']).trim(),
    kind: data['kind'] as DeviceKind,
    ownerId: String(data['ownerId']),
    active: Boolean(data['active']),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };

  if (base.kind === 'tag') {
    return { ...base, kind: 'tag' };
  }

  const anchor: AnchorDevice = {
    ...base,
    kind: 'anchor',
    anchorType: data['anchorType'] as DeviceType,
  };

  if (data['position']) {
    anchor.position = data['position'] as AnchorDevice['position'];
  }

  return anchor;
}
