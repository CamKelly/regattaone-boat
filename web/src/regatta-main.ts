import {
  clearGpsLeafletMap,
  initGpsLeafletMapStyle,
  invalidateGpsLeafletMapSize,
  recenterGpsLeafletMap,
  setGpsLeafletMapStyle,
  updateGpsLeafletMap,
} from "./lib/gps-leaflet-map";
import { formatImuFields, parseImuPacket, PKT_MIN_SIZE } from "./lib/imu-protocol";
import {
  fixQualityLabel,
  fixTypeLabel,
  formatCoordDeg,
  formatCourseDeg,
  formatSpeedKnots,
  openStreetMapUrl,
} from "./lib/nmea-parse";
import {
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_LORA_LINE_CHAR_UUID,
  BLE_LORA_STATS_CHAR_UUID,
  BLE_LORA_TX_CHAR_UUID,
  BLE_MESHTASTIC_RX_CHAR_UUID,
  BLE_MESHTASTIC_STATS_CHAR_UUID,
  BLE_MESHTASTIC_TX_CHAR_UUID,
  BLE_SERVICE_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
  BOAT_ID_MAX_LEN,
  BOAT_ID_BLE_NAME_MAX_LEN,
  type DeviceType,
  deviceTypeLabel,
  parseDeviceType,
} from "./lib/protocol";
import {
  asWebGatt,
  connectNativeGatt,
  ensureBleInitialized,
  isBleAvailable,
  isNativeBle,
  requestBleDevice,
  type BleDevicePick,
  type BleGattCharacteristicLike,
  type BleGattServerLike,
} from "./lib/ble-transport";

/** Bump when BLE connect logic changes — shown in UI so stale cached JS is obvious. */
const WEB_BLE_REV = "2026-06-24f";

const DEFAULT_IMU_META =
  "Connect to stream accel, gyro, mag, temperature, and pressure.";

let imuTabActive = true;
let regattaAppStarted = false;

interface ImuDisplay {
  accel: string;
  gyro: string;
  mag: string;
  temp: string;
  baro: string;
  meta: string;
}

interface LoraStatsSender {
  sig: string;
  first: number;
  last: number;
  missing: number;
  rx: number;
}

type LoraMeshState = "off" | "listening" | "locked";

interface LoraMeshPeer {
  id: number;
  type: number;
  last_ms: number;
}

interface LoraMeshRxMsg {
  from: number;
  seq: number;
  text: string;
  last_ms: number;
}

interface LoraMeshSnapshot {
  active: boolean;
  state: LoraMeshState;
  my_id: number | null;
  my_type: number;
  tx_ok: number;
  tx_fail: number;
  rx: number;
  collision_yield: number;
  msg_tx_ok: number;
  msg_tx_fail: number;
  msg_rx: number;
  peers: LoraMeshPeer[];
  rx_msgs: LoraMeshRxMsg[];
}

interface LoraStatsSnapshot {
  tx: { queued: number; ok: number; timeout: number };
  rx_bad: number;
  senders: LoraStatsSender[];
  mesh: LoraMeshSnapshot;
}

interface MeshtasticNode {
  num: number;
  name: string;
  short: string;
  last_ms: number;
  lat: number | null;
  lon: number | null;
  alt_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  has_gps_update: boolean;
  gps_has_lock: boolean;
  fix_quality: number | null;
  fix_type: number | null;
  sats_in_view: number | null;
  seq_number: number | null;
  time_sec: number | null;
  timestamp_sec: number | null;
}

interface MeshtasticRxMsg {
  from: number;
  from_name: string;
  text: string;
  last_ms: number;
}

interface MeshtasticStatsSnapshot {
  connected: boolean;
  config_ok: boolean;
  my_num: number | null;
  tx_ok: number;
  tx_fail: number;
  rx: number;
  gps_rx: number;
  gps_api_rx: number;
  nodes: MeshtasticNode[];
  rx_msgs: MeshtasticRxMsg[];
}

const defaultLoraMesh = (): LoraMeshSnapshot => ({
  active: false,
  state: "off",
  my_id: null,
  my_type: 4,
  tx_ok: 0,
  tx_fail: 0,
  rx: 0,
  collision_yield: 0,
  msg_tx_ok: 0,
  msg_tx_fail: 0,
  msg_rx: 0,
  peers: [],
  rx_msgs: [],
});

const defaultLoraStats = (): LoraStatsSnapshot => ({
  tx: { queued: 0, ok: 0, timeout: 0 },
  rx_bad: 0,
  senders: [],
  mesh: defaultLoraMesh(),
});

const defaultMeshtasticStats = (): MeshtasticStatsSnapshot => ({
  connected: false,
  config_ok: false,
  my_num: null,
  tx_ok: 0,
  tx_fail: 0,
  rx: 0,
  gps_rx: 0,
  gps_api_rx: 0,
  nodes: [],
  rx_msgs: [],
});

function hasDirectLoRa(session: BleBoatSession | null): boolean {
  return session?.charLoraTx != null;
}

function hasMeshtastic(session: BleBoatSession | null): boolean {
  return session?.charMeshtasticRx != null;
}

const MESH_TYPE_CODES: DeviceType[] = [
  "port",
  "starboard",
  "fixed_dgps_mark",
  "waypoint",
  "boat",
];

function meshTypeLabel(code: number): string {
  const t = MESH_TYPE_CODES[code];
  return t ? deviceTypeLabel(t) : `unknown (${code})`;
}

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms ago`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s ago`;
  }
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s ago` : `${min}m ago`;
}

const BLE_OPTIONAL_SERVICES = [
  BLE_SERVICE_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_LORA_TX_CHAR_UUID,
  BLE_LORA_LINE_CHAR_UUID,
  BLE_LORA_STATS_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_MESHTASTIC_RX_CHAR_UUID,
  BLE_MESHTASTIC_TX_CHAR_UUID,
  BLE_MESHTASTIC_STATS_CHAR_UUID,
];

interface BleBoatSession {
  deviceId: string;
  device: BluetoothDevice | null;
  gatt: BleGattServerLike;
  nativeBle: boolean;
  name: string;
  charImu: BleGattCharacteristicLike | null;
  charLoraTx: BleGattCharacteristicLike | null;
  charLoraLine: BleGattCharacteristicLike | null;
  charLoraStats: BleGattCharacteristicLike | null;
  charMeshtasticRx: BleGattCharacteristicLike | null;
  charMeshtasticTx: BleGattCharacteristicLike | null;
  charMeshtasticStats: BleGattCharacteristicLike | null;
  charUwbLine: BleGattCharacteristicLike | null;
  charUwbAt: BleGattCharacteristicLike | null;
  charBoatId: BleGattCharacteristicLike | null;
  charDeviceType: BleGattCharacteristicLike | null;
  boatId: string;
  boatIdDraft: string;
  deviceType: DeviceType;
  deviceTypeDraft: DeviceType;
  loraLineLogText: string;
  /** Last `! STATUS:` line from firmware (0xFEF8). */
  loraRadioStatus: string;
  loraStats: LoraStatsSnapshot;
  /** Wall clock when loraStats was last applied (for live "ago" display). */
  loraStatsReceivedWallMs: number;
  loraStatsNotifyBuf: string;
  uwbLineLogText: string;
  loraTxDraft: string;
  uwbAtDraft: string;
  lastImuWallMs: number;
  imu: ImuDisplay;
  notificationsOn: boolean;
  imuNotificationsOn: boolean;
  /** Incremented per UWB request to ignore stale notify/read data. */
  commsGen: number;
  activeUwbGen: number;
  loraBusy: boolean;
  loraStreamRunning: boolean;
  loraStreamSeq: number;
  loraStreamTimer: ReturnType<typeof setTimeout> | null;
  loraTabView: "normal" | "mesh";
  loraMeshRunning: boolean;
  /** Sent/received mesh lines for the inbox below the peer table. */
  meshMessageLog: string[];
  meshtasticStats: MeshtasticStatsSnapshot;
  meshtasticStatsReceivedWallMs: number;
  meshtasticStatsNotifyBuf: string;
  meshtasticLineLogText: string;
  meshtasticTxDraft: string;
  uwbBusy: boolean;
  /** True when GATT was intentionally disconnected to park this device in the list. */
  parked: boolean;
  gattChain: Promise<void>;
  onImuNotify: (ev: Event) => void;
  onLoraLineNotify: (ev: Event) => void;
  onLoraStatsNotify: (ev: Event) => void;
  onMeshtasticLineNotify: (ev: Event) => void;
  onMeshtasticStatsNotify: (ev: Event) => void;
  onUwbLineNotify: (ev: Event) => void;
  onDisconnected: () => void;
}

const MESHTASTIC_GPS_SOURCE_SHORT = "1HX";

const sessions = new Map<string, BleBoatSession>();
let activeSessionId: string | null = null;
let meshUiRefreshTimer: ReturnType<typeof setInterval> | null = null;
let meshtasticUiRefreshTimer: ReturnType<typeof setInterval> | null = null;

let connectBtn!: HTMLButtonElement;
let bleStatusEl: HTMLElement | null = null;
let deviceSelectEl: HTMLSelectElement | null = null;
let deviceDisconnectBtn: HTMLButtonElement | null = null;
let suppressDeviceSelectChange = false;

function defaultImuDisplay(): ImuDisplay {
  return {
    accel: "—",
    gyro: "—",
    mag: "—",
    temp: "—",
    baro: "—",
    meta: DEFAULT_IMU_META,
  };
}

function getActiveSession(): BleBoatSession | null {
  if (!activeSessionId) {
    return null;
  }
  return sessions.get(activeSessionId) ?? null;
}

function sessionDisplayName(session: BleBoatSession): string {
  const id = session.boatId.trim();
  return id.length > 0 ? id : session.name;
}

async function readDeviceTypeFromDevice(session: BleBoatSession): Promise<void> {
  if (!session.charDeviceType || !session.gatt.connected) {
    return;
  }
  try {
    const val = await session.charDeviceType.readValue();
    const raw = new TextDecoder().decode(val).replace(/\0/g, "").trim();
    const type = parseDeviceType(raw);
    if (type) {
      session.deviceType = type;
      session.deviceTypeDraft = type;
    }
  } catch (e) {
    console.warn("BLE device type read failed", session.name, e);
  }
}

async function saveDeviceTypeToDevice(): Promise<void> {
  const session = getActiveSession();
  const select = document.querySelector<HTMLSelectElement>("#device-type-select");
  const statusEl = document.querySelector("#device-type-status");
  if (!session?.charDeviceType || !select) {
    if (statusEl) {
      statusEl.textContent = "Device type requires firmware with characteristic 0xFEFC.";
    }
    return;
  }
  const type = parseDeviceType(select.value);
  if (!type) {
    if (statusEl) {
      statusEl.textContent = "Choose a valid device type.";
    }
    return;
  }
  try {
    await gattWrite(session, "type", new TextEncoder().encode(type));
    session.deviceType = type;
    session.deviceTypeDraft = type;
    if (statusEl) {
      statusEl.textContent = `Saved: ${deviceTypeLabel(type)}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) {
      statusEl.textContent = `Save failed: ${msg}`;
    }
  }
}

function setFieldEnabled(el: HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null, enabled: boolean): void {
  if (!el) {
    return;
  }
  el.disabled = !enabled;
  if (enabled) {
    el.removeAttribute("disabled");
  } else {
    el.setAttribute("disabled", "");
  }
}

function syncDeviceTypeUi(session: BleBoatSession | null): void {
  const select = document.querySelector<HTMLSelectElement>("#device-type-select");
  const saveBtn = document.querySelector<HTMLButtonElement>("#device-type-save");
  const statusEl = document.querySelector("#device-type-status");
  const canEdit = session !== null && session.gatt.connected && session.charDeviceType !== null;
  if (select) {
    setFieldEnabled(select, canEdit);
    select.value = session?.deviceTypeDraft ?? "boat";
  }
  setFieldEnabled(saveBtn, canEdit);
  if (statusEl) {
    if (!session) {
      statusEl.textContent = "Connect a device to set its type.";
    } else if (!session.charDeviceType) {
      statusEl.textContent = "Flash firmware with device type support (0xFEFC) to enable.";
    } else if (!session.gatt.connected) {
      statusEl.textContent = `Stored on device: ${deviceTypeLabel(session.deviceType)}. Reconnect to edit.`;
    } else {
      statusEl.textContent = `Stored on device: ${deviceTypeLabel(session.deviceType)}`;
    }
  }
}

async function readBoatIdFromDevice(session: BleBoatSession): Promise<void> {
  if (!session.charBoatId || !session.gatt.connected) {
    return;
  }
  try {
    const val = await session.charBoatId.readValue();
    session.boatId = new TextDecoder().decode(val).replace(/\0/g, "").trim();
    session.boatIdDraft = session.boatId;
  } catch (e) {
    console.warn("BLE boat id read failed", session.name, e);
  }
}

function validateBoatIdDraft(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return "Boat ID cannot be empty.";
  }
  if (trimmed.length > BOAT_ID_MAX_LEN) {
    return `Boat ID must be at most ${BOAT_ID_MAX_LEN} characters.`;
  }
  if (!/^[\x20-\x7E]+$/.test(trimmed)) {
    return "Boat ID must be printable ASCII.";
  }
  return null;
}

