import { formatImuFields, parseImuPacket, PKT_MIN_SIZE } from "./lib/imu-protocol";
import {
  BLE_IMU_CHAR_UUID,
  BLE_NOTECARD_REQ_CHAR_UUID,
  BLE_NOTECARD_RSP_CHAR_UUID,
  BLE_SERVICE_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
} from "./lib/protocol";

/** Bump when BLE connect logic changes — shown in UI so stale cached JS is obvious. */
const WEB_BLE_REV = "2026-05-22a";

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
  notecardRspAcc: number[];
  uwbLineLogText: string;
  notecardJsonDraft: string;
  uwbAtDraft: string;
  lastImuWallMs: number;
  imu: ImuDisplay;
  connectionStatus: string;
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
let deviceListEl: HTMLElement | null = null;

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
  const hasSession = session !== null;
  if (ncSend) {
    ncSend.disabled = !hasSession || session.charNotecardReq === null;
  }
  if (uwbSend) {
    uwbSend.disabled = !hasSession || session.charUwbAt === null;
  }
  if (uwbInput) {
    uwbInput.disabled = !hasSession || session.charUwbAt === null;
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
  setBleToolbar(`BLE: ${session.name} (${sessions.size} connected)`);
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
    setBleToolbar(`BLE: ${active.name} · ${n} device${n === 1 ? "" : "s"}`);
  } else {
    setBleToolbar(`BLE: ${n} device${n === 1 ? "" : "s"} connected`);
  }
}

function renderDeviceList(): void {
  if (!deviceListEl) {
    return;
  }
  deviceListEl.replaceChildren();

  if (sessions.size === 0) {
    const empty = document.createElement("p");
    empty.className = "ble-device-list-empty hint";
    empty.textContent = "No devices connected. Use Add device to connect.";
    deviceListEl.appendChild(empty);
    return;
  }

  for (const session of sessions.values()) {
    const row = document.createElement("div");
    row.className = "ble-device-row";
    if (session.deviceId === activeSessionId) {
      row.classList.add("ble-device-row--active");
    }

    const name = document.createElement("span");
    name.className = "ble-device-name";
    name.textContent = session.deviceId === activeSessionId ? `${session.name} (active)` : session.name;

    const actions = document.createElement("div");
    actions.className = "ble-device-actions";

    if (session.deviceId !== activeSessionId) {
      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "regatta-ble-btn regatta-ble-btn--secondary ble-device-select";
      selectBtn.textContent = "Use";
      selectBtn.addEventListener("click", () => setActiveSession(session.deviceId));
      actions.appendChild(selectBtn);
    }

    const disconnectBtn = document.createElement("button");
    disconnectBtn.type = "button";
    disconnectBtn.className = "regatta-ble-btn ble-device-disconnect";
    disconnectBtn.textContent = "Disconnect";
    disconnectBtn.addEventListener("click", () => void disconnectSession(session.deviceId));
    actions.appendChild(disconnectBtn);

    row.appendChild(name);
    row.appendChild(actions);
    deviceListEl.appendChild(row);
  }
}

function setActiveSession(deviceId: string): void {
  const next = sessions.get(deviceId);
  if (!next) {
    return;
  }
  const prev = getActiveSession();
  if (prev && prev.deviceId !== deviceId) {
    saveUiToSession(prev);
  }
  activeSessionId = deviceId;
  loadSessionToUi(next);
  renderDeviceList();
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
    removeSession(session.deviceId, false);
  };
}

function teardownSession(session: BleBoatSession): void {
  session.charImu?.removeEventListener("characteristicvaluechanged", session.onImuNotify);
  session.charNotecardRsp?.removeEventListener("characteristicvaluechanged", session.onNotecardRspNotify);
  session.charUwbLine?.removeEventListener("characteristicvaluechanged", session.onUwbLineNotify);
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
      setActiveSession(remaining.deviceId);
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

  renderDeviceList();
  updateToolbarSummary();
}

