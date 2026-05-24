/** BLE GATT UUIDs — same service as firmware `main/ble_sen0140.c` (0xFEF0). */

export const BLE_SERVICE_UUID = "0000fef0-0000-1000-8000-00805f9b34fb";

/** Notify: binary IMU packet (`sen0140_ble_imu_pkt_t`, 42 bytes v2). */
export const BLE_IMU_CHAR_UUID = "0000fef1-0000-1000-8000-00805f9b34fb";

/** Write UTF-8 Notecard JSON request (must end with `\n`); response notifies on FEF8. */
export const BLE_NOTECARD_REQ_CHAR_UUID = "0000fef7-0000-1000-8000-00805f9b34fb";
/** Notify: UTF-8 JSON response chunks from Blues Notecard. */
export const BLE_NOTECARD_RSP_CHAR_UUID = "0000fef8-0000-1000-8000-00805f9b34fb";
/** Notify: UTF-8 lines from RYUW122 UART. */
export const BLE_UWB_LINE_CHAR_UUID = "0000fef9-0000-1000-8000-00805f9b34fb";
/** Write UTF-8 AT command to RYUW122 (firmware appends CRLF if missing). */
export const BLE_UWB_AT_CHAR_UUID = "0000fefa-0000-1000-8000-00805f9b34fb";
/** Read/write user-assigned boat id (UTF-8, max 32 chars, stored in device NVS). */
export const BLE_BOAT_ID_CHAR_UUID = "0000fefb-0000-1000-8000-00805f9b34fb";
/** Read/write device type (stored in device NVS). */
export const BLE_DEVICE_TYPE_CHAR_UUID = "0000fefc-0000-1000-8000-00805f9b34fb";

export type DeviceType =
  | "port"
  | "starboard"
  | "fixed_dgps_mark"
  | "waypoint"
  | "boat";

export const DEVICE_TYPES: DeviceType[] = [
  "port",
  "starboard",
  "fixed_dgps_mark",
  "waypoint",
  "boat",
];

export function deviceTypeLabel(type: DeviceType): string {
  switch (type) {
    case "port":
      return "Port";
    case "starboard":
      return "Starboard";
    case "fixed_dgps_mark":
      return "Fixed DGPS mark";
    case "waypoint":
      return "Waypoint";
    case "boat":
      return "Boat";
  }
}

export function parseDeviceType(raw: string): DeviceType | null {
  const s = raw.trim().toLowerCase().replace(/-/g, "_");
  if (DEVICE_TYPES.includes(s as DeviceType)) {
    return s as DeviceType;
  }
  return null;
}

export const BOAT_ID_MAX_LEN = 32;
/** Max chars in BLE scan name (legacy ADV packet limit with service UUID). */
export const BOAT_ID_BLE_NAME_MAX_LEN = 20;
