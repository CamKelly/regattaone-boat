import { formatImuFields, parseImuPacket, PKT_MIN_SIZE } from "./lib/imu-protocol";
import {
  BLE_BOAT_ID_CHAR_UUID,
  BLE_IMU_CHAR_UUID,
  BLE_NOTECARD_REQ_CHAR_UUID,
  BLE_NOTECARD_RSP_CHAR_UUID,
  BLE_SERVICE_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
  BOAT_ID_MAX_LEN,
  BOAT_ID_BLE_NAME_MAX_LEN,
} from "./lib/protocol";

/** Bump when BLE connect logic changes — shown in UI so stale cached JS is obvious. */
const WEB_BLE_REV = "2026-05-23a";

const DEFAULT_IMU_META =
  "Connect to stream accel, gyro, mag, temperature, and pressure.";

interface ImuDisplay {
  accel: string;
  gyro: string;
  mag: string;
  temp: string;
  baro: string;
  meta: string;
}

interface BleBoatSession {
  deviceId: string;
  device: BluetoothDevice;
  gatt: BluetoothRemoteGATTServer;
  name: string;
  charImu: BluetoothRemoteGATTCharacteristic | null;
  charNotecardReq: BluetoothRemoteGATTCharacteristic | null;
  charNotecardRsp: BluetoothRemoteGATTCharacteristic | null;
  charUwbLine: BluetoothRemoteGATTCharacteristic | null;
  charUwbAt: BluetoothRemoteGATTCharacteristic | null;
  charBoatId: BluetoothRemoteGATTCharacteristic | null;
  boatId: string;
  boatIdDraft: string;
  notecardRspAcc: number[];
  uwbLineLogText: string;
  notecardJsonDraft: string;
  uwbAtDraft: string;
  lastImuWallMs: number;
  imu: ImuDisplay;
  connectionStatus: string;
  notificationsOn: boolean;
  imuNotificationsOn: boolean;
  /** True when GATT was intentionally disconnected to park this device in the list. */
  parked: boolean;
  gattChain: Promise<void>;
  onImuNotify: (ev: Event) => void;
  onNotecardRspNotify: (ev: Event) => void;
  onUwbLineNotify: (ev: Event) => void;
  onDisconnected: () => void;
}

const sessions = new Map<string, BleBoatSession>();
let activeSessionId: string | null = null;

let connectBtn!: HTMLButtonElement;
let statusEl: HTMLElement | null = null;
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
    updateToolbarSummary();
    setBleToolbar(`BLE: ${sessionDisplayName(session)} · ${sessions.size} device${sessions.size === 1 ? "" : "s"}`);
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
    input.disabled = !canEdit;
    input.value = session?.boatIdDraft ?? "";
    input.maxLength = BOAT_ID_MAX_LEN;
  }
  if (saveBtn) {
    saveBtn.disabled = !canEdit;
  }
  if (statusEl) {
    if (!session) {
      statusEl.textContent = "Connect a device to set its boat ID.";
    } else if (!session.charBoatId) {
      statusEl.textContent = "Flash firmware with boat ID support (0xFEFB) to enable.";
    } else if (session.boatId) {
      statusEl.textContent = `Stored on device: ${session.boatId}`;
    } else {
      statusEl.textContent = "No ID set — assign one to use as the BLE name (shown when adding/connecting).";
    }
  }
}

function setBleToolbar(text: string): void {
  if (bleStatusEl) {
    bleStatusEl.textContent = text;
  }
}

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setText(id: string, text: string): void {
  const el = document.querySelector(`#${id}`);
  if (el) {
    el.textContent = text;
  }
}

function syncActionButtons(): void {
  const session = getActiveSession();
  const ncSend = document.querySelector<HTMLButtonElement>("#notecard-send");
  const uwbSend = document.querySelector<HTMLButtonElement>("#uwb-at-send");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  const canWrite = session !== null && session.gatt.connected;
  if (ncSend) {
    ncSend.disabled = !canWrite || session.charNotecardReq === null;
  }
  if (uwbSend) {
    uwbSend.disabled = !canWrite || session.charUwbAt === null;
  }
  if (uwbInput) {
    uwbInput.disabled = !canWrite || session.charUwbAt === null;
  }
  syncBoatIdUi(session);
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
  session.charNotecardRsp?.removeEventListener("characteristicvaluechanged", session.onNotecardRspNotify);
  session.charUwbLine?.removeEventListener("characteristicvaluechanged", session.onUwbLineNotify);
}

