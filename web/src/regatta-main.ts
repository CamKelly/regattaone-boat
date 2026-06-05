import {
  clearGpsLeafletMap,
  invalidateGpsLeafletMapSize,
  recenterGpsLeafletMap,
  updateGpsLeafletMap,
} from "./lib/gps-leaflet-map";
import { formatImuFields, parseImuPacket, PKT_MIN_SIZE } from "./lib/imu-protocol";
import {
  applyNmeaLine,
  defaultGpsFix,
  estimateHorizontalAccuracyM,
  fixQualityLabel,
  fixTypeLabel,
  formatAccuracyM,
  formatAltitudeM,
  formatCoordDeg,
  formatCourseDeg,
  formatDop,
  formatSpeedKnots,
  formatUtc,
  openStreetMapUrl,
  type GpsFix,
} from "./lib/nmea-parse";
import {
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
  BLE_GPS_LINE_CHAR_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_LORA_LINE_CHAR_UUID,
  BLE_LORA_TX_CHAR_UUID,
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
const WEB_BLE_REV = "2026-06-03a";

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

const BLE_OPTIONAL_SERVICES = [
  BLE_SERVICE_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_LORA_TX_CHAR_UUID,
  BLE_LORA_LINE_CHAR_UUID,
  BLE_GPS_LINE_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_BOAT_ID_CHAR_UUID,
  BLE_DEVICE_TYPE_CHAR_UUID,
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
  charGpsLine: BleGattCharacteristicLike | null;
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
  gpsFix: GpsFix;
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
  uwbBusy: boolean;
  /** True when GATT was intentionally disconnected to park this device in the list. */
  parked: boolean;
  gattChain: Promise<void>;
  onImuNotify: (ev: Event) => void;
  onLoraLineNotify: (ev: Event) => void;
  onGpsLineNotify: (ev: Event) => void;
  onUwbLineNotify: (ev: Event) => void;
  onDisconnected: () => void;
}

const sessions = new Map<string, BleBoatSession>();
let activeSessionId: string | null = null;

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
  if (!active.charLoraTx) {
    missing.push("LoRa");
  }
  if (!active.charGpsLine) {
    missing.push("GPS");
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
  session.charGpsLine?.removeEventListener("characteristicvaluechanged", session.onGpsLineNotify);
  session.charUwbLine?.removeEventListener("characteristicvaluechanged", session.onUwbLineNotify);
}

async function bindSessionCharacteristics(session: BleBoatSession): Promise<void> {
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charLoraTx = null;
  session.charLoraLine = null;
  session.charGpsLine = null;
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
  } catch (e) {
    console.warn("BLE LoRa TX unavailable", session.name, e);
  }
  try {
    session.charLoraLine = await svc.getCharacteristic(BLE_LORA_LINE_CHAR_UUID);
    session.charLoraLine.addEventListener("characteristicvaluechanged", session.onLoraLineNotify);
  } catch (e) {
    console.warn("BLE LoRa RX unavailable", session.name, e);
  }
  try {
    session.charGpsLine = await svc.getCharacteristic(BLE_GPS_LINE_CHAR_UUID);
    session.charGpsLine.addEventListener("characteristicvaluechanged", session.onGpsLineNotify);
  } catch (e) {
    console.warn("BLE GPS NMEA unavailable", session.name, e);
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

function ingestGpsNmea(session: BleBoatSession, chunk: string): void {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) {
    return;
  }
  applyNmeaLine(session.gpsFix, trimmed);
  renderGpsDisplay(session);
}

function renderGpsDisplay(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const fix = session.gpsFix;
  const acc = estimateHorizontalAccuracyM(fix.hdop);

  const ppsNote =
    fix.ppsCount !== null
      ? ` · PPS ${fix.ppsCount}${fix.ppsUpdatedAtMs > 0 ? ` (last edge ${Math.max(0, Math.round(performance.now() - fix.ppsUpdatedAtMs))} ms ago)` : ""}`
      : "";

  if (fix.updatedAtMs === 0 && fix.ppsCount === null) {
    setText("gps-meta", "Waiting for NMEA sentences…");
  } else if (fix.fixValid && fix.lat !== null && fix.lon !== null) {
    setText(
      "gps-meta",
      `Fix OK · last ${fix.lastSentence ?? "?"} · updated ${Math.max(0, Math.round(performance.now() - fix.updatedAtMs))} ms ago${ppsNote}`,
    );
  } else {
    setText(
      "gps-meta",
      `No valid fix · last ${fix.lastSentence ?? "?"} · ${fixQualityLabel(fix.fixQuality)}${ppsNote}`,
    );
  }

  if (fix.lat !== null && fix.lon !== null) {
    setText(
      "gps-position",
      `${formatCoordDeg(fix.lat, true)}\n${formatCoordDeg(fix.lon, false)}`,
    );
  } else {
    setText("gps-position", "—");
  }

  const fixParts = [fixQualityLabel(fix.fixQuality)];
  if (fix.fixType !== null) {
    fixParts.push(fixTypeLabel(fix.fixType));
  }
  if (fix.fixMode) {
    fixParts.push(fix.fixMode === "A" ? "auto" : fix.fixMode === "M" ? "manual" : fix.fixMode);
  }
  setText("gps-fix", fix.fixValid ? fixParts.join(" · ") : `No fix · ${fixParts.join(" · ")}`);
  setText("gps-accuracy", formatAccuracyM(acc));
  setText("gps-sog", formatSpeedKnots(fix.sogKnots));
  setText("gps-cog", formatCourseDeg(fix.cogDeg));
  setText("gps-altitude", formatAltitudeM(fix.altitudeM, fix.geoidSepM));
  setText(
    "gps-sats",
    fix.satsUsed !== null || fix.satsInView !== null
      ? `${fix.satsUsed ?? "—"} used · ${fix.satsInView ?? "—"} in view`
      : "—",
  );
  setText(
    "gps-dop",
    `${formatDop(fix.hdop)} / ${formatDop(fix.vdop)} / ${formatDop(fix.pdop)}`,
  );
  setText("gps-utc", formatUtc(fix.utcTime, fix.utcDate));
  setText(
    "gps-magvar",
    fix.magneticVariationDeg !== null ? `${fix.magneticVariationDeg.toFixed(1)}°` : "—",
  );
  if (fix.ppsCount !== null) {
    const age =
      fix.ppsUpdatedAtMs > 0 ? `${Math.max(0, Math.round(performance.now() - fix.ppsUpdatedAtMs))} ms ago` : "—";
    setText("gps-pps", `${fix.ppsCount} pulses · last edge ${age}`);
  } else {
    setText("gps-pps", "—");
  }

  updateGpsMap(session, fix);
}

function updateGpsMap(_session: BleBoatSession, fix: GpsFix): void {
  const hint = document.querySelector<HTMLElement>("#gps-map-hint");
  const link = document.querySelector<HTMLAnchorElement>("#gps-map-link");
  if (!hint || !link) {
    return;
  }

  if (!fix.fixValid || fix.lat === null || fix.lon === null) {
    clearGpsLeafletMap();
    hint.hidden = false;
    link.hidden = true;
    return;
  }

  updateGpsLeafletMap(fix.lat, fix.lon);
  link.href = openStreetMapUrl(fix.lat, fix.lon);
  link.hidden = false;
  hint.hidden = true;
}

function clearGpsDisplay(session: BleBoatSession | null): void {
  if (session) {
    session.gpsFix = defaultGpsFix();
  }
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
  setText("gps-meta", "Waiting for NMEA fix…");
  for (const id of [
    "gps-position",
    "gps-fix",
    "gps-accuracy",
    "gps-sog",
    "gps-cog",
    "gps-altitude",
    "gps-sats",
    "gps-dop",
    "gps-utc",
    "gps-magvar",
    "gps-pps",
  ]) {
    setText(id, "—");
  }
}

function appendStreamLine(session: BleBoatSession, field: "loraLineLogText", chunk: string): void {
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
  }
}

