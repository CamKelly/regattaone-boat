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
/** Read/Write JSON UWB test config (role, networkId, address, password, peer, autoRange). */
export const BLE_UWB_CFG_CHAR_UUID = "0000fefb-0000-1000-8000-00805f9b34fb";
/** Notify JSON distance samples from anchor (+ANCHOR_RCV). */
export const BLE_UWB_DIST_CHAR_UUID = "0000fefc-0000-1000-8000-00805f9b34fb";

export type UwbRole = "anchor" | "tag";

export interface UwbConfig {
  role: UwbRole;
  networkId: string;
  address: string;
  password: string;
  peerAddress: string;
  anchorPayload: string;
  tagPayload: string;
  rangeIntervalMs: number;
  autoRange: boolean;
}

export interface UwbDistanceSample {
  d_cm: number;
  peer: string;
}
