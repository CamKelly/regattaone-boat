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
  BLE_CONSOLE_LOG_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_DWM3000_CONFIG_CHAR_UUID,
  BLE_DWM3000_RANGE_CHAR_UUID,
  BLE_GPS_LINE_CHAR_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_MESHTASTIC_RX_CHAR_UUID,
  BLE_MESHTASTIC_STATS_CHAR_UUID,
  BLE_MESHTASTIC_TX_CHAR_UUID,
  BLE_SERVICE_UUID,
  BOAT_ID_MAX_LEN,
  BOAT_ID_BLE_NAME_MAX_LEN,
  DWM3000_DEFAULTS,
  type DeviceType,
  type Dwm3000Config,
  deviceTypeLabel,
  formatDwm3000ConfigJson,
  parseDeviceType,
  parseDwm3000ConfigJson,
  parseDwm3000RangeJson,
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
import { formatDistanceToNow } from "date-fns";
import {
  renderRelativePositionChart,
  resizeRelativePositionChart,
  type RelativePoint,
} from "./lib/relative-position-chart";

/** Bump when BLE connect logic changes — shown in UI so stale cached JS is obvious. */
const WEB_BLE_REV = "2026-07-28a";

const DEFAULT_IMU_META =
  "Connect to stream accel, gyro, mag, temperature, and pressure.";

let imuTabActive = false;
let regattaAppStarted = false;
/** When true, console log text still accumulates but the UI is frozen. */
let consoleLogPaused = false;
/** Case-insensitive substring; empty = show all lines. */
let consoleLogFilter = "";

interface ImuDisplay {
  accel: string;
  gyro: string;
  mag: string;
  temp: string;
  baro: string;
  meta: string;
  /** Wall-clock ms when the latest IMU packet arrived (0 = none). */
  updatedAtMs: number;
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

/** Latest Port/Starboard mark broadcast received over Meshtastic ($PREGMARK). */
interface MarkBroadcastSnapshot {
  role: "P" | "S";
  uwb: number;
  lat_e7: number;
  lon_e7: number;
  acc_cm: number;
  dist_cm: number | null;
  gps_valid: boolean;
  from: number;
  updatedAtMs: number;
}

/** Boat geometry snapshot from $PREGGEOM / $PREGTDOA (per-distance last-good timestamps). */
interface BoatGeomSnapshot {
  boat_port_cm: number | null;
  boat_starboard_cm: number | null;
  port_starboard_cm: number | null;
  starboard_port_cm: number | null;
  anchor_ps_cm?: number | null;
  anchor_pr_cm?: number | null;
  anchor_sr_cm?: number | null;
  boat_port_at_ms: number;
  boat_starboard_at_ms: number;
  port_starboard_at_ms: number;
  starboard_port_at_ms: number;
  port_uwb: number;
  starboard_uwb: number;
  /** Local TDoA frame: Port at origin, Starboard +X, Reference +Y. */
  tdoa_ok?: boolean;
  tdoa_seq?: number;
  x_m?: number | null;
  y_m?: number | null;
  reference_x_m?: number | null;
  reference_y_m?: number | null;
  boat_reference_cm?: number | null;
  tdoa_at_ms?: number;
  stale?: boolean;
  updatedAtMs: number;
}

interface LocalTwrSnapshot {
  ps_cm: number | null;
  pr_cm: number | null;
  sr_cm: number | null;
  ps_at_ms: number;
  pr_at_ms: number;
  sr_at_ms: number;
}

interface RegisteredBoatSnapshot {
  id: number; uuid: string; gps_valid: boolean; lat_e7: number; lon_e7: number;
  registered_age_ms: number; last_range_age_ms: number; grants: number; missed: number; completed: number;
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


/** Format an elapsed age as a relative string (e.g. "3s ago", "2 minutes ago"). */
function formatAgoFromAgeMs(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "—";
  }
  if (ageMs < 60_000) {
    return `${Math.max(0, Math.floor(ageMs / 1000))}s ago`;
  }
  return formatDistanceToNow(Date.now() - ageMs, { addSuffix: true });
}

/** Relative age from an elapsed millisecond count (e.g. performance.now() delta). */
function formatAgo(ms: number): string {
  return formatAgoFromAgeMs(ms);
}

/** Relative age from a wall-clock epoch (Date.now()-style timestamp). */
function formatAgoAt(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return "—";
  }
  return formatAgoFromAgeMs(Math.max(0, Date.now() - epochMs));
}

/** Append a date-fns ago suffix to a metric value (leaves "—" alone). */
function withMetricAgo(value: string, epochMs: number | null | undefined): string {
  if (!value || value === "—") {
    return value || "—";
  }
  if (epochMs == null || !Number.isFinite(epochMs) || epochMs <= 0) {
    return value;
  }
  return `${value} · ${formatAgoAt(epochMs)}`;
}

/** Append ago from an age-in-ms (performance.now delta). */
function withMetricAgoAge(value: string, ageMs: number): string {
  if (!value || value === "—") {
    return value || "—";
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || !Number.isFinite(Date.now() - ageMs)) {
    return value;
  }
  return `${value} · ${formatAgo(ageMs)}`;
}

const BLE_OPTIONAL_SERVICES = [
  BLE_SERVICE_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_DWM3000_CONFIG_CHAR_UUID,
  BLE_DWM3000_RANGE_CHAR_UUID,
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_GPS_LINE_CHAR_UUID,
  BLE_MESHTASTIC_RX_CHAR_UUID,
  BLE_MESHTASTIC_TX_CHAR_UUID,
  BLE_MESHTASTIC_STATS_CHAR_UUID,
  BLE_CONSOLE_LOG_CHAR_UUID,
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
  charBoatId: BleGattCharacteristicLike | null;
  charDeviceType: BleGattCharacteristicLike | null;
  charDwm3000Config: BleGattCharacteristicLike | null;
  charDwm3000Range: BleGattCharacteristicLike | null;
  charGpsLine: BleGattCharacteristicLike | null;
  charConsoleLog: BleGattCharacteristicLike | null;
  boatId: string;
  boatIdDraft: string;
  deviceType: DeviceType;
  deviceTypeDraft: DeviceType;
  dwm3000Config: Dwm3000Config;
  dwm3000ConfigDraft: Dwm3000Config;
  dwm3000PeerDraft: string;
  lastImuWallMs: number;
  imu: ImuDisplay;
  notificationsOn: boolean;
  imuNotificationsOn: boolean;
  meshtasticStats: MeshtasticStatsSnapshot;
  meshtasticStatsReceivedWallMs: number;
  meshtasticStatsNotifyBuf: string;
  /** Incomplete 0xFEE5 line fragment across BLE notify chunks. */
  meshtasticLineNotifyBuf: string;
  meshtasticLineLogText: string;
  /** Incomplete console log fragment across BLE notify chunks. */
  consoleLineNotifyBuf: string;
  consoleLineLogText: string;
  meshtasticTxDraft: string;
  markPort: MarkBroadcastSnapshot | null;
  markStarboard: MarkBroadcastSnapshot | null;
  boatGeom: BoatGeomSnapshot | null;
  tdoaTrail: Array<{ seq: number; x: number; y: number }>;
  localTwr: LocalTwrSnapshot;
  registeredBoats: RegisteredBoatSnapshot[];
  gpsFix: GpsFix;
  /** True when GATT was intentionally disconnected to park this device in the list. */
  parked: boolean;
  gattChain: Promise<void>;
  onImuNotify: (ev: Event) => void;
  onMeshtasticLineNotify: (ev: Event) => void;
  onMeshtasticStatsNotify: (ev: Event) => void;
  onGpsLineNotify: (ev: Event) => void;
  onConsoleLogNotify: (ev: Event) => void;
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
    updatedAtMs: 0,
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
  const statusEl = document.querySelector("#device-type-status");
  if (!session?.charDeviceType) {
    if (statusEl) {
      statusEl.textContent = "Device type requires firmware with characteristic 0xFEFC.";
    }
    return;
  }
  const type = session.deviceTypeDraft;
  try {
    await gattWrite(session, "type", new TextEncoder().encode(type));
    session.deviceType = type;
    syncDeviceTypeUi(session);
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
    statusEl.textContent = !session
      ? "Connect a device to set its type (port / starboard / boat)."
      : !session.charDeviceType
        ? "Flash firmware with device type support (0xFEFC) to enable."
        : !session.gatt.connected
          ? `Stored on device: ${deviceTypeLabel(session.deviceType)}. Reconnect to edit.`
          : `Stored on device: ${deviceTypeLabel(session.deviceType)} — controls mark / boat radio behaviour.`;
  }
}

