import { Capacitor } from "@capacitor/core";
import { BleClient } from "@capacitor-community/bluetooth-le";

import { BLE_SERVICE_UUID } from "./protocol";

/** Minimal GATT characteristic surface used by regatta-main.ts */
export interface BleGattCharacteristicLike {
  readValue(): Promise<DataView>;
  writeValue(data: BufferSource): Promise<void>;
  startNotifications(): Promise<void>;
  stopNotifications(): Promise<void>;
  addEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
}

export interface BleGattServerLike {
  connected: boolean;
  connect(): Promise<BleGattServerLike>;
  disconnect(): Promise<void>;
  getPrimaryService(uuid: string): Promise<{
    getCharacteristic(uuid: string): Promise<BleGattCharacteristicLike>;
  }>;
}

export interface BleDevicePick {
  deviceId: string;
  name: string;
}

let bleReady: Promise<void> | null = null;

export function isNativeBle(): boolean {
  return Capacitor.isNativePlatform();
}

export function isBleAvailable(): boolean {
  return isNativeBle() || typeof navigator !== "undefined" && !!navigator.bluetooth;
}

function bufferToDataView(data: BufferSource): DataView {
  if (data instanceof DataView) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new DataView(data);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export async function ensureBleInitialized(): Promise<void> {
  if (!isNativeBle()) {
    return;
  }
  if (!bleReady) {
    bleReady = BleClient.initialize().catch((err) => {
      bleReady = null;
      throw err;
    });
  }
  await bleReady;
}

class NativeBleCharacteristic implements BleGattCharacteristicLike {
  private listeners = new Set<(ev: Event) => void>();
  private notifyActive = false;

  constructor(
    private readonly deviceId: string,
    private readonly serviceUuid: string,
    private readonly characteristicUuid: string,
  ) {}

  async readValue(): Promise<DataView> {
    return BleClient.read(this.deviceId, this.serviceUuid, this.characteristicUuid);
  }

  async writeValue(data: BufferSource): Promise<void> {
    await BleClient.write(
      this.deviceId,
      this.serviceUuid,
      this.characteristicUuid,
      bufferToDataView(data),
    );
  }

  async startNotifications(): Promise<void> {
    if (this.notifyActive) {
      return;
    }
    await BleClient.startNotifications(
      this.deviceId,
      this.serviceUuid,
      this.characteristicUuid,
      (value) => {
        const ev = { target: { value } } as unknown as Event;
        for (const listener of this.listeners) {
          listener(ev);
        }
      },
    );
    this.notifyActive = true;
  }

  async stopNotifications(): Promise<void> {
    if (!this.notifyActive) {
      return;
    }
    await BleClient.stopNotifications(
      this.deviceId,
      this.serviceUuid,
      this.characteristicUuid,
    );
    this.notifyActive = false;
  }

  addEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void {
    if (type === "characteristicvaluechanged") {
      this.listeners.add(listener);
    }
  }

  removeEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void {
    if (type === "characteristicvaluechanged") {
      this.listeners.delete(listener);
    }
  }
}

class NativeBleGattServer implements BleGattServerLike {
  connected = false;

  constructor(
    readonly deviceId: string,
    private readonly onDisconnect?: () => void,
  ) {}

  async connect(): Promise<BleGattServerLike> {
    await BleClient.connect(this.deviceId, () => {
      this.connected = false;
      this.onDisconnect?.();
    });
    this.connected = true;
    return this;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    await BleClient.disconnect(this.deviceId);
    this.connected = false;
  }

  async getPrimaryService(serviceUuid: string): Promise<{
    getCharacteristic(uuid: string): Promise<BleGattCharacteristicLike>;
  }> {
    return {
      getCharacteristic: async (characteristicUuid: string) =>
        new NativeBleCharacteristic(this.deviceId, serviceUuid, characteristicUuid),
    };
  }
}

export async function requestBleDevice(optionalServiceUuids: string[]): Promise<BleDevicePick> {
  await ensureBleInitialized();
  const dev = await BleClient.requestDevice({
    services: [BLE_SERVICE_UUID],
    optionalServices: optionalServiceUuids,
    displayMode: "list",
  });
  return {
    deviceId: dev.deviceId,
    name: dev.name?.trim() || "Boat",
  };
}

export async function connectNativeGatt(
  deviceId: string,
  onDisconnect: () => void,
): Promise<BleGattServerLike> {
  await ensureBleInitialized();
  const gatt = new NativeBleGattServer(deviceId, onDisconnect);
  await gatt.connect();
  return gatt;
}

export function asWebCharacteristic(char: BluetoothRemoteGATTCharacteristic): BleGattCharacteristicLike {
  return {
    readValue: () => char.readValue(),
    writeValue: (data) => char.writeValue(data),
    startNotifications: async () => {
      await char.startNotifications();
    },
    stopNotifications: async () => {
      await char.stopNotifications();
    },
    addEventListener: (type, listener) => char.addEventListener(type, listener),
    removeEventListener: (type, listener) => char.removeEventListener(type, listener),
  };
}

export function asWebGatt(gatt: BluetoothRemoteGATTServer): BleGattServerLike {
  return {
    get connected() {
      return gatt.connected;
    },
    connect: async () => asWebGatt(await gatt.connect()),
    disconnect: async () => {
      gatt.disconnect();
    },
    getPrimaryService: async (serviceUuid) => {
      const svc = await gatt.getPrimaryService(serviceUuid);
      return {
        getCharacteristic: async (characteristicUuid) =>
          asWebCharacteristic(await svc.getCharacteristic(characteristicUuid)),
      };
    },
  };
}