async function bindSessionCharacteristics(session: BleBoatSession): Promise<string> {
  await setSessionNotifications(session, false);
  detachCharacteristicListeners(session);
  session.charImu = null;
  session.charNotecardReq = null;
  session.charNotecardRsp = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
  session.notificationsOn = false;
  session.imuNotificationsOn = false;

  const svc = await session.gatt.getPrimaryService(BLE_SERVICE_UUID);
  const parts: string[] = [`Web BLE ${WEB_BLE_REV}`];

  try {
    session.charImu = await svc.getCharacteristic(BLE_IMU_CHAR_UUID);
    session.charImu.addEventListener("characteristicvaluechanged", session.onImuNotify);
    parts.push("IMU ✓");
  } catch (e) {
    parts.push("IMU ✗");
    console.error("BLE IMU", session.name, e);
  }
  try {
    session.charUwbAt = await svc.getCharacteristic(BLE_UWB_AT_CHAR_UUID);
    parts.push("UWB AT ✓");
  } catch (e) {
    parts.push("UWB AT ✗");
    console.error("BLE UWB AT", session.name, e);
  }
  try {
    session.charUwbLine = await svc.getCharacteristic(BLE_UWB_LINE_CHAR_UUID);
    session.charUwbLine.addEventListener("characteristicvaluechanged", session.onUwbLineNotify);
    parts.push("UWB RX ✓");
  } catch (e) {
    parts.push("UWB RX ✗");
    console.error("BLE UWB line", session.name, e);
  }
  try {
    session.charNotecardReq = await svc.getCharacteristic(BLE_NOTECARD_REQ_CHAR_UUID);
    parts.push("NC req ✓");
  } catch (e) {
    parts.push("NC req —");
  }
  try {
    session.charNotecardRsp = await svc.getCharacteristic(BLE_NOTECARD_RSP_CHAR_UUID);
    session.charNotecardRsp.addEventListener("characteristicvaluechanged", session.onNotecardRspNotify);
    parts.push("NC rsp ✓");
  } catch (e) {
    parts.push("NC rsp —");
  }
  try {
    session.charBoatId = await svc.getCharacteristic(BLE_BOAT_ID_CHAR_UUID);
    parts.push("ID ✓");
  } catch (e) {
    session.charBoatId = null;
    parts.push("ID —");
  }

  return parts.join(" · ");
}

