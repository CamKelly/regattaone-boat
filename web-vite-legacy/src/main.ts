import * as THREE from "three";
import { Madgwick } from "./madgwick";
import {
  BLE_CHAR_UUID,
  BLE_SERVICE_UUID,
  FLAG_ADXL,
  FLAG_BARO_PRESS,
  FLAG_BARO_TEMP,
  FLAG_ITG,
  FLAG_MAG,
  PKT_MIN_SIZE,
  parseImuPacket,
} from "./protocol";

import { MagTimePlot } from "./magPlot";
import "./style.css";

const connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect")!;
const alignBtn = document.querySelector<HTMLButtonElement>("#align")!;
const statusEl = document.querySelector<HTMLPreElement>("#status")!;
const hdgDegEl = document.querySelector<HTMLSpanElement>("#hdg-deg")!;
const compassNeedleEl = document.querySelector<HTMLDivElement>("#compass-needle")!;
const bubbleDotEl = document.querySelector<HTMLDivElement>("#bubble-dot")!;
const bubbleTiltEl = document.querySelector<HTMLSpanElement>("#bubble-tilt")!;
const heelDegEl = document.querySelector<HTMLSpanElement>("#heel-deg")!;
const heelRateEl = document.querySelector<HTMLSpanElement>("#heel-rate")!;
const canvas = document.querySelector<HTMLCanvasElement>("#c")!;
const magPlotToggle = document.querySelector<HTMLInputElement>("#mag-plot-toggle")!;
const viewPanDegEl = document.querySelector<HTMLSpanElement>("#view-pan-deg")!;
const viewTiltDegEl = document.querySelector<HTMLSpanElement>("#view-tilt-deg")!;
const telemetryStripEl = document.querySelector<HTMLDivElement>("#telemetry-strip")!;
const telemetryCanvas = document.querySelector<HTMLCanvasElement>("#telemetry-canvas")!;
const magPlot = new MagTimePlot();

const MAG_TEX_W = 512;
const MAG_TEX_H = 400;

telemetryCanvas.width = MAG_TEX_W;
telemetryCanvas.height = MAG_TEX_H;

function updateTelemetryStripVisibility(): void {
  telemetryStripEl.hidden = !magPlot.enabled;
  if (magPlot.enabled) {
    magPlot.markDirty();
  }
}

const PCB_TEXTURE_URL = "/sen0140-board.png";

function populateBoardFromPhoto(board: THREE.Group, pcbTexture: THREE.Texture, renderer: THREE.WebGLRenderer): void {
  const img = pcbTexture.image as HTMLImageElement;
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const maxEdge = 2.25;
  let w: number;
  let d: number;
  if (iw >= ih) {
    w = maxEdge;
    d = maxEdge * (ih / iw);
  } else {
    d = maxEdge;
    w = maxEdge * (iw / ih);
  }

  const slabT = 0.07;
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(w, slabT, d),
    new THREE.MeshStandardMaterial({ color: 0x141820, roughness: 0.92, metalness: 0.04 }),
  );
  slab.position.y = 0;

  pcbTexture.colorSpace = THREE.SRGBColorSpace;
  pcbTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const topMat = new THREE.MeshStandardMaterial({
    map: pcbTexture,
    roughness: 0.82,
    metalness: 0.06,
    side: THREE.FrontSide,
  });
  const pcbTop = new THREE.Mesh(new THREE.PlaneGeometry(w, d), topMat);
  pcbTop.rotation.x = -Math.PI / 2;
  const topSurfaceY = slabT / 2 + 0.002;
  pcbTop.position.y = topSurfaceY;
  pcbTop.renderOrder = 1;

  const arrLen = Math.min(1.55, Math.max(w, d) * 0.55);
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, topSurfaceY + 0.045, 0),
    arrLen,
    0xff3355,
    Math.max(0.12, arrLen * 0.09),
    Math.max(0.08, arrLen * 0.06),
  );

  board.add(slab);
  board.add(pcbTop);
  board.add(arrow);
}

function populateBoardFallback(board: THREE.Group): void {
  const boardMat = new THREE.MeshStandardMaterial({
    color: 0x3d8bfd,
    metalness: 0.2,
    roughness: 0.5,
    depthWrite: true,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.35, 1.4), boardMat);
  mesh.renderOrder = 1;
  mesh.add(
    new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 1.6, 0xff3355, 0.15, 0.1),
  );
  board.add(mesh);
}

