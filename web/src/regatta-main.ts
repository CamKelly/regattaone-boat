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
  applyNmeaLine,
  defaultGpsFix,
  fixQualityLabel,
  fixTypeLabel,
  formatAltitudeM,
  formatCoordDeg,
  formatCourseDeg,
  formatPpsCount,
  formatPpsIntervalUs,
  formatSpeedKnots,
  formatUtc,
  openStreetMapUrl,
  type GpsFix,
} from "./lib/nmea-parse";
import {
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_DWM3000_CONFIG_CHAR_UUID,
  BLE_DWM3000_RANGE_CHAR_UUID,
  BLE_GPS_LINE_CHAR_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_MESHTASTIC_RX_CHAR_UUID,
  BLE_MESHTASTIC_STATS_CHAR_UUID,
  BLE_MESHTASTIC_TX_CHAR_UUID,
  BLE_SERVICE_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
  BOAT_ID_MAX_LEN,
  BOAT_ID_BLE_NAME_MAX_LEN,
  DWM3000_DEFAULTS,
  type DeviceType,
  type Dwm3000Config,
  type UwbRole,
  deviceTypeHasAnchor,
  deviceTypeHasTag,
  deviceTypeLabel,
  encodeUwbAtWrite,
  formatDwm3000ConfigJson,
  parseDeviceType,
  parseDwm3000ConfigJson,
  parseDwm3000RangeJson,
  parseUwbNotifyLine,
  uwbWriteNeedsRolePrefix,
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
const WEB_BLE_REV = "2026-06-25b";

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


function hasMeshtastic(session: BleBoatSession | null): boolean {
  return session?.charMeshtasticRx != null;
}


function hasDwm3000(session: BleBoatSession | null): boolean {
  return session?.charDwm3000Config != null;
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
  BLE_DWM3000_CONFIG_CHAR_UUID,
  BLE_DWM3000_RANGE_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_GPS_LINE_CHAR_UUID,
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
  charMeshtasticRx: BleGattCharacteristicLike | null;
  charMeshtasticTx: BleGattCharacteristicLike | null;
  charMeshtasticStats: BleGattCharacteristicLike | null;
  charUwbLine: BleGattCharacteristicLike | null;
  charUwbAt: BleGattCharacteristicLike | null;
  charBoatId: BleGattCharacteristicLike | null;
  charDeviceType: BleGattCharacteristicLike | null;
  charDwm3000Config: BleGattCharacteristicLike | null;
  charDwm3000Range: BleGattCharacteristicLike | null;
  charGpsLine: BleGattCharacteristicLike | null;
  boatId: string;
  boatIdDraft: string;
  deviceType: DeviceType;
  deviceTypeDraft: DeviceType;
  dwm3000Config: Dwm3000Config;
  dwm3000ConfigDraft: Dwm3000Config;
  dwm3000PeerDraft: string;
  uwbAnchorLineLogText: string;
  uwbTagLineLogText: string;
  uwbAnchorAtDraft: string;
  uwbTagAtDraft: string;
  activeUwbRole: UwbRole | null;
  lastImuWallMs: number;
  imu: ImuDisplay;
  notificationsOn: boolean;
  imuNotificationsOn: boolean;
  /** Incremented per UWB request to ignore stale notify/read data. */
  commsGen: number;
  activeUwbGen: number;
  meshtasticStats: MeshtasticStatsSnapshot;
  meshtasticStatsReceivedWallMs: number;
  meshtasticStatsNotifyBuf: string;
  meshtasticLineLogText: string;
  meshtasticTxDraft: string;
  gpsFix: GpsFix;
  uwbBusy: boolean;
  /** True when GATT was intentionally disconnected to park this device in the list. */
  parked: boolean;
  gattChain: Promise<void>;
  onImuNotify: (ev: Event) => void;
  onMeshtasticLineNotify: (ev: Event) => void;
  onMeshtasticStatsNotify: (ev: Event) => void;
  onGpsLineNotify: (ev: Event) => void;
  onUwbLineNotify: (ev: Event) => void;
  onDisconnected: () => void;
}

const MESHTASTIC_GPS_SOURCE_SHORT = "1HX";

const sessions = new Map<string, BleBoatSession>();
let activeSessionId: string | null = null;
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
      syncUwbUi(session);
    }
  } catch (e) {
    console.warn("BLE device type read failed", session.name, e);
  }
}

