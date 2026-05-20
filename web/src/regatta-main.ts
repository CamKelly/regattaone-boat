import { formatImuFields, parseImuPacket, PKT_MIN_SIZE } from "./lib/imu-protocol";
import {
  BLE_IMU_CHAR_UUID,
  BLE_NOTECARD_REQ_CHAR_UUID,
  BLE_NOTECARD_RSP_CHAR_UUID,
  BLE_SERVICE_UUID,
  BLE_UWB_AT_CHAR_UUID,
  BLE_UWB_LINE_CHAR_UUID,
} from "./lib/protocol";

let gatt: BluetoothRemoteGATTServer | null = null;
let charImu: BluetoothRemoteGATTCharacteristic | null = null;
let charNotecardReq: BluetoothRemoteGATTCharacteristic | null = null;
let charNotecardRsp: BluetoothRemoteGATTCharacteristic | null = null;
let charUwbLine: BluetoothRemoteGATTCharacteristic | null = null;
let charUwbAt: BluetoothRemoteGATTCharacteristic | null = null;

let connectBtn!: HTMLButtonElement;
let disconnectBtn!: HTMLButtonElement;
let statusEl: HTMLElement | null = null;
let bleStatusEl: HTMLElement | null = null;

/** Bump when BLE connect logic changes — shown in UI so stale cached JS is obvious. */
const WEB_BLE_REV = "2026-05-20a";

const notecardRspAcc: number[] = [];
let uwbLineLogText = "";
let lastImuWallMs = 0;

function bleErrMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  const ncSend = document.querySelector<HTMLButtonElement>("#notecard-send");
  const uwbSend = document.querySelector<HTMLButtonElement>("#uwb-at-send");
  const uwbInput = document.querySelector<HTMLInputElement>("#uwb-at-input");
  if (ncSend) {
    ncSend.disabled = charNotecardReq === null;
  }
  if (uwbSend) {
    uwbSend.disabled = charUwbAt === null;
  }
  if (uwbInput) {
    uwbInput.disabled = charUwbAt === null;
  }
}

function renderNotecardRspFromAcc(): void {
  const el = document.querySelector("#notecard-rsp-log");
  if (!el) {
    return;
  }
  el.textContent = new TextDecoder().decode(new Uint8Array(notecardRspAcc));
}

function appendUwbLog(chunk: string): void {
  uwbLineLogText += chunk;
  if (uwbLineLogText.length > 16000) {
    uwbLineLogText = uwbLineLogText.slice(-12000);
  }
  const el = document.querySelector("#uwb-line-log");
  if (el) {
    el.textContent = uwbLineLogText;
    el.scrollTop = el.scrollHeight;
  }
}

function onNotecardRspNotify(ev: Event): void {
  const ch = ev.target as BluetoothRemoteGATTCharacteristic;
  const v = ch.value;
  if (!v) {
    return;
  }
  const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  for (let i = 0; i < u8.length; i++) {
    notecardRspAcc.push(u8[i]!);
  }
  renderNotecardRspFromAcc();
}

function onUwbLineNotify(ev: Event): void {
  const ch = ev.target as BluetoothRemoteGATTCharacteristic;
  const v = ch.value;
  if (!v) {
    return;
  }
  const s = new TextDecoder().decode(v.buffer);
  if (s.length > 0) {
    appendUwbLog(s.endsWith("\n") ? s : `${s}\n`);
  }
}

function onImuNotify(ev: Event): void {
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
  const dtMs = lastImuWallMs > 0 ? now - lastImuWallMs : 0;
  lastImuWallMs = now;

  const f = formatImuFields(pkt);
  setText("imu-accel", f.accel);
  setText("imu-gyro", f.gyro);
  setText("imu-mag", f.mag);
  setText("imu-temp", f.temp);
  setText("imu-baro", f.baro);
  setText("imu-meta", `${f.meta}${dtMs > 0 ? ` · ${dtMs.toFixed(0)} ms` : ""}`);
}

function resetImuDisplay(): void {
  lastImuWallMs = 0;
  setText("imu-accel", "—");
  setText("imu-gyro", "—");
  setText("imu-mag", "—");
  setText("imu-temp", "—");
  setText("imu-baro", "—");
  setText("imu-meta", "Connect to stream accel, gyro, mag, temperature, and pressure.");
}