/** Heading “forward” in board space: matches red arrow after boardVisual Y = 90° + 180° (PCB vs world axes). */
const vForward = new THREE.Vector3(-1, 0, 0);
const vFlat = new THREE.Vector3();

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _heelDeck = new THREE.Vector3();
const _heelFwd = new THREE.Vector3();
const _heelUpProj = new THREE.Vector3();
const _heelNProj = new THREE.Vector3();
const _heelCross = new THREE.Vector3();
const lastOmegaMesh = new THREE.Vector3();

/**
 * Maps SEN0140 / ADXL345 layout (Z out of the PCB when flat) to mesh: thin +Y, floor XZ.
 */
const SENSOR_TO_MESH = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ"));

/** Madgwick q (sensor frame) composed with fixed chip→mesh rotation. No conjugate — avoids cross-axis coupling with gyro. */
function copyFusedToMeshQuat(outMesh: THREE.Quaternion, fusedSrc: THREE.Quaternion): void {
  outMesh.copy(fusedSrc).multiply(SENSOR_TO_MESH);
}

let gatt: BluetoothRemoteGATTServer | null = null;
let charNotify: BluetoothRemoteGATTCharacteristic | null = null;
const filter = new Madgwick();
filter.beta = 0.085;
let lastPacketWallMs = 0;

const HEEL_RATE_VISUAL_TAU_SEC = 0.12;
let heelRateSmoothedRadS = 0;
let heelRateSmoothPrimed = false;

/** After "Align when flat", maps fused pose so that pose reads as identity (flat on grid). */
const levelCorrection = new THREE.Quaternion();
const qFused = new THREE.Quaternion();
const qMesh = new THREE.Quaternion();
/** Board world quat for telemetry heading (same chain as `board` in tick). */
const qHeadingPlot = new THREE.Quaternion();
const boardUpForLevel = new THREE.Vector3();

/** Degrees from vertical to treat as “on level” (IMU + Madgwick rarely hold sub‑1°). */
const BUBBLE_LEVEL_OK_DEG = 5;

/** PCB +Y normal in world; bubble uses horizontal tilt vs gravity (ignores “Align when flat”). */
function updateBubbleLevel(meshQuat: THREE.Quaternion, imuStale: boolean): void {
  if (imuStale) {
    bubbleDotEl.style.transform = "translate(0px, 0px)";
    bubbleTiltEl.textContent = "—";
    bubbleTiltEl.style.removeProperty("color");
    return;
  }
  boardUpForLevel.set(0, 1, 0).applyQuaternion(meshQuat);
  const cos = Math.min(1, Math.max(-1, boardUpForLevel.y));
  const tiltDeg = (Math.acos(cos) * 180) / Math.PI;
  const maxPx = 21;
  const gain = 92;
  let px = boardUpForLevel.x * gain;
  let py = -boardUpForLevel.z * gain;
  const r = Math.hypot(px, py);
  if (r > maxPx && r > 1e-6) {
    const s = maxPx / r;
    px *= s;
    py *= s;
  }
  bubbleDotEl.style.transform = `translate(${px}px, ${py}px)`;
  bubbleTiltEl.textContent = `${tiltDeg.toFixed(1)}°`;
  if (tiltDeg <= BUBBLE_LEVEL_OK_DEG) {
    bubbleTiltEl.style.color = "#4ade80";
  } else {
    bubbleTiltEl.style.removeProperty("color");
  }
}

let viewPanDeg = 0;
let viewTiltDeg = 0;
let orbitInitPitchDegClamp = 0;

function wrapDeg360(d: number): number {
  return ((d % 360) + 360) % 360;
}

function syncViewOrbitReadout(): void {
  viewPanDegEl.textContent = `${wrapDeg360(viewPanDeg).toFixed(2)}°`;
  viewTiltDegEl.textContent = `${viewTiltDeg.toFixed(2)}°`;
}

function clampViewTiltOffset(): void {
  const minOff = -88 - orbitInitPitchDegClamp;
  const maxOff = 88 - orbitInitPitchDegClamp;
  viewTiltDeg = Math.min(maxOff, Math.max(minOff, viewTiltDeg));
}

