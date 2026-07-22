import { GeoPoint } from './geo-point.model';

/** High-level device classification used across client and Cloud Functions. */
export type DeviceKind = 'anchor' | 'tag';

/**
 * BLE / firmware device type (0xFEFC) — course / fleet role.
 */
export type DeviceType = 'port' | 'starboard' | 'boat';

export const DEVICE_TYPES: readonly DeviceType[] = ['port', 'starboard', 'boat'] as const;

export interface DeviceTimestamps {
  createdAt: string;
  updatedAt: string;
}

export interface DeviceBase extends DeviceTimestamps {
  id: string;
  name: string;
  kind: DeviceKind;
  ownerId: string;
  active: boolean;
}

export interface TagDevice extends DeviceBase {
  kind: 'tag';
}

export interface AnchorDevice extends DeviceBase {
  kind: 'anchor';
  anchorType: DeviceType;
  position?: GeoPoint;
}

export type Device = TagDevice | AnchorDevice;

/** Valid `anchorType` values for AnchorDevice records. */
export const ANCHOR_TYPES: readonly DeviceType[] = ['port', 'starboard', 'boat'] as const;

export const DEVICE_KINDS: readonly DeviceKind[] = ['anchor', 'tag'] as const;

export function isAnchorDevice(device: Device): device is AnchorDevice {
  return device.kind === 'anchor';
}

export function isTagDevice(device: Device): device is TagDevice {
  return device.kind === 'tag';
}

export function deviceTypeHasAnchor(type: DeviceType): boolean {
  return type === 'boat';
}

export function deviceTypeHasTag(type: DeviceType): boolean {
  return type === 'port' || type === 'starboard';
}

export function anchorTypeRequiresPosition(_anchorType: DeviceType): boolean {
  return false;
}