async function sendNotecardRequest(): Promise<void> {
  if (!charNotecardReq) {
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
  notecardRspAcc.length = 0;
  renderNotecardRspFromAcc();
  try {
    await charNotecardReq.writeValue(new TextEncoder().encode(line));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const el = document.querySelector("#notecard-rsp-log");
    if (el) {
      el.textContent = `Write error: ${msg}`;
    }
  }
}

async function sendUwbAt(): Promise<void> {
  if (!charUwbAt) {
    return;
  }
  const input = document.querySelector<HTMLInputElement>("#uwb-at-input");
  let cmd = (input?.value ?? "").trim();
  if (!cmd) {
    return;
  }
  appendUwbLog(`> ${cmd}\n`);
  try {
    await charUwbAt.writeValue(new TextEncoder().encode(cmd));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendUwbLog(`! BLE write error: ${msg}\n`);
  }
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

    setStatus(`Connecting to ${dev.name ?? "device"}…`);
    setBleToolbar("BLE: connecting…");
    gatt = await dev.gatt!.connect();
    try {
      const g = gatt as BluetoothRemoteGATTServer & { requestMtu?: (n: number) => Promise<number> };
      if (typeof g.requestMtu === "function") {
        await g.requestMtu(247);
      }
    } catch {
      /* optional */
    }

    const svc = await gatt.getPrimaryService(BLE_SERVICE_UUID);

    charImu = null;
    charNotecardReq = null;
    charNotecardRsp = null;
    charUwbLine = null;
    charUwbAt = null;

    const parts: string[] = [`Web BLE ${WEB_BLE_REV}`];

    try {
      charImu = await svc.getCharacteristic(BLE_IMU_CHAR_UUID);
      charImu.addEventListener("characteristicvaluechanged", onImuNotify);
      await charImu.startNotifications();
      parts.push("IMU ✓");
    } catch (e) {
      charImu = null;
      parts.push("IMU ✗");
      console.error("BLE IMU", e);
    }
    try {
      charUwbAt = await svc.getCharacteristic(BLE_UWB_AT_CHAR_UUID);
      parts.push("UWB AT ✓");
    } catch (e) {
      charUwbAt = null;
      parts.push("UWB AT ✗");
      console.error("BLE UWB AT", e);
    }
    try {
      charUwbLine = await svc.getCharacteristic(BLE_UWB_LINE_CHAR_UUID);
      charUwbLine.addEventListener("characteristicvaluechanged", onUwbLineNotify);
      await charUwbLine.startNotifications();
      parts.push("UWB RX ✓");
    } catch (e) {
      charUwbLine = null;
      parts.push("UWB RX ✗");
      console.error("BLE UWB line", e);
    }
    try {
      charNotecardReq = await svc.getCharacteristic(BLE_NOTECARD_REQ_CHAR_UUID);
      parts.push("NC req ✓");
    } catch (e) {
      charNotecardReq = null;
      parts.push("NC req —");
    }
    try {
      charNotecardRsp = await svc.getCharacteristic(BLE_NOTECARD_RSP_CHAR_UUID);
      charNotecardRsp.addEventListener("characteristicvaluechanged", onNotecardRspNotify);
      await charNotecardRsp.startNotifications();
      parts.push("NC rsp ✓");
    } catch (e) {
      charNotecardRsp = null;
      parts.push("NC rsp —");
    }

    syncActionButtons();
    disconnectBtn.disabled = false;
    setBleToolbar(`BLE: ${dev.name ?? "connected"}`);
    setStatus(parts.join(" · "));
    dev.addEventListener("gattserverdisconnected", onDisconnected);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Error: ${msg}`);
    setBleToolbar("BLE: —");
    connectBtn.disabled = false;
    teardownChars();
    gatt = null;
  }
}

function teardownChars(): void {
  charImu?.removeEventListener("characteristicvaluechanged", onImuNotify);
  charNotecardRsp?.removeEventListener("characteristicvaluechanged", onNotecardRspNotify);
  charUwbLine?.removeEventListener("characteristicvaluechanged", onUwbLineNotify);
  charImu = null;
  charNotecardReq = null;
  charNotecardRsp = null;
  charUwbLine = null;
  charUwbAt = null;
  syncActionButtons();
}

function onDisconnected(): void {
  teardownChars();
  gatt = null;
  disconnectBtn.disabled = true;
  connectBtn.disabled = false;
  setBleToolbar("BLE: disconnected");
  notecardRspAcc.length = 0;
  renderNotecardRspFromAcc();
  uwbLineLogText = "";
  const uwbEl = document.querySelector("#uwb-line-log");
  if (uwbEl) {
    uwbEl.textContent = "";
  }
  resetImuDisplay();
  setStatus("Disconnected");
}

async function disconnectBle(): Promise<void> {
  try {
    await gatt?.disconnect();
  } catch {
    /* ignore */
  }
  onDisconnected();
}

export function startRegattaApp(): void {
  document.body.dataset["appScreen"] = "boat";
  document.body.dataset["appTab"] = "main";

  connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
  disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect")!;
  statusEl = document.querySelector("#boat-status");
  bleStatusEl = document.querySelector("#ble-status");

  document.querySelector("#notecard-send")?.addEventListener("click", () => void sendNotecardRequest());
  document.querySelector("#uwb-at-send")?.addEventListener("click", () => void sendUwbAt());
  document.querySelector("#uwb-at-input")?.addEventListener("keydown", (ev) => {
    if (ev instanceof KeyboardEvent && ev.key === "Enter") {
      void sendUwbAt();
    }
  });

  connectBtn.addEventListener("click", () => void connectBle());
  disconnectBtn.addEventListener("click", () => void disconnectBle());

  setBleToolbar("BLE: —");
  resetImuDisplay();
  setStatus(`Disconnected. Connect to RegattaOne-Boat (service 0xFEF0).\nWeb BLE ${WEB_BLE_REV} — hard-refresh (Cmd+Shift+R) if IMU/AT stay disabled.`);
  syncActionButtons();
}