function bumpViewPan(delta: number): void {
  viewPanDeg += delta;
  syncViewOrbitReadout();
}

function bumpViewTilt(delta: number): void {
  viewTiltDeg += delta;
  clampViewTiltOffset();
  syncViewOrbitReadout();
}

function setStatus(s: string): void {
  statusEl.textContent = s;
}

/** Billboard sprite for a single letter (e.g. "N" at north). */
function makeLetterSprite(letter: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.font = "bold 88px system-ui,sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, 64, 68);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.42, 0.42, 1);
  sprite.renderOrder = 2;
  return sprite;
}

/** Billboard sprite for short axis labels (+X, −Y, …). */
function makeAxisLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 112;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 112);
  ctx.font = "bold 64px system-ui,sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 58);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.62, 0.27, 1);
  sprite.renderOrder = 2;
  return sprite;
}

const axisOriginY = 0.055;
const axisArrowLen = 1.32;
const axisHeadLen = 0.11;
const axisHeadWidth = 0.075;
const axisLabelOffset = 0.24;

const vAxisTip = new THREE.Vector3();

function addSignedWorldAxis(
  parent: THREE.Object3D,
  direction: THREE.Vector3,
  hex: number,
  label: string,
  labelColor: string,
): void {
  const dir = direction.clone().normalize();
  const origin = new THREE.Vector3(0, axisOriginY, 0);
  const arrow = new THREE.ArrowHelper(dir, origin, axisArrowLen, axisHeadLen, axisHeadWidth);
  arrow.line.renderOrder = 0;
  arrow.cone.renderOrder = 0;
  parent.add(arrow);

  vAxisTip.copy(origin).addScaledVector(dir, axisArrowLen + axisLabelOffset);
  vAxisTip.y += 0.06;
  const sprite = makeAxisLabelSprite(label, labelColor);
  sprite.position.copy(vAxisTip);
  parent.add(sprite);
}

function signedHeelDegFromBoardQuat(boardWorldQuat: THREE.Quaternion): number {
  _heelDeck.set(0, 1, 0).applyQuaternion(boardWorldQuat);
  _heelFwd.copy(vForward).applyQuaternion(boardWorldQuat);
  const uf = _heelFwd.dot(WORLD_UP);
  if (Math.abs(uf) > 0.985) {
    return NaN;
  }
  _heelUpProj.copy(WORLD_UP).addScaledVector(_heelFwd, -uf);
  _heelUpProj.normalize();
  const nf = _heelDeck.dot(_heelFwd);
  _heelNProj.copy(_heelDeck).addScaledVector(_heelFwd, -nf);
  if (_heelNProj.lengthSq() < 1e-12) {
    return NaN;
  }
  _heelNProj.normalize();
  _heelCross.crossVectors(_heelUpProj, _heelNProj);
  const sinHeel = _heelFwd.dot(_heelCross);
  const cosHeel = _heelUpProj.dot(_heelNProj);
  return THREE.MathUtils.radToDeg(Math.atan2(sinHeel, cosHeel));
}

/**
 * Clockwise heading in degrees from world +Z (grid north) in the XZ plane, matching the 2D compass
 * (N at 12 o'clock, CW positive). Uses atan2(z, x) so 0° = forward along +Z, 90° = +X.
 */
function headingDegFromBoard(boardWorldQuat: THREE.Quaternion): number | null {
  vFlat.copy(vForward).applyQuaternion(boardWorldQuat);
  vFlat.y = 0;
  if (vFlat.lengthSq() < 1e-8) {
    return null;
  }
  vFlat.normalize();
  const rad = Math.atan2(vFlat.z, vFlat.x);
  let deg = 90 - THREE.MathUtils.radToDeg(rad);
  deg = ((deg % 360) + 360) % 360;
  return deg;
}

