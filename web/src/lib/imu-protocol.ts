/** Matches `sen0140_ble_imu_pkt_t` in main/ble_sen0140.c (little-endian). */

export const PKT_V1_SIZE = 34;
export const PKT_V2_SIZE = 42;
export const PKT_MIN_SIZE = PKT_V1_SIZE;

export const FLAG_ADXL = 0x01;
export const FLAG_ITG = 0x02;
export const FLAG_MAG = 0x04;
export const FLAG_BARO_TEMP = 0x08;
export const FLAG_BARO_PRESS = 0x10;

export type ImuPacket = {
  version: number;
  flags: number;
  seq: number;
  ax: number;
  ay: number;
  az: number;
  /** rad/s from firmware */
  gx: number;
  gy: number;
  gz: number;
  mx: number;
  my: number;
  mz: number;
  temp_c: number;
  press_hpa: number;
};

function readImuTail(dv: DataView, o: number): {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  mx: number;
  my: number;
  mz: number;
  nextOff: number;
} {
  let o0 = o;
  const ax = dv.getFloat32(o0, true);
  o0 += 4;
  const ay = dv.getFloat32(o0, true);
  o0 += 4;
  const az = dv.getFloat32(o0, true);
  o0 += 4;
  const gx = dv.getFloat32(o0, true);
  o0 += 4;
  const gy = dv.getFloat32(o0, true);
  o0 += 4;
  const gz = dv.getFloat32(o0, true);
  o0 += 4;
  const mx = dv.getInt16(o0, true);
  o0 += 2;
  const my = dv.getInt16(o0, true);
  o0 += 2;
  const mz = dv.getInt16(o0, true);
  o0 += 2;
  return { ax, ay, az, gx, gy, gz, mx, my, mz, nextOff: o0 };
}

export function parseImuPacket(buf: ArrayBuffer | ArrayBufferView): ImuPacket | null {
  const len = buf instanceof ArrayBuffer ? buf.byteLength : buf.byteLength;
  if (len < PKT_MIN_SIZE) {
    return null;
  }
  const dv =
    buf instanceof ArrayBuffer
      ? new DataView(buf)
      : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint8(0);
  if (version !== 1 && version !== 2) {
    return null;
  }
  const flags = dv.getUint8(1);
  const seq = dv.getUint16(2, true);
  const imu = readImuTail(dv, 4);

  let temp_c = NaN;
  let press_hpa = NaN;
  if (version === 2) {
    if (len < PKT_V2_SIZE) {
      return null;
    }
    temp_c = dv.getFloat32(imu.nextOff, true);
    press_hpa = dv.getFloat32(imu.nextOff + 4, true);
  }

  return {
    version,
    flags,
    seq,
    ax: imu.ax,
    ay: imu.ay,
    az: imu.az,
    gx: imu.gx,
    gy: imu.gy,
    gz: imu.gz,
    mx: imu.mx,
    my: imu.my,
    mz: imu.mz,
    temp_c,
    press_hpa,
  };
}

const RAD2DEG = 180 / Math.PI;

export function formatImuFields(pkt: ImuPacket): {
  accel: string;
  gyro: string;
  mag: string;
  temp: string;
  baro: string;
  meta: string;
} {
  const hasA = (pkt.flags & FLAG_ADXL) !== 0;
  const hasG = (pkt.flags & FLAG_ITG) !== 0;
  const hasM = (pkt.flags & FLAG_MAG) !== 0;
  const hasT = (pkt.flags & FLAG_BARO_TEMP) !== 0 && Number.isFinite(pkt.temp_c);
  const hasP = (pkt.flags & FLAG_BARO_PRESS) !== 0 && Number.isFinite(pkt.press_hpa);

  const accel = hasA
    ? `X ${pkt.ax.toFixed(3)}   Y ${pkt.ay.toFixed(3)}   Z ${pkt.az.toFixed(3)} g`
    : "—";
  const gyro = hasG
    ? `X ${(pkt.gx * RAD2DEG).toFixed(1)}  Y ${(pkt.gy * RAD2DEG).toFixed(1)}  Z ${(pkt.gz * RAD2DEG).toFixed(1)} °/s`
    : "—";
  const mag = hasM ? `X ${pkt.mx}  Y ${pkt.my}  Z ${pkt.mz}` : "—";
  const temp = hasT ? `${pkt.temp_c.toFixed(2)} °C` : "—";
  const baro = hasP ? `${pkt.press_hpa.toFixed(2)} hPa` : "—";
  const meta = `seq ${pkt.seq} · flags 0x${pkt.flags.toString(16)} · v${pkt.version}`;

  return { accel, gyro, mag, temp, baro, meta };
}