async function saveDeviceTypeToDevice(): Promise<void> {
  const session = getActiveSession();
  const statusEl = document.querySelector("#device-type-status");
  const dwmStatusEl = document.querySelector("#dwm3000-device-type-status");
  if (!session?.charDeviceType) {
    const msg = "Device type requires firmware with characteristic 0xFEFC.";
    if (statusEl) {
      statusEl.textContent = msg;
    }
    if (dwmStatusEl) {
      dwmStatusEl.textContent = msg;
    }
    return;
  }
  const type = session.deviceTypeDraft;
  try {
    await gattWrite(session, "type", new TextEncoder().encode(type));
    session.deviceType = type;
    syncUwbUi(session);
    syncDeviceTypeUi(session);
    const saved = `Saved: ${deviceTypeLabel(type)}`;
    if (statusEl) {
      statusEl.textContent = saved;
    }
    if (dwmStatusEl) {
      dwmStatusEl.textContent = saved;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = `Save failed: ${msg}`;
    if (statusEl) {
      statusEl.textContent = err;
    }
    if (dwmStatusEl) {
      dwmStatusEl.textContent = err;
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
  const selects = [
    document.querySelector<HTMLSelectElement>("#device-type-select"),
    document.querySelector<HTMLSelectElement>("#dwm3000-device-type-select"),
  ];
  const saveBtn = document.querySelector<HTMLButtonElement>("#device-type-save");
  const dwmSaveBtn = document.querySelector<HTMLButtonElement>("#dwm3000-device-type-save");
  const statusEl = document.querySelector("#device-type-status");
  const dwmStatusEl = document.querySelector("#dwm3000-device-type-status");
  const canEdit = session !== null && session.gatt.connected && session.charDeviceType !== null;
  for (const select of selects) {
    if (select) {
      setFieldEnabled(select, canEdit);
      select.value = session?.deviceTypeDraft ?? "boat";
    }
  }
  setFieldEnabled(saveBtn, canEdit);
  setFieldEnabled(dwmSaveBtn, canEdit);
  const statusText = !session
    ? "Connect a device to set its type."
    : !session.charDeviceType
      ? "Flash firmware with device type support (0xFEFC) to enable."
      : !session.gatt.connected
        ? `Stored on device: ${deviceTypeLabel(session.deviceType)}. Reconnect to edit.`
        : `Stored on device: ${deviceTypeLabel(session.deviceType)}`;
  if (statusEl) {
    statusEl.textContent = statusText;
  }
  if (dwmStatusEl) {
    dwmStatusEl.textContent = statusText;
  }
}

function defaultDwm3000Config(): Dwm3000Config {
  return { ...DWM3000_DEFAULTS };
}

function formatHexU16(n: number): string {
  return `0x${n.toString(16).padStart(4, "0").toUpperCase()}`;
}

function parseHexU16(raw: string, allowZero = false): number | null {
  const s = raw.trim();
  if (!s) {
    return null;
  }
  const hex = s.startsWith("0x") || s.startsWith("0X");
  const v = Number.parseInt(hex ? s.slice(2) : s, hex ? 16 : 10);
  if (!Number.isFinite(v) || v < 0 || v >= 0xffff) {
    return null;
  }
  if (!allowZero && v === 0) {
    return null;
  }
  return v;
}

function dwm3000ConfigFromDraft(): Dwm3000Config | null {
  const addrRaw = document.querySelector<HTMLInputElement>("#dwm3000-addr-input")?.value ?? "";
  const panRaw = document.querySelector<HTMLInputElement>("#dwm3000-pan-input")?.value ?? "";
  const antRaw = document.querySelector<HTMLInputElement>("#dwm3000-ant-input")?.value ?? "";
  const twrRaw = document.querySelector<HTMLInputElement>("#dwm3000-twr-input")?.value ?? "";
  const addr = parseHexU16(addrRaw);
  const pan = parseHexU16(panRaw, true);
  const ant = Number.parseInt(antRaw.trim(), 10);
  const twr = Number.parseInt(twrRaw.trim(), 10);
  if (addr == null || pan == null || !Number.isFinite(ant) || !Number.isFinite(twr)) {
    return null;
  }
  if (ant < 0 || ant > 65535 || twr < 300 || twr > 20000) {
    return null;
  }
  return { addr, pan, ant, twr };
}

async function readDwm3000ConfigFromDevice(session: BleBoatSession): Promise<void> {
  if (!session.charDwm3000Config || !session.gatt.connected) {
    return;
  }
  try {
    const val = await session.charDwm3000Config.readValue();
    const raw = new TextDecoder().decode(val).replace(/\0/g, "").trim();
    const cfg = parseDwm3000ConfigJson(raw);
    if (cfg) {
      session.dwm3000Config = cfg;
      session.dwm3000ConfigDraft = { ...cfg };
    }
  } catch (e) {
    console.warn("BLE DWM3000 config read failed", session.name, e);
  }
}

async function saveDwm3000ConfigToDevice(): Promise<void> {
  const session = getActiveSession();
  const statusEl = document.querySelector("#dwm3000-config-status");
  if (!session?.charDwm3000Config) {
    if (statusEl) {
      statusEl.textContent = "DWM3000 settings require firmware with characteristic 0xFEF2.";
    }
    return;
  }
  if (!session.gatt.connected) {
    if (statusEl) {
      statusEl.textContent = "Device not connected — reconnect before saving.";
    }
    return;
  }
  const cfg = dwm3000ConfigFromDraft();
  if (!cfg) {
    if (statusEl) {
      statusEl.textContent = "Check address (hex), PAN (hex), antenna delay, and TWR delay.";
    }
    return;
  }
  try {
    await gattWrite(session, "dwm3000cfg", new TextEncoder().encode(formatDwm3000ConfigJson(cfg)));
    session.dwm3000Config = cfg;
    session.dwm3000ConfigDraft = { ...cfg };
    syncDwm3000Ui(session);
    if (statusEl) {
      statusEl.textContent =
        `Saved: addr ${formatHexU16(cfg.addr)}, PAN ${formatHexU16(cfg.pan)}, ant ${cfg.ant}, twr ${cfg.twr} µs`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) {
      statusEl.textContent = `Save failed: ${msg}`;
    }
  }
}

async function measureDwm3000Range(): Promise<void> {
  const session = getActiveSession();
  const statusEl = document.querySelector("#dwm3000-range-status");
  const btn = document.querySelector<HTMLButtonElement>("#dwm3000-range-btn");
  if (!session?.charDwm3000Range) {
    if (statusEl) {
      statusEl.textContent = "Ranging requires firmware with characteristic 0xFEF3.";
    }
    return;
  }
  const peer = parseHexU16(session.dwm3000PeerDraft);
  if (peer == null) {
    if (statusEl) {
      statusEl.textContent = "Enter a valid peer UWB address (e.g. 0x0002).";
    }
    return;
  }
  setFieldEnabled(btn, false);
  if (statusEl) {
    statusEl.textContent = `Ranging to ${formatHexU16(peer)}…`;
  }
  try {
    await gattWrite(session, "dwm3000range", new TextEncoder().encode(`range=${peer}`));
    const val = await runGattOp(session, () => session.charDwm3000Range!.readValue());
    const raw = new TextDecoder().decode(val).replace(/\0/g, "").trim();
    const result = parseDwm3000RangeJson(raw);
    if (!result) {
      if (statusEl) {
        statusEl.textContent = "Unexpected range response from device.";
      }
      return;
    }
    if (result.ok && result.dist_cm != null) {
      const m = (result.dist_cm / 100).toFixed(2);
      if (statusEl) {
        statusEl.textContent = `Distance to ${formatHexU16(result.peer)}: ${result.dist_cm} cm (${m} m)`;
      }
    } else {
      if (statusEl) {
        statusEl.textContent = `Range to ${formatHexU16(result.peer)} failed${result.err ? `: ${result.err}` : ""}`;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) {
      statusEl.textContent = `Range failed: ${msg}`;
    }
  } finally {
    syncDwm3000Ui(session);
  }
}

function syncDwm3000TabVisibility(session: BleBoatSession | null): void {
  const tab = document.querySelector<HTMLElement>("#dwm3000-tab");
  if (tab) {
    tab.hidden = !hasDwm3000(session);
  }
}

function syncDwm3000Ui(session: BleBoatSession | null): void {
  const addrInput = document.querySelector<HTMLInputElement>("#dwm3000-addr-input");
  const panInput = document.querySelector<HTMLInputElement>("#dwm3000-pan-input");
  const antInput = document.querySelector<HTMLInputElement>("#dwm3000-ant-input");
  const twrInput = document.querySelector<HTMLInputElement>("#dwm3000-twr-input");
  const peerInput = document.querySelector<HTMLInputElement>("#dwm3000-peer-input");
  const saveBtn = document.querySelector<HTMLButtonElement>("#dwm3000-config-save");
  const rangeBtn = document.querySelector<HTMLButtonElement>("#dwm3000-range-btn");
  const statusEl = document.querySelector("#dwm3000-config-status");
  const canEdit = session !== null && session.gatt.connected && session.charDwm3000Config !== null;
  const canRange = session !== null && session.gatt.connected && session.charDwm3000Range !== null;
  const cfg = session?.dwm3000ConfigDraft ?? defaultDwm3000Config();
  if (addrInput && document.activeElement !== addrInput) {
    addrInput.value = formatHexU16(cfg.addr);
  }
  if (panInput && document.activeElement !== panInput) {
    panInput.value = formatHexU16(cfg.pan);
  }
  if (antInput && document.activeElement !== antInput) {
    antInput.value = String(cfg.ant);
  }
  if (twrInput && document.activeElement !== twrInput) {
    twrInput.value = String(cfg.twr);
  }
  if (peerInput && document.activeElement !== peerInput) {
    peerInput.value = session?.dwm3000PeerDraft ?? "";
  }
  setFieldEnabled(addrInput, canEdit);
  setFieldEnabled(panInput, canEdit);
  setFieldEnabled(antInput, canEdit);
  setFieldEnabled(twrInput, canEdit);
  setFieldEnabled(saveBtn, canEdit);
  setFieldEnabled(peerInput, canRange);
  setFieldEnabled(rangeBtn, canRange && !session?.uwbBusy);
  if (statusEl) {
    if (!session) {
      statusEl.textContent = "Connect a DWM3000 device to edit settings.";
    } else if (!session.charDwm3000Config) {
      statusEl.textContent = "Flash firmware with DWM3000 ranging (0xFEF2) to enable.";
    } else if (!session.gatt.connected) {
      statusEl.textContent = `Stored: addr ${formatHexU16(session.dwm3000Config.addr)}. Reconnect to edit.`;
    } else {
      statusEl.textContent =
        `Stored: addr ${formatHexU16(session.dwm3000Config.addr)}, PAN ${formatHexU16(session.dwm3000Config.pan)}`;
    }
  }
  syncDwm3000TabVisibility(session);
  syncDeviceTypeUi(session);
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
  if (!active.charMeshtasticRx) {
    missing.push("Meshtastic");
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
  for (const id of ["uwb-at-send-anchor", "uwb-at-send-tag"] as const) {
    const btn = document.querySelector<HTMLButtonElement>(`#${id}`);
    if (btn) {
      btn.disabled = !session || session.uwbBusy;
    }
  }
  for (const id of ["uwb-at-input-anchor", "uwb-at-input-tag"] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (input) {
      input.disabled = !session || session.uwbBusy;
    }
  }
  syncBoatIdUi(session);
  syncDeviceTypeUi(session);
  syncDwm3000Ui(session);
  syncUwbUi(session);
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
  session.charMeshtasticRx?.removeEventListener("characteristicvaluechanged", session.onMeshtasticLineNotify);
  session.charMeshtasticStats?.removeEventListener("characteristicvaluechanged", session.onMeshtasticStatsNotify);
  session.charGpsLine?.removeEventListener("characteristicvaluechanged", session.onGpsLineNotify);
  session.charUwbLine?.removeEventListener("characteristicvaluechanged", session.onUwbLineNotify);
}

async function bindSessionCharacteristics(session: BleBoatSession): Promise<void> {
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charMeshtasticRx = null;
  session.charMeshtasticTx = null;
  session.charMeshtasticStats = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
  session.charDeviceType = null;
  session.charDwm3000Config = null;
  session.charDwm3000Range = null;
  session.charGpsLine = null;
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
  try {
    session.charDwm3000Config = await svc.getCharacteristic(BLE_DWM3000_CONFIG_CHAR_UUID);
  } catch {
    session.charDwm3000Config = null;
  }
  try {
    session.charDwm3000Range = await svc.getCharacteristic(BLE_DWM3000_RANGE_CHAR_UUID);
  } catch {
    session.charDwm3000Range = null;
  }
  try {
    session.charGpsLine = await svc.getCharacteristic(BLE_GPS_LINE_CHAR_UUID);
    session.charGpsLine.addEventListener("characteristicvaluechanged", session.onGpsLineNotify);
  } catch {
    session.charGpsLine = null;
  }

  markMeshtasticBleReady(session);
  syncMeshtasticTabVisibility(session);
  syncDwm3000TabVisibility(session);
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

  if (session.charGpsLine) {
    renderGpsDisplayFromNmea(session);
    return;
  }

  renderGpsDisplayFromMeshtastic(session);
}

function renderGpsPpsFields(fix: GpsFix): void {
  const ppsAgeMs =
    fix.ppsUpdatedAtMs > 0 ? Math.max(0, performance.now() - fix.ppsUpdatedAtMs) : Number.POSITIVE_INFINITY;
  setText("gps-pps-count", formatPpsCount(fix.ppsCount));
  setText("gps-pps-last", fix.ppsUpdatedAtMs > 0 ? formatAgo(ppsAgeMs) : "—");
  setText("gps-pps-interval", formatPpsIntervalUs(fix.ppsCapDeltaUs));
}

function renderGpsDisplayFromNmea(session: BleBoatSession): void {
  const fix = session.gpsFix;
  const hasNmea = fix.updatedAtMs > 0;
  const hasPps = fix.ppsUpdatedAtMs > 0;
  const ageMs =
    fix.updatedAtMs > 0 ? Math.max(0, performance.now() - fix.updatedAtMs) : Number.POSITIVE_INFINITY;

  if (!hasNmea && !hasPps) {
    clearGpsDisplay(null);
    setText("gps-meta", "Waiting for NMEA from GPS UART (0xFEFD)…");
    setText("gps-source", "GPS UART");
    return;
  }

  if (!hasNmea && hasPps) {
    const ppsAgeMs = Math.max(0, performance.now() - fix.ppsUpdatedAtMs);
    setText("gps-meta", `GPS UART · PPS active · ${formatAgo(ppsAgeMs)} · waiting for NMEA…`);
    setText("gps-source", "GPS UART · PPS");
    for (const id of [
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
    updateGpsMap(null, null);
    renderGpsPpsFields(fix);
    return;
  }

  const hasCoords = fix.lat !== null && fix.lon !== null;
  const fixLabel = fixQualityLabel(fix.fixQuality);
  const fixNote = hasCoords
    ? fix.fixValid
      ? "Fix OK"
      : "Coordinates received · fix not valid"
    : fix.fixQuality !== null && fix.fixQuality > 0
      ? "Searching · no coordinates yet"
      : `No fix · ${fixLabel}`;

  const ppsNote = hasPps ? " · PPS OK" : "";
  setText(
    "gps-meta",
    `GPS UART · ${fixNote} · ${formatAgo(ageMs)}${fix.lastSentence ? ` · ${fix.lastSentence}` : ""}${ppsNote}`,
  );
  setText("gps-source", "GPS UART · NMEA");

  if (hasCoords) {
    setText(
      "gps-position",
      `${formatCoordDeg(fix.lat, true)}\n${formatCoordDeg(fix.lon, false)}`,
    );
    updateGpsMap(fix.lat, fix.lon);
  } else {
    setText("gps-position", "—");
    updateGpsMap(null, null);
  }

  setText("gps-last-heard", formatAgo(ageMs));
  setText("gps-fix", fixLabel);
  setText("gps-fix-type", fixTypeLabel(fix.fixType));
  setText(
    "gps-sats",
    fix.satsInView !== null
      ? String(fix.satsInView)
      : fix.satsUsed !== null
        ? String(fix.satsUsed)
        : "—",
  );
  setText("gps-seq", "—");
  setText("gps-utc", formatUtc(fix.utcTime, fix.utcDate));
  setText("gps-sog", formatSpeedKnots(fix.sogKnots));
  setText("gps-cog", formatCourseDeg(fix.cogDeg));
  setText("gps-altitude", formatAltitudeM(fix.altitudeM, fix.geoidSepM));
  renderGpsPpsFields(fix);
}

function renderGpsDisplayFromMeshtastic(session: BleBoatSession): void {
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
    for (const id of ["gps-position", "gps-last-heard", "gps-fix", "gps-fix-type", "gps-sats", "gps-seq", "gps-utc", "gps-sog", "gps-cog", "gps-altitude", "gps-pps-count", "gps-pps-last", "gps-pps-interval"]) {
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

function ingestGpsLine(session: BleBoatSession, chunk: string): void {
  if (!chunk) {
    return;
  }
  const parts = chunk.split("\n");
  for (const part of parts) {
    const line = part.trim();
    if (!line) {
      continue;
    }
    session.gpsFix = applyNmeaLine(session.gpsFix, line);
  }
  renderGpsDisplay(session);
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
  setText("gps-meta", "Waiting for NMEA from GPS UART…");
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
    "gps-pps-count",
    "gps-pps-last",
    "gps-pps-interval",
  ]) {
    setText(id, "—");
  }
}

function appendStreamLine(session: BleBoatSession, chunk: string): void {
  if (chunk.length === 0) {
    return;
  }
  const line = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  const current = session.meshtasticLineLogText;
  if (current.endsWith(line)) {
    return;
  }
  session.meshtasticLineLogText += line;
  if (session.meshtasticLineLogText.length > 64000) {
    session.meshtasticLineLogText = session.meshtasticLineLogText.slice(-48000);
  }
  renderMeshtasticLog(session);
}


function uwbLogText(session: BleBoatSession, role: UwbRole): string {
  return role === "anchor" ? session.uwbAnchorLineLogText : session.uwbTagLineLogText;
}

function setUwbLogText(session: BleBoatSession, role: UwbRole, text: string): void {
  if (role === "anchor") {
    session.uwbAnchorLineLogText = text;
  } else {
    session.uwbTagLineLogText = text;
  }
}

function defaultUwbRoleForType(type: DeviceType): UwbRole {
  return deviceTypeHasAnchor(type) && !deviceTypeHasTag(type) ? "anchor" : "tag";
}

function syncUwbUi(session: BleBoatSession | null): void {
  const type = session?.deviceTypeDraft ?? session?.deviceType ?? "boat";
  const showAnchor = deviceTypeHasAnchor(type);
  const showTag = deviceTypeHasTag(type);
  const anchorPanel = document.querySelector<HTMLElement>("#uwb-panel-anchor");
  const tagPanel = document.querySelector<HTMLElement>("#uwb-panel-tag");
  const hint = document.querySelector("#uwb-routing-hint");
  if (anchorPanel) {
    anchorPanel.hidden = !showAnchor;
  }
  if (tagPanel) {
    tagPanel.hidden = !showTag;
  }
  if (hint) {
    hint.textContent = session
      ? `RYUW122 routing for ${deviceTypeLabel(type)} · UART A = anchor role, UART B = tag role`
      : "Connect a device — RYUW122 UART panels follow device type anchor/tag roles.";
  }
}

function renderUwbLogRole(session: BleBoatSession, role: UwbRole): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector(`#uwb-line-log-${role}`);
  if (!el) {
    return;
  }
  el.textContent = uwbLogText(session, role);
  el.scrollTop = el.scrollHeight;
}

function appendUwbLogRole(session: BleBoatSession, role: UwbRole, chunk: string): void {
  const field = role === "anchor" ? "uwbAnchorLineLogText" : "uwbTagLineLogText";
  session[field] += chunk;
  if (session[field].length > 16000) {
    session[field] = session[field].slice(-12000);
  }
  renderUwbLogRole(session, role);
}

function ingestUwbUartChunk(session: BleBoatSession, chunk: string, gen: number): void {
  if (gen !== 0 && gen !== session.activeUwbGen) {
    return;
  }
  const line = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  const parsed = parseUwbNotifyLine(line.trimEnd());
  const role = parsed?.role ?? defaultUwbRoleForType(session.deviceTypeDraft);
  const body = parsed?.line ?? line;
  const display = body.endsWith("\n") ? body : `${body}\n`;
  const current = uwbLogText(session, role);
  if (current.endsWith(display)) {
    return;
  }
  appendUwbLogRole(session, role, display);
}

function appendUwbLineIfNew(session: BleBoatSession, chunk: string, gen: number): void {
  ingestUwbUartChunk(session, chunk, gen);
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
    await setCommsNotifications(session, true);
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
    await readDwm3000ConfigFromDevice(session);
    syncBoatIdUi(session);
    syncDeviceTypeUi(session);
    syncDwm3000Ui(session);
    return session.gatt.connected;
  } catch (e) {
    console.error("BLE activate failed", session.name, e);
    session.notificationsOn = false;
    session.imuNotificationsOn = false;
    return false;
  }
}

async function deactivateSession(session: BleBoatSession): Promise<void> {
  session.parked = true;
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charMeshtasticRx = null;
  session.charMeshtasticTx = null;
  session.charMeshtasticStats = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
  session.charDeviceType = null;
  session.charDwm3000Config = null;
  session.charDwm3000Range = null;
  session.charGpsLine = null;
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

async function pollUwbResponse(
  session: BleBoatSession,
  gen: number,
  role: UwbRole,
  baselineLen: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let nextReadAt = 0;
  while (performance.now() < deadline) {
    if (gen !== session.activeUwbGen) {
      return false;
    }
    if (uwbLogText(session, role).length > baselineLen) {
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
          if (uwbLogText(session, role).length > baselineLen) {
            return true;
          }
        }
      } catch {
        /* optional */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return uwbLogText(session, role).length > baselineLen;
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
    session.charMeshtasticRx,
    session.charMeshtasticStats,
    session.charGpsLine,
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

type GattWriteTarget = "uwb" | "boatid" | "type" | "meshtastic" | "mtstats" | "dwm3000cfg" | "dwm3000range";

function getWriteCharacteristic(session: BleBoatSession, target: GattWriteTarget): BleGattCharacteristicLike | null {
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
  if (target === "dwm3000cfg") {
    return session.charDwm3000Config;
  }
  if (target === "dwm3000range") {
    return session.charDwm3000Range;
  }
  return session.charBoatId;
}

async function gattWrite(session: BleBoatSession, target: GattWriteTarget, data: ArrayBuffer | Uint8Array): Promise<void> {
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
  appendStreamLine(session, chunk);
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


function clearUwbLogRole(session: BleBoatSession | null, role: UwbRole): void {
  if (session) {
    setUwbLogText(session, role, "");
  }
  const el = document.querySelector(`#uwb-line-log-${role}`);
  if (el) {
    el.textContent = "";
  }
}

function renderUwbLogs(session: BleBoatSession): void {
  renderUwbLogRole(session, "anchor");
  renderUwbLogRole(session, "tag");
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
  const uwbAnchorInput = document.querySelector<HTMLInputElement>("#uwb-at-input-anchor");
  const uwbTagInput = document.querySelector<HTMLInputElement>("#uwb-at-input-tag");
  const mtInput = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  session.uwbAnchorAtDraft = uwbAnchorInput?.value ?? "";
  session.uwbTagAtDraft = uwbTagInput?.value ?? "";
  session.meshtasticTxDraft = mtInput?.value ?? "";
  const boatIdInput = document.querySelector<HTMLInputElement>("#boat-id-input");
  session.boatIdDraft = boatIdInput?.value ?? session.boatIdDraft;
  const typeSelect = document.querySelector<HTMLSelectElement>("#device-type-select");
  const dwmTypeSelect = document.querySelector<HTMLSelectElement>("#dwm3000-device-type-select");
  const typeParsed = typeSelect ? parseDeviceType(typeSelect.value) : null;
  if (typeParsed) {
    session.deviceTypeDraft = typeParsed;
  } else if (dwmTypeSelect) {
    const dwmParsed = parseDeviceType(dwmTypeSelect.value);
    if (dwmParsed) {
      session.deviceTypeDraft = dwmParsed;
    }
  }
  const cfgDraft = dwm3000ConfigFromDraft();
  if (cfgDraft) {
    session.dwm3000ConfigDraft = cfgDraft;
  }
  session.dwm3000PeerDraft =
    document.querySelector<HTMLInputElement>("#dwm3000-peer-input")?.value ?? session.dwm3000PeerDraft;
}

function loadSessionToUi(session: BleBoatSession): void {
  const uwbAnchorInput = document.querySelector<HTMLInputElement>("#uwb-at-input-anchor");
  const uwbTagInput = document.querySelector<HTMLInputElement>("#uwb-at-input-tag");
  const mtInput = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  if (uwbAnchorInput) {
    uwbAnchorInput.value = session.uwbAnchorAtDraft;
  }
  if (uwbTagInput) {
    uwbTagInput.value = session.uwbTagAtDraft;
  }
  if (mtInput) {
    mtInput.value = session.meshtasticTxDraft;
  }
  renderImuDisplay(session);
  mergeMeshtasticPeersFromLog(session);
  renderMeshtastic(session);
  renderGpsDisplay(session);
  renderUwbLogs(session);
  syncUwbUi(session);
  syncDwm3000Ui(session);
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
  for (const id of ["uwb-at-input-anchor", "uwb-at-input-tag"] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    if (input) {
      input.value = "";
    }
  }
  for (const role of ["anchor", "tag"] as const) {
    const el = document.querySelector(`#uwb-line-log-${role}`);
    if (el) {
      el.textContent = "";
    }
  }
  syncUwbUi(null);
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
  syncMeshtasticTabVisibility(null);
  syncMeshtasticUiRefresh(null);
  syncDwm3000TabVisibility(null);
  syncDwm3000Ui(null);
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

  session.onGpsLineNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    ingestGpsLine(session, new TextDecoder().decode(v));
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
      ingestUwbUartChunk(session, s, 0);
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


async function sendUwbAt(role: UwbRole): Promise<void> {
  const session = getActiveSession();
  const logEl = document.querySelector(`#uwb-line-log-${role}`);
  if (!session?.charUwbAt) {
    if (logEl) {
      logEl.textContent = session
        ? "! UWB characteristic 0xFEFA unavailable.\n"
        : "! Connect a BLE device first.\n";
    }
    return;
  }
  const type = session.deviceTypeDraft;
  if (role === "anchor" && !deviceTypeHasAnchor(type)) {
    return;
  }
  if (role === "tag" && !deviceTypeHasTag(type)) {
    return;
  }
  if (session.uwbBusy) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>(`#uwb-at-input-${role}`);
  const cmd = (input?.value ?? "").trim();
  if (!cmd) {
    return;
  }
  session.uwbBusy = true;
  if (role === "anchor") {
    session.uwbAnchorAtDraft = input?.value ?? "";
  } else {
    session.uwbTagAtDraft = input?.value ?? "";
  }
  appendUwbLogRole(session, role, `> ${cmd}\n`);
  const baselineLen = uwbLogText(session, role).length;
  const gen = ++session.commsGen;
  session.activeUwbGen = gen;
  session.activeUwbRole = role;
  try {
    const imuWasOn = await pauseImuForComms(session);
    try {
      await ensureUwbComms(session);
      const payload = uwbWriteNeedsRolePrefix(type)
        ? encodeUwbAtWrite(role, cmd)
        : new TextEncoder().encode(cmd);
      await gattWrite(session, "uwb", payload);
      const gotReply = await pollUwbResponse(session, gen, role, baselineLen, 8000);
      if (gen === session.activeUwbGen && !gotReply) {
        appendUwbLogRole(
          session,
          role,
          "! No UWB response — check serial log (power, baud, wiring).\n",
        );
      }
    } finally {
      await restoreImuAfterComms(session, imuWasOn);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendUwbLogRole(session, role, `! BLE write error: ${msg}\n`);
  } finally {
    session.uwbBusy = false;
    if (gen === session.activeUwbGen) {
      session.activeUwbGen = 0;
      session.activeUwbRole = null;
    }
    syncActionButtons();
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
    charMeshtasticRx: null,
    charMeshtasticTx: null,
    charMeshtasticStats: null,
    charUwbLine: null,
    charUwbAt: null,
    charBoatId: null,
    charDeviceType: null,
    charDwm3000Config: null,
    charDwm3000Range: null,
    charGpsLine: null,
    boatId: "",
    boatIdDraft: "",
    deviceType: "boat",
    deviceTypeDraft: "boat",
    dwm3000Config: defaultDwm3000Config(),
    dwm3000ConfigDraft: defaultDwm3000Config(),
    dwm3000PeerDraft: "",
    uwbAnchorLineLogText: "",
    uwbTagLineLogText: "",
    uwbAnchorAtDraft: "",
    uwbTagAtDraft: "",
    activeUwbRole: null,
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    notificationsOn: false,
    imuNotificationsOn: false,
    commsGen: 0,
    activeUwbGen: 0,
    meshtasticStats: defaultMeshtasticStats(),
    meshtasticStatsReceivedWallMs: 0,
    meshtasticStatsNotifyBuf: "",
    meshtasticLineLogText: "",
    meshtasticTxDraft: "",
    gpsFix: defaultGpsFix(),
    uwbBusy: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onMeshtasticLineNotify: () => {},
    onMeshtasticStatsNotify: () => {},
    onGpsLineNotify: () => {},
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
    charMeshtasticRx: null,
    charMeshtasticTx: null,
    charMeshtasticStats: null,
    charUwbLine: null,
    charUwbAt: null,
    charBoatId: null,
    charDeviceType: null,
    charDwm3000Config: null,
    charDwm3000Range: null,
    charGpsLine: null,
    boatId: "",
    boatIdDraft: "",
    deviceType: "boat",
    deviceTypeDraft: "boat",
    dwm3000Config: defaultDwm3000Config(),
    dwm3000ConfigDraft: defaultDwm3000Config(),
    dwm3000PeerDraft: "",
    uwbAnchorLineLogText: "",
    uwbTagLineLogText: "",
    uwbAnchorAtDraft: "",
    uwbTagAtDraft: "",
    activeUwbRole: null,
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    notificationsOn: false,
    imuNotificationsOn: false,
    commsGen: 0,
    activeUwbGen: 0,
    meshtasticStats: defaultMeshtasticStats(),
    meshtasticStatsReceivedWallMs: 0,
    meshtasticStatsNotifyBuf: "",
    meshtasticLineLogText: "",
    meshtasticTxDraft: "",
    gpsFix: defaultGpsFix(),
    uwbBusy: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onMeshtasticLineNotify: () => {},
    onMeshtasticStatsNotify: () => {},
    onGpsLineNotify: () => {},
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
    if (btn.id === "uwb-at-send-anchor") {
      void sendUwbAt("anchor");
      return;
    }
    if (btn.id === "uwb-at-send-tag") {
      void sendUwbAt("tag");
      return;
    }
    if (btn.id === "uwb-log-clear-anchor") {
      clearUwbLogRole(getActiveSession(), "anchor");
      return;
    }
    if (btn.id === "uwb-log-clear-tag") {
      clearUwbLogRole(getActiveSession(), "tag");
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
    if (btn.id === "device-type-save" || btn.id === "dwm3000-device-type-save") {
      void saveDeviceTypeToDevice();
      return;
    }
    if (btn.id === "dwm3000-config-save") {
      void saveDwm3000ConfigToDevice();
      return;
    }
    if (btn.id === "dwm3000-range-btn") {
      void measureDwm3000Range();
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
    if (target instanceof HTMLInputElement && target.id === "uwb-at-input-anchor") {
      void sendUwbAt("anchor");
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "uwb-at-input-tag") {
      void sendUwbAt("tag");
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
    if (target instanceof HTMLInputElement && target.id === "meshtastic-tx-input") {
      session.meshtasticTxDraft = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "uwb-at-input-anchor") {
      session.uwbAnchorAtDraft = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "uwb-at-input-tag") {
      session.uwbTagAtDraft = target.value;
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "dwm3000-peer-input") {
      session.dwm3000PeerDraft = target.value;
      return;
    }
    if (
      target instanceof HTMLInputElement &&
      (target.id === "dwm3000-addr-input" ||
        target.id === "dwm3000-pan-input" ||
        target.id === "dwm3000-ant-input" ||
        target.id === "dwm3000-twr-input")
    ) {
      const cfg = dwm3000ConfigFromDraft();
      if (cfg) {
        session.dwm3000ConfigDraft = cfg;
      }
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
        syncDeviceTypeUi(session);
      }
    }
  });
  document.querySelector<HTMLSelectElement>("#dwm3000-device-type-select")?.addEventListener("change", (ev) => {
    const session = getActiveSession();
    if (session && ev.target instanceof HTMLSelectElement) {
      const type = parseDeviceType(ev.target.value);
      if (type) {
        session.deviceTypeDraft = type;
        syncDeviceTypeUi(session);
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
      if (session?.gatt.connected && session.charGpsLine) {
        renderGpsDisplay(session);
      } else if (session?.gatt.connected && session.charMeshtasticStats) {
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
  syncDwm3000Ui(null);
  renderDeviceSelector();
  updateBleToolbar();
  syncActionButtons();
}