function renderScene(): void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x0f1419, 1);
  renderer.sortObjects = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1419);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const orbitTarget = new THREE.Vector3(0, 0.15, 0);
  const camBase = new THREE.Vector3(2.8, 1.9, 3.2);
  const rel0 = new THREE.Vector3().subVectors(camBase, orbitTarget);
  const orbitRadius = rel0.length();
  const horiz0 = Math.hypot(rel0.x, rel0.z);
  const orbitInitYaw = Math.atan2(rel0.x, rel0.z);
  const orbitInitPitchDeg = THREE.MathUtils.radToDeg(Math.atan2(rel0.y, horiz0));
  orbitInitPitchDegClamp = orbitInitPitchDeg;

  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(2, 4, 3);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0x404860, 0.6));

  const board = new THREE.Group();
  board.renderOrder = 1;
  const boardVisual = new THREE.Group();
  boardVisual.rotation.y = Math.PI / 2 + Math.PI;
  board.add(boardVisual);
  scene.add(board);

  new THREE.TextureLoader().load(
    PCB_TEXTURE_URL,
    (pcbTexture) => {
      populateBoardFromPhoto(boardVisual, pcbTexture, renderer);
      if (magPlot.enabled) {
        magPlot.markDirty();
      }
    },
    undefined,
    () => {
      populateBoardFallback(boardVisual);
      if (magPlot.enabled) {
        magPlot.markDirty();
      }
    },
  );

  const grid = new THREE.GridHelper(6, 12, 0x334155, 0x1e293b);
  grid.renderOrder = 0;
  scene.add(grid);

  // World axes (+X red). Vertical (Three +Y) labeled Z (blue); floor north (Three +Z) labeled Y (green).
  addSignedWorldAxis(scene, new THREE.Vector3(1, 0, 0), 0xef4444, "+X", "#f87171");
  addSignedWorldAxis(scene, new THREE.Vector3(-1, 0, 0), 0x7f1d1d, "−X", "#fca5a5");
  addSignedWorldAxis(scene, new THREE.Vector3(0, 1, 0), 0x3b82f6, "+Z", "#93c5fd");
  addSignedWorldAxis(scene, new THREE.Vector3(0, -1, 0), 0x1e3a8a, "−Z", "#60a5fa");
  addSignedWorldAxis(scene, new THREE.Vector3(0, 0, 1), 0x22c55e, "+Y", "#86efac");
  addSignedWorldAxis(scene, new THREE.Vector3(0, 0, -1), 0x14532d, "−Y", "#4ade80");

  const northOrigin = new THREE.Vector3(0, 0.07, 0);
  const northLen = 2.35;
  const northArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    northOrigin,
    northLen,
    0x22c55e,
    0.22,
    0.11,
  );
  northArrow.line.renderOrder = 0;
  northArrow.cone.renderOrder = 0;
  scene.add(northArrow);

  const northLabel = makeLetterSprite("N", "#22c55e");
  northLabel.position.set(0, 0.22, northOrigin.z + northLen + 0.12);
  scene.add(northLabel);

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  let lastTickWallMs = performance.now();
  function tick(): void {
    requestAnimationFrame(tick);
    const tickNow = performance.now();
    const dtSec = Math.min(0.05, Math.max(0, (tickNow - lastTickWallMs) / 1000));
    lastTickWallMs = tickNow;
    const { w, x, y, z } = filter.q;
    qFused.set(x, y, z, w);
    copyFusedToMeshQuat(qMesh, qFused);
    board.quaternion.copy(levelCorrection).multiply(qMesh);
    const imuStale = lastPacketWallMs === 0 || tickNow - lastPacketWallMs > 2500;
    updateBubbleLevel(qMesh, imuStale);
    const h = headingDegFromBoard(board.quaternion);
    if (h !== null) {
      hdgDegEl.textContent = h.toFixed(0);
      compassNeedleEl.style.transform = `rotate(${h}deg)`;
    } else {
      hdgDegEl.textContent = "—";
      compassNeedleEl.style.transform = "rotate(0deg)";
    }
    if (imuStale) {
      heelDegEl.textContent = "—";
      heelRateEl.textContent = "—";
      heelRateSmoothPrimed = false;
    } else {
      const heelDeg = signedHeelDegFromBoardQuat(board.quaternion);
      heelDegEl.textContent = Number.isFinite(heelDeg) ? heelDeg.toFixed(1) : "—";
      const rawHeelRate = lastOmegaMesh.dot(vForward);
      if (!heelRateSmoothPrimed) {
        heelRateSmoothedRadS = rawHeelRate;
        heelRateSmoothPrimed = true;
      } else {
        const alphaR = 1 - Math.exp(-dtSec / HEEL_RATE_VISUAL_TAU_SEC);
        heelRateSmoothedRadS += alphaR * (rawHeelRate - heelRateSmoothedRadS);
      }
      heelRateEl.textContent = `${THREE.MathUtils.radToDeg(heelRateSmoothedRadS).toFixed(1)}`;
    }
    if (magPlot.enabled) {
      const ctx = telemetryCanvas.getContext("2d");
      if (ctx) {
        magPlot.paintIfDirty(ctx, MAG_TEX_W, MAG_TEX_H);
      }
    }
    const panRad = THREE.MathUtils.degToRad(viewPanDeg);
    const yawRad = orbitInitYaw + panRad;
    const pitchDeg = THREE.MathUtils.clamp(orbitInitPitchDeg + viewTiltDeg, -88, 88);
    const pitchRad = THREE.MathUtils.degToRad(pitchDeg);
    const cp = Math.cos(pitchRad);
    camera.position.set(
      orbitTarget.x + orbitRadius * cp * Math.sin(yawRad),
      orbitTarget.y + orbitRadius * Math.sin(pitchRad),
      orbitTarget.z + orbitRadius * cp * Math.cos(yawRad),
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(orbitTarget);
    renderer.render(scene, camera);
  }
  tick();
}