async function sendNotecardRequest(): Promise<void> {
  const session = getActiveSession();
  if (!session?.charNotecardReq) {
    return;
  }
  const ta = document.querySelector<HTMLTextAreaElement>("#notecard-json");
  let line = (ta?.value ?? "").trim();
  if (!line) {
    return;
  }
  if (!line.endsWith("\n")) {
    line += "\n";
  }
  session.notecardJsonDraft = ta?.value ?? "";
  session.notecardRspAcc.length = 0;
  renderNotecardRsp(session);
  try {
    await session.charNotecardReq.writeValue(new TextEncoder().encode(line));
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
    await session.charUwbAt.writeValue(new TextEncoder().encode(cmd));
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
    notecardRspAcc: [],
    uwbLineLogText: "",
    notecardJsonDraft: "",
    uwbAtDraft: "",
    lastImuWallMs: 0,
    imu: defaultImuDisplay(),
    connectionStatus: "",
    onImuNotify: () => {},
    onNotecardRspNotify: () => {},
    onUwbLineNotify: () => {},
    onDisconnected: () => {},
  };
  createNotifyHandlers(session);

  const svc = await gatt.getPrimaryService(BLE_SERVICE_UUID);
  const parts: string[] = [`Web BLE ${WEB_BLE_REV}`];

  try {
    session.charImu = await svc.getCharacteristic(BLE_IMU_CHAR_UUID);
    session.charImu.addEventListener("characteristicvaluechanged", session.onImuNotify);
    await session.charImu.startNotifications();
    parts.push("IMU ✓");
  } catch (e) {
    session.charImu = null;
    parts.push("IMU ✗");
    console.error("BLE IMU", e);
  }
  try {
    session.charUwbAt = await svc.getCharacteristic(BLE_UWB_AT_CHAR_UUID);
    parts.push("UWB AT ✓");
  } catch (e) {
    session.charUwbAt = null;
    parts.push("UWB AT ✗");
    console.error("BLE UWB AT", e);
  }
  try {
    session.charUwbLine = await svc.getCharacteristic(BLE_UWB_LINE_CHAR_UUID);
    session.charUwbLine.addEventListener("characteristicvaluechanged", session.onUwbLineNotify);
    await session.charUwbLine.startNotifications();
    parts.push("UWB RX ✓");
  } catch (e) {
    session.charUwbLine = null;
    parts.push("UWB RX ✗");
    console.error("BLE UWB line", e);
  }
  try {
    session.charNotecardReq = await svc.getCharacteristic(BLE_NOTECARD_REQ_CHAR_UUID);
    parts.push("NC req ✓");
  } catch (e) {
    session.charNotecardReq = null;
    parts.push("NC req —");
  }
  try {
    session.charNotecardRsp = await svc.getCharacteristic(BLE_NOTECARD_RSP_CHAR_UUID);
    session.charNotecardRsp.addEventListener("characteristicvaluechanged", session.onNotecardRspNotify);
    await session.charNotecardRsp.startNotifications();
    parts.push("NC rsp ✓");
  } catch (e) {
    session.charNotecardRsp = null;
    parts.push("NC rsp —");
  }

  session.connectionStatus = parts.join(" · ");
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
      ],
    });

    if (sessions.has(dev.id)) {
      setActiveSession(dev.id);
      setStatus(`${dev.name ?? "Device"} is already connected — switched to it.`);
      return;
    }

    setStatus(`Connecting to ${dev.name ?? "device"}…`);
    setBleToolbar("BLE: connecting…");

    const session = await setupGattSession(dev);
    sessions.set(session.deviceId, session);
    setActiveSession(session.deviceId);
    renderDeviceList();
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
  deviceListEl = document.querySelector("#ble-device-list");

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

  connectBtn.addEventListener("click", () => void connectBle());

  setBleToolbar("BLE: —");
  clearUiPanels();
  renderDeviceList();
  setStatus(
    `No devices connected. Add RegattaOne-Boat devices (service 0xFEF0).\nWeb BLE ${WEB_BLE_REV} — hard-refresh (Cmd+Shift+R) if controls stay disabled.`,
  );
  syncActionButtons();
}
