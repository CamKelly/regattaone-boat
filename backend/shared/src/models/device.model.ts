import { GeoPoint } from './geo-point.model';

/** High-level device classification used across client and Cloud Functions. */
export type DeviceKind = 'anchor' | 'tag';

/**
 * BLE / firmware device type (0xFEFC) — course / fleet role.
 */
export type DeviceType =
  | 'port'
  | 'port_anchor'
  | 'starboard'
  | 'starboard_anchor'
  | 'waypoint'
  | 'waypoint_anchor'
  | 'boat';

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

export const ANCHOR_TYPES: readonly DeviceType[] = [
  'port_anchor',
  'starboard_anchor',
  'waypoint_anchor',
  'boat',
] as const;

export const DEVICE_KINDS: readonly DeviceKind[] = ['anchor', 'tag'] as const;

export function isAnchorDevice(device: Device): device is AnchorDevice {
  return device.kind === 'anchor';
}

export function isTagDevice(device: Device): device is TagDevice {
  return device.kind === 'tag';
}

export function deviceTypeHasAnchor(type: DeviceType): boolean {
  return (
    type === 'port_anchor' ||
    type === 'starboard_anchor' ||
    type === 'waypoint_anchor' ||
    type === 'boat'
  );
}

export function deviceTypeHasTag(type: DeviceType): boolean {
  return type !== 'boat';
}

export function anchorTypeRequiresPosition(_anchorType: DeviceType): boolean {
  return false;
}