function captureLevelOrientation(): void {
  const { w, x, y, z } = filter.q;
  qFused.set(x, y, z, w);
  copyFusedToMeshQuat(qMesh, qFused);
  levelCorrection.copy(qMesh).invert();
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
  const dt = lastPacketWallMs > 0 ? Math.min(0.1, Math.max(0.001, (now - lastPacketWallMs) / 1000)) : 0.02;
  lastPacketWallMs = now;

  const hasA = (pkt.flags & FLAG_ADXL) !== 0;
  const hasG = (pkt.flags & FLAG_ITG) !== 0;
  const hasM = (pkt.flags & FLAG_MAG) !== 0;
  const hasT = (pkt.flags & FLAG_BARO_TEMP) !== 0 && Number.isFinite(pkt.temp_c);
  const hasP = (pkt.flags & FLAG_BARO_PRESS) !== 0 && Number.isFinite(pkt.press_hpa);

  if (hasG && hasA) {
    const gy = -pkt.gy;
    const gz = -pkt.gz;
    lastOmegaMesh.set(pkt.gx, gy, gz).applyQuaternion(SENSOR_TO_MESH);
    if (hasM) {
      filter.updateMARG(pkt.gx, gy, gz, pkt.ax, pkt.ay, pkt.az, pkt.mx, pkt.my, pkt.mz, dt);
    } else {
      filter.updateIMU(pkt.gx, gy, gz, pkt.ax, pkt.ay, pkt.az, dt);
    }
  }

  if (magPlot.enabled) {
    let headingDeg = NaN;
    if (hasG && hasA) {
      const { w, x, y, z } = filter.q;
      qFused.set(x, y, z, w);
      copyFusedToMeshQuat(qMesh, qFused);
      qHeadingPlot.copy(levelCorrection).multiply(qMesh);
      const hdg = headingDegFromBoard(qHeadingPlot);
      headingDeg = hdg !== null ? hdg : NaN;
    }
    magPlot.pushSample({
      mx: hasM ? pkt.mx : NaN,
      my: hasM ? pkt.my : NaN,
      mz: hasM ? pkt.mz : NaN,
      gyroMag: hasG ? Math.hypot(pkt.gx, pkt.gy, pkt.gz) : NaN,
      accMag: hasA ? Math.hypot(pkt.ax, pkt.ay, pkt.az) : NaN,
      tempC: hasT ? pkt.temp_c : NaN,
      pressHpa: hasP ? pkt.press_hpa : NaN,
      headingDeg,
      dtMs: dt * 1000,
    });
  }

  setStatus(
    `seq=${pkt.seq}  pkt v${pkt.version}  flags=0x${pkt.flags.toString(16)}  dt=${(dt * 1000).toFixed(1)}ms\n` +
      `acc(g) ${hasA ? `${pkt.ax.toFixed(2)},${pkt.ay.toFixed(2)},${pkt.az.toFixed(2)}` : "—"}\n` +
      `gyr(r/s) ${hasG ? `${pkt.gx.toFixed(2)},${pkt.gy.toFixed(2)},${pkt.gz.toFixed(2)}` : "—"}\n` +
      `mag ${hasM ? `${pkt.mx},${pkt.my},${pkt.mz}` : "—"}\n` +
      `temp(°C) ${hasT ? pkt.temp_c.toFixed(1) : "—"}    press(hPa) ${hasP ? pkt.press_hpa.toFixed(1) : "—"}`,
  );
}

