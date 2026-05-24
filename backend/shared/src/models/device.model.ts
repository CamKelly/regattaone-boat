import { GeoPoint } from './geo-point.model';

/** High-level device classification used across client and Cloud Functions. */
export type DeviceKind = 'anchor' | 'tag';

/**
 * Anchor subtypes:
 * - port: port-side mark
 * - starboard: starboard-side mark
 * - fixed_dgps_mark: fixed differential GPS mark with exact lat/lng
 * - waypoint: race course waypoint
 * - boat: a boat acting as an anchor device
 */
export type DeviceType =
  | 'port'
  | 'starboard'
  | 'fixed_dgps_mark'
  | 'waypoint'
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
  /** Required for fixed_dgps_mark; optional for other anchor types. */
  position?: GeoPoint;
}

export type Device = TagDevice | AnchorDevice;

export const ANCHOR_TYPES: readonly DeviceType[] = [
  'port',
  'starboard',
  'fixed_dgps_mark',
  'waypoint',
  'boat',
] as const;

export const DEVICE_KINDS: readonly DeviceKind[] = ['anchor', 'tag'] as const;

export function isAnchorDevice(device: Device): device is AnchorDevice {
  return device.kind === 'anchor';
}

export function isTagDevice(device: Device): device is TagDevice {
  return device.kind === 'tag';
}

export function anchorTypeRequiresPosition(anchorType: DeviceType): boolean {
  return anchorType === 'fixed_dgps_mark';
}