async function saveBoatIdToDevice(): Promise<void> {
  const session = getActiveSession();
  const input = document.querySelector<HTMLInputElement>("#boat-id-input");
  const statusEl = document.querySelector("#boat-id-status");
  if (!session?.charBoatId || !input) {
    if (statusEl) {
      statusEl.textContent = "Boat ID requires firmware with characteristic 0xFEFB.";
    }
    return;
  }
  if (!session.gatt.connected) {
    if (statusEl) {
      statusEl.textContent = "Device not connected — reconnect before saving.";
    }
    return;
  }
  const draft = input.value;
  const err = validateBoatIdDraft(draft);
  if (err) {
    if (statusEl) {
      statusEl.textContent = err;
    }
    return;
  }
  const trimmed = draft.trim();
  try {
    await gattWrite(session, "boatid", new TextEncoder().encode(trimmed));
    session.boatId = trimmed;
    session.boatIdDraft = trimmed;
    session.name = trimmed;
    if (statusEl) {
      const bleNote =
        trimmed.length > BOAT_ID_BLE_NAME_MAX_LEN
          ? ` Saved on device. BLE scan name uses first ${BOAT_ID_BLE_NAME_MAX_LEN} chars until reconnect.`
          : " Saved on device — BLE name updates after disconnect/reconnect.";
      statusEl.textContent = `Saved: ${trimmed}.${bleNote}`;
    }
    renderDeviceSelector();
    updateBleToolbar();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) {
      statusEl.textContent = `Save failed: ${msg}`;
    }
  }
}

function syncBoatIdUi(session: BleBoatSession | null): void {
  const input = document.querySelector<HTMLInputElement>("#boat-id-input");
  const saveBtn = document.querySelector<HTMLButtonElement>("#boat-id-save");
  const statusEl = document.querySelector("#boat-id-status");
  const canEdit = session !== null && session.gatt.connected && session.charBoatId !== null;
  if (input) {
    setFieldEnabled(input, canEdit);
    if (document.activeElement !== input) {
      input.value = session?.boatIdDraft ?? "";
    }
    input.maxLength = BOAT_ID_MAX_LEN;
  }
  setFieldEnabled(saveBtn, canEdit);
  if (statusEl) {
    if (!session) {
      statusEl.textContent = "Connect a device to set its boat ID.";
    } else if (!session.charBoatId) {
      statusEl.textContent = "Flash firmware with boat ID support (0xFEFB) to enable.";
    } else if (!session.gatt.connected) {
      statusEl.textContent = `Stored on device: ${session.boatId || "—"}. Reconnect to edit.`;
    } else if (session.boatId) {
      statusEl.textContent = `Stored on device: ${session.boatId}`;
    } else {
      statusEl.textContent = `No custom ID — BLE advertises as "${session.name}" until you assign one.`;
    }
  }
}

function setBleToolbar(text: string): void {
  if (bleStatusEl) {
    bleStatusEl.textContent = text;
  }
}

/** Toolbar line: active device name, device count, and problems only (no GATT checklist). */
function updateBleToolbar(note?: string): void {
  const n = sessions.size;
  if (n === 0) {
    setBleToolbar(note ?? "BLE: add a device");
    return;
  }
  const active = getActiveSession();
  if (!active) {
    setBleToolbar(note ?? `BLE: ${n} device${n === 1 ? "" : "s"} — select one`);
    return;
  }
  const name = sessionDisplayName(active);
  const multi = n > 1 ? ` · ${n} devices` : "";
  if (note) {
    setBleToolbar(`BLE: ${name}${multi} — ${note}`);
    return;
  }
  if (!active.gatt.connected) {
    setBleToolbar(`BLE: ${name}${multi} — not connected`);
    return;
  }
  const missing: string[] = [];
  if (!active.charImu) {
    missing.push("IMU");
  }
  if (!active.charUwbAt) {
    missing.push("UWB");
  }
  if (!active.charLoraTx && !active.charMeshtasticRx) {
    missing.push("LoRa/Mesh");
  }
  if (missing.length > 0) {
    setBleToolbar(`BLE: ${name}${multi} — ${missing.join(", ")} unavailable`);
    return;
  }
  setBleToolbar(`BLE: ${name}${multi}`);
}

function setText(id: string, text: string): void {
  const el = document.querySelector(`#${id}`);
  if (el) {
    el.textContent = text;
  }
}

function syncActionButtons(): void {
  const session = getActiveSession();
  const uwbSend = document.querySelector<HTMLButtonElement>("#uwb-at-send");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  if (uwbSend) {
    uwbSend.disabled = false;
  }
  if (uwbInput) {
    uwbInput.disabled = false;
  }
  syncLoraStreamUi(session);
  syncLoraMeshUi(session);
  syncBoatIdUi(session);
  syncDeviceTypeUi(session);
}

async function runGattOp<T>(session: BleBoatSession, op: () => Promise<T>): Promise<T> {
  const prev = session.gattChain;
  let release!: () => void;
  session.gattChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    if (!session.gatt.connected) {
      throw new Error("Device not connected");
    }
    return await op();
  } finally {
    release();
  }
}

function detachCharacteristicListeners(session: BleBoatSession): void {
  session.charImu?.removeEventListener("characteristicvaluechanged", session.onImuNotify);
  session.charLoraLine?.removeEventListener("characteristicvaluechanged", session.onLoraLineNotify);
  session.charLoraStats?.removeEventListener("characteristicvaluechanged", session.onLoraStatsNotify);
  session.charMeshtasticRx?.removeEventListener("characteristicvaluechanged", session.onMeshtasticLineNotify);
  session.charMeshtasticStats?.removeEventListener("characteristicvaluechanged", session.onMeshtasticStatsNotify);
  session.charUwbLine?.removeEventListener("characteristicvaluechanged", session.onUwbLineNotify);
}

async function bindSessionCharacteristics(session: BleBoatSession): Promise<void> {
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charLoraTx = null;
  session.charLoraLine = null;
  session.charLoraStats = null;
  session.charMeshtasticRx = null;
  session.charMeshtasticTx = null;
  session.charMeshtasticStats = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
  session.charDeviceType = null;
  session.notificationsOn = false;
  session.imuNotificationsOn = false;

  const svc = await session.gatt.getPrimaryService(BLE_SERVICE_UUID);

  try {
    session.charImu = await svc.getCharacteristic(BLE_IMU_CHAR_UUID);
    session.charImu.addEventListener("characteristicvaluechanged", session.onImuNotify);
  } catch (e) {
    console.error("BLE IMU unavailable", session.name, e);
  }
  try {
    session.charUwbAt = await svc.getCharacteristic(BLE_UWB_AT_CHAR_UUID);
  } catch (e) {
    console.error("BLE UWB AT unavailable", session.name, e);
  }
  try {
    session.charUwbLine = await svc.getCharacteristic(BLE_UWB_LINE_CHAR_UUID);
    session.charUwbLine.addEventListener("characteristicvaluechanged", session.onUwbLineNotify);
  } catch (e) {
    console.warn("BLE UWB RX unavailable", session.name, e);
  }
  try {
    session.charLoraTx = await svc.getCharacteristic(BLE_LORA_TX_CHAR_UUID);
  } catch {
    session.charLoraTx = null;
  }
  try {
    session.charLoraLine = await svc.getCharacteristic(BLE_LORA_LINE_CHAR_UUID);
    session.charLoraLine.addEventListener("characteristicvaluechanged", session.onLoraLineNotify);
  } catch {
    session.charLoraLine = null;
  }
  try {
    session.charLoraStats = await svc.getCharacteristic(BLE_LORA_STATS_CHAR_UUID);
    session.charLoraStats.addEventListener("characteristicvaluechanged", session.onLoraStatsNotify);
  } catch {
    session.charLoraStats = null;
  }
  try {
    session.charMeshtasticRx = await svc.getCharacteristic(BLE_MESHTASTIC_RX_CHAR_UUID);
    session.charMeshtasticRx.addEventListener("characteristicvaluechanged", session.onMeshtasticLineNotify);
  } catch (e) {
    console.warn("BLE Meshtastic RX unavailable", session.name, e);
  }
  try {
    session.charMeshtasticTx = await svc.getCharacteristic(BLE_MESHTASTIC_TX_CHAR_UUID);
  } catch (e) {
    console.warn("BLE Meshtastic TX unavailable", session.name, e);
  }
  try {
    session.charMeshtasticStats = await svc.getCharacteristic(BLE_MESHTASTIC_STATS_CHAR_UUID);
    session.charMeshtasticStats.addEventListener("characteristicvaluechanged", session.onMeshtasticStatsNotify);
  } catch (e) {
    console.warn("BLE Meshtastic stats unavailable", session.name, e);
  }
  try {
    session.charBoatId = await svc.getCharacteristic(BLE_BOAT_ID_CHAR_UUID);
  } catch (e) {
    session.charBoatId = null;
    console.warn("BLE boat ID unavailable", session.name, e);
  }
  try {
    session.charDeviceType = await svc.getCharacteristic(BLE_DEVICE_TYPE_CHAR_UUID);
  } catch (e) {
    session.charDeviceType = null;
    console.warn("BLE device type unavailable", session.name, e);
  }

  markMeshtasticBleReady(session);
  syncLoraTabVisibility(session);
  syncMeshtasticTabVisibility(session);
}

async function ensureLoraComms(session: BleBoatSession): Promise<void> {
  if (!session.charLoraTx || !session.charLoraLine) {
    await bindSessionCharacteristics(session);
  }
  await setCommsNotifications(session, true);
}

async function ensureUwbComms(session: BleBoatSession): Promise<void> {
  if (!session.charUwbAt || !session.charUwbLine) {
    await bindSessionCharacteristics(session);
  }
  await setCommsNotifications(session, true);
}

async function pauseImuForComms(session: BleBoatSession): Promise<boolean> {
  const wasOn = session.imuNotificationsOn;
  if (wasOn) {
    await setImuNotifications(session, false);
  }
  return wasOn;
}

async function restoreImuAfterComms(session: BleBoatSession, wasOn: boolean): Promise<void> {
  if (wasOn) {
    await setImuNotifications(session, true);
  }
}

function meshtasticSelfNodePlaceholder(num: number): MeshtasticNode {
  return {
    num,
    name: "",
    short: "",
    last_ms: 0,
    lat: null,
    lon: null,
    alt_m: null,
    speed_mps: null,
    heading_deg: null,
    has_gps_update: false,
    gps_has_lock: false,
    fix_quality: null,
    fix_type: null,
    sats_in_view: null,
    seq_number: null,
    time_sec: null,
    timestamp_sec: null,
  };
}

function findMeshtasticGpsNode(session: BleBoatSession): MeshtasticNode | null {
  const stats = session.meshtasticStats;
  const myNum = stats.my_num;
  if (myNum !== null) {
    const self = stats.nodes.find((n) => n.num === myNum);
    return self ?? meshtasticSelfNodePlaceholder(myNum);
  }
  const gpsNodes = stats.nodes
    .filter((n) => n.has_gps_update)
    .sort((a, b) => a.last_ms - b.last_ms);
  if (gpsNodes.length > 0) {
    return gpsNodes[0];
  }
  const target = MESHTASTIC_GPS_SOURCE_SHORT.toLowerCase();
  for (const node of stats.nodes) {
    if (node.short.toLowerCase() === target) {
      return node;
    }
  }
  if (stats.nodes.length === 1) {
    return stats.nodes[0];
  }
  return null;
}