async function connectBle(): Promise<void> {
  if (!navigator.bluetooth) {
    setStatus("Web Bluetooth not available. Use Chrome (desktop or Android) on HTTPS or localhost.");
    return;
  }

  connectBtn.disabled = true;
  setStatus("Selecting device…");

  try {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: [BLE_SERVICE_UUID],
    });

    setStatus(`Connecting to ${dev.name ?? "device"}…`);
    gatt = await dev.gatt!.connect();
    try {
      const g = gatt as BluetoothRemoteGATTServer & { requestMtu?: (n: number) => Promise<number> };
      if (typeof g.requestMtu === "function") {
        await g.requestMtu(247);
      }
    } catch {
      /* Optional larger ATT MTU in some Chromium builds. */
    }
    const svc = await gatt.getPrimaryService(BLE_SERVICE_UUID);
    charNotify = await svc.getCharacteristic(BLE_CHAR_UUID);
    charNotify.addEventListener("characteristicvaluechanged", onImuNotify);
    await charNotify.startNotifications();

    lastPacketWallMs = 0;
    disconnectBtn.disabled = false;
    alignBtn.disabled = false;
    levelCorrection.identity();
    setStatus("Streaming… Use “Align when flat” once with the board level on the table.");
    dev.addEventListener("gattserverdisconnected", onDisconnected);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Error: ${msg}`);
    connectBtn.disabled = false;
    charNotify = null;
    gatt = null;
  }
}

function onDisconnected(): void {
  charNotify?.removeEventListener("characteristicvaluechanged", onImuNotify);
  charNotify = null;
  gatt = null;
  disconnectBtn.disabled = true;
  alignBtn.disabled = true;
  connectBtn.disabled = false;
  lastPacketWallMs = 0;
  heelRateSmoothPrimed = false;
  heelRateSmoothedRadS = 0;
  levelCorrection.identity();
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

connectBtn.addEventListener("click", () => void connectBle());
disconnectBtn.addEventListener("click", () => void disconnectBle());
alignBtn.addEventListener("click", () => {
  captureLevelOrientation();
});

magPlotToggle.addEventListener("change", () => {
  magPlot.setEnabled(magPlotToggle.checked);
  updateTelemetryStripVisibility();
});

if (magPlotToggle.checked) {
  magPlot.setEnabled(true);
}
updateTelemetryStripVisibility();

document.querySelector("#view-pan-cc15")!.addEventListener("click", () => bumpViewPan(-15));
document.querySelector("#view-pan-c15")!.addEventListener("click", () => bumpViewPan(15));
document.querySelector("#view-pan-cc1")!.addEventListener("click", () => bumpViewPan(-1));
document.querySelector("#view-pan-c1")!.addEventListener("click", () => bumpViewPan(1));
document.querySelector("#view-pan-cc025")!.addEventListener("click", () => bumpViewPan(-0.25));
document.querySelector("#view-pan-c025")!.addEventListener("click", () => bumpViewPan(0.25));

document.querySelector("#view-tilt-cc15")!.addEventListener("click", () => bumpViewTilt(-15));
document.querySelector("#view-tilt-c15")!.addEventListener("click", () => bumpViewTilt(15));
document.querySelector("#view-tilt-cc1")!.addEventListener("click", () => bumpViewTilt(-1));
document.querySelector("#view-tilt-c1")!.addEventListener("click", () => bumpViewTilt(1));
document.querySelector("#view-tilt-cc025")!.addEventListener("click", () => bumpViewTilt(-0.25));
document.querySelector("#view-tilt-c025")!.addEventListener("click", () => bumpViewTilt(0.25));

document.querySelector("#view-orbit-reset")!.addEventListener("click", () => {
  viewPanDeg = 0;
  viewTiltDeg = 0;
  syncViewOrbitReadout();
});

syncViewOrbitReadout();

renderScene();
