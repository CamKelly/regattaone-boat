import {
  BLE_NOTECARD_REQ_CHAR_UUID,
  BLE_NOTECARD_RSP_CHAR_UUID,
  BLE_SERVICE_UUID,
  BLE_UWB_LINE_CHAR_UUID,
} from "./lib/protocol";

let gatt: BluetoothRemoteGATTServer | null = null;
let charNotecardReq: BluetoothRemoteGATTCharacteristic | null = null;
let charNotecardRsp: BluetoothRemoteGATTCharacteristic | null = null;
let charUwbLine: BluetoothRemoteGATTCharacteristic | null = null;

let connectBtn!: HTMLButtonElement;
let disconnectBtn!: HTMLButtonElement;
let statusEl: HTMLElement | null = null;
let bleStatusEl: HTMLElement | null = null;

const notecardRspAcc: number[] = [];
let uwbLineLogText = "";

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

function syncSendBtn(): void {
  const sendBtn = document.querySelector<HTMLButtonElement>("#notecard-send");
  if (sendBtn) {
    sendBtn.disabled = charNotecardReq === null;
  }
}

function renderNotecardRspFromAcc(): void {
  const el = document.querySelector("#notecard-rsp-log");
  if (!el) {
    return;
  }
  el.textContent = new TextDecoder().decode(new Uint8Array(notecardRspAcc));
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
  uwbLineLogText += s;
  if (uwbLineLogText.length > 12000) {
    uwbLineLogText = uwbLineLogText.slice(-8000);
  }
  const el = document.querySelector("#uwb-line-log");
  if (el) {
    el.textContent = uwbLineLogText;
  }
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
      optionalServices: [BLE_SERVICE_UUID],
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

    charNotecardReq = null;
    charNotecardRsp = null;
    charUwbLine = null;

    try {
      charNotecardReq = await svc.getCharacteristic(BLE_NOTECARD_REQ_CHAR_UUID);
    } catch {
      charNotecardReq = null;
    }
    try {
      charNotecardRsp = await svc.getCharacteristic(BLE_NOTECARD_RSP_CHAR_UUID);
      charNotecardRsp.addEventListener("characteristicvaluechanged", onNotecardRspNotify);
      await charNotecardRsp.startNotifications();
    } catch {
      charNotecardRsp = null;
    }
    try {
      charUwbLine = await svc.getCharacteristic(BLE_UWB_LINE_CHAR_UUID);
      charUwbLine.addEventListener("characteristicvaluechanged", onUwbLineNotify);
      await charUwbLine.startNotifications();
    } catch {
      charUwbLine = null;
    }

    syncSendBtn();
    disconnectBtn.disabled = false;
    setBleToolbar(`BLE: ${dev.name ?? "connected"}`);
    setStatus("Connected. Send Notecard JSON (newline-terminated) or watch UWB UART lines below.");
    dev.addEventListener("gattserverdisconnected", onDisconnected);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Error: ${msg}`);
    setBleToolbar("BLE: —");
    connectBtn.disabled = false;
    charNotecardRsp?.removeEventListener("characteristicvaluechanged", onNotecardRspNotify);
    charUwbLine?.removeEventListener("characteristicvaluechanged", onUwbLineNotify);
    charNotecardReq = null;
    charNotecardRsp = null;
    charUwbLine = null;
    syncSendBtn();
    gatt = null;
  }
}

function onDisconnected(): void {
  charNotecardRsp?.removeEventListener("characteristicvaluechanged", onNotecardRspNotify);
  charUwbLine?.removeEventListener("characteristicvaluechanged", onUwbLineNotify);
  charNotecardReq = null;
  charNotecardRsp = null;
  charUwbLine = null;
  syncSendBtn();
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

  connectBtn.addEventListener("click", () => void connectBle());
  disconnectBtn.addEventListener("click", () => void disconnectBle());

  setBleToolbar("BLE: —");
  setStatus("Disconnected. Choose a device advertising the RegattaOne service (e.g. RegattaOne-Boat).");
  syncSendBtn();
}