async function activateSession(session: BleBoatSession): Promise<boolean> {
  session.parked = false;
  try {
    if (!session.gatt.connected) {
      session.gatt = await session.device.gatt!.connect();
      try {
        const g = session.gatt as BluetoothRemoteGATTServer & { requestMtu?: (n: number) => Promise<number> };
        if (typeof g.requestMtu === "function") {
          await g.requestMtu(247);
        }
      } catch {
        /* optional */
      }
    }
    if (!session.charImu || !session.charUwbAt) {
      session.connectionStatus = await bindSessionCharacteristics(session);
    }
    await setSessionNotifications(session, true);
    await readBoatIdFromDevice(session);
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
  session.charNotecardReq = null;
  session.charNotecardRsp = null;
  session.charUwbLine = null;
  session.charUwbAt = null;
  session.charBoatId = null;
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
  if (session.charNotecardRsp) {
    ops.push(enabled ? session.charNotecardRsp.startNotifications() : session.charNotecardRsp.stopNotifications());
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

type GattWriteTarget = "notecard" | "uwb" | "boatid";

function getWriteCharacteristic(session: BleBoatSession, target: GattWriteTarget): BluetoothRemoteGATTCharacteristic | null {
  if (target === "notecard") {
    return session.charNotecardReq;
  }
  if (target === "uwb") {
    return session.charUwbAt;
  }
  return session.charBoatId;
}

async function gattWrite(session: BleBoatSession, target: GattWriteTarget, data: BufferSource): Promise<void> {
  if (!(await ensureSessionConnected(session))) {
    throw new Error("Device not connected");
  }
  const imuWasOn = session.imuNotificationsOn;
  if (imuWasOn) {
    await setImuNotifications(session, false);
  }
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const char = getWriteCharacteristic(session, target);
      if (!char) {
        throw new Error("Characteristic unavailable");
      }
      try {
        await runGattOp(session, () => char.writeValue(data));
        return;
      } catch (e) {
        lastErr = e;
        if (attempt === 0 && session.gatt.connected) {
          session.connectionStatus = await bindSessionCharacteristics(session);
          if (session.deviceId === activeSessionId) {
            await setCommsNotifications(session, true);
          }
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    if (imuWasOn && session.deviceId === activeSessionId && session.gatt.connected) {
      await setImuNotifications(session, true);
    }
  }
}

function renderNotecardRsp(session: BleBoatSession): void {
  if (session.deviceId !== activeSessionId) {
    return;
  }
  const el = document.querySelector("#notecard-rsp-log");
  if (!el) {
    return;
  }
  el.textContent = new TextDecoder().decode(new Uint8Array(session.notecardRspAcc));
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
  const ncTa = document.querySelector<HTMLTextAreaElement>("#notecard-json");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  session.notecardJsonDraft = ncTa?.value ?? "";
  session.uwbAtDraft = uwbInput?.value ?? "";
  const boatIdInput = document.querySelector<HTMLInputElement>("#boat-id-input");
  session.boatIdDraft = boatIdInput?.value ?? session.boatIdDraft;
}

function loadSessionToUi(session: BleBoatSession): void {
  const ncTa = document.querySelector<HTMLTextAreaElement>("#notecard-json");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  if (ncTa) {
    ncTa.value = session.notecardJsonDraft;
  }
  if (uwbInput) {
    uwbInput.value = session.uwbAtDraft;
  }
  renderImuDisplay(session);
  renderNotecardRsp(session);
  renderUwbLog(session);
  setStatus(session.connectionStatus);
  setBleToolbar(`BLE: ${sessionDisplayName(session)} · ${sessions.size} device${sessions.size === 1 ? "" : "s"}`);
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
  const ncTa = document.querySelector<HTMLTextAreaElement>("#notecard-json");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  if (ncTa) {
    ncTa.value = "";
  }
  if (uwbInput) {
    uwbInput.value = "";
  }
  const ncRsp = document.querySelector("#notecard-rsp-log");
  const uwbLog = document.querySelector("#uwb-line-log");
  if (ncRsp) {
    ncRsp.textContent = "";
  }
  if (uwbLog) {
    uwbLog.textContent = "";
  }
}

function updateToolbarSummary(): void {
  const n = sessions.size;
  if (n === 0) {
    setBleToolbar("BLE: —");
    return;
  }
  const active = getActiveSession();
  if (active) {
    setBleToolbar(`BLE: ${sessionDisplayName(active)} · ${n} device${n === 1 ? "" : "s"}`);
  } else {
    setBleToolbar(`BLE: ${n} device${n === 1 ? "" : "s"} connected`);
  }
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
    setStatus(`${next.name} could not connect.`);
    syncActionButtons();
    renderDeviceSelector();
    return;
  }
  loadSessionToUi(next);
  renderDeviceSelector();
  updateToolbarSummary();
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

  session.onNotecardRspNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v) {
      return;
    }
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (let i = 0; i < u8.length; i++) {
      session.notecardRspAcc.push(u8[i]!);
    }
    renderNotecardRsp(session);
  };

  session.onUwbLineNotify = (ev: Event) => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic;
    const v = ch.value;
    if (!v) {
      return;
    }
    const s = new TextDecoder().decode(v);
    if (s.length > 0) {
      appendUwbLog(session, s.endsWith("\n") ? s : `${s}\n`);
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
  session.device.removeEventListener("gattserverdisconnected", session.onDisconnected);
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
      setStatus(
        wasManualDisconnect
          ? `Disconnected. Web BLE ${WEB_BLE_REV} — add a device to connect.`
          : "Device disconnected unexpectedly.",
      );
      syncActionButtons();
    }
  }

  renderDeviceSelector();
  updateToolbarSummary();
}

async function sendNotecardRequest(): Promise<void> {
  const session = getActiveSession();
  if (!session?.charNotecardReq) {
    return;
  }
  const ta = document.querySelector<HTMLTextAreaElement>("#notecard-json");
  const body = (ta?.value ?? "").trim();
  if (!body) {
    return;
  }
  try {
    JSON.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const el = document.querySelector("#notecard-rsp-log");
    if (el) {
      el.textContent =
        `Invalid JSON before send: ${msg}\n` +
        `Use a colon between key and value, e.g. {"req":"hub.status"}`;
    }
    return;
  }
  const line = body.endsWith("\n") ? body : `${body}\n`;
  session.notecardJsonDraft = ta?.value ?? "";
  session.notecardRspAcc.length = 0;
  renderNotecardRsp(session);
  try {
    await gattWrite(session, "notecard", new TextEncoder().encode(line));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const el = document.querySelector("#notecard-rsp-log");
    if (el) {
      el.textContent = `Write error: ${msg}`;
    }
  }
}

async function sendUwbAt(): Promise<void> {
  const session = getActiveSession();
  if (!session?.charUwbAt) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>("#uwb-at-input");
  let cmd = (input?.value ?? "").trim();
  if (!cmd) {
    return;
  }
  session.uwbAtDraft = input?.value ?? "";
  appendUwbLog(session, `> ${cmd}\n`);
  try {
    await gattWrite(session, "uwb", new TextEncoder().encode(cmd));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendUwbLog(session, `! BLE write error: ${msg}\n`);
  }
}