function defaultLoraRadioStatus(session: BleBoatSession): string {
  if (!session.charLoraTx || !session.charLoraLine) {
    return "unavailable — flash CONFIG_REGATTAONE_SX1262_ENABLE=y and reconnect";
  }
  return session.gatt.connected ? "waiting for notify…" : "not connected";
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
    if (!session.charImu || !session.charUwbAt) {
      await bindSessionCharacteristics(session);
    }
    await setCommsNotifications(session, true);
    imuTabActive = true;
    await setImuNotifications(session, true);
    await readBoatIdFromDevice(session);
    await readDeviceTypeFromDevice(session);
    syncBoatIdUi(session);
    syncDeviceTypeUi(session);
    if (!session.loraRadioStatus) {
      session.loraRadioStatus = defaultLoraRadioStatus(session);
    }
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
  session.parked = true;
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charLoraTx = null;
  session.charLoraLine = null;
  session.charGpsLine = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
  session.charDeviceType = null;
  session.notificationsOn = false;
  session.imuNotificationsOn = false;
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
  const ops: Promise<unknown>[] = [];
  if (session.charUwbLine) {
    ops.push(enabled ? session.charUwbLine.startNotifications() : session.charUwbLine.stopNotifications());
  }
  if (session.charLoraLine) {
    ops.push(enabled ? session.charLoraLine.startNotifications() : session.charLoraLine.stopNotifications());
  }
  if (session.charGpsLine) {
    ops.push(enabled ? session.charGpsLine.startNotifications() : session.charGpsLine.stopNotifications());
  }
  const results = await Promise.allSettled(ops);
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

type GattWriteTarget = "lora" | "uwb" | "boatid" | "type";

function getWriteCharacteristic(session: BleBoatSession, target: GattWriteTarget): BleGattCharacteristicLike | null {
  if (target === "lora") {
    return session.charLoraTx;
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
    if (isLoraRxLogLine(trimmed)) {
      appendStreamLine(session, "loraLineLogText", `${trimmed}\n`);
    }
  }
}

/** TX/stream/errors are not shown in the LoRa log (RX packets only). */
function appendLoraLog(_session: BleBoatSession, _chunk: string): void {}

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
  session.loraTxDraft = loraInput?.value ?? "";
  session.uwbAtDraft = uwbInput?.value ?? "";
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
  if (loraInput) {
    loraInput.value = session.loraTxDraft;
  }
  if (uwbInput) {
    uwbInput.value = session.uwbAtDraft;
  }
  renderImuDisplay(session);
  renderLoraLog(session);
  renderLoraStatus(session);
  syncLoraStreamUi(session);
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
  syncLoraStreamUi(null);
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

  session.onGpsLineNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v || v.byteLength === 0) {
      return;
    }
    const chunk = new TextDecoder().decode(v);
    ingestGpsNmea(session, chunk);
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
  const streaming = session?.loraStreamRunning === true;
  const loraSend = document.querySelector<HTMLButtonElement>("#lora-tx-send");
  const loraInput = document.querySelector<HTMLInputElement>("#lora-tx-input");
  const ttlInput = document.querySelector<HTMLInputElement>("#lora-ttl-input");
  const intervalInput = document.querySelector<HTMLInputElement>("#lora-interval-input");
  const startBtn = document.querySelector<HTMLButtonElement>("#lora-stream-start");
  const stopBtn = document.querySelector<HTMLButtonElement>("#lora-stream-stop");
  const statusEl = document.querySelector("#lora-stream-status");

  if (loraSend) {
    loraSend.disabled = !session || streaming;
  }
  if (loraInput) {
    loraInput.disabled = !session || streaming;
  }
  if (ttlInput) {
    ttlInput.disabled = !session || streaming;
  }
  if (intervalInput) {
    intervalInput.disabled = !session || streaming;
  }
  if (startBtn) {
    startBtn.disabled = !session || streaming;
  }
  if (stopBtn) {
    stopBtn.disabled = !session || !streaming;
  }
  if (statusEl) {
    if (!session) {
      statusEl.textContent = "Stream: connect BLE first";
    } else if (streaming) {
      statusEl.textContent = `Stream: sending (next #${session.loraStreamSeq})`;
    } else {
      statusEl.textContent = "Stream: stopped";
    }
  }
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
    const msg =
      "! LoRa TX 0xFEF7 unavailable — flash CONFIG_REGATTAONE_SX1262_ENABLE=y and reconnect.\n";
    session.loraRadioStatus = "unavailable — SX1262 not enabled in firmware";
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
  const base = loraBasePayload();
  if (!base) {
    return;
  }
  session.loraTxDraft = document.querySelector<HTMLInputElement>("#lora-tx-input")?.value ?? "";
  session.loraStreamSeq = 1;
  session.loraStreamRunning = true;
  syncLoraStreamUi(session);
  appendLoraLog(session, `>> stream started (interval ${parseLoraIntervalMs()} ms)\n`);
  await loraStreamStep(session);
}

