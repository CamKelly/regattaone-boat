/** BLE GATT UUIDs — same service as firmware `main/ble_sen0140.c` (0xFEF0). */

export const BLE_SERVICE_UUID = "0000fef0-0000-1000-8000-00805f9b34fb";

/** Notify: binary IMU packet (`sen0140_ble_imu_pkt_t`, 42 bytes v2). */
export const BLE_IMU_CHAR_UUID = "0000fef1-0000-1000-8000-00805f9b34fb";

/** Notify: UTF-8 lines from RYUW122 UART. */
export const BLE_UWB_LINE_CHAR_UUID = "0000fef9-0000-1000-8000-00805f9b34fb";
/** Write UTF-8 AT command to RYUW122 (firmware appends CRLF if missing). */
export const BLE_UWB_AT_CHAR_UUID = "0000fefa-0000-1000-8000-00805f9b34fb";
/** Read/write user-assigned boat id (UTF-8, max 32 chars, stored in device NVS). */
export const BLE_BOAT_ID_CHAR_UUID = "0000fefb-0000-1000-8000-00805f9b34fb";
/** Read/write device type (stored in device NVS). */
export const BLE_DEVICE_TYPE_CHAR_UUID = "0000fefc-0000-1000-8000-00805f9b34fb";
/** Notify: GPS NMEA 0183 lines from UART. */
export const BLE_GPS_LINE_CHAR_UUID = "0000fefd-0000-1000-8000-00805f9b34fb";
/** Notify: Meshtastic line log (`<<` / `>>` / `!` status lines). */
export const BLE_MESHTASTIC_RX_CHAR_UUID = "0000fee5-0000-1000-8000-00805f9b34fb";
/**
 * Write Meshtastic commands: `send=<nodeNum>\\n<text>`, `send=broadcast\\n<text>`, `config=1`.
 */
export const BLE_MESHTASTIC_TX_CHAR_UUID = "0000fee6-0000-1000-8000-00805f9b34fb";
/**
 * Read/notify: Meshtastic node roster + message stats JSON.
 * Node objects may include lat, lon, alt_m, speed_mps, heading_deg when position is shared.
 * Write `stats=1` to refresh notify.
 */
export const BLE_MESHTASTIC_STATS_CHAR_UUID = "0000fee7-0000-1000-8000-00805f9b34fb";

/**
 * Device type (BLE 0xFEFC) selects SC16IS752 UWB routing when the bridge is enabled:
 *   UART A (TXA/RXA) — ANCHOR RYUW122
 *   UART B (TXB/RXB) — TAG RYUW122
 */
export type DeviceType =
  | "port"
  | "port_anchor"
  | "starboard"
  | "starboard_anchor"
  | "waypoint"
  | "waypoint_anchor"
  | "boat";

export const DEVICE_TYPES: DeviceType[] = [
  "port",
  "port_anchor",
  "starboard",
  "starboard_anchor",
  "waypoint",
  "waypoint_anchor",
  "boat",
];

export type UwbRole = "anchor" | "tag";

export function deviceTypeHasAnchor(type: DeviceType): boolean {
  return (
    type === "port_anchor" ||
    type === "starboard_anchor" ||
    type === "waypoint_anchor" ||
    type === "boat"
  );
}

export function deviceTypeHasTag(type: DeviceType): boolean {
  return type !== "boat";
}

export function deviceTypeLabel(type: DeviceType): string {
  switch (type) {
    case "port":
      return "Port";
    case "port_anchor":
      return "Port + anchor";
    case "starboard":
      return "Starboard";
    case "starboard_anchor":
      return "Starboard + anchor";
    case "waypoint":
      return "Waypoint";
    case "waypoint_anchor":
      return "Waypoint + anchor";
    case "boat":
      return "Boat";
  }
}

export function parseDeviceType(raw: string): DeviceType | null {
  const s = raw.trim().toLowerCase().replace(/-/g, "_");
  if (s === "fixed_dgps_mark") {
    return "waypoint";
  }
  if (DEVICE_TYPES.includes(s as DeviceType)) {
    return s as DeviceType;
  }
  return null;
}

/** Prefix AT writes for dual-UART SC16IS752 routing (firmware strips prefix). */
export function encodeUwbAtWrite(role: UwbRole, cmd: string): Uint8Array {
  const prefix = role === "anchor" ? "@ANCHOR\n" : "@TAG\n";
  const body = new TextEncoder().encode(cmd);
  const head = new TextEncoder().encode(prefix);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Split firmware notify line into role + payload (after optional prefix). */
export function parseUwbNotifyLine(raw: string): { role: UwbRole; line: string } | null {
  if (raw.startsWith("[ANCHOR]")) {
    return { role: "anchor", line: raw.slice("[ANCHOR]".length).replace(/^\s*/, "") };
  }
  if (raw.startsWith("[TAG]")) {
    return { role: "tag", line: raw.slice("[TAG]".length).replace(/^\s*/, "") };
  }
  return null;
}

export function uwbWriteNeedsRolePrefix(type: DeviceType): boolean {
  return deviceTypeHasAnchor(type) && deviceTypeHasTag(type);
}

export const BOAT_ID_MAX_LEN = 32;
/** Max chars in BLE scan name (legacy ADV packet limit with service UUID). */
export const BOAT_ID_BLE_NAME_MAX_LEN = 20;