function formatMeshtasticUtc(sec: number | null): string {
  if (sec === null || sec <= 0) {
    return "—";
  }
  return new Date(sec * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function renderGpsDisplay(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }

  const node = findMeshtasticGpsNode(session);
  const stats = session.meshtasticStats;
  if (!node) {
    clearGpsDisplay(null);
    if (stats.gps_rx > 0) {
      setText(
        "gps-meta",
        `Companion reports ${stats.gps_rx} GPS packets (api ${stats.gps_api_rx}) · waiting for roster…`,
      );
      setText("gps-source", stats.my_num !== null ? `node ${stats.my_num}` : "—");
    } else if (!stats.config_ok) {
      setText("gps-meta", "Waiting for Meshtastic config handshake…");
    } else if (session.meshtasticStatsReceivedWallMs > 0) {
      setText("gps-meta", "Config ready · waiting for GPS stats from companion (0xFEE7)…");
    } else {
      setText("gps-meta", "Waiting for Meshtastic stats from companion…");
    }
    return;
  }

  if (!node.has_gps_update) {
    const label = node.name || node.short || MESHTASTIC_GPS_SOURCE_SHORT;
    const gpsRx = stats.gps_rx;
    const gpsNote =
      stats.config_ok && gpsRx === 0
        ? " · companion GPS rx: 0"
        : gpsRx > 0
          ? ` · companion GPS rx: ${gpsRx}`
          : "";
    setText("gps-meta", `${label} · node ${node.num} · waiting for GPS stream (~1 Hz)${gpsNote}`);
    setText("gps-source", `${label} · node ${node.num}`);
    for (const id of ["gps-position", "gps-last-heard", "gps-fix", "gps-fix-type", "gps-sats", "gps-seq", "gps-utc", "gps-sog", "gps-cog", "gps-altitude"]) {
      setText(id, "—");
    }
    updateGpsMap(null, null);
    return;
  }

  const ageMs = meshtasticAgeMs(session, node.last_ms);
  const label = node.name || node.short || MESHTASTIC_GPS_SOURCE_SHORT;
  const fixLabel = fixQualityLabel(node.fix_quality);
  const fixNote =
    node.lat !== null && node.lon !== null
      ? "Fix OK"
      : node.gps_has_lock
        ? "Lock · waiting for coordinates…"
        : `No fix · ${fixLabel}`;
  const seqNote = node.seq_number !== null ? ` · seq ${node.seq_number}` : "";
  setText("gps-meta", `${label} (${node.short || MESHTASTIC_GPS_SOURCE_SHORT}) · ${fixNote} · ${formatAgo(ageMs)}${seqNote}`);

  if (node.lat !== null && node.lon !== null) {
    setText(
      "gps-position",
      `${formatCoordDeg(node.lat, true)}\n${formatCoordDeg(node.lon, false)}`,
    );
    updateGpsMap(node.lat, node.lon);
  } else {
    setText("gps-position", "—");
    updateGpsMap(null, null);
  }

  setText("gps-source", `${label} · node ${node.num}`);
  setText("gps-last-heard", formatAgo(ageMs));
  setText("gps-fix", fixLabel);
  setText("gps-fix-type", fixTypeLabel(node.fix_type));
  setText("gps-sats", node.sats_in_view !== null ? String(node.sats_in_view) : "—");
  setText("gps-seq", node.seq_number !== null ? String(node.seq_number) : "—");
  setText(
    "gps-utc",
    node.timestamp_sec !== null && node.timestamp_sec > 0
      ? formatMeshtasticUtc(node.timestamp_sec)
      : formatMeshtasticUtc(node.time_sec),
  );
  setText("gps-sog", formatMeshtasticSpeed(node));
  setText("gps-cog", formatMeshtasticHeading(node));
  setText(
    "gps-altitude",
    node.alt_m !== null ? `${node.alt_m} m MSL` : "—",
  );
}

function updateGpsMap(lat: number | null, lon: number | null): void {
  const hint = document.querySelector<HTMLElement>("#gps-map-hint");
  const link = document.querySelector<HTMLAnchorElement>("#gps-map-link");
  if (!hint || !link) {
    return;
  }

  if (lat === null || lon === null) {
    clearGpsLeafletMap();
    hint.hidden = false;
    link.hidden = true;
    return;
  }

  updateGpsLeafletMap(lat, lon);
  link.href = openStreetMapUrl(lat, lon);
  link.hidden = false;
  hint.hidden = true;
}

function clearGpsDisplay(_session: BleBoatSession | null): void {
  clearGpsLeafletMap();
  const hint = document.querySelector<HTMLElement>("#gps-map-hint");
  const link = document.querySelector<HTMLAnchorElement>("#gps-map-link");
  if (hint) {
    hint.hidden = false;
  }
  if (link) {
    link.hidden = true;
    link.href = "#";
  }
  setText("gps-meta", `Waiting for Meshtastic position from node ${MESHTASTIC_GPS_SOURCE_SHORT}…`);
  for (const id of [
    "gps-source",
    "gps-position",
    "gps-last-heard",
    "gps-fix",
    "gps-fix-type",
    "gps-sats",
    "gps-seq",
    "gps-utc",
    "gps-sog",
    "gps-cog",
    "gps-altitude",
  ]) {
    setText(id, "—");
  }
}

function appendStreamLine(
  session: BleBoatSession,
  field: "loraLineLogText" | "meshtasticLineLogText",
  chunk: string,
): void {
  if (chunk.length === 0) {
    return;
  }
  const line = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  const current = session[field];
  if (current.endsWith(line)) {
    return;
  }
  session[field] += line;
  if (session[field].length > 64000) {
    session[field] = session[field].slice(-48000);
  }
  if (field === "loraLineLogText") {
    renderLoraLog(session);
  } else {
    renderMeshtasticLog(session);
  }
}

function defaultLoraRadioStatus(session: BleBoatSession): string {
  const missing: string[] = [];
  if (!session.charLoraTx) {
    missing.push("0xFEF7 TX");
  }
  if (!session.charLoraLine) {
    missing.push("0xFEF8 notify");
  }
  if (missing.length > 0) {
    return `BLE LoRa GATT missing (${missing.join(", ")})`;
  }
  return session.gatt.connected ? "waiting for status notify…" : "not connected";
}

function appendUwbLineIfNew(session: BleBoatSession, chunk: string, gen: number): void {
  if (gen !== session.activeUwbGen || chunk.length === 0) {
    return;
  }
  const line = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  if (session.uwbLineLogText.endsWith(line)) {
    return;
  }
  appendUwbLog(session, line);
}

async function activateSession(session: BleBoatSession): Promise<boolean> {
  session.parked = false;
  try {
    if (!session.gatt.connected) {
      if (session.nativeBle) {
        session.gatt = await connectNativeGatt(session.deviceId, session.onDisconnected);
      } else if (session.device?.gatt) {
        const webGatt = await session.device.gatt.connect();
        session.gatt = asWebGatt(webGatt);
        try {
          const g = webGatt as BluetoothRemoteGATTServer & { requestMtu?: (n: number) => Promise<number> };
          if (typeof g.requestMtu === "function") {
            await g.requestMtu(247);
          }
        } catch {
          /* optional */
        }
      } else {
        return false;
      }
    }
    if (!session.charImu || !session.charUwbAt || !session.charMeshtasticStats) {
      await bindSessionCharacteristics(session);
    }
    const statsBaseline = session.loraStatsReceivedWallMs;
    await setCommsNotifications(session, true);
    await syncLoraStatsFromDevice(session, statsBaseline);
    if (session.loraStats.mesh.active && hasDirectLoRa(session)) {
      session.loraMeshRunning = true;
      session.loraTabView = "mesh";
    }
    if (hasMeshtastic(session)) {
      void (async () => {
        await ensureMeshtasticConfigReady(session, 20000);
        await syncMeshtasticStatsFromDevice(session, session.meshtasticStatsReceivedWallMs, 5000);
        if (session.deviceId === activeSessionId) {
          renderMeshtastic(session);
          renderGpsDisplay(session);
          syncMeshtasticUiRefresh(session);
        }
      })();
    }
    imuTabActive = true;
    await setImuNotifications(session, true);
    await readBoatIdFromDevice(session);
    await readDeviceTypeFromDevice(session);
    syncBoatIdUi(session);
    syncDeviceTypeUi(session);
    session.loraRadioStatus = defaultLoraRadioStatus(session);
    renderLoraStatus(session);
    return session.gatt.connected;
  } catch (e) {
    console.error("BLE activate failed", session.name, e);
    session.notificationsOn = false;
    session.imuNotificationsOn = false;
    return false;
  }
}

async function deactivateSession(session: BleBoatSession): Promise<void> {
  stopLoraStream(session);
  // Park BLE only — leave mesh running on the device unless the user pressed Stop mesh.
  stopLoraMesh(session, false);
  session.parked = true;
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charLoraTx = null;
  session.charLoraLine = null;
  session.charLoraStats = null;
  session.charMeshtasticRx = null;
  session.charMeshtasticTx = null;
  session.charMeshtasticStats = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
  session.charDeviceType = null;
  session.notificationsOn = false;
  session.imuNotificationsOn = false;
  syncMeshtasticUiRefresh(null);
  if (session.gatt.connected) {
    try {
      await session.gatt.disconnect();
    } catch {
      /* ignore */
    }
  }
}

async function ensureSessionConnected(session: BleBoatSession): Promise<boolean> {
  if (session.gatt.connected && session.charImu && session.charUwbAt) {
    return true;
  }
  return activateSession(session);
}

async function pollUwbResponse(session: BleBoatSession, gen: number, baselineLen: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let nextReadAt = 0;
  while (performance.now() < deadline) {
    if (gen !== session.activeUwbGen) {
      return false;
    }
    if (session.uwbLineLogText.length > baselineLen) {
      return true;
    }
    const now = performance.now();
    if (session.charUwbLine && session.gatt.connected && now >= nextReadAt) {
      nextReadAt = now + 250;
      try {
        const val = await runGattOp(session, () => session.charUwbLine!.readValue());
        if (val.byteLength > 0) {
          const chunk = new TextDecoder().decode(val);
          appendUwbLineIfNew(session, chunk, gen);
          if (session.uwbLineLogText.length > baselineLen) {
            return true;
          }
        }
      } catch {
        /* optional */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return session.uwbLineLogText.length > baselineLen;
}

async function setImuNotifications(session: BleBoatSession, enabled: boolean): Promise<void> {
  if (session.imuNotificationsOn === enabled) {
    return;
  }
  if (!session.gatt.connected || !session.charImu) {
    session.imuNotificationsOn = false;
    return;
  }
  try {
    if (enabled) {
      try {
        await session.charImu.stopNotifications();
      } catch {
        /* CCCD may not be subscribed yet */
      }
      await session.charImu.startNotifications();
    } else {
      await session.charImu.stopNotifications();
    }
    session.imuNotificationsOn = enabled;
  } catch (e) {
    session.imuNotificationsOn = false;
    console.warn(`BLE IMU notifications ${enabled ? "start" : "stop"} failed`, session.name, e);
  }
}

async function setCommsNotifications(session: BleBoatSession, enabled: boolean): Promise<void> {
  if (session.notificationsOn === enabled) {
    return;
  }
  if (!session.gatt.connected) {
    session.notificationsOn = false;
    return;
  }
  const chars = [
    session.charUwbLine,
    session.charLoraLine,
    session.charLoraStats,
    session.charMeshtasticRx,
    session.charMeshtasticStats,
  ].filter((c): c is BleGattCharacteristicLike => c !== null);
  const results: PromiseSettledResult<unknown>[] = [];
  for (const chr of chars) {
    try {
      if (enabled) {
        await chr.startNotifications();
      } else {
        await chr.stopNotifications();
      }
      results.push({ status: "fulfilled", value: undefined });
    } catch (e) {
      results.push({ status: "rejected", reason: e });
    }
  }
  const failed = results.some((r) => r.status === "rejected");
  session.notificationsOn = enabled && !failed;
  if (failed) {
    console.warn(`BLE comms notifications ${enabled ? "start" : "stop"} partial failure`, session.name);
  }
}

async function setSessionNotifications(session: BleBoatSession, enabled: boolean): Promise<void> {
  if (enabled) {
    await setCommsNotifications(session, true);
    await setImuNotifications(session, true);
  } else {
    await setImuNotifications(session, false);
    await setCommsNotifications(session, false);
  }
}

type GattWriteTarget = "lora" | "uwb" | "boatid" | "type" | "stats" | "meshtastic" | "mtstats";

function getWriteCharacteristic(session: BleBoatSession, target: GattWriteTarget): BleGattCharacteristicLike | null {
  if (target === "lora") {
    return session.charLoraTx;
  }
  if (target === "stats") {
    return session.charLoraStats;
  }
  if (target === "meshtastic") {
    return session.charMeshtasticTx;
  }
  if (target === "mtstats") {
    return session.charMeshtasticStats;
  }
  if (target === "uwb") {
    return session.charUwbAt;
  }
  if (target === "type") {
    return session.charDeviceType;
  }
  return session.charBoatId;
}

async function gattWrite(session: BleBoatSession, target: GattWriteTarget, data: BufferSource): Promise<void> {
  if (!(await ensureSessionConnected(session))) {
    throw new Error("Device not connected");
  }
  const char = getWriteCharacteristic(session, target);
  if (!char) {
    throw new Error("Characteristic unavailable");
  }
  await runGattOp(session, () => char.writeValue(data));
}

/** BLE 0xFEE6: `send=<dest>\n<message>` — firmware parses; mesh payload is message only. */
function encodeMeshtasticSendCmd(dest: string, message: string): ArrayBuffer {
  const prefix = new TextEncoder().encode(`send=${dest}\n`);
  const body = new TextEncoder().encode(message);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function clearLoraLog(session: BleBoatSession | null): void {
  if (session) {
    session.loraLineLogText = "";
  }
  const el = document.querySelector("#lora-line-log");
  if (el) {
    el.textContent = "";
  }
}

function renderLoraLog(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector("#lora-line-log");
  if (!el) {
    return;
  }
  el.textContent = session.loraLineLogText;
  el.scrollTop = el.scrollHeight;
}

function parseLoraStatsJson(raw: string): LoraStatsSnapshot | null {
  try {
    const data = JSON.parse(raw) as {
      tx?: { queued?: number; ok?: number; timeout?: number };
      rx_bad?: number;
      senders?: Array<{ sig?: string; first?: number; last?: number; missing?: number; rx?: number }>;
      mesh?: {
        active?: boolean;
        state?: string;
        my_id?: number | null;
        my_type?: number;
        tx_ok?: number;
        tx_fail?: number;
        rx?: number;
        collision_yield?: number;
        msg_tx_ok?: number;
        msg_tx_fail?: number;
        msg_rx?: number;
        peers?: Array<{ id?: number; type?: number; last_ms?: number }>;
        rx_msgs?: Array<{ from?: number; seq?: number; text?: string; last_ms?: number }>;
      };
    };
    const senders: LoraStatsSender[] = [];
    if (Array.isArray(data.senders)) {
      for (const s of data.senders) {
        if (!s.sig) {
          continue;
        }
        senders.push({
          sig: s.sig,
          first: Number(s.first ?? 0),
          last: Number(s.last ?? 0),
          missing: Number(s.missing ?? 0),
          rx: Number(s.rx ?? 0),
        });
      }
    }
    const meshRaw = data.mesh;
    const meshState =
      meshRaw?.state === "listening" || meshRaw?.state === "locked" ? meshRaw.state : "off";
    const peers: LoraMeshPeer[] = [];
    if (Array.isArray(meshRaw?.peers)) {
      for (const p of meshRaw.peers) {
        if (p.id === undefined) {
          continue;
        }
        peers.push({
          id: Number(p.id),
          type: Number(p.type ?? 0),
          last_ms: Number(p.last_ms ?? 0),
        });
      }
      peers.sort((a, b) => a.id - b.id);
    }
    const rx_msgs: LoraMeshRxMsg[] = [];
    if (Array.isArray(meshRaw?.rx_msgs)) {
      for (const msg of meshRaw.rx_msgs) {
        if (msg.from === undefined || !msg.text) {
          continue;
        }
        rx_msgs.push({
          from: Number(msg.from),
          seq: Number(msg.seq ?? 0),
          text: String(msg.text),
          last_ms: Number(msg.last_ms ?? 0),
        });
      }
    }
    const myIdRaw = meshRaw?.my_id;
    return {
      tx: {
        queued: Number(data.tx?.queued ?? 0),
        ok: Number(data.tx?.ok ?? 0),
        timeout: Number(data.tx?.timeout ?? 0),
      },
      rx_bad: Number(data.rx_bad ?? 0),
      senders,
      mesh: {
        active: meshRaw?.active === true,
        state: meshState,
        my_id: myIdRaw === null || myIdRaw === undefined ? null : Number(myIdRaw),
        my_type: Number(meshRaw?.my_type ?? 4),
        tx_ok: Number(meshRaw?.tx_ok ?? 0),
        tx_fail: Number(meshRaw?.tx_fail ?? 0),
        rx: Number(meshRaw?.rx ?? 0),
        collision_yield: Number(meshRaw?.collision_yield ?? 0),
        msg_tx_ok: Number(meshRaw?.msg_tx_ok ?? 0),
        msg_tx_fail: Number(meshRaw?.msg_tx_fail ?? 0),
        msg_rx: Number(meshRaw?.msg_rx ?? 0),
        peers,
        rx_msgs,
      },
    };
  } catch {
    return null;
  }
}

function appendMeshMessageLog(session: BleBoatSession, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const last = session.meshMessageLog[session.meshMessageLog.length - 1];
  if (last === trimmed) {
    return;
  }
  session.meshMessageLog.push(trimmed);
  if (session.meshMessageLog.length > 48) {
    session.meshMessageLog = session.meshMessageLog.slice(-32);
  }
  renderLoraMeshRxLog(session);
}

function mergeMeshRxFromStats(
  session: BleBoatSession,
  prev: LoraMeshSnapshot,
  next: LoraMeshSnapshot,
): void {
  for (const msg of next.rx_msgs) {
    const dup = prev.rx_msgs.some(
      (p) =>
        p.from === msg.from &&
        p.seq === msg.seq &&
        p.text === msg.text &&
        p.last_ms === msg.last_ms,
    );
    if (!dup) {
      appendMeshMessageLog(session, `← from ${msg.from} seq ${msg.seq}: ${msg.text}`);
    }
  }
}

function meshAgeMs(session: BleBoatSession, ageAtReceiptMs: number): number {
  if (session.loraStatsReceivedWallMs <= 0) {
    return ageAtReceiptMs;
  }
  return ageAtReceiptMs + (Date.now() - session.loraStatsReceivedWallMs);
}

function applyLoraStats(session: BleBoatSession, parsed: LoraStatsSnapshot): void {
  mergeMeshRxFromStats(session, session.loraStats.mesh, parsed.mesh);
  session.loraStats = parsed;
  session.loraStatsReceivedWallMs = Date.now();
  session.loraMeshRunning = parsed.mesh.active;
  renderLoraStats(session);
  renderLoraMesh(session);
  syncLoraStreamUi(session);
  syncLoraMeshUi(session);
}

function ingestLoraStatsChunk(session: BleBoatSession, chunk: string): void {
  if (!chunk) {
    return;
  }

  // BLE read (and lucky single notify) delivers a full JSON object — parse directly.
  const solo = parseLoraStatsJson(chunk.trim());
  if (solo) {
    session.loraStatsNotifyBuf = "";
    applyLoraStats(session, solo);
    return;
  }

  // Multi-chunk notify: 0xFEFE JSON is split into ~200-byte BLE packets.
  if (chunk.startsWith('{"tx"')) {
    session.loraStatsNotifyBuf = chunk;
  } else {
    session.loraStatsNotifyBuf += chunk;
  }

  const parsed = parseLoraStatsJson(session.loraStatsNotifyBuf.trim());
  if (!parsed) {
    if (session.loraStatsNotifyBuf.length > 512) {
      console.warn(
        "LoRa stats JSON reassembly failed",
        session.name,
        session.loraStatsNotifyBuf.slice(0, 120),
        "…",
      );
    }
    if (session.loraStatsNotifyBuf.length > 16384) {
      session.loraStatsNotifyBuf = "";
    }
    return;
  }
  session.loraStatsNotifyBuf = "";
  applyLoraStats(session, parsed);
}

async function waitForLoraStatsNotify(
  session: BleBoatSession,
  baselineWallMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.loraStatsReceivedWallMs > baselineWallMs) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return false;
}

async function requestLoraStatsNotify(session: BleBoatSession): Promise<void> {
  if (!session.charLoraStats) {
    return;
  }
  try {
    await gattWrite(session, "stats", new TextEncoder().encode("stats=1"));
  } catch (e) {
    console.warn("BLE LoRa stats refresh failed", session.name, e);
  }
}

/** Sync mesh/stream state from device via chunked BLE notify (not MTU-limited read). */
async function syncLoraStatsFromDevice(
  session: BleBoatSession,
  baselineWallMs = session.loraStatsReceivedWallMs,
): Promise<void> {
  if (!session.charLoraStats) {
    return;
  }
  if (await waitForLoraStatsNotify(session, baselineWallMs, 2000)) {
    return;
  }
  await requestLoraStatsNotify(session);
  if (!(await waitForLoraStatsNotify(session, baselineWallMs, 3000))) {
    console.warn("LoRa stats notify sync timed out", session.name);
  }
}

async function readLoraStatsFromDevice(session: BleBoatSession): Promise<void> {
  await syncLoraStatsFromDevice(session);
}

async function writeLoraStreamGate(session: BleBoatSession, active: boolean): Promise<void> {
  if (!session.charLoraStats) {
    return;
  }
  try {
    await gattWrite(session, "stats", new TextEncoder().encode(active ? "stream=1" : "stream=0"));
  } catch (e) {
    console.warn("BLE LoRa stream gate write failed", session.name, e);
  }
}

async function writeLoraMeshGate(session: BleBoatSession, active: boolean): Promise<void> {
  if (!session.charLoraStats) {
    return;
  }
  try {
    await gattWrite(session, "stats", new TextEncoder().encode(active ? "mesh=1" : "mesh=0"));
  } catch (e) {
    console.warn("BLE LoRa mesh gate write failed", session.name, e);
  }
}

function syncLoraTabView(session: BleBoatSession | null): void {
  const normalPanel = document.querySelector<HTMLElement>("#lora-panel-normal");
  const meshPanel = document.querySelector<HTMLElement>("#lora-panel-mesh");
  const meshRow = document.querySelector<HTMLElement>("#lora-view-mesh-row");
  const directLoRa = hasDirectLoRa(session);
  const view = session?.loraTabView ?? "normal";
  if (normalPanel) {
    normalPanel.hidden = view !== "normal";
  }
  if (meshPanel) {
    meshPanel.hidden = view !== "mesh" || !directLoRa;
  }
  if (meshRow) {
    meshRow.hidden = view !== "normal" || !directLoRa;
  }
  if (!directLoRa && session) {
    session.loraTabView = "normal";
  }
  syncMeshUiRefresh(session);
  syncMeshtasticTabVisibility(session);
}

function meshSelfLabel(mesh: LoraMeshSnapshot): string {
  if (!mesh.active) {
    return "This device: mesh off";
  }
  const type = meshTypeLabel(mesh.my_type);
  if (mesh.state === "listening") {
    return `This device: listening for peers (claiming ID…) · type ${type}`;
  }
  if (mesh.state === "locked" && mesh.my_id !== null) {
    return `This device: locked mesh ID ${mesh.my_id} · type ${type}`;
  }
  return `This device: mesh active · type ${type}`;
}

function renderLoraMeshRxLog(session: BleBoatSession): void {
  const el = document.querySelector<HTMLPreElement>("#lora-mesh-rx-log");
  if (!el || session.deviceId !== activeSessionId) {
    return;
  }
  el.textContent =
    session.meshMessageLog.length > 0 ? `${session.meshMessageLog.join("\n")}\n` : "";
}

function renderLoraMesh(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const selfEl = document.querySelector("#lora-mesh-self");
  const statsEl = document.querySelector("#lora-mesh-stats");
  const tbody = document.querySelector("#lora-mesh-peers-body");
  const m = session.loraStats.mesh;
  const myId = m.my_id;
  if (selfEl) {
    selfEl.textContent = meshSelfLabel(m);
  }
  if (statsEl) {
    const peerCount = m.peers.filter((p) => myId === null || p.id !== myId).length;
    statsEl.textContent =
      `Mesh TX ok: ${m.tx_ok}, fail: ${m.tx_fail}, RX: ${m.rx} · peers: ${peerCount}` +
      (m.collision_yield > 0 ? ` · yields: ${m.collision_yield}` : "");
  }
  if (!tbody) {
    return;
  }
  tbody.textContent = "";
  for (const p of m.peers) {
    const tr = document.createElement("tr");
    const isSelf = myId !== null && p.id === myId;
    if (isSelf) {
      tr.classList.add("lora-mesh-peer-self");
    } else {
      tr.classList.add("lora-mesh-peer-clickable");
      tr.dataset["meshPeerId"] = String(p.id);
      tr.title = "Click to send a message";
    }
    for (const cell of [String(p.id), meshTypeLabel(p.type), formatAgo(meshAgeMs(session, p.last_ms))]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  renderLoraMeshRxLog(session);
}

async function promptAndSendMeshMessage(session: BleBoatSession, destId: number): Promise<void> {
  if (!session.charLoraStats) {
    return;
  }
  if (session.loraStats.mesh.state !== "locked") {
    window.alert("Mesh must be locked (you need a mesh ID) before sending messages.");
    return;
  }
  const text = window.prompt(`Message to mesh ID ${destId}:`, "");
  if (text === null) {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed.length > 200) {
    window.alert("Message must be 200 characters or fewer.");
    return;
  }
  try {
    await gattWrite(
      session,
      "stats",
      new TextEncoder().encode(`mesh_tx=${destId}\n${trimmed}`),
    );
    const sentLine = `→ sent to ${destId}: ${trimmed}`;
    appendMeshMessageLog(session, sentLine);
    console.info("mesh message queued", { destId, text: trimmed, device: session.name });
    renderLoraMesh(session);
  } catch (e) {
    console.warn("BLE mesh message write failed", session.name, e);
    window.alert("Failed to send message. Check BLE connection and that mesh is active.");
  }
}

function syncMeshUiRefresh(session: BleBoatSession | null): void {
  if (meshUiRefreshTimer !== null) {
    clearInterval(meshUiRefreshTimer);
    meshUiRefreshTimer = null;
  }
  const meshActive = session?.loraStats.mesh.active === true || session?.loraMeshRunning === true;
  if (!meshActive || !session || session.deviceId !== activeSessionId) {
    return;
  }
  meshUiRefreshTimer = setInterval(() => {
    const active = getActiveSession();
    if (!active || active.deviceId !== activeSessionId) {
      return;
    }
    if (!active.loraStats.mesh.active && !active.loraMeshRunning) {
      return;
    }
    renderLoraMesh(active);
  }, 1000);
}

function syncLoraMeshUi(session: BleBoatSession | null): void {
  const directLoRa = hasDirectLoRa(session);
  const meshActive = session?.loraStats.mesh.active === true || session?.loraMeshRunning === true;
  const startBtn = document.querySelector<HTMLButtonElement>("#lora-mesh-start");
  const stopBtn = document.querySelector<HTMLButtonElement>("#lora-mesh-stop");
  if (startBtn) {
    startBtn.disabled = !session || !directLoRa || meshActive;
  }
  if (stopBtn) {
    stopBtn.disabled = !session || !directLoRa || !meshActive;
  }
  syncLoraTabView(session);
}

function syncLoraTabVisibility(session: BleBoatSession | null): void {
  const tab = document.querySelector<HTMLElement>("#lora-tab");
  if (tab) {
    tab.hidden = !hasDirectLoRa(session);
  }
}

function syncMeshtasticTabVisibility(session: BleBoatSession | null): void {
  const tab = document.querySelector<HTMLElement>("#meshtastic-tab");
  if (tab) {
    tab.hidden = !hasMeshtastic(session);
  }
}

function markMeshtasticBleReady(session: BleBoatSession): void {
  if (!hasMeshtastic(session)) {
    return;
  }
  session.meshtasticStats = {
    ...session.meshtasticStats,
    connected: true,
  };
}

function meshtasticAgeMs(session: BleBoatSession, ageAtReceiptMs: number): number {
  if (session.meshtasticStatsReceivedWallMs <= 0) {
    return ageAtReceiptMs;
  }
  return ageAtReceiptMs + (Date.now() - session.meshtasticStatsReceivedWallMs);
}

function parseMeshtasticOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatMeshtasticPosition(n: MeshtasticNode): string {
  if (n.lat === null || n.lon === null) {
    return "—";
  }
  const parts = [`${n.lat.toFixed(5)}°, ${n.lon.toFixed(5)}°`];
  if (n.alt_m !== null) {
    parts.push(`${n.alt_m} m`);
  }
  return parts.join(" · ");
}

function formatMeshtasticSpeed(n: MeshtasticNode): string {
  if (n.speed_mps === null) {
    return "—";
  }
  return formatSpeedKnots(n.speed_mps / 0.514444);
}

function formatMeshtasticHeading(n: MeshtasticNode): string {
  if (n.heading_deg === null) {
    return "—";
  }
  return formatCourseDeg(n.heading_deg);
}

function parseMeshtasticStatsJson(raw: string): MeshtasticStatsSnapshot | null {
  try {
    const data = JSON.parse(raw) as {
      connected?: boolean;
      config_ok?: boolean;
      my_num?: number | null;
      tx_ok?: number;
      tx_fail?: number;
      rx?: number;
      gps_rx?: number;
      gps_api_rx?: number;
      nodes?: Array<{
        num?: number;
        name?: string;
        short?: string;
        last_ms?: number;
        lat?: number;
        lon?: number;
        alt_m?: number;
        speed_mps?: number;
        heading_deg?: number;
        has_gps_update?: boolean;
        gps_has_lock?: boolean;
        fix_quality?: number;
        fix_type?: number;
        sats_in_view?: number;
        seq_number?: number;
        time_sec?: number;
        timestamp_sec?: number;
      }>;
      rx_msgs?: Array<{ from?: number; from_name?: string; text?: string; last_ms?: number }>;
    };
    const nodes: MeshtasticNode[] = [];
    if (Array.isArray(data.nodes)) {
      for (const n of data.nodes) {
        if (n.num === undefined) {
          continue;
        }
        nodes.push({
          num: Number(n.num),
          name: String(n.name ?? ""),
          short: String(n.short ?? ""),
          last_ms: Number(n.last_ms ?? 0),
          lat: parseMeshtasticOptionalNumber(n.lat),
          lon: parseMeshtasticOptionalNumber(n.lon),
          alt_m: parseMeshtasticOptionalNumber(n.alt_m),
          speed_mps: parseMeshtasticOptionalNumber(n.speed_mps),
          heading_deg: parseMeshtasticOptionalNumber(n.heading_deg),
          has_gps_update: n.has_gps_update === true,
          gps_has_lock: n.gps_has_lock === true,
          fix_quality: parseMeshtasticOptionalNumber(n.fix_quality),
          fix_type: parseMeshtasticOptionalNumber(n.fix_type),
          sats_in_view: parseMeshtasticOptionalNumber(n.sats_in_view),
          seq_number: parseMeshtasticOptionalNumber(n.seq_number),
          time_sec: parseMeshtasticOptionalNumber(n.time_sec),
          timestamp_sec: parseMeshtasticOptionalNumber(n.timestamp_sec),
        });
      }
      nodes.sort((a, b) => a.num - b.num);
    }
    const rx_msgs: MeshtasticRxMsg[] = [];
    if (Array.isArray(data.rx_msgs)) {
      for (const m of data.rx_msgs) {
        if (m.from === undefined || !m.text) {
          continue;
        }
        rx_msgs.push({
          from: Number(m.from),
          from_name: String(m.from_name ?? ""),
          text: String(m.text),
          last_ms: Number(m.last_ms ?? 0),
        });
      }
    }
    const myRaw = data.my_num;
    return {
      connected: data.connected === true,
      config_ok: data.config_ok === true,
      my_num: myRaw === null || myRaw === undefined ? null : Number(myRaw),
      tx_ok: Number(data.tx_ok ?? 0),
      tx_fail: Number(data.tx_fail ?? 0),
      rx: Number(data.rx ?? 0),
      gps_rx: Number(data.gps_rx ?? 0),
      gps_api_rx: Number(data.gps_api_rx ?? 0),
      nodes,
      rx_msgs,
    };
  } catch {
    return null;
  }
}

function ingestMeshtasticStatsChunk(session: BleBoatSession, chunk: string): void {
  if (!chunk) {
    return;
  }

  const trimmed = chunk.trim();
  const solo = parseMeshtasticStatsJson(trimmed);
  if (solo) {
    session.meshtasticStatsNotifyBuf = "";
    applyMeshtasticStats(session, solo);
    return;
  }

  // Multi-chunk notify: 0xFEE7 JSON is split into ~244-byte BLE packets.
  if (trimmed.startsWith('{"connected"')) {
    if (session.meshtasticStatsNotifyBuf) {
      const prev = parseMeshtasticStatsJson(session.meshtasticStatsNotifyBuf.trim());
      if (prev) {
        session.meshtasticStatsNotifyBuf = "";
        applyMeshtasticStats(session, prev);
      }
    }
    session.meshtasticStatsNotifyBuf = chunk;
  } else if (session.meshtasticStatsNotifyBuf) {
    session.meshtasticStatsNotifyBuf += chunk;
  } else {
    return;
  }

  const parsed = parseMeshtasticStatsJson(session.meshtasticStatsNotifyBuf.trim());
  if (!parsed) {
    if (session.meshtasticStatsNotifyBuf.length > 16384) {
      session.meshtasticStatsNotifyBuf = "";
    }
    return;
  }
  session.meshtasticStatsNotifyBuf = "";
  applyMeshtasticStats(session, parsed);
}

async function waitForMeshtasticStatsNotify(
  session: BleBoatSession,
  baselineWallMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.meshtasticStatsReceivedWallMs > baselineWallMs) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return session.meshtasticStatsReceivedWallMs > baselineWallMs;
}

function parseMeshtasticLogPeer(line: string): { num: number; name: string } | null {
  const trimmed = line.trim();
  const hex = /^<< 0x([0-9A-Fa-f]{1,8}):/.exec(trimmed);
  if (hex) {
    return { num: parseInt(hex[1], 16), name: `0x${hex[1].toUpperCase()}` };
  }
  const dec = /^<< (\d+):/.exec(trimmed);
  if (dec) {
    const num = Number(dec[1]);
    return Number.isFinite(num) ? { num, name: String(num) } : null;
  }
  const named = /^<< ([^:\n]+):/.exec(trimmed);
  if (named && !named[1].startsWith("0x")) {
    return { num: 0, name: named[1] };
  }
  return null;
}

function mergeMeshtasticPeersFromLog(session: BleBoatSession): void {
  const peers = new Map<number, MeshtasticNode>();
  for (const existing of session.meshtasticStats.nodes) {
    peers.set(existing.num, existing);
  }
  const lines = session.meshtasticLineLogText.split("\n");
  let rx = 0;
  let tx = 0;
  let configOk = session.meshtasticStats.config_ok;
  for (const line of lines) {
    if (line.startsWith("! config ready")) {
      configOk = true;
    }
    if (line.startsWith("<< ")) {
      rx++;
      const peer = parseMeshtasticLogPeer(line);
      if (peer && peer.num !== 0) {
        const prev = peers.get(peer.num);
        peers.set(peer.num, {
          num: peer.num,
          name: peer.name,
          short: prev?.short ?? "",
          last_ms: prev?.last_ms ?? 0,
          lat: prev?.lat ?? null,
          lon: prev?.lon ?? null,
          alt_m: prev?.alt_m ?? null,
          speed_mps: prev?.speed_mps ?? null,
          heading_deg: prev?.heading_deg ?? null,
          has_gps_update: prev?.has_gps_update ?? false,
          gps_has_lock: prev?.gps_has_lock ?? false,
          fix_quality: prev?.fix_quality ?? null,
          fix_type: prev?.fix_type ?? null,
          sats_in_view: prev?.sats_in_view ?? null,
          seq_number: prev?.seq_number ?? null,
          time_sec: prev?.time_sec ?? null,
          timestamp_sec: prev?.timestamp_sec ?? null,
        });
      }
    } else if (line.startsWith(">> ")) {
      tx++;
    }
  }
  const mergedNodes = [...peers.values()].sort((a, b) => a.num - b.num);
  const prev = session.meshtasticStats;
  session.meshtasticStats = {
    ...prev,
    connected: true,
    config_ok: configOk,
    tx_ok: Math.max(prev.tx_ok, tx),
    rx: Math.max(prev.rx, rx),
    nodes: mergedNodes.length > 0 ? mergedNodes : prev.nodes,
  };
  if (prev.my_num !== null || prev.gps_rx > 0 || mergedNodes.some((n) => n.has_gps_update)) {
    session.meshtasticStatsReceivedWallMs = Date.now();
  }
}

function ingestMeshtasticLine(session: BleBoatSession, chunk: string): void {
  if (!chunk) {
    return;
  }
  appendStreamLine(session, "meshtasticLineLogText", chunk);
  mergeMeshtasticPeersFromLog(session);
  renderMeshtastic(session);
  syncMeshtasticUiRefresh(session);
}

function applyMeshtasticStats(session: BleBoatSession, parsed: MeshtasticStatsSnapshot): void {
  const prev = session.meshtasticStats;
  const nodes = parsed.nodes.map((n) => {
    const existing = prev.nodes.find((p) => p.num === n.num);
    return {
      ...n,
      name: n.name || existing?.name || "",
      short: n.short || existing?.short || "",
    };
  });
  session.meshtasticStats = {
    ...parsed,
    nodes,
    config_ok: parsed.config_ok || prev.config_ok,
  };
  session.meshtasticStatsReceivedWallMs = Date.now();
  mergeMeshtasticPeersFromLog(session);
  renderMeshtastic(session);
  renderGpsDisplay(session);
  syncMeshtasticUiRefresh(session);
}

async function requestMeshtasticStatsNotify(session: BleBoatSession): Promise<void> {
  if (!session.charMeshtasticStats) {
    return;
  }
  try {
    await gattWrite(session, "mtstats", new TextEncoder().encode("stats=1"));
  } catch (e) {
    console.warn("BLE Meshtastic stats write refresh failed", session.name, e);
  }
}

/** Wait for Meshtastic config handshake (auto on connect; also used before send). */
async function ensureMeshtasticConfigReady(
  session: BleBoatSession,
  timeoutMs = 15000,
): Promise<boolean> {
  if (!hasMeshtastic(session)) {
    return false;
  }
  mergeMeshtasticPeersFromLog(session);
  if (session.meshtasticStats.config_ok) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  let configRequested = false;

  while (Date.now() < deadline) {
    mergeMeshtasticPeersFromLog(session);
    if (session.meshtasticStats.config_ok) {
      renderMeshtastic(session);
      return true;
    }

    const statsBaseline = session.meshtasticStatsReceivedWallMs;
    await syncMeshtasticStatsFromDevice(session, statsBaseline, 1500);
    mergeMeshtasticPeersFromLog(session);
    if (session.meshtasticStats.config_ok) {
      renderMeshtastic(session);
      return true;
    }

    if (!configRequested && session.charMeshtasticTx) {
      configRequested = true;
      try {
        await gattWrite(session, "meshtastic", new TextEncoder().encode("config=1"));
      } catch (e) {
        console.warn("Meshtastic config=1 failed", session.name, e);
      }
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  mergeMeshtasticPeersFromLog(session);
  return session.meshtasticStats.config_ok;
}

async function syncMeshtasticStatsFromDevice(
  session: BleBoatSession,
  baselineWallMs = session.meshtasticStatsReceivedWallMs,
  timeoutMs = 8000,
): Promise<void> {
  if (!session.charMeshtasticStats) {
    mergeMeshtasticPeersFromLog(session);
    renderMeshtastic(session);
    return;
  }
  if (await waitForMeshtasticStatsNotify(session, baselineWallMs, 600)) {
    return;
  }
  await requestMeshtasticStatsNotify(session);
  if (await waitForMeshtasticStatsNotify(session, baselineWallMs, timeoutMs)) {
    return;
  }
  mergeMeshtasticPeersFromLog(session);
  renderMeshtastic(session);
  const statsAgeMs = Date.now() - session.meshtasticStatsReceivedWallMs;
  if (session.meshtasticStatsReceivedWallMs === 0 || statsAgeMs > 10000) {
    console.warn("Meshtastic stats notify sync timed out", session.name);
  }
}

async function refreshMeshtasticRoster(session: BleBoatSession): Promise<void> {
  if (!hasMeshtastic(session)) {
    window.alert("Meshtastic not available on this device.");
    return;
  }
  if (!session.charMeshtasticStats) {
    window.alert("Missing 0xFEE7 stats — reflash Freenove firmware with Meshtastic client.");
    return;
  }
  const btn = document.querySelector<HTMLButtonElement>("#meshtastic-roster-refresh");
  if (btn) {
    btn.disabled = true;
  }
  try {
    if (session.charMeshtasticTx) {
      await gattWrite(session, "meshtastic", new TextEncoder().encode("config=1"));
    }
    const ok = await ensureMeshtasticConfigReady(session, 8000);
    if (!ok) {
      mergeMeshtasticPeersFromLog(session);
    }
    renderMeshtastic(session);
  } catch (e) {
    console.warn("Meshtastic roster refresh failed", session.name, e);
    window.alert("Failed to refresh roster. Check BLE connection.");
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function renderMeshtasticLog(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector<HTMLPreElement>("#meshtastic-line-log");
  if (el) {
    el.textContent = session.meshtasticLineLogText;
    el.scrollTop = el.scrollHeight;
  }
}

function meshtasticSelfLabel(session: BleBoatSession): string {
  if (!hasMeshtastic(session)) {
    return "This device: Meshtastic unavailable";
  }
  if (!session.charMeshtasticStats) {
    return "This device: BLE OK — reflash firmware for 0xFEE7 stats";
  }
  if (session.meshtasticStatsReceivedWallMs === 0 && session.meshtasticStats.nodes.length === 0) {
    return "This device: waiting for companion UART…";
  }
  const stats = session.meshtasticStats;
  if (!stats.config_ok) {
    return "This device: waiting for Meshtastic config…";
  }
  if (stats.my_num !== null) {
    return `This device: node #${stats.my_num}`;
  }
  return "This device: Meshtastic connected";
}

function renderMeshtastic(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const statusEl = document.querySelector("#meshtastic-status");
  const selfEl = document.querySelector("#meshtastic-self");
  const statsEl = document.querySelector("#meshtastic-stats");
  const tbody = document.querySelector("#meshtastic-peers-body");
  const m = session.meshtasticStats;
  const bleReady = hasMeshtastic(session);
  if (statusEl) {
    if (!bleReady) {
      statusEl.textContent = "Meshtastic: not available on this device";
    } else if (!session.charMeshtasticStats) {
      statusEl.textContent = "Meshtastic: BLE partial — missing 0xFEE7 (reflash firmware)";
    } else if (m.config_ok) {
      statusEl.textContent = "Meshtastic: connected (config ready)";
    } else if (session.meshtasticStatsReceivedWallMs > 0) {
      statusEl.textContent = "Meshtastic: connected (loading roster…)";
    } else {
      statusEl.textContent = "Meshtastic: BLE connected (waiting for companion UART)";
    }
  }
  if (selfEl) {
    selfEl.textContent = meshtasticSelfLabel(session);
  }
  if (statsEl) {
    statsEl.textContent = `TX ok: ${m.tx_ok}, fail: ${m.tx_fail}, RX: ${m.rx}, GPS: ${m.gps_rx} (api ${m.gps_api_rx}) · nodes: ${m.nodes.length}`;
  }
  if (!tbody) {
    return;
  }
  tbody.textContent = "";
  for (const n of m.nodes) {
    const tr = document.createElement("tr");
    tr.classList.add("lora-mesh-peer-clickable");
    tr.dataset["mtPeerNum"] = String(n.num);
    tr.title = "Click to send a message";
    const shortLabel = n.short || "—";
    const nameLabel = n.name || `0x${n.num.toString(16).toUpperCase()}`;
    const cells: (string | HTMLElement)[] = [
      shortLabel,
      nameLabel,
      String(n.num),
      formatMeshtasticPosition(n),
      formatMeshtasticSpeed(n),
      formatMeshtasticHeading(n),
      formatAgo(meshtasticAgeMs(session, n.last_ms)),
    ];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement("td");
      const cell = cells[i];
      if (i === 3 && n.lat !== null && n.lon !== null) {
        const link = document.createElement("a");
        link.href = openStreetMapUrl(n.lat, n.lon);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = String(cell);
        td.appendChild(link);
      } else {
        td.textContent = String(cell);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  renderMeshtasticLog(session);
  renderGpsDisplay(session);
}

function syncMeshtasticUiRefresh(session: BleBoatSession | null): void {
  if (meshtasticUiRefreshTimer !== null) {
    clearInterval(meshtasticUiRefreshTimer);
    meshtasticUiRefreshTimer = null;
  }
  if (!session || session.deviceId !== activeSessionId || !hasMeshtastic(session)) {
    return;
  }
  meshtasticUiRefreshTimer = setInterval(() => {
    const active = getActiveSession();
    if (!active || active.deviceId !== activeSessionId) {
      return;
    }
    renderMeshtastic(active);
    renderGpsDisplay(active);
  }, 1000);
}

async function promptAndSendMeshtasticMessage(session: BleBoatSession, destNum: number): Promise<void> {
  if (!session.charMeshtasticTx) {
    return;
  }
  const text = window.prompt(`Message to node ${destNum}:`, "");
  if (text === null) {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed.length > 200) {
    window.alert("Message must be 200 characters or fewer.");
    return;
  }
  if (!(await ensureMeshtasticConfigReady(session))) {
    window.alert("Meshtastic config did not become ready. Check companion UART and try again.");
    return;
  }
  try {
    await gattWrite(session, "meshtastic", encodeMeshtasticSendCmd(String(destNum), trimmed));
    console.info("meshtastic message queued", { destNum, text: trimmed, device: session.name });
    await requestMeshtasticStatsNotify(session);
    renderMeshtastic(session);
  } catch (e) {
    console.warn("BLE Meshtastic message write failed", session.name, e);
    window.alert("Failed to send message. Check BLE connection.");
  }
}

async function sendMeshtasticBroadcast(session: BleBoatSession): Promise<void> {
  if (!session.charMeshtasticTx) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  const text = (input?.value ?? session.meshtasticTxDraft).trim();
  if (!text) {
    return;
  }
  if (text.length > 200) {
    window.alert("Message must be 200 characters or fewer.");
    return;
  }
  const btn = document.querySelector<HTMLButtonElement>("#meshtastic-tx-broadcast");
  if (btn) {
    btn.disabled = true;
  }
  try {
    if (!(await ensureMeshtasticConfigReady(session))) {
      window.alert("Meshtastic config did not become ready. Check companion UART and try again.");
      return;
    }
    await gattWrite(session, "meshtastic", encodeMeshtasticSendCmd("broadcast", text));
    if (input) {
      input.value = "";
    }
    session.meshtasticTxDraft = "";
    await requestMeshtasticStatsNotify(session);
    renderMeshtastic(session);
  } catch (e) {
    console.warn("BLE Meshtastic broadcast failed", session.name, e);
    window.alert("Failed to send broadcast.");
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function clearMeshtasticLog(session: BleBoatSession | null): void {
  if (session) {
    session.meshtasticLineLogText = "";
  }
  const el = document.querySelector("#meshtastic-line-log");
  if (el) {
    el.textContent = "";
  }
}

function renderLoraStats(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const txEl = document.querySelector("#lora-stats-tx");
  if (txEl) {
    const t = session.loraStats.tx;
    txEl.textContent =
      `Stream TX — queued: ${t.queued}, ok: ${t.ok}, timeout: ${t.timeout} · RX bad: ${session.loraStats.rx_bad}`;
  }
  const tbody = document.querySelector("#lora-stats-senders-body");
  if (!tbody) {
    return;
  }
  tbody.textContent = "";
  for (const s of session.loraStats.senders) {
    const tr = document.createElement("tr");
    for (const cell of [s.sig, String(s.first), String(s.last), String(s.missing), String(s.rx)]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function renderLoraStatus(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector("#lora-status");
  if (!el) {
    return;
  }
  const status = session.loraRadioStatus.trim();
  el.textContent = status.length > 0 ? `LoRa radio: ${status}` : "LoRa radio: (no status yet)";
}

function isLoraRxLogLine(trimmed: string): boolean {
  return trimmed.startsWith("RX ");
}

function meshLinePeerId(trimmed: string): number | null {
  const from = trimmed.match(/<< mesh (?:RX|ACK|NACK).* from (\d+)/);
  if (from) {
    return Number(from[1]);
  }
  return null;
}

/** Bump peer "last heard" from mesh line traffic when stats notify is delayed. */
function touchMeshPeerHeard(session: BleBoatSession, peerId: number): void {
  if (!Number.isFinite(peerId) || peerId <= 0) {
    return;
  }
  let peer = session.loraStats.mesh.peers.find((p) => p.id === peerId);
  if (!peer) {
    peer = { id: peerId, type: 0, last_ms: 0 };
    session.loraStats.mesh.peers.push(peer);
    session.loraStats.mesh.peers.sort((a, b) => a.id - b.id);
  } else {
    peer.last_ms = 0;
  }
  session.loraStatsReceivedWallMs = Date.now();
  if (session.deviceId === activeSessionId) {
    renderLoraMesh(session);
  }
}

function ingestLoraLine(session: BleBoatSession, chunk: string): void {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("! STATUS:")) {
      session.loraRadioStatus = trimmed.slice("! STATUS:".length).trim();
      renderLoraStatus(session);
      continue;
    }
    if (
      trimmed.startsWith(">> mesh TX") ||
      trimmed.startsWith("<< mesh RX") ||
      trimmed.startsWith(">> mesh ACK") ||
      trimmed.startsWith("<< mesh ACK") ||
      trimmed.startsWith("<< mesh NACK") ||
      trimmed.startsWith("! mesh TX") ||
      trimmed.startsWith("! mesh CRC")
    ) {
      appendMeshMessageLog(session, trimmed);
      const peerId = meshLinePeerId(trimmed);
      if (peerId !== null) {
        touchMeshPeerHeard(session, peerId);
      }
      continue;
    }
    if (isLoraRxLogLine(trimmed)) {
      appendStreamLine(session, "loraLineLogText", `${trimmed}\n`);
    }
  }
}

/** TX/stream/errors are not shown in the LoRa log (RX packets only). */
function appendLoraLog(_session: BleBoatSession, _chunk: string): void {}

function clearMeshMessageLog(session: BleBoatSession | null): void {
  if (session) {
    session.meshMessageLog = [];
    renderLoraMeshRxLog(session);
  }
}

function clearUwbLog(session: BleBoatSession | null): void {
  if (session) {
    session.uwbLineLogText = "";
  }
  const el = document.querySelector("#uwb-line-log");
  if (el) {
    el.textContent = "";
  }
}

function renderUwbLog(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector("#uwb-line-log");
  if (!el) {
    return;
  }
  el.textContent = session.uwbLineLogText;
  el.scrollTop = el.scrollHeight;
}

function appendUwbLog(session: BleBoatSession, chunk: string): void {
  session.uwbLineLogText += chunk;
  if (session.uwbLineLogText.length > 16000) {
    session.uwbLineLogText = session.uwbLineLogText.slice(-12000);
  }
  renderUwbLog(session);
}

function renderImuDisplay(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  setText("imu-accel", session.imu.accel);
  setText("imu-gyro", session.imu.gyro);
  setText("imu-mag", session.imu.mag);
  setText("imu-temp", session.imu.temp);
  setText("imu-baro", session.imu.baro);
  setText("imu-meta", session.imu.meta);
}

function saveUiToSession(session: BleBoatSession): void {
  const loraInput = document.querySelector<HTMLInputElement>("#lora-tx-input");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  const mtInput = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  session.loraTxDraft = loraInput?.value ?? "";
  session.uwbAtDraft = uwbInput?.value ?? "";
  session.meshtasticTxDraft = mtInput?.value ?? "";
  const boatIdInput = document.querySelector<HTMLInputElement>("#boat-id-input");
  session.boatIdDraft = boatIdInput?.value ?? session.boatIdDraft;
  const typeSelect = document.querySelector<HTMLSelectElement>("#device-type-select");
  const typeParsed = typeSelect ? parseDeviceType(typeSelect.value) : null;
  if (typeParsed) {
    session.deviceTypeDraft = typeParsed;
  }
}

function loadSessionToUi(session: BleBoatSession): void {
  const loraInput = document.querySelector<HTMLInputElement>("#lora-tx-input");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  const mtInput = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  if (loraInput) {
    loraInput.value = session.loraTxDraft;
  }
  if (uwbInput) {
    uwbInput.value = session.uwbAtDraft;
  }
  if (mtInput) {
    mtInput.value = session.meshtasticTxDraft;
  }
  renderImuDisplay(session);
  renderLoraLog(session);
  renderLoraStatus(session);
  renderLoraStats(session);
  renderLoraMesh(session);
  mergeMeshtasticPeersFromLog(session);
  renderMeshtastic(session);
  syncLoraStreamUi(session);
  syncLoraMeshUi(session);
  syncLoraTabView(session);
  renderGpsDisplay(session);
  renderUwbLog(session);
  updateBleToolbar();
  syncActionButtons();
}

function clearUiPanels(): void {
  const imu = defaultImuDisplay();
  setText("imu-accel", imu.accel);
  setText("imu-gyro", imu.gyro);
  setText("imu-mag", imu.mag);
  setText("imu-temp", imu.temp);
  setText("imu-baro", imu.baro);
  setText("imu-meta", imu.meta);
  const loraInput = document.querySelector<HTMLInputElement>("#lora-tx-input");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  if (loraInput) {
    loraInput.value = "";
  }
  if (uwbInput) {
    uwbInput.value = "";
  }
  const loraStatus = document.querySelector("#lora-status");
  const loraLog = document.querySelector("#lora-line-log");
  const uwbLog = document.querySelector("#uwb-line-log");
  if (loraStatus) {
    loraStatus.textContent = "LoRa radio: connect BLE for status";
  }
  if (loraLog) {
    loraLog.textContent = "";
  }
  if (uwbLog) {
    uwbLog.textContent = "";
  }
  const loraStatsTx = document.querySelector("#lora-stats-tx");
  const loraStatsBody = document.querySelector("#lora-stats-senders-body");
  if (loraStatsTx) {
    loraStatsTx.textContent = "Stream TX — queued: 0, ok: 0, timeout: 0 · RX bad: 0";
  }
  if (loraStatsBody) {
    loraStatsBody.textContent = "";
  }
  const meshSelf = document.querySelector("#lora-mesh-self");
  const meshStats = document.querySelector("#lora-mesh-stats");
  const meshPeers = document.querySelector("#lora-mesh-peers-body");
  if (meshSelf) {
    meshSelf.textContent = "This device: mesh off";
  }
  if (meshStats) {
    meshStats.textContent = "Mesh TX ok: 0 · fail: 0 · RX: 0";
  }
  if (meshPeers) {
    meshPeers.textContent = "";
  }
  const meshRxLog = document.querySelector("#lora-mesh-rx-log");
  if (meshRxLog) {
    meshRxLog.textContent = "";
  }
  const mtLog = document.querySelector("#meshtastic-line-log");
  const mtPeers = document.querySelector("#meshtastic-peers-body");
  if (mtLog) {
    mtLog.textContent = "";
  }
  if (mtPeers) {
    mtPeers.textContent = "";
  }
  setText("meshtastic-status", "Meshtastic: connect BLE for status");
  setText("meshtastic-self", "This device: waiting…");
  setText("meshtastic-stats", "TX ok: 0 · fail: 0 · RX: 0");
  syncLoraStreamUi(null);
  syncLoraMeshUi(null);
  syncLoraTabView(null);
  syncLoraTabVisibility(null);
  syncMeshtasticTabVisibility(null);
  syncMeshtasticUiRefresh(null);
  clearGpsDisplay(null);
}

function sessionLabel(session: BleBoatSession): string {
  const offline = session.gatt.connected ? "" : session.parked ? " · parked" : " · offline";
  let duplicateName = false;
  for (const other of sessions.values()) {
    if (other.deviceId !== session.deviceId && other.name === session.name) {
      duplicateName = true;
      break;
    }
  }
  const suffix = duplicateName ? ` · ${session.deviceId.slice(-6)}` : "";
  return `${sessionDisplayName(session)}${suffix}${offline}`;
}

function renderDeviceSelector(): void {
  if (!deviceSelectEl || !deviceDisconnectBtn) {
    return;
  }

  suppressDeviceSelectChange = true;
  deviceSelectEl.replaceChildren();

  if (sessions.size === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No devices connected";
    deviceSelectEl.appendChild(opt);
    deviceSelectEl.disabled = true;
    deviceDisconnectBtn.disabled = true;
  } else {
    deviceSelectEl.disabled = false;
    deviceDisconnectBtn.disabled = activeSessionId === null;
    for (const session of sessions.values()) {
      const opt = document.createElement("option");
      opt.value = session.deviceId;
      opt.textContent = sessionLabel(session);
      deviceSelectEl.appendChild(opt);
    }
    if (activeSessionId) {
      deviceSelectEl.value = activeSessionId;
    }
  }

  suppressDeviceSelectChange = false;
}

async function setActiveSession(deviceId: string): Promise<void> {
  const next = sessions.get(deviceId);
  if (!next) {
    return;
  }
  const prev = getActiveSession();
  if (prev && prev.deviceId !== deviceId) {
    saveUiToSession(prev);
    await deactivateSession(prev);
  }
  activeSessionId = deviceId;
  if (!(await activateSession(next))) {
    updateBleToolbar("could not connect");
    syncActionButtons();
    renderDeviceSelector();
    return;
  }
  loadSessionToUi(next);
  renderDeviceSelector();
  updateBleToolbar();
}

function createNotifyHandlers(session: BleBoatSession): void {
  session.onImuNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength < PKT_MIN_SIZE) {
      return;
    }
    const pkt = parseImuPacket(v);
    if (!pkt) {
      return;
    }
    const now = performance.now();
    const dtMs = session.lastImuWallMs > 0 ? now - session.lastImuWallMs : 0;
    session.lastImuWallMs = now;
    const f = formatImuFields(pkt);
    session.imu = {
      accel: f.accel,
      gyro: f.gyro,
      mag: f.mag,
      temp: f.temp,
      baro: f.baro,
      meta: `${f.meta}${dtMs > 0 ? ` · ${dtMs.toFixed(0)} ms` : ""}`,
    };
    renderImuDisplay(session);
  };

  session.onLoraLineNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    const chunk = new TextDecoder().decode(v);
    ingestLoraLine(session, chunk);
  };

  session.onLoraStatsNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    ingestLoraStatsChunk(session, new TextDecoder().decode(v));
  };

  session.onMeshtasticLineNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    ingestMeshtasticLine(session, new TextDecoder().decode(v));
  };

  session.onMeshtasticStatsNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    ingestMeshtasticStatsChunk(session, new TextDecoder().decode(v));
  };

  session.onUwbLineNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    const s = new TextDecoder().decode(v);
    const gen = session.activeUwbGen;
    if (gen !== 0) {
      appendUwbLineIfNew(session, s, gen);
    } else {
      const line = s.endsWith("\n") ? s : `${s}\n`;
      if (!session.uwbLineLogText.endsWith(line)) {
        appendUwbLog(session, line);
      }
    }
  };

  session.onDisconnected = () => {
    if (session.parked) {
      return;
    }
    removeSession(session.deviceId, false);
  };
}

function teardownSession(session: BleBoatSession): void {
  detachCharacteristicListeners(session);
  if (!session.nativeBle && session.device) {
    session.device.removeEventListener("gattserverdisconnected", session.onDisconnected);
  }
}

function removeSession(deviceId: string, wasManualDisconnect: boolean): void {
  const session = sessions.get(deviceId);
  if (!session) {
    return;
  }
  stopLoraStream(session);
  stopLoraMesh(session);
  if (activeSessionId === deviceId) {
    saveUiToSession(session);
  }
  teardownSession(session);
  sessions.delete(deviceId);

  if (activeSessionId === deviceId) {
    activeSessionId = null;
    const remaining = sessions.values().next().value as BleBoatSession | undefined;
    if (remaining) {
      void setActiveSession(remaining.deviceId);
    } else {
      clearUiPanels();
      updateBleToolbar(wasManualDisconnect ? "disconnected" : "link lost");
      syncActionButtons();
    }
  }

  renderDeviceSelector();
  updateBleToolbar();
}

function parseLoraTtlMs(): number {
  const ttlInput = document.querySelector<HTMLInputElement>("#lora-ttl-input");
  const raw = Number.parseInt(ttlInput?.value ?? "", 10);
  if (!Number.isFinite(raw) || raw < 100) {
    return 30000;
  }
  return Math.min(raw, 600000);
}

function parseLoraIntervalMs(): number {
  const intervalInput = document.querySelector<HTMLInputElement>("#lora-interval-input");
  const raw = Number.parseInt(intervalInput?.value ?? "", 10);
  if (!Number.isFinite(raw) || raw < 500) {
    return 3000;
  }
  return Math.min(raw, 600000);
}

function loraBasePayload(): string {
  const input = document.querySelector<HTMLInputElement>("#lora-tx-input");
  return (input?.value ?? "").trim();
}

function syncLoraStreamUi(session: BleBoatSession | null): void {
  const meshActive = session?.loraStats.mesh.active === true || session?.loraMeshRunning === true;
  const streaming = session?.loraStreamRunning === true;
  const loraSend = document.querySelector<HTMLButtonElement>("#lora-tx-send");
  const loraInput = document.querySelector<HTMLInputElement>("#lora-tx-input");
  const ttlInput = document.querySelector<HTMLInputElement>("#lora-ttl-input");
  const intervalInput = document.querySelector<HTMLInputElement>("#lora-interval-input");
  const startBtn = document.querySelector<HTMLButtonElement>("#lora-stream-start");
  const stopBtn = document.querySelector<HTMLButtonElement>("#lora-stream-stop");
  const statusEl = document.querySelector("#lora-stream-status");

  if (loraSend) {
    loraSend.disabled = !session || streaming || meshActive;
  }
  if (loraInput) {
    loraInput.disabled = !session || streaming || meshActive;
  }
  if (ttlInput) {
    ttlInput.disabled = !session || streaming || meshActive;
  }
  if (intervalInput) {
    intervalInput.disabled = !session || streaming || meshActive;
  }
  if (startBtn) {
    startBtn.disabled = !session || streaming || meshActive;
  }
  if (stopBtn) {
    stopBtn.disabled = !session || !streaming;
  }
  if (statusEl) {
    if (!session) {
      statusEl.textContent = "Stream: connect BLE first";
    } else if (meshActive) {
      statusEl.textContent = "Stream: disabled (mesh mode active)";
    } else if (streaming) {
      statusEl.textContent = `Stream: sending (next #${session.loraStreamSeq})`;
    } else {
      statusEl.textContent = "Stream: stopped";
    }
  }
}

function stopLoraMesh(session: BleBoatSession | null, stopOnDevice = true): void {
  if (!session) {
    return;
  }
  const wasRunning = session.loraMeshRunning || session.loraStats.mesh.active;
  session.loraMeshRunning = false;
  session.meshMessageLog = [];
  if (stopOnDevice && wasRunning) {
    void writeLoraMeshGate(session, false);
  }
  if (session.deviceId === activeSessionId) {
    renderLoraMeshRxLog(session);
    syncLoraMeshUi(session);
    syncLoraStreamUi(session);
  }
}

async function startLoraMesh(): Promise<void> {
  const session = getActiveSession();
  if (!session || session.loraMeshRunning || session.loraStats.mesh.active) {
    return;
  }
  stopLoraStream(session);
  session.loraMeshRunning = true;
  session.loraTabView = "mesh";
  await writeLoraMeshGate(session, true);
  await readLoraStatsFromDevice(session);
  syncLoraMeshUi(session);
  syncLoraStreamUi(session);
  renderLoraMesh(session);
}

function stopLoraMeshActive(): void {
  stopLoraMesh(getActiveSession());
}

function stopLoraStream(session: BleBoatSession | null): void {
  if (!session) {
    return;
  }
  const wasRunning = session.loraStreamRunning;
  session.loraStreamRunning = false;
  if (session.loraStreamTimer !== null) {
    clearTimeout(session.loraStreamTimer);
    session.loraStreamTimer = null;
  }
  if (wasRunning) {
    void writeLoraStreamGate(session, false);
    appendLoraLog(session, ">> stream stopped\n");
  }
  if (session.deviceId === activeSessionId) {
    syncLoraStreamUi(session);
  }
}

async function queueLoraPayload(session: BleBoatSession, payload: string): Promise<boolean> {
  if (!payload) {
    return false;
  }
  if (!session.charLoraTx) {
    await bindSessionCharacteristics(session);
  }
  if (!session.charLoraTx) {
    const msg = "! LoRa TX 0xFEF7 not found on BLE service — reconnect.\n";
    session.loraRadioStatus = "BLE LoRa TX (0xFEF7) not found";
    renderLoraStatus(session);
    appendLoraLog(session, msg);
    return false;
  }
  if (session.loraBusy) {
    return false;
  }
  const ttlMs = parseLoraTtlMs();
  const body = `TTL=${ttlMs}\n${payload}`;
  session.loraBusy = true;
  appendLoraLog(session, `>> queue ttl=${ttlMs} ms: ${payload}\n`);
  try {
    const imuWasOn = await pauseImuForComms(session);
    try {
      await ensureLoraComms(session);
      await gattWrite(session, "lora", new TextEncoder().encode(body));
    } finally {
      await restoreImuAfterComms(session, imuWasOn);
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLoraLog(session, `! Write error: ${msg}\n`);
    return false;
  } finally {
    session.loraBusy = false;
    updateBleToolbar();
  }
}

async function loraStreamStep(session: BleBoatSession): Promise<void> {
  if (!session.loraStreamRunning || activeSessionId !== session.deviceId) {
    return;
  }
  const base = loraBasePayload();
  if (!base) {
    appendLoraLog(session, "! Stream stopped — message text is empty\n");
    stopLoraStream(session);
    return;
  }
  const seq = session.loraStreamSeq;
  session.loraStreamSeq += 1;
  syncLoraStreamUi(session);
  const payload = `${base} #${seq}`;
  await queueLoraPayload(session, payload);
  if (!session.loraStreamRunning) {
    return;
  }
  const delayMs = parseLoraIntervalMs();
  session.loraStreamTimer = setTimeout(() => {
    session.loraStreamTimer = null;
    void loraStreamStep(session);
  }, delayMs);
}

async function startLoraStream(): Promise<void> {
  const session = getActiveSession();
  if (!session || session.loraStreamRunning) {
    return;
  }
  if (session.loraStats.mesh.active || session.loraMeshRunning) {
    return;
  }
  stopLoraMesh(session);
  const base = loraBasePayload();
  if (!base) {
    return;
  }
  session.loraTxDraft = document.querySelector<HTMLInputElement>("#lora-tx-input")?.value ?? "";
  session.loraStreamSeq = 1;
  session.loraStreamRunning = true;
  syncLoraStreamUi(session);
  await writeLoraStreamGate(session, true);
  appendLoraLog(session, `>> stream started (interval ${parseLoraIntervalMs()} ms)\n`);
  await loraStreamStep(session);
}

function stopLoraStreamActive(): void {
  stopLoraStream(getActiveSession());
}

async function sendLoraTx(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    const statusEl = document.querySelector("#lora-status");
    if (statusEl) {
      statusEl.textContent = "LoRa radio: connect a BLE device first";
    }
    return;
  }
  if (session.loraStreamRunning) {
    return;
  }
  if (session.loraStats.mesh.active || session.loraMeshRunning) {
    return;
  }
  const payload = loraBasePayload();
  if (!payload) {
    return;
  }
  session.loraTxDraft = document.querySelector<HTMLInputElement>("#lora-tx-input")?.value ?? "";
  await queueLoraPayload(session, payload);
}

async function sendUwbAt(): Promise<void> {
  const session = getActiveSession();
  if (!session?.charUwbAt) {
    const el = document.querySelector("#uwb-line-log");
    if (el) {
      el.textContent = session
        ? "! UWB characteristic 0xFEFA unavailable.\n"
        : "! Connect a BLE device first.\n";
    }
    return;
  }
  if (session.uwbBusy) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>("#uwb-at-input");
  let cmd = (input?.value ?? "").trim();
  if (!cmd) {
    return;
  }
  session.uwbBusy = true;
  session.uwbAtDraft = input?.value ?? "";
  appendUwbLog(session, `> ${cmd}\n`);
  const baselineLen = session.uwbLineLogText.length;
  const gen = ++session.commsGen;
  session.activeUwbGen = gen;
  try {
    const imuWasOn = await pauseImuForComms(session);
    try {
      await ensureUwbComms(session);
      await gattWrite(session, "uwb", new TextEncoder().encode(cmd));
      const gotReply = await pollUwbResponse(session, gen, baselineLen, 8000);
      if (gen === session.activeUwbGen && !gotReply) {
        appendUwbLog(
          session,
          "! No UWB response — check idf.py monitor for ryuw122 boot log (AT probe, TX/RX GPIO, baud, power).\n",
        );
      }
    } finally {
      await restoreImuAfterComms(session, imuWasOn);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendUwbLog(session, `! BLE write error: ${msg}\n`);
  } finally {
    session.uwbBusy = false;
    if (gen === session.activeUwbGen) {
      session.activeUwbGen = 0;
    }
  }
}

async function setupNativeGattSession(pick: BleDevicePick): Promise<BleBoatSession> {
  const session: BleBoatSession = {
    deviceId: pick.deviceId,
    device: null,
    gatt: { connected: false } as BleGattServerLike,
    nativeBle: true,
    name: pick.name,
    charImu: null,
    charLoraTx: null,
    charLoraLine: null,
    charLoraStats: null,
    charMeshtasticRx: null,
    charMeshtasticTx: null,
    charMeshtasticStats: null,
    charUwbLine: null,
    charUwbAt: null,
    charBoatId: null,
    charDeviceType: null,
    boatId: "",
    boatIdDraft: "",
    deviceType: "boat",
    deviceTypeDraft: "boat",
    loraLineLogText: "",
    loraRadioStatus: "",
    loraStats: defaultLoraStats(),
    loraStatsReceivedWallMs: 0,
    loraStatsNotifyBuf: "",
    uwbLineLogText: "",
    loraTxDraft: "",
    uwbAtDraft: "",
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    notificationsOn: false,
    imuNotificationsOn: false,
    commsGen: 0,
    activeUwbGen: 0,
    loraBusy: false,
    loraStreamRunning: false,
    loraStreamSeq: 1,
    loraStreamTimer: null,
    loraTabView: "normal",
    loraMeshRunning: false,
    meshMessageLog: [],
    meshtasticStats: defaultMeshtasticStats(),
    meshtasticStatsReceivedWallMs: 0,
    meshtasticStatsNotifyBuf: "",
    meshtasticLineLogText: "",
    meshtasticTxDraft: "",
    uwbBusy: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onLoraLineNotify: () => {},
    onLoraStatsNotify: () => {},
    onMeshtasticLineNotify: () => {},
    onMeshtasticStatsNotify: () => {},
    onUwbLineNotify: () => {},
    onDisconnected: () => {},
  };
  createNotifyHandlers(session);
  session.gatt = await connectNativeGatt(pick.deviceId, session.onDisconnected);
  await bindSessionCharacteristics(session);
  return session;
}

async function setupWebGattSession(dev: BluetoothDevice): Promise<BleBoatSession> {
  const gatt = dev.gatt!.connected ? dev.gatt! : await dev.gatt!.connect();
  try {
    const g = gatt as BluetoothRemoteGATTServer & { requestMtu?: (n: number) => Promise<number> };
    if (typeof g.requestMtu === "function") {
      await g.requestMtu(247);
    }
  } catch {
    /* optional */
  }

  const session: BleBoatSession = {
    deviceId: dev.id,
    device: dev,
    gatt: asWebGatt(gatt),
    nativeBle: false,
    name: dev.name ?? "Boat",
    charImu: null,
    charLoraTx: null,
    charLoraLine: null,
    charLoraStats: null,
    charMeshtasticRx: null,
    charMeshtasticTx: null,
    charMeshtasticStats: null,
    charUwbLine: null,
    charUwbAt: null,
    charBoatId: null,
    charDeviceType: null,
    boatId: "",
    boatIdDraft: "",
    deviceType: "boat",
    deviceTypeDraft: "boat",
    loraLineLogText: "",
    loraRadioStatus: "",
    loraStats: defaultLoraStats(),
    loraStatsReceivedWallMs: 0,
    loraStatsNotifyBuf: "",
    uwbLineLogText: "",
    loraTxDraft: "",
    uwbAtDraft: "",
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    notificationsOn: false,
    imuNotificationsOn: false,
    commsGen: 0,
    activeUwbGen: 0,
    loraBusy: false,
    loraStreamRunning: false,
    loraStreamSeq: 1,
    loraStreamTimer: null,
    loraTabView: "normal",
    loraMeshRunning: false,
    meshMessageLog: [],
    meshtasticStats: defaultMeshtasticStats(),
    meshtasticStatsReceivedWallMs: 0,
    meshtasticStatsNotifyBuf: "",
    meshtasticLineLogText: "",
    meshtasticTxDraft: "",
    uwbBusy: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onLoraLineNotify: () => {},
    onLoraStatsNotify: () => {},
    onMeshtasticLineNotify: () => {},
    onMeshtasticStatsNotify: () => {},
    onUwbLineNotify: () => {},
    onDisconnected: () => {},
  };
  createNotifyHandlers(session);

  await bindSessionCharacteristics(session);

  dev.addEventListener("gattserverdisconnected", session.onDisconnected);
  return session;
}

async function connectBle(): Promise<void> {
  if (!isBleAvailable()) {
    updateBleToolbar("Bluetooth unavailable — use Chrome or the native app");
    return;
  }

  connectBtn.disabled = true;
  updateBleToolbar("selecting device…");

  try {
    if (isNativeBle()) {
      await ensureBleInitialized();
      const pick = await requestBleDevice(BLE_OPTIONAL_SERVICES);

      if (sessions.has(pick.deviceId)) {
        await setActiveSession(pick.deviceId);
        updateBleToolbar("switched device");
        return;
      }

      updateBleToolbar("connecting…");

      const activeBeforeConnect = getActiveSession();
      if (activeBeforeConnect) {
        await deactivateSession(activeBeforeConnect);
      }

      const session = await setupNativeGattSession(pick);
      sessions.set(session.deviceId, session);
      await setActiveSession(session.deviceId);
      renderDeviceSelector();
      return;
    }

    if (!navigator.bluetooth) {
      updateBleToolbar("Web Bluetooth unavailable — use Chrome on HTTPS");
      return;
    }

    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: BLE_OPTIONAL_SERVICES,
    });

    if (sessions.has(dev.id)) {
      await setActiveSession(dev.id);
      updateBleToolbar("switched device");
      return;
    }

    updateBleToolbar("connecting…");

    const activeBeforeConnect = getActiveSession();
    if (activeBeforeConnect) {
      await deactivateSession(activeBeforeConnect);
    }

    const session = await setupWebGattSession(dev);
    sessions.set(session.deviceId, session);
    await setActiveSession(session.deviceId);
    renderDeviceSelector();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("cancel") || msg.includes("Cancel")) {
      updateBleToolbar();
    } else {
      updateBleToolbar(msg);
      console.error("BLE connect failed", e);
    }
  } finally {
    connectBtn.disabled = false;
  }
}

async function disconnectSession(deviceId: string): Promise<void> {
  const session = sessions.get(deviceId);
  if (!session) {
    return;
  }
  await setSessionNotifications(session, false);
  try {
    if (session.gatt.connected) {
      await session.gatt.disconnect();
    }
  } catch {
    /* ignore */
  }
  removeSession(deviceId, true);
}

export function startRegattaApp(): void {
  if (regattaAppStarted) {
    return;
  }
  regattaAppStarted = true;

  document.body.dataset["appScreen"] = "boat";
  document.body.dataset["appTab"] = "main";

  connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
  bleStatusEl = document.querySelector("#ble-status");
  deviceSelectEl = document.querySelector<HTMLSelectElement>("#ble-device-select");
  deviceDisconnectBtn = document.querySelector<HTMLButtonElement>("#ble-device-disconnect");

  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const peerRow = target?.closest<HTMLTableRowElement>("tr.lora-mesh-peer-clickable");
    if (peerRow?.dataset["meshPeerId"]) {
      const session = getActiveSession();
      const destId = Number(peerRow.dataset["meshPeerId"]);
      if (session && Number.isFinite(destId)) {
        void promptAndSendMeshMessage(session, destId);
      }
      return;
    }
    const mtPeerRow = target?.closest<HTMLTableRowElement>("tr[data-mt-peer-num]");
    if (mtPeerRow?.dataset["mtPeerNum"]) {
      const session = getActiveSession();
      const destNum = Number(mtPeerRow.dataset["mtPeerNum"]);
      if (session && Number.isFinite(destNum)) {
        void promptAndSendMeshtasticMessage(session, destNum);
      }
      return;
    }
    const btn = target?.closest("button");
    if (!btn) {
      return;
    }
    if (btn.id === "lora-tx-send") {
      void sendLoraTx();
      return;
    }
    if (btn.id === "lora-stream-start") {
      void startLoraStream();
      return;
    }
    if (btn.id === "lora-stream-stop") {
      stopLoraStreamActive();
      return;
    }
    if (btn.id === "lora-view-mesh") {
      const session = getActiveSession();
      if (session) {
        session.loraTabView = "mesh";
        syncLoraTabView(session);
        renderLoraMesh(session);
      }
      return;
    }
    if (btn.id === "lora-view-normal") {
      const session = getActiveSession();
      if (session) {
        session.loraTabView = "normal";
        syncLoraTabView(session);
      }
      return;
    }
    if (btn.id === "lora-mesh-start") {
      void startLoraMesh();
      return;
    }
    if (btn.id === "lora-mesh-stop") {
      stopLoraMeshActive();
      return;
    }
    if (btn.id === "lora-mesh-log-clear") {
      clearMeshMessageLog(getActiveSession());
      return;
    }
    if (btn.id === "uwb-at-send") {
      void sendUwbAt();
      return;
    }
    if (btn.id === "uwb-log-clear") {
      clearUwbLog(getActiveSession());
      return;
    }
    if (btn.id === "lora-log-clear") {
      clearLoraLog(getActiveSession());
      return;
    }
    if (btn.id === "meshtastic-roster-refresh") {
      const session = getActiveSession();
      if (session) {
        void refreshMeshtasticRoster(session);
      }
      return;
    }
    if (btn.id === "meshtastic-tx-broadcast") {
      const session = getActiveSession();
      if (session) {
        void sendMeshtasticBroadcast(session);
      }
      return;
    }
    if (btn.id === "meshtastic-log-clear") {
      clearMeshtasticLog(getActiveSession());
      return;
    }
    if (btn.id === "device-type-save") {
      void saveDeviceTypeToDevice();
      return;
    }
    if (btn.id === "boat-id-save") {
      void saveBoatIdToDevice();
      return;
    }
    if (btn.id === "gps-map-recenter") {
      recenterGpsLeafletMap();
      return;
    }
    if (btn.id === "gps-map-style-street") {
      setGpsLeafletMapStyle("street");
      return;
    }
    if (btn.id === "gps-map-style-satellite") {
      setGpsLeafletMapStyle("satellite");
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (!(ev instanceof KeyboardEvent) || ev.key !== "Enter") {
      return;
    }
    const target = ev.target;
    if (target instanceof HTMLInputElement && target.id === "uwb-at-input") {
      void sendUwbAt();
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "lora-tx-input") {
      void sendLoraTx();
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "meshtastic-tx-input") {
      const session = getActiveSession();
      if (session) {
        void sendMeshtasticBroadcast(session);
      }
    }
  });
  document.addEventListener("input", (ev) => {
    const session = getActiveSession();
    if (!session) {
      return;
    }
    const target = ev.target;
    if (target instanceof HTMLInputElement && target.id === "lora-tx-input") {
      session.loraTxDraft = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "meshtastic-tx-input") {
      session.meshtasticTxDraft = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "uwb-at-input") {
      session.uwbAtDraft = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "boat-id-input") {
      session.boatIdDraft = target.value;
    }
  });


  deviceSelectEl?.addEventListener("change", () => {
    if (suppressDeviceSelectChange || !deviceSelectEl) {
      return;
    }
    const id = deviceSelectEl.value;
    if (id && id !== activeSessionId) {
      void setActiveSession(id);
    }
  });
  deviceDisconnectBtn?.addEventListener("click", () => {
    if (activeSessionId) {
      void disconnectSession(activeSessionId);
    }
  });

  document.querySelector<HTMLSelectElement>("#device-type-select")?.addEventListener("change", (ev) => {
    const session = getActiveSession();
    if (session && ev.target instanceof HTMLSelectElement) {
      const type = parseDeviceType(ev.target.value);
      if (type) {
        session.deviceTypeDraft = type;
      }
    }
  });

  connectBtn.addEventListener("click", () => void connectBle());

  initGpsLeafletMapStyle();

  document.querySelector("#ble-tabs")?.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement | null)?.closest(".ant-tabs-tab");
    if (!tab) {
      return;
    }
    const label = tab.textContent ?? "";
    const wantImu = label.includes("IMU");
    if (label.includes("GPS")) {
      requestAnimationFrame(() => invalidateGpsLeafletMapSize());
      const session = getActiveSession();
      if (session?.gatt.connected && session.charMeshtasticStats) {
        void syncMeshtasticStatsFromDevice(session, session.meshtasticStatsReceivedWallMs, 8000).then(() =>
          renderGpsDisplay(session),
        );
      }
    }
    if (wantImu === imuTabActive) {
      return;
    }
    imuTabActive = wantImu;
    const session = getActiveSession();
    if (!session?.gatt.connected) {
      return;
    }
    void setImuNotifications(session, imuTabActive);
  });

  console.info(`RegattaOne Boat web BLE ${WEB_BLE_REV}`);
  if (isNativeBle()) {
    void ensureBleInitialized().catch((e) => {
      console.error("Native BLE init failed", e);
      updateBleToolbar("Bluetooth unavailable — enable in Settings");
    });
  }
  clearUiPanels();
  syncBoatIdUi(null);
  syncDeviceTypeUi(null);
  renderDeviceSelector();
  updateBleToolbar();
  syncActionButtons();
}