function defaultDwm3000Config(): Dwm3000Config {
  return { ...DWM3000_DEFAULTS };
}

function formatHexU16(n: number): string {
  return `0x${n.toString(16).padStart(4, "0").toUpperCase()}`;
}

function parseHexU16(raw: string, allowZero = false, allowBroadcast = false): number | null {
  const s = raw.trim();
  if (!s) {
    return null;
  }
  const hex = s.startsWith("0x") || s.startsWith("0X");
  const v = Number.parseInt(hex ? s.slice(2) : s, hex ? 16 : 10);
  if (!Number.isFinite(v) || v < 0 || v > 0xffff || (!allowBroadcast && v === 0xffff)) {
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
  const readInt = (id: string) => Number.parseInt(document.querySelector<HTMLInputElement>(id)?.value ?? "", 10);
  const addr = parseHexU16(addrRaw, true);
  const pan = parseHexU16(panRaw, true);
  const ant = Number.parseInt(antRaw.trim(), 10);
  const twr = Number.parseInt(twrRaw.trim(), 10);
  const registration_ms = readInt("#dwm3000-registration-ms");
  const grant_ms = readInt("#dwm3000-grant-ms");
  const inactivity_ms = readInt("#dwm3000-inactivity-ms");
  const baseline_max_age_ms = readInt("#dwm3000-baseline-age-ms");
  const max_missed = readInt("#dwm3000-max-missed");
  const baseline_retries = readInt("#dwm3000-baseline-retries");
  const boat_retries = readInt("#dwm3000-boat-retries");
  if (addr == null || pan == null || ![ant, twr, registration_ms, grant_ms, inactivity_ms,
      baseline_max_age_ms, max_missed, baseline_retries, boat_retries].every(Number.isFinite)) {
    return null;
  }
  if (ant < 0 || ant > 65535 || twr < 300 || twr > 20000) {
    return null;
  }
  return { addr, pan, ant, twr, registration_ms, grant_ms, inactivity_ms, baseline_max_age_ms,
    max_missed, baseline_retries, boat_retries,
    detailed_logs: document.querySelector<HTMLInputElement>("#dwm3000-detailed-logs")?.checked ?? false,
    scheduler_paused: document.querySelector<HTMLInputElement>("#dwm3000-scheduler-paused")?.checked ?? false };
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

function syncDwm3000TabVisibility(_session: BleBoatSession | null): void {
  /* DWM3000 is the default landing tab — keep it visible even before connect. */
  const tab = document.querySelector<HTMLElement>("#dwm3000-tab");
  if (tab) {
    tab.hidden = false;
  }
}

function syncDwm3000Ui(session: BleBoatSession | null): void {
  const addrInput = document.querySelector<HTMLInputElement>("#dwm3000-addr-input");
  const panInput = document.querySelector<HTMLInputElement>("#dwm3000-pan-input");
  const antInput = document.querySelector<HTMLInputElement>("#dwm3000-ant-input");
  const twrInput = document.querySelector<HTMLInputElement>("#dwm3000-twr-input");
  const numericConfigInputs: Array<[string, keyof Dwm3000Config]> = [
    ["#dwm3000-registration-ms", "registration_ms"], ["#dwm3000-grant-ms", "grant_ms"],
    ["#dwm3000-inactivity-ms", "inactivity_ms"], ["#dwm3000-baseline-age-ms", "baseline_max_age_ms"],
    ["#dwm3000-max-missed", "max_missed"], ["#dwm3000-baseline-retries", "baseline_retries"],
    ["#dwm3000-boat-retries", "boat_retries"],
  ];
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
  for (const [selector, key] of numericConfigInputs) {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (input && document.activeElement !== input) input.value = String(cfg[key]);
    setFieldEnabled(input, canEdit);
  }
  const detailed = document.querySelector<HTMLInputElement>("#dwm3000-detailed-logs");
  const paused = document.querySelector<HTMLInputElement>("#dwm3000-scheduler-paused");
  if (detailed && document.activeElement !== detailed) detailed.checked = cfg.detailed_logs;
  if (paused && document.activeElement !== paused) paused.checked = cfg.scheduler_paused;
  if (peerInput && document.activeElement !== peerInput) {
    peerInput.value = session?.dwm3000PeerDraft ?? "";
  }
  setFieldEnabled(addrInput, false);
  setFieldEnabled(panInput, canEdit);
  setFieldEnabled(antInput, canEdit);
  setFieldEnabled(twrInput, canEdit);
  setFieldEnabled(detailed, canEdit);
  setFieldEnabled(paused, canEdit && session?.deviceType === "port");
  setFieldEnabled(saveBtn, canEdit);
  setFieldEnabled(peerInput, canRange);
  setFieldEnabled(rangeBtn, canRange);
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
  renderLocalTwr(session);
  renderRegisteredBoats(session);
}

function formatLocalTwr(cm: number | null, atMs: number): string {
  if (cm == null) {
    return "Waiting for TWR…";
  }
  return withMetricAgo(`${cm} cm · ${(cm / 2.54).toFixed(1)} in`, atMs);
}

function renderLocalTwr(session: BleBoatSession | null): void {
  const role = session?.deviceType ?? null;
  const showPs = role === "port" || role === "boat";
  const showPr = false;
  const showSr = false;
  const setCard = (link: "ps" | "pr" | "sr", visible: boolean, text: string) => {
    const card = document.querySelector<HTMLElement>(`#dwm3000-live-${link}-card`);
    const value = document.querySelector<HTMLElement>(`#dwm3000-live-${link}`);
    if (card) card.hidden = !visible;
    if (value) value.textContent = text;
  };
  const twr = session?.localTwr;
  setCard("ps", showPs, formatLocalTwr(twr?.ps_cm ?? null, twr?.ps_at_ms ?? 0));
  setCard("pr", showPr, formatLocalTwr(twr?.pr_cm ?? null, twr?.pr_at_ms ?? 0));
  setCard("sr", showSr, formatLocalTwr(twr?.sr_cm ?? null, twr?.sr_at_ms ?? 0));
  const hint = document.querySelector<HTMLElement>("#dwm3000-live-ranges-hint");
  if (hint) {
    hint.textContent = role === "port"
      ? "Port measures P↔S before each complete Boat queue rotation."
      : role === "starboard"
        ? "Starboard responds to Port baseline ranging and the currently granted Boat."
        : role
          ? "Boat receives PS in its grant, then ranges Starboard and Port."
          : "Connect a Port or Starboard device.";
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
function syncConnectButton(): void {
  if (!connectBtn) {
    return;
  }
  const connected = activeSessionId !== null && sessions.has(activeSessionId);
  connectBtn.textContent = connected ? "Disconnect" : "Connect Device";
}

function updateBleToolbar(note?: string): void {
  syncConnectButton();
  const n = sessions.size;
  if (n === 0) {
    setBleToolbar(note ?? "BLE: connect a device");
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
  syncBoatIdUi(session);
  syncDeviceTypeUi(session);
  syncDwm3000Ui(session);
  syncUwbTestUi(session);
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
  session.charConsoleLog?.removeEventListener("characteristicvaluechanged", session.onConsoleLogNotify);
}

async function bindSessionCharacteristics(session: BleBoatSession): Promise<void> {
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charMeshtasticRx = null;
  session.charMeshtasticTx = null;
  session.charMeshtasticStats = null;
  session.charBoatId = null;
  session.charDeviceType = null;
  session.charDwm3000Config = null;
  session.charDwm3000Range = null;
  session.charGpsLine = null;
  session.charConsoleLog = null;
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
  try {
    session.charConsoleLog = await svc.getCharacteristic(BLE_CONSOLE_LOG_CHAR_UUID);
    session.charConsoleLog.addEventListener("characteristicvaluechanged", session.onConsoleLogNotify);
  } catch {
    session.charConsoleLog = null;
  }

  markMeshtasticBleReady(session);
  syncMeshtasticTabVisibility(session);
  syncDwm3000TabVisibility(session);
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
  setText("gps-pps-count", withMetricAgoAge(formatPpsCount(fix.ppsCount), ppsAgeMs));
  setText("gps-pps-last", fix.ppsUpdatedAtMs > 0 ? formatAgo(ppsAgeMs) : "—");
  setText("gps-pps-interval", withMetricAgoAge(formatPpsIntervalUs(fix.ppsCapDeltaUs), ppsAgeMs));
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
      withMetricAgoAge(
        `${formatCoordDeg(fix.lat, true)}\n${formatCoordDeg(fix.lon, false)}`,
        ageMs,
      ),
    );
    updateGpsMap(fix.lat, fix.lon);
  } else {
    setText("gps-position", "—");
    updateGpsMap(null, null);
  }

  setText("gps-last-heard", formatAgo(ageMs));
  setText("gps-fix", withMetricAgoAge(fixLabel, ageMs));
  setText("gps-fix-type", withMetricAgoAge(fixTypeLabel(fix.fixType), ageMs));
  setText(
    "gps-sats",
    withMetricAgoAge(
      fix.satsInView !== null
        ? String(fix.satsInView)
        : fix.satsUsed !== null
          ? String(fix.satsUsed)
          : "—",
      ageMs,
    ),
  );
  setText("gps-seq", "—");
  setText("gps-utc", withMetricAgoAge(formatUtc(fix.utcTime, fix.utcDate), ageMs));
  setText("gps-sog", withMetricAgoAge(formatSpeedKnots(fix.sogKnots), ageMs));
  setText("gps-cog", withMetricAgoAge(formatCourseDeg(fix.cogDeg), ageMs));
  setText("gps-altitude", withMetricAgoAge(formatAltitudeM(fix.altitudeM, fix.geoidSepM), ageMs));
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
      withMetricAgoAge(
        `${formatCoordDeg(node.lat, true)}\n${formatCoordDeg(node.lon, false)}`,
        ageMs,
      ),
    );
    updateGpsMap(node.lat, node.lon);
  } else {
    setText("gps-position", "—");
    updateGpsMap(null, null);
  }

  setText("gps-source", `${label} · node ${node.num}`);
  setText("gps-last-heard", formatAgo(ageMs));
  setText("gps-fix", withMetricAgoAge(fixLabel, ageMs));
  setText("gps-fix-type", withMetricAgoAge(fixTypeLabel(node.fix_type), ageMs));
  setText(
    "gps-sats",
    withMetricAgoAge(node.sats_in_view !== null ? String(node.sats_in_view) : "—", ageMs),
  );
  setText("gps-seq", withMetricAgoAge(node.seq_number !== null ? String(node.seq_number) : "—", ageMs));
  setText(
    "gps-utc",
    withMetricAgoAge(
      node.timestamp_sec !== null && node.timestamp_sec > 0
        ? formatMeshtasticUtc(node.timestamp_sec)
        : formatMeshtasticUtc(node.time_sec),
      ageMs,
    ),
  );
  setText("gps-sog", withMetricAgoAge(formatMeshtasticSpeed(node), ageMs));
  setText("gps-cog", withMetricAgoAge(formatMeshtasticHeading(node), ageMs));
  setText(
    "gps-altitude",
    withMetricAgoAge(node.alt_m !== null ? `${node.alt_m} m MSL` : "—", ageMs),
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
    if (!session.charImu || !session.charMeshtasticStats) {
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
    await setImuNotifications(session, imuTabActive);
    await readBoatIdFromDevice(session);
    await readDeviceTypeFromDevice(session);
    await readDwm3000ConfigFromDevice(session);
    syncBoatIdUi(session);
    syncDeviceTypeUi(session);
    syncDwm3000Ui(session);
    syncMeshtasticUiRefresh(session);
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
  session.charBoatId = null;
  session.charDeviceType = null;
  session.charDwm3000Config = null;
  session.charDwm3000Range = null;
  session.charGpsLine = null;
  session.charConsoleLog = null;
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
  if (session.gatt.connected && session.charImu) {
    return true;
  }
  return activateSession(session);
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
    session.charMeshtasticRx,
    session.charMeshtasticStats,
    session.charGpsLine,
    session.charConsoleLog,
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

type GattWriteTarget = "boatid" | "type" | "meshtastic" | "mtstats" | "dwm3000cfg" | "dwm3000range";

function getWriteCharacteristic(session: BleBoatSession, target: GattWriteTarget): BleGattCharacteristicLike | null {
  if (target === "meshtastic") {
    return session.charMeshtasticTx;
  }
  if (target === "mtstats") {
    return session.charMeshtasticStats;
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
  // Reassemble across BLE notify chunks (PREGMARK / long text can span packets).
  session.meshtasticLineNotifyBuf += chunk;
  if (session.meshtasticLineNotifyBuf.length > 8192) {
    const cut = session.meshtasticLineNotifyBuf.lastIndexOf("\n");
    session.meshtasticLineNotifyBuf =
      cut >= 0 ? session.meshtasticLineNotifyBuf.slice(cut + 1) : session.meshtasticLineNotifyBuf.slice(-1024);
  }

  const endedWithNewline = /[\r\n]$/.test(session.meshtasticLineNotifyBuf);
  const parts = session.meshtasticLineNotifyBuf.split(/\r?\n/);
  const complete = endedWithNewline ? parts : parts.slice(0, -1);
  session.meshtasticLineNotifyBuf = endedWithNewline ? "" : (parts[parts.length - 1] ?? "");

  let hadMark = false;
  let hadGeom = false;
  let other = "";
  for (const raw of complete) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("$PREGMARK,")) {
      if (applyMarkBroadcastLine(session, line)) {
        hadMark = true;
      } else {
        console.warn("Ignored malformed $PREGMARK line", line.slice(0, 120));
      }
      continue;
    }
    if (line.startsWith("$PREGGEOM,")) {
      if (applyBoatGeomLine(session, line)) {
        hadGeom = true;
      } else {
        console.warn("Ignored malformed $PREGGEOM line", line.slice(0, 120));
      }
      continue;
    }
    if (line.startsWith("$PREGTDOA,")) {
      if (applyBoatTdoaLine(session, line)) {
        hadGeom = true;
      } else {
        console.warn("Ignored malformed $PREGTDOA line", line.slice(0, 120));
      }
      continue;
    }
    if (line.startsWith("$PREGSTART,")) {
      if (applyStartLinePosition(session, line)) hadGeom = true;
      else console.warn("Ignored malformed $PREGSTART line", line.slice(0, 120));
      continue;
    }
    if (line.startsWith("$PREGUWB,")) {
      if (applyStartLineStatus(session, line)) hadGeom = true;
      else console.warn("Ignored malformed $PREGUWB line", line.slice(0, 120));
      continue;
    }
    if (line.startsWith("$PREGMSG,")) {
      if (!applyUwbTestMsgLine(session, line)) {
        console.warn("Ignored malformed $PREGMSG line", line.slice(0, 120));
      }
      continue;
    }
    if (line.startsWith("$PREGBOATS,")) {
      if (applyRegisteredBoatsLine(session, line)) hadGeom = true;
      continue;
    }
    other += `${line}\n`;
  }
  if (other.length > 0) {
    appendStreamLine(session, other);
    mergeMeshtasticPeersFromLog(session);
  }
  if (hadMark) {
    renderMarkBroadcasts(session);
  }
  if (hadGeom) {
    renderBoatGeom(session);
  }
  if (hadMark || hadGeom || other.length > 0) {
    renderMeshtastic(session);
    syncMeshtasticUiRefresh(session);
  }
}

function applyMarkBroadcastLine(session: BleBoatSession, line: string): boolean {
  const jsonPart = line.slice("$PREGMARK,".length).trim();
  try {
    const o = JSON.parse(jsonPart) as {
      role?: string;
      uwb?: number;
      lat_e7?: number;
      lon_e7?: number;
      acc_cm?: number;
      dist_cm?: number;
      gps?: boolean;
      from?: number;
    };
    if (o.role !== "P" && o.role !== "S") {
      return false;
    }
    if (typeof o.uwb !== "number" || typeof o.lat_e7 !== "number" || typeof o.lon_e7 !== "number") {
      return false;
    }
    const distRaw = typeof o.dist_cm === "number" ? o.dist_cm : 65535;
    const snap: MarkBroadcastSnapshot = {
      role: o.role,
      uwb: o.uwb & 0xffff,
      lat_e7: o.lat_e7,
      lon_e7: o.lon_e7,
      acc_cm: typeof o.acc_cm === "number" ? o.acc_cm : 0,
      dist_cm: distRaw >= 65535 ? null : distRaw,
      gps_valid: o.gps === true,
      from: typeof o.from === "number" ? o.from : 0,
      updatedAtMs: Date.now(),
    };
    if (snap.role === "P") {
      session.markPort = snap;
    } else {
      session.markStarboard = snap;
    }
    return true;
  } catch {
    return false;
  }
}

function formatMarkCoord(e7: number, gpsValid: boolean): string {
  if (!gpsValid && e7 === 0) {
    return "—";
  }
  return `${(e7 / 1e7).toFixed(6)}°`;
}

function formatMarkDist(cm: number | null, oppositeLabel: string): string {
  if (cm === null) {
    return "—";
  }
  if (cm >= 100) {
    return `${(cm / 100).toFixed(2)} m to ${oppositeLabel}`;
  }
  return `${cm} cm to ${oppositeLabel}`;
}

function formatGeomDist(cm: number | null): string {
  if (cm === null) {
    return "—";
  }
  if (cm >= 100) {
    return `${(cm / 100).toFixed(2)} m`;
  }
  return `${cm} cm`;
}

function parseGeomCm(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value >= 65535) {
    return null;
  }
  return Math.round(value);
}

function mergeGeomCm(
  incoming: number | null,
  prevCm: number | null,
  prevAt: number,
  now: number,
): { cm: number | null; at: number } {
  if (incoming != null) {
    return { cm: incoming, at: now };
  }
  return { cm: prevCm, at: prevAt };
}

function applyBoatTdoaLine(session: BleBoatSession, line: string): boolean {
  const jsonPart = line.slice("$PREGTDOA,".length).trim();
  try {
    const o = JSON.parse(jsonPart) as {
      seq?: number;
      ok?: number | boolean;
      x_m?: number;
      y_m?: number;
      reference_x_m?: number;
      reference_y_m?: number;
      boat_port_cm?: number | null;
      boat_starboard_cm?: number | null;
      boat_reference_cm?: number | null;
    };
    const now = Date.now();
    const prev = session.boatGeom;
    const ok = o.ok === true || o.ok === 1;
    const boatPort = mergeGeomCm(parseGeomCm(o.boat_port_cm), prev?.boat_port_cm ?? null, prev?.boat_port_at_ms ?? 0, now);
    const boatStb = mergeGeomCm(
      parseGeomCm(o.boat_starboard_cm),
      prev?.boat_starboard_cm ?? null,
      prev?.boat_starboard_at_ms ?? 0,
      now,
    );
    session.boatGeom = {
      boat_port_cm: ok ? boatPort.cm : (prev?.boat_port_cm ?? null),
      boat_starboard_cm: ok ? boatStb.cm : (prev?.boat_starboard_cm ?? null),
      port_starboard_cm: prev?.port_starboard_cm ?? null,
      starboard_port_cm: prev?.starboard_port_cm ?? null,
      anchor_ps_cm: prev?.anchor_ps_cm ?? null,
      anchor_pr_cm: prev?.anchor_pr_cm ?? null,
      anchor_sr_cm: prev?.anchor_sr_cm ?? null,
      boat_port_at_ms: ok ? boatPort.at : (prev?.boat_port_at_ms ?? 0),
      boat_starboard_at_ms: ok ? boatStb.at : (prev?.boat_starboard_at_ms ?? 0),
      port_starboard_at_ms: prev?.port_starboard_at_ms ?? 0,
      starboard_port_at_ms: prev?.starboard_port_at_ms ?? 0,
      port_uwb: prev?.port_uwb ?? 0,
      starboard_uwb: prev?.starboard_uwb ?? 0,
      tdoa_ok: ok,
      tdoa_seq: typeof o.seq === "number" ? o.seq : prev?.tdoa_seq,
      x_m: ok && typeof o.x_m === "number" ? o.x_m : prev?.x_m ?? null,
      y_m: ok && typeof o.y_m === "number" ? o.y_m : prev?.y_m ?? null,
      reference_x_m:
        typeof o.reference_x_m === "number" ? o.reference_x_m : prev?.reference_x_m ?? null,
      reference_y_m:
        typeof o.reference_y_m === "number" ? o.reference_y_m : prev?.reference_y_m ?? null,
      boat_reference_cm: ok ? parseGeomCm(o.boat_reference_cm) : prev?.boat_reference_cm ?? null,
      tdoa_at_ms: ok ? now : prev?.tdoa_at_ms,
      updatedAtMs: now,
    };
    if (ok && typeof o.x_m === "number" && typeof o.y_m === "number") {
      const seq = typeof o.seq === "number" ? o.seq : 0;
      if (session.tdoaTrail.at(-1)?.seq !== seq) {
        session.tdoaTrail.push({ seq, x: o.x_m, y: o.y_m });
        session.tdoaTrail.splice(0, Math.max(0, session.tdoaTrail.length - 30));
      }
    }
    renderRelativePosition(session);
    return true;
  } catch {
    return false;
  }
}

function applyStartLinePosition(session: BleBoatSession, line: string): boolean {
  try {
    const o = JSON.parse(line.slice("$PREGSTART,".length).trim()) as {
      seq?: number; fresh?: number | boolean; ps_cm?: number; bp_cm?: number; bs_cm?: number;
      x_m?: number; y_m?: number;
    };
    const now = Date.now();
    const prev = session.boatGeom;
    const fresh = o.fresh === true || o.fresh === 1;
    const ps = parseGeomCm(o.ps_cm) ?? prev?.anchor_ps_cm ?? null;
    session.boatGeom = {
      boat_port_cm: fresh ? parseGeomCm(o.bp_cm) : prev?.boat_port_cm ?? null,
      boat_starboard_cm: fresh ? parseGeomCm(o.bs_cm) : prev?.boat_starboard_cm ?? null,
      port_starboard_cm: ps, starboard_port_cm: ps, anchor_ps_cm: ps,
      anchor_pr_cm: null, anchor_sr_cm: null,
      boat_port_at_ms: fresh ? now : prev?.boat_port_at_ms ?? 0,
      boat_starboard_at_ms: fresh ? now : prev?.boat_starboard_at_ms ?? 0,
      port_starboard_at_ms: now, starboard_port_at_ms: now,
      port_uwb: 1, starboard_uwb: 2,
      tdoa_ok: prev?.tdoa_ok || fresh,
      tdoa_seq: fresh && typeof o.seq === "number" ? o.seq : prev?.tdoa_seq,
      x_m: fresh && typeof o.x_m === "number" ? o.x_m : prev?.x_m ?? null,
      y_m: fresh && typeof o.y_m === "number" ? o.y_m : prev?.y_m ?? null,
      reference_x_m: null, reference_y_m: null, boat_reference_cm: null,
      tdoa_at_ms: fresh ? now : prev?.tdoa_at_ms,
      stale: !fresh,
      updatedAtMs: now,
    };
    renderRelativePosition(session);
    return true;
  } catch { return false; }
}

function applyStartLineStatus(session: BleBoatSession, line: string): boolean {
  try {
    const o = JSON.parse(line.slice("$PREGUWB,".length).trim()) as {
      ps_cm?: number; baseline_age_ms?: number;
    };
    const ps = parseGeomCm(o.ps_cm);
    const hasBaseline = ps != null && ps > 0 && o.baseline_age_ms !== -1;
    if (hasBaseline) {
      const now = Date.now();
      session.localTwr.ps_cm = ps;
      session.localTwr.ps_at_ms = now;
      const prev = session.boatGeom;
      if (prev) {
        prev.anchor_ps_cm = ps; prev.port_starboard_cm = ps; prev.starboard_port_cm = ps;
        prev.port_starboard_at_ms = now; prev.starboard_port_at_ms = now;
      }
    } else {
      session.localTwr.ps_cm = null;
      session.localTwr.ps_at_ms = 0;
    }
    renderLocalTwr(session);
    renderRelativePosition(session);
    return true;
  } catch { return false; }
}

function applyUwbTestMsgLine(_session: BleBoatSession, line: string): boolean {
  try {
    const o = JSON.parse(line.slice("$PREGMSG,".length).trim()) as {
      src?: number; dst?: number; dir?: string; text?: string;
    };
    if (typeof o.src !== "number" || typeof o.dst !== "number" || typeof o.text !== "string") {
      return false;
    }
    const dir = o.dir === "tx" ? "TX" : "RX";
    const stamp = new Date().toLocaleTimeString();
    const entry =
      `[${stamp}] ${dir} src=${formatHexU16(o.src)} dst=${formatHexU16(o.dst)} ${o.text}\n`;
    const logEl = document.querySelector<HTMLElement>("#uwb-test-log");
    if (logEl) {
      logEl.textContent = `${logEl.textContent ?? ""}${entry}`;
      logEl.scrollTop = logEl.scrollHeight;
    }
    return true;
  } catch {
    return false;
  }
}

function syncUwbTestUi(session: BleBoatSession | null): void {
  const statusEl = document.querySelector("#uwb-test-status");
  const sendBtn = document.querySelector<HTMLButtonElement>("#uwb-test-send");
  const dstInput = document.querySelector<HTMLInputElement>("#uwb-test-dst-input");
  const textInput = document.querySelector<HTMLInputElement>("#uwb-test-text-input");
  const canSend = session !== null && session.gatt.connected && session.charDwm3000Range !== null;
  setFieldEnabled(sendBtn, canSend);
  setFieldEnabled(dstInput, canSend);
  setFieldEnabled(textInput, canSend);
  if (statusEl) {
    if (!session) statusEl.textContent = "Connect a DWM3000 device to send or receive.";
    else if (!session.charDwm3000Range) statusEl.textContent = "Flash firmware with DWM3000 ranging (0xFEF3).";
    else if (!session.gatt.connected) statusEl.textContent = "Device disconnected — reconnect to send.";
    else statusEl.textContent = "Ready. Use 0xFFFF to broadcast to every listening device.";
  }
}

function encodeUwbTestMsgCmd(dst: number, message: string): ArrayBuffer {
  const prefix = new TextEncoder().encode(`msg=${dst}\n`);
  const body = new TextEncoder().encode(message);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

async function sendUwbTestMsg(): Promise<void> {
  const session = getActiveSession();
  const statusEl = document.querySelector("#uwb-test-status");
  if (!session?.charDwm3000Range) {
    if (statusEl) statusEl.textContent = "Connect a DWM3000 device first.";
    return;
  }
  const dstRaw = document.querySelector<HTMLInputElement>("#uwb-test-dst-input")?.value ?? "";
  const text = (document.querySelector<HTMLInputElement>("#uwb-test-text-input")?.value ?? "").trim();
  const dst = parseHexU16(dstRaw, true, true);
  if (dst == null) {
    if (statusEl) statusEl.textContent = "Enter a destination address (e.g. 0xFFFF or 0x0001).";
    return;
  }
  if (!text) {
    if (statusEl) statusEl.textContent = "Enter a non-empty message (max 48 characters).";
    return;
  }
  if (new TextEncoder().encode(text).length > 48) {
    if (statusEl) statusEl.textContent = "Message is too long (max 48 UTF-8 bytes).";
    return;
  }
  try {
    await gattWrite(session, "dwm3000range", encodeUwbTestMsgCmd(dst, text));
    if (statusEl) statusEl.textContent = `Sent to ${formatHexU16(dst)}.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) statusEl.textContent = `Send failed: ${msg}`;
  }
}

function applyRegisteredBoatsLine(session: BleBoatSession, line: string): boolean {
  try {
    const o = JSON.parse(line.slice("$PREGBOATS,".length).trim()) as Partial<RegisteredBoatSnapshot> & { reset?: number; end?: number };
    if (o.reset === 1) session.registeredBoats = [];
    else if (typeof o.id === "number" && typeof o.uuid === "string") {
      session.registeredBoats = session.registeredBoats.filter((b) => b.id !== o.id);
      session.registeredBoats.push({
        id: o.id, uuid: o.uuid, gps_valid: o.gps_valid === true || (o.gps_valid as unknown) === 1,
        lat_e7: Number(o.lat_e7 ?? 0), lon_e7: Number(o.lon_e7 ?? 0),
        registered_age_ms: Number(o.registered_age_ms ?? 0), last_range_age_ms: Number(o.last_range_age_ms ?? 0),
        grants: Number(o.grants ?? 0), missed: Number(o.missed ?? 0), completed: Number(o.completed ?? 0),
      });
    }
    renderRegisteredBoats(session);
    return true;
  } catch { return false; }
}

function renderRegisteredBoats(session: BleBoatSession | null): void {
  const section = document.querySelector<HTMLElement>("#dwm3000-registered-section");
  const body = document.querySelector<HTMLTableSectionElement>("#dwm3000-registered-body");
  if (section) section.hidden = session?.deviceType !== "port";
  if (!body) return;
  body.replaceChildren(...(session?.registeredBoats ?? []).sort((a, b) => a.id - b.id).map((boat) => {
    const tr = document.createElement("tr");
    const gps = boat.gps_valid ? `${(boat.lat_e7 / 1e7).toFixed(6)}, ${(boat.lon_e7 / 1e7).toFixed(6)}` : "—";
    for (const value of [formatHexU16(boat.id), boat.uuid, gps,
      `${(boat.last_range_age_ms / 1000).toFixed(1)} s`, String(boat.completed), String(boat.missed)]) {
      const td = document.createElement("td"); td.textContent = value; tr.appendChild(td);
    }
    return tr;
  }));
}

function applyBoatGeomLine(session: BleBoatSession, line: string): boolean {
  const jsonPart = line.slice("$PREGGEOM,".length).trim();
  try {
    const o = JSON.parse(jsonPart) as {
      boat_port_cm?: number | null;
      boat_starboard_cm?: number | null;
      port_starboard_cm?: number | null;
      starboard_port_cm?: number | null;
      anchor_ps_cm?: number | null;
      anchor_pr_cm?: number | null;
      anchor_sr_cm?: number | null;
      port_uwb?: number;
      starboard_uwb?: number;
    };
    const now = Date.now();
    const prev = session.boatGeom;
    const boatPort = mergeGeomCm(parseGeomCm(o.boat_port_cm), prev?.boat_port_cm ?? null, prev?.boat_port_at_ms ?? 0, now);
    const boatStb = mergeGeomCm(
      parseGeomCm(o.boat_starboard_cm),
      prev?.boat_starboard_cm ?? null,
      prev?.boat_starboard_at_ms ?? 0,
      now,
    );
    const portStb = mergeGeomCm(
      parseGeomCm(o.port_starboard_cm),
      prev?.port_starboard_cm ?? null,
      prev?.port_starboard_at_ms ?? 0,
      now,
    );
    const stbPort = mergeGeomCm(
      parseGeomCm(o.starboard_port_cm),
      prev?.starboard_port_cm ?? null,
      prev?.starboard_port_at_ms ?? 0,
      now,
    );
    session.boatGeom = {
      boat_port_cm: boatPort.cm,
      boat_starboard_cm: boatStb.cm,
      port_starboard_cm: portStb.cm,
      starboard_port_cm: stbPort.cm,
      anchor_ps_cm: parseGeomCm(o.anchor_ps_cm) ?? prev?.anchor_ps_cm ?? null,
      anchor_pr_cm: parseGeomCm(o.anchor_pr_cm) ?? prev?.anchor_pr_cm ?? null,
      anchor_sr_cm: parseGeomCm(o.anchor_sr_cm) ?? prev?.anchor_sr_cm ?? null,
      boat_port_at_ms: boatPort.at,
      boat_starboard_at_ms: boatStb.at,
      port_starboard_at_ms: portStb.at,
      starboard_port_at_ms: stbPort.at,
      port_uwb: typeof o.port_uwb === "number" ? o.port_uwb & 0xffff : prev?.port_uwb ?? 0,
      starboard_uwb: typeof o.starboard_uwb === "number" ? o.starboard_uwb & 0xffff : prev?.starboard_uwb ?? 0,
      tdoa_ok: prev?.tdoa_ok,
      tdoa_seq: prev?.tdoa_seq,
      x_m: prev?.x_m ?? null,
      y_m: prev?.y_m ?? null,
      reference_x_m: prev?.reference_x_m ?? null,
      reference_y_m: prev?.reference_y_m ?? null,
      boat_reference_cm: prev?.boat_reference_cm ?? null,
      tdoa_at_ms: prev?.tdoa_at_ms,
      updatedAtMs: now,
    };
    return true;
  } catch {
    return false;
  }
}

function renderBoatGeom(session: BleBoatSession | null): void {
  if (session && session.deviceId !== activeSessionId) {
    return;
  }
  const set = (id: string, value: string) => {
    const el = document.querySelector(`#${id}`);
    if (el) {
      el.textContent = value;
    }
  };
  const g = session?.boatGeom ?? null;
  if (!g) {
    set("boat-geom-boat-port", "—");
    set("boat-geom-boat-starboard", "—");
    set("boat-geom-boat-reference", "—");
    set("boat-geom-port-starboard", "—");
    set("boat-geom-starboard-port", "—");
    set("boat-geom-xy", "—");
    return;
  }
  set("boat-geom-boat-port", withMetricAgo(formatGeomDist(g.boat_port_cm), g.boat_port_at_ms));
  set("boat-geom-boat-starboard", withMetricAgo(formatGeomDist(g.boat_starboard_cm), g.boat_starboard_at_ms));
  set(
    "boat-geom-boat-reference",
    g.boat_reference_cm != null
      ? withMetricAgo(formatGeomDist(g.boat_reference_cm), g.tdoa_at_ms ?? g.updatedAtMs)
      : "—",
  );
  set("boat-geom-port-starboard", withMetricAgo(formatGeomDist(g.port_starboard_cm), g.port_starboard_at_ms));
  set("boat-geom-starboard-port", withMetricAgo(formatGeomDist(g.starboard_port_cm), g.starboard_port_at_ms));
  if (g.tdoa_ok && g.x_m != null && g.y_m != null) {
    set(
      "boat-geom-xy",
      withMetricAgo(`x=${g.x_m.toFixed(2)} m  y=${g.y_m.toFixed(2)} m (seq ${g.tdoa_seq ?? "—"})`, g.tdoa_at_ms ?? g.updatedAtMs),
    );
  } else {
    set("boat-geom-xy", "—");
  }
}

function relativeBaselineM(session: BleBoatSession): number | null {
  const g = session.boatGeom;
  const cm = g?.anchor_ps_cm ?? g?.port_starboard_cm ?? g?.starboard_port_cm ?? session.markPort?.dist_cm ?? session.markStarboard?.dist_cm;
  return cm != null && cm > 0 ? cm / 100 : null;
}

function referenceFromBaselines(g: BoatGeomSnapshot | null): { x: number; y: number } | null {
  const ps = g?.anchor_ps_cm != null ? g.anchor_ps_cm / 100 : null;
  const pr = g?.anchor_pr_cm != null ? g.anchor_pr_cm / 100 : null;
  const sr = g?.anchor_sr_cm != null ? g.anchor_sr_cm / 100 : null;
  if (ps == null || pr == null || sr == null || ps <= 0 || pr <= 0 || sr <= 0) {
    return null;
  }
  const x = (ps * ps + pr * pr - sr * sr) / (2 * ps);
  const y2 = pr * pr - x * x;
  if (y2 < -0.05) {
    return null;
  }
  return { x, y: Math.sqrt(Math.max(0, y2)) };
}

function renderRelativePosition(session: BleBoatSession | null): void {
  if (session && session.deviceId !== activeSessionId) {
    return;
  }
  const status = document.querySelector<HTMLElement>("#relative-position-status");
  const coordinates = document.querySelector<HTMLElement>("#relative-position-coordinates");
  const setPoint = (id: "p" | "s" | "b", point: RelativePoint | null) => {
    const el = document.querySelector<HTMLElement>(`#relative-position-${id}`);
    if (el) {
      el.textContent = point
        ? `(${point.x.toFixed(3)}, ${point.y.toFixed(3)}) m · (${(point.x * 39.37007874).toFixed(1)}, ${(point.y * 39.37007874).toFixed(1)}) in`
        : "—";
    }
  };
  const flipY = document.querySelector<HTMLInputElement>("#relative-position-flip-y")?.checked === true;
  const sign = flipY ? -1 : 1;
  if (!session) {
    if (status) status.textContent = "Connect to a Boat and wait for a successful DS-TWR cycle.";
    if (coordinates) coordinates.textContent = "—";
    setPoint("p", null);
    setPoint("s", null);
    setPoint("b", null);
    renderRelativePositionChart([], null, []);
    return;
  }

  const baseline = relativeBaselineM(session);
  const g = session.boatGeom;
  const anchors: RelativePoint[] = [{ name: "P", x: 0, y: 0 }];
  if (baseline != null) {
    anchors.push({ name: "S", x: baseline, y: 0 });
  }
  const boat = g?.tdoa_ok && g.x_m != null && g.y_m != null
    ? { name: "B", x: g.x_m, y: sign * g.y_m, stale: g.stale === true }
    : null;
  const trail: RelativePoint[] = [];

  if (status) {
    status.textContent = boat
      ? `${g?.stale ? "Stale DS-TWR position (latest cycle failed)" : "Live DS-TWR position"} · sequence ${g?.tdoa_seq ?? "—"}${flipY ? " · Y flipped for display" : ""}`
      : "Waiting for successful Boat↔Starboard and Boat↔Port ranging…";
  }
  if (coordinates) {
    coordinates.textContent = boat
      ? `Boat (${boat.x.toFixed(2)}, ${boat.y.toFixed(2)}) m · (${(boat.x * 39.37007874).toFixed(1)}, ${(boat.y * 39.37007874).toFixed(1)}) in`
      : "—";
  }
  setPoint("p", anchors.find((p) => p.name === "P") ?? null);
  setPoint("s", anchors.find((p) => p.name === "S") ?? null);
  setPoint("b", boat);
  renderRelativePositionChart(anchors, boat, trail);
}

function renderMarkBroadcastPanel(
  prefix: "port" | "starboard",
  snap: MarkBroadcastSnapshot | null,
  oppositeLabel: string,
): void {
  const set = (suffix: string, value: string) => {
    const el = document.querySelector(`#mark-${prefix}-${suffix}`);
    if (el) {
      el.textContent = value;
    }
  };
  if (!snap) {
    set("uwb", "—");
    set("lat", "—");
    set("lon", "—");
    set("acc", "—");
    set("dist", "—");
    set("from", "—");
    return;
  }
  const at = snap.updatedAtMs;
  set("uwb", withMetricAgo(`0x${snap.uwb.toString(16).toUpperCase().padStart(4, "0")}`, at));
  set("lat", withMetricAgo(formatMarkCoord(snap.lat_e7, snap.gps_valid), at));
  set("lon", withMetricAgo(formatMarkCoord(snap.lon_e7, snap.gps_valid), at));
  set("acc", withMetricAgo(snap.acc_cm > 0 ? `${snap.acc_cm} cm` : "—", at));
  set("dist", withMetricAgo(formatMarkDist(snap.dist_cm, oppositeLabel), at));
  set(
    "from",
    withMetricAgo(snap.from ? `0x${snap.from.toString(16).toUpperCase().padStart(8, "0")}` : "—", at),
  );
}

function renderMarkBroadcasts(session: BleBoatSession | null): void {
  if (session && session.deviceId !== activeSessionId) {
    return;
  }
  renderMarkBroadcastPanel("port", session?.markPort ?? null, "Starboard");
  renderMarkBroadcastPanel("starboard", session?.markStarboard ?? null, "Port");
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
  renderRelativePosition(session);
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

function filteredConsoleLogText(full: string): string {
  const needle = consoleLogFilter.trim().toLowerCase();
  if (!needle) {
    return full;
  }
  return full
    .split("\n")
    .filter((line) => line.length > 0 && line.toLowerCase().includes(needle))
    .map((line) => `${line}\n`)
    .join("");
}

function paintConsoleLog(session: BleBoatSession | null): void {
  if (session && session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector<HTMLPreElement>("#console-line-log");
  if (el) {
    el.textContent = filteredConsoleLogText(session?.consoleLineLogText ?? "");
    el.scrollTop = el.scrollHeight;
  }
}

function renderConsoleLog(session: BleBoatSession | null): void {
  if (consoleLogPaused) {
    return;
  }
  paintConsoleLog(session);
}

function syncConsoleLogPauseUi(): void {
  const btn = document.querySelector<HTMLButtonElement>("#console-log-pause");
  if (btn) {
    btn.textContent = consoleLogPaused ? "Resume" : "Pause";
    btn.setAttribute("aria-pressed", consoleLogPaused ? "true" : "false");
  }
}

function toggleConsoleLogPaused(): void {
  consoleLogPaused = !consoleLogPaused;
  syncConsoleLogPauseUi();
  if (!consoleLogPaused) {
    paintConsoleLog(getActiveSession());
  }
}

function clearConsoleLog(session: BleBoatSession | null): void {
  if (session) {
    session.consoleLineLogText = "";
    session.consoleLineNotifyBuf = "";
  }
  const el = document.querySelector("#console-line-log");
  if (el) {
    el.textContent = "";
  }
}

function applyAnchorGeometryFromConsole(session: BleBoatSession, line: string): boolean {
  const beacon = line.match(/mark_blink:\s+beacon\b.*\brole=([PSR])\b/);
  if (!beacon) {
    return false;
  }

  const readCm = (name: "ps" | "pr" | "sr"): number | null => {
    const match = line.match(new RegExp(`\\b${name}=(\\d+)\\b`));
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const role = beacon[1];
  const ps = role === "P" ? readCm("ps") : null;
  const pr = role === "P" ? readCm("pr") : null;
  const sr = role === "S" ? readCm("sr") : null;
  if (ps == null && pr == null && sr == null) {
    return false;
  }
  const now = Date.now();
  const prev = session.boatGeom;
  session.boatGeom = {
    boat_port_cm: prev?.boat_port_cm ?? null,
    boat_starboard_cm: prev?.boat_starboard_cm ?? null,
    port_starboard_cm: ps ?? prev?.port_starboard_cm ?? null,
    starboard_port_cm: ps ?? prev?.starboard_port_cm ?? null,
    anchor_ps_cm: ps ?? prev?.anchor_ps_cm ?? null,
    anchor_pr_cm: pr ?? prev?.anchor_pr_cm ?? null,
    anchor_sr_cm: sr ?? prev?.anchor_sr_cm ?? null,
    boat_port_at_ms: prev?.boat_port_at_ms ?? 0,
    boat_starboard_at_ms: prev?.boat_starboard_at_ms ?? 0,
    port_starboard_at_ms: now,
    starboard_port_at_ms: now,
    port_uwb: prev?.port_uwb ?? 0,
    starboard_uwb: prev?.starboard_uwb ?? 0,
    tdoa_ok: prev?.tdoa_ok,
    tdoa_seq: prev?.tdoa_seq,
    x_m: prev?.x_m ?? null,
    y_m: prev?.y_m ?? null,
    reference_x_m: prev?.reference_x_m ?? null,
    reference_y_m: prev?.reference_y_m ?? null,
    boat_reference_cm: prev?.boat_reference_cm ?? null,
    tdoa_at_ms: prev?.tdoa_at_ms,
    updatedAtMs: now,
  };
  return true;
}

function applyLocalTwrFromConsole(session: BleBoatSession, line: string): boolean {
  const match = line.match(/mark_blink:\s+baseline\s+(ps|pr|sr)=(\d+)\s+cm\b/);
  if (!match) {
    return false;
  }
  const link = match[1] as "ps" | "pr" | "sr";
  const cm = Number(match[2]);
  if (!Number.isFinite(cm) || cm <= 0) {
    return false;
  }
  session.localTwr[`${link}_cm`] = cm;
  session.localTwr[`${link}_at_ms`] = Date.now();
  return true;
}

function ingestConsoleLogChunk(session: BleBoatSession, chunk: string): void {
  if (!chunk) {
    return;
  }
  session.consoleLineNotifyBuf += chunk;
  if (session.consoleLineNotifyBuf.length > 8192) {
    const cut = session.consoleLineNotifyBuf.lastIndexOf("\n");
    session.consoleLineNotifyBuf =
      cut >= 0 ? session.consoleLineNotifyBuf.slice(cut + 1) : session.consoleLineNotifyBuf.slice(-1024);
  }

  const endedWithNewline = /[\r\n]$/.test(session.consoleLineNotifyBuf);
  const parts = session.consoleLineNotifyBuf.split(/\r?\n/);
  const complete = endedWithNewline ? parts : parts.slice(0, -1);
  session.consoleLineNotifyBuf = endedWithNewline ? "" : (parts[parts.length - 1] ?? "");

  let added = false;
  let geometryUpdated = false;
  let localTwrUpdated = false;
  for (const raw of complete) {
    const line = raw.replace(/\r$/, "");
    if (!line) {
      continue;
    }
    session.consoleLineLogText += `${line}\n`;
    if (line.startsWith("$PREGSTART,")) geometryUpdated = applyStartLinePosition(session, line) || geometryUpdated;
    else if (line.startsWith("$PREGUWB,")) geometryUpdated = applyStartLineStatus(session, line) || geometryUpdated;
    else if (line.startsWith("$PREGMSG,")) applyUwbTestMsgLine(session, line);
    else if (line.startsWith("$PREGBOATS,")) geometryUpdated = applyRegisteredBoatsLine(session, line) || geometryUpdated;
    geometryUpdated = applyAnchorGeometryFromConsole(session, line) || geometryUpdated;
    localTwrUpdated = applyLocalTwrFromConsole(session, line) || localTwrUpdated;
    added = true;
  }
  if (!added) {
    return;
  }
  if (session.consoleLineLogText.length > 96000) {
    session.consoleLineLogText = session.consoleLineLogText.slice(-72000);
  }
  renderConsoleLog(session);
  if (geometryUpdated) {
    renderBoatGeom(session);
    renderRelativePosition(session);
  }
  if (localTwrUpdated) {
    renderLocalTwr(session);
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
  renderMarkBroadcasts(session);
  renderBoatGeom(session);
  renderRelativePosition(session);
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
  if (!session || session.deviceId !== activeSessionId || !session.gatt.connected) {
    return;
  }
  meshtasticUiRefreshTimer = setInterval(() => {
    const active = getActiveSession();
    if (!active || active.deviceId !== activeSessionId || !active.gatt.connected) {
      return;
    }
    if (hasMeshtastic(active)) {
      renderMeshtastic(active);
      renderMarkBroadcasts(active);
      renderBoatGeom(active);
      renderRelativePosition(active);
    }
    renderGpsDisplay(active);
    renderImuDisplay(active);
    renderLocalTwr(active);
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
    session.meshtasticLineNotifyBuf = "";
  }
  const el = document.querySelector("#meshtastic-line-log");
  if (el) {
    el.textContent = "";
  }
}


function renderImuDisplay(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const at = session.imu.updatedAtMs;
  setText("imu-accel", withMetricAgo(session.imu.accel, at));
  setText("imu-gyro", withMetricAgo(session.imu.gyro, at));
  setText("imu-mag", withMetricAgo(session.imu.mag, at));
  setText("imu-temp", withMetricAgo(session.imu.temp, at));
  setText("imu-baro", withMetricAgo(session.imu.baro, at));
  setText("imu-meta", session.imu.meta);
}

function saveUiToSession(session: BleBoatSession): void {
  const mtInput = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  session.meshtasticTxDraft = mtInput?.value ?? "";
  const boatIdInput = document.querySelector<HTMLInputElement>("#boat-id-input");
  session.boatIdDraft = boatIdInput?.value ?? session.boatIdDraft;
  const typeSelect = document.querySelector<HTMLSelectElement>("#device-type-select");
  const typeParsed = typeSelect ? parseDeviceType(typeSelect.value) : null;
  if (typeParsed) {
    session.deviceTypeDraft = typeParsed;
  }
  const cfgDraft = dwm3000ConfigFromDraft();
  if (cfgDraft) {
    session.dwm3000ConfigDraft = cfgDraft;
  }
  session.dwm3000PeerDraft =
    document.querySelector<HTMLInputElement>("#dwm3000-peer-input")?.value ?? session.dwm3000PeerDraft;
}

function loadSessionToUi(session: BleBoatSession): void {
  const mtInput = document.querySelector<HTMLInputElement>("#meshtastic-tx-input");
  if (mtInput) {
    mtInput.value = session.meshtasticTxDraft;
  }
  renderImuDisplay(session);
  mergeMeshtasticPeersFromLog(session);
  renderMeshtastic(session);
  renderConsoleLog(session);
  renderGpsDisplay(session);
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
  renderMarkBroadcasts(null);
  renderBoatGeom(null);
  renderRelativePosition(null);
  clearConsoleLog(null);
  syncMeshtasticTabVisibility(null);
  syncMeshtasticUiRefresh(null);
  syncDwm3000TabVisibility(null);
  syncDwm3000Ui(null);
  syncUwbTestUi(null);
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
      updatedAtMs: Date.now(),
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

  session.onConsoleLogNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    ingestConsoleLogChunk(session, new TextDecoder().decode(v));
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
    charBoatId: null,
    charDeviceType: null,
    charDwm3000Config: null,
    charDwm3000Range: null,
    charGpsLine: null,
    charConsoleLog: null,
    boatId: "",
    boatIdDraft: "",
    deviceType: "boat",
    deviceTypeDraft: "boat",
    dwm3000Config: defaultDwm3000Config(),
    dwm3000ConfigDraft: defaultDwm3000Config(),
    dwm3000PeerDraft: "",
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    notificationsOn: false,
    imuNotificationsOn: false,
    meshtasticStats: defaultMeshtasticStats(),
    meshtasticStatsReceivedWallMs: 0,
    meshtasticStatsNotifyBuf: "",
    meshtasticLineNotifyBuf: "",
    meshtasticLineLogText: "",
    consoleLineNotifyBuf: "",
    consoleLineLogText: "",
    meshtasticTxDraft: "",
    markPort: null,
    markStarboard: null,
    boatGeom: null,
    tdoaTrail: [],
    localTwr: { ps_cm: null, pr_cm: null, sr_cm: null, ps_at_ms: 0, pr_at_ms: 0, sr_at_ms: 0 },
    registeredBoats: [],
    gpsFix: defaultGpsFix(),
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onMeshtasticLineNotify: () => {},
    onMeshtasticStatsNotify: () => {},
    onGpsLineNotify: () => {},
    onConsoleLogNotify: () => {},
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
    charBoatId: null,
    charDeviceType: null,
    charDwm3000Config: null,
    charDwm3000Range: null,
    charGpsLine: null,
    charConsoleLog: null,
    boatId: "",
    boatIdDraft: "",
    deviceType: "boat",
    deviceTypeDraft: "boat",
    dwm3000Config: defaultDwm3000Config(),
    dwm3000ConfigDraft: defaultDwm3000Config(),
    dwm3000PeerDraft: "",
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    notificationsOn: false,
    imuNotificationsOn: false,
    meshtasticStats: defaultMeshtasticStats(),
    meshtasticStatsReceivedWallMs: 0,
    meshtasticStatsNotifyBuf: "",
    meshtasticLineNotifyBuf: "",
    meshtasticLineLogText: "",
    consoleLineNotifyBuf: "",
    consoleLineLogText: "",
    meshtasticTxDraft: "",
    markPort: null,
    markStarboard: null,
    boatGeom: null,
    tdoaTrail: [],
    localTwr: { ps_cm: null, pr_cm: null, sr_cm: null, ps_at_ms: 0, pr_at_ms: 0, sr_at_ms: 0 },
    registeredBoats: [],
    gpsFix: defaultGpsFix(),
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onMeshtasticLineNotify: () => {},
    onMeshtasticStatsNotify: () => {},
    onGpsLineNotify: () => {},
    onConsoleLogNotify: () => {},
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
    if (btn.id === "console-log-clear") {
      clearConsoleLog(getActiveSession());
      return;
    }
    if (btn.id === "console-log-pause") {
      toggleConsoleLogPaused();
      return;
    }
    if (btn.id === "device-type-save") {
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
    if (target instanceof HTMLInputElement && target.id === "meshtastic-tx-input") {
      const session = getActiveSession();
      if (session) {
        void sendMeshtasticBroadcast(session);
      }
    }
  });
  document.addEventListener("input", (ev) => {
    const target = ev.target;
    if (target instanceof HTMLInputElement && target.id === "console-log-filter") {
      consoleLogFilter = target.value;
      paintConsoleLog(getActiveSession());
      return;
    }
    const session = getActiveSession();
    if (!session) {
      return;
    }
    if (target instanceof HTMLInputElement && target.id === "meshtastic-tx-input") {
      session.meshtasticTxDraft = target.value;
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
        target.id === "dwm3000-twr-input" || target.id.startsWith("dwm3000-registration-") ||
        target.id.startsWith("dwm3000-grant-") || target.id.startsWith("dwm3000-inactivity-") ||
        target.id.startsWith("dwm3000-baseline-") || target.id.startsWith("dwm3000-max-") ||
        target.id.startsWith("dwm3000-boat-") || target.id === "dwm3000-detailed-logs" ||
        target.id === "dwm3000-scheduler-paused")
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

  connectBtn.addEventListener("click", () => {
    if (activeSessionId && sessions.has(activeSessionId)) {
      void disconnectSession(activeSessionId);
      return;
    }
    void connectBle();
  });

  document.querySelector("#uwb-test-send")?.addEventListener("click", () => {
    void sendUwbTestMsg();
  });
  document.querySelector("#uwb-test-text-input")?.addEventListener("keydown", (ev) => {
    if (ev instanceof KeyboardEvent && ev.key === "Enter") {
      ev.preventDefault();
      void sendUwbTestMsg();
    }
  });
  document.querySelector("#uwb-test-log-clear")?.addEventListener("click", () => {
    const logEl = document.querySelector<HTMLElement>("#uwb-test-log");
    if (logEl) logEl.textContent = "";
  });

  initGpsLeafletMapStyle();

  document.querySelector("#ble-tabs")?.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement | null)?.closest(".ant-tabs-tab");
    if (!tab) {
      return;
    }
    const label = tab.textContent ?? "";
    const wantImu = label.includes("IMU");
    if (label.includes("Meshtastic")) {
      const session = getActiveSession();
      if (session?.gatt.connected) {
        // ng-zorro may remount the pane; push session state into the DOM again.
        renderMeshtastic(session);
        renderMarkBroadcasts(session);
        renderBoatGeom(session);
      }
    }
    if (label.includes("Position")) {
      requestAnimationFrame(() => {
        renderRelativePosition(getActiveSession());
        resizeRelativePositionChart();
      });
    }
    if (label.includes("DWM3000")) {
      renderLocalTwr(getActiveSession());
    }
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
  document.querySelector<HTMLInputElement>("#relative-position-flip-y")?.addEventListener("change", () => {
    renderRelativePosition(getActiveSession());
  });
  syncConsoleLogPauseUi();
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
  syncUwbTestUi(null);
  renderDeviceSelector();
  updateBleToolbar();
  syncActionButtons();
}