function stopLoraStreamActive(): void {
  stopLoraStream(getActiveSession());
}

async function sendLoraTx(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    const msg =
      "! LoRa TX 0xFEF7 unavailable — flash CONFIG_REGATTAONE_SX1262_ENABLE=y and reconnect.\n";
    const statusEl = document.querySelector("#lora-status");
    if (statusEl) {
      statusEl.textContent = "LoRa radio: connect a BLE device first";
    }
    return;
  }
  if (session.loraStreamRunning) {
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
    charGpsLine: null,
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
    gpsFix: defaultGpsFix(),
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
    uwbBusy: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onLoraLineNotify: () => {},
    onGpsLineNotify: () => {},
    onUwbLineNotify: () => {},
    onDisconnected: () => {},
  };
  session.loraRadioStatus = defaultLoraRadioStatus(session);
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
    charGpsLine: null,
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
    gpsFix: defaultGpsFix(),
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
    uwbBusy: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onLoraLineNotify: () => {},
    onGpsLineNotify: () => {},
    onUwbLineNotify: () => {},
    onDisconnected: () => {},
  };
  session.loraRadioStatus = defaultLoraRadioStatus(session);
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
    if (btn.id === "device-type-save") {
      void saveDeviceTypeToDevice();
      return;
    }
    if (btn.id === "boat-id-save") {
      void saveBoatIdToDevice();
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

  document.querySelector("#gps-map-recenter")?.addEventListener("click", () => {
    recenterGpsLeafletMap();
  });

  document.querySelector("#ble-tabs")?.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement | null)?.closest(".ant-tabs-tab");
    if (!tab) {
      return;
    }
    const label = tab.textContent ?? "";
    const wantImu = label.includes("IMU");
    if (label.includes("GPS")) {
      requestAnimationFrame(() => invalidateGpsLeafletMapSize());
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