async function setupGattSession(dev: BluetoothDevice): Promise<BleBoatSession> {
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
    gatt,
    name: dev.name ?? "RegattaOne-Boat",
    charImu: null,
    charNotecardReq: null,
    charNotecardRsp: null,
    charUwbLine: null,
    charUwbAt: null,
    charBoatId: null,
    boatId: "",
    boatIdDraft: "",
    notecardRspAcc: [],
    uwbLineLogText: "",
    notecardJsonDraft: "",
    uwbAtDraft: "",
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    connectionStatus: "",
    notificationsOn: false,
    imuNotificationsOn: false,
    parked: false,
    gattChain: Promise.resolve(),
    onImuNotify: () => {},
    onNotecardRspNotify: () => {},
    onUwbLineNotify: () => {},
    onDisconnected: () => {},
  };
  createNotifyHandlers(session);

  session.connectionStatus = await bindSessionCharacteristics(session);

  dev.addEventListener("gattserverdisconnected", session.onDisconnected);
  return session;
}

async function connectBle(): Promise<void> {
  if (!navigator.bluetooth) {
    setStatus("Web Bluetooth not available. Use Chrome on HTTPS or localhost.");
    return;
  }

  connectBtn.disabled = true;
  setStatus("Selecting device…");
  setBleToolbar("BLE: selecting…");

  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: [
        BLE_SERVICE_UUID,
        BLE_IMU_CHAR_UUID,
        BLE_NOTECARD_REQ_CHAR_UUID,
        BLE_NOTECARD_RSP_CHAR_UUID,
        BLE_UWB_LINE_CHAR_UUID,
        BLE_UWB_AT_CHAR_UUID,
        BLE_BOAT_ID_CHAR_UUID,
      ],
    });

    if (sessions.has(dev.id)) {
      await setActiveSession(dev.id);
      setStatus(`${dev.name ?? "Device"} is already connected — switched to it.`);
      return;
    }

    setStatus(`Connecting to ${dev.name ?? "device"}…`);
    setBleToolbar("BLE: connecting…");

    const activeBeforeConnect = getActiveSession();
    if (activeBeforeConnect) {
      await deactivateSession(activeBeforeConnect);
    }

    const session = await setupGattSession(dev);
    sessions.set(session.deviceId, session);
    await setActiveSession(session.deviceId);
    renderDeviceSelector();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("cancel")) {
      const active = getActiveSession();
      if (active) {
        setStatus(active.connectionStatus);
      } else {
        setStatus(`No device selected. Web BLE ${WEB_BLE_REV}`);
      }
    } else {
      setStatus(`Error: ${msg}`);
    }
    updateToolbarSummary();
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
  document.body.dataset["appScreen"] = "boat";
  document.body.dataset["appTab"] = "main";

  connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
  statusEl = document.querySelector("#boat-status");
  bleStatusEl = document.querySelector("#ble-status");
  deviceSelectEl = document.querySelector<HTMLSelectElement>("#ble-device-select");
  deviceDisconnectBtn = document.querySelector<HTMLButtonElement>("#ble-device-disconnect");

  document.querySelector("#notecard-send")?.addEventListener("click", () => void sendNotecardRequest());
  document.querySelector("#uwb-at-send")?.addEventListener("click", () => void sendUwbAt());
  document.querySelector("#uwb-at-input")?.addEventListener("keydown", (ev) => {
    if (ev instanceof KeyboardEvent && ev.key === "Enter") {
      void sendUwbAt();
    }
  });
  document.querySelector<HTMLTextAreaElement>("#notecard-json")?.addEventListener("input", (ev) => {
    const session = getActiveSession();
    if (session && ev.target instanceof HTMLTextAreaElement) {
      session.notecardJsonDraft = ev.target.value;
    }
  });
  document.querySelector<HTMLInputElement>("#uwb-at-input")?.addEventListener("input", (ev) => {
    const session = getActiveSession();
    if (session && ev.target instanceof HTMLInputElement) {
      session.uwbAtDraft = ev.target.value;
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

  document.querySelector("#boat-id-save")?.addEventListener("click", () => void saveBoatIdToDevice());
  document.querySelector<HTMLInputElement>("#boat-id-input")?.addEventListener("input", (ev) => {
    const session = getActiveSession();
    if (session && ev.target instanceof HTMLInputElement) {
      session.boatIdDraft = ev.target.value;
    }
  });

  connectBtn.addEventListener("click", () => void connectBle());

  setBleToolbar("BLE: —");
  clearUiPanels();
  syncBoatIdUi(null);
  renderDeviceSelector();
  setStatus(
    `No devices connected. Add RegattaOne-Boat devices (service 0xFEF0).\nWeb BLE ${WEB_BLE_REV} — hard-refresh (Cmd+Shift+R) if controls stay disabled.`,
  );
  syncActionButtons();
}
