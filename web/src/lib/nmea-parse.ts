/** Parsed GPS fix merged from common NMEA 0183 sentences (GGA, RMC, GSA, VTG, GSV). */

export interface GpsFix {
  fixValid: boolean;
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  geoidSepM: number | null;
  hdop: number | null;
  vdop: number | null;
  pdop: number | null;
  satsUsed: number | null;
  satsInView: number | null;
  fixQuality: number | null;
  /** GSA mode: M = manual, A = automatic. */
  fixMode: string | null;
  /** GSA fix type: 1 = none, 2 = 2D, 3 = 3D. */
  fixType: number | null;
  sogKnots: number | null;
  cogDeg: number | null;
  magneticVariationDeg: number | null;
  utcTime: string | null;
  utcDate: string | null;
  /** Most recently applied sentence type (e.g. GGA). */
  lastSentence: string | null;
  updatedAtMs: number;
  /** 1 Hz PPS edges from firmware ($PREGPPS). */
  ppsCount: number | null;
  ppsLastEdgeUs: number | null;
  /** UTC µs at last PPS when firmware sends 4+ field $PREGPPS. */
  ppsUtcUs: number | null;
  /** MCPWM latched capture ticks at last PPS (hw capture path). */
  ppsCapTicks: number | null;
  /** µs between last two PPS captures (expect ~1000000). */
  ppsCapDeltaUs: number | null;
  ppsUpdatedAtMs: number;
}

const UERE_M = 5;

export function defaultGpsFix(): GpsFix {
  return {
    fixValid: false,
    lat: null,
    lon: null,
    altitudeM: null,
    geoidSepM: null,
    hdop: null,
    vdop: null,
    pdop: null,
    satsUsed: null,
    satsInView: null,
    fixQuality: null,
    fixMode: null,
    fixType: null,
    sogKnots: null,
    cogDeg: null,
    magneticVariationDeg: null,
    utcTime: null,
    utcDate: null,
    lastSentence: null,
    updatedAtMs: 0,
    ppsCount: null,
    ppsLastEdgeUs: null,
    ppsUtcUs: null,
    ppsCapTicks: null,
    ppsCapDeltaUs: null,
    ppsUpdatedAtMs: 0,
  };
}

export function fixQualityLabel(quality: number | null): string {
  switch (quality) {
    case 0:
      return "No fix";
    case 1:
      return "GPS fix";
    case 2:
      return "DGPS fix";
    case 4:
      return "RTK fixed";
    case 5:
      return "RTK float";
    case 6:
      return "Estimated (dead reckoning)";
    default:
      return quality === null ? "—" : `Quality ${quality}`;
  }
}

export function fixTypeLabel(type: number | null): string {
  switch (type) {
    case 1:
      return "No fix";
    case 2:
      return "2D";
    case 3:
      return "3D";
    default:
      return type === null ? "—" : String(type);
  }
}

/** Rough horizontal accuracy from HDOP (consumer GPS UERE ≈ 5 m). */
export function estimateHorizontalAccuracyM(hdop: number | null): number | null {
  if (hdop === null || !Number.isFinite(hdop) || hdop <= 0) {
    return null;
  }
  return hdop * UERE_M;
}

export function formatCoordDeg(value: number | null, isLat: boolean): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  const hemi = isLat ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg}° ${min.toFixed(4)}′ ${hemi}  (${abs.toFixed(6)}°)`;
}

export function formatSpeedKnots(knots: number | null): string {
  if (knots === null || !Number.isFinite(knots)) {
    return "—";
  }
  const kmh = knots * 1.852;
  const mps = knots * 0.514444;
  return `${knots.toFixed(2)} kn · ${kmh.toFixed(2)} km/h · ${mps.toFixed(2)} m/s`;
}

export function formatCourseDeg(deg: number | null): string {
  if (deg === null || !Number.isFinite(deg)) {
    return "—";
  }
  return `${deg.toFixed(1)}° true`;
}

export function formatDop(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(2);
}

export function formatAccuracyM(m: number | null): string {
  if (m === null || !Number.isFinite(m)) {
    return "—";
  }
  if (m < 1) {
    return `±${(m * 100).toFixed(0)} cm`;
  }
  return `±${m.toFixed(1)} m`;
}

export function formatAltitudeM(alt: number | null, geoidSep: number | null): string {
  if (alt === null || !Number.isFinite(alt)) {
    return "—";
  }
  const ellipsoid =
    geoidSep !== null && Number.isFinite(geoidSep) ? alt + geoidSep : null;
  const base = `${alt.toFixed(1)} m MSL`;
  if (ellipsoid !== null) {
    return `${base} · ${ellipsoid.toFixed(1)} m ellipsoid`;
  }
  return base;
}

export function formatUtc(time: string | null, date: string | null): string {
  if (!time && !date) {
    return "—";
  }
  return [date, time].filter(Boolean).join(" ");
}

/** PPS pulse count from firmware $PREGPPS. */
export function formatPpsCount(count: number | null): string {
  if (count === null || !Number.isFinite(count)) {
    return "—";
  }
  return String(count);
}

/** Interval between last two PPS edges (~1,000,000 µs when locked). */
export function formatPpsIntervalUs(deltaUs: number | null): string {
  if (deltaUs === null || !Number.isFinite(deltaUs) || deltaUs <= 0) {
    return "—";
  }
  const sec = deltaUs / 1_000_000;
  const ppm = Math.round((deltaUs - 1_000_000) * 1000 / 1_000_000);
  const ppmNote = Math.abs(ppm) <= 5000 ? ` · ${ppm >= 0 ? "+" : ""}${ppm} ppm` : "";
  return `${sec.toFixed(6)} s (${Math.round(deltaUs)} µs)${ppmNote}`;
}

export function openStreetMapUrl(lat: number, lon: number, zoom = 16): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
}

export function openStreetMapEmbedUrl(lat: number, lon: number, padDeg = 0.004): string {
  const minLon = lon - padDeg;
  const minLat = lat - padDeg;
  const maxLon = lon + padDeg;
  const maxLat = lat + padDeg;
  const marker = `${lat}%2C${lon}`;
  return (
    `https://www.openstreetmap.org/export/embed.html?bbox=${minLon}%2C${minLat}%2C${maxLon}%2C${maxLat}` +
    `&layer=mapnik&marker=${marker}`
  );
}

function parseNum(raw: string | undefined): number | null {
  if (!raw || raw.length === 0) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseIntField(raw: string | undefined): number | null {
  const n = parseNum(raw);
  return n === null ? null : Math.trunc(n);
}

function parseLatLon(raw: string | undefined, hemi: string | undefined): number | null {
  if (!raw || raw.length === 0 || !hemi) {
    return null;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    return null;
  }
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  const h = hemi.toUpperCase();
  if (h === "S" || h === "W") {
    dec = -dec;
  } else if (h !== "N" && h !== "E") {
    return null;
  }
  return dec;
}

function formatNmeaTime(raw: string | undefined): string | null {
  if (!raw || raw.length < 6) {
    return null;
  }
  const hh = raw.slice(0, 2);
  const mm = raw.slice(2, 4);
  const ss = raw.slice(4);
  return `${hh}:${mm}:${ss} UTC`;
}

function formatNmeaDate(raw: string | undefined): string | null {
  if (!raw || raw.length !== 6) {
    return null;
  }
  const dd = raw.slice(0, 2);
  const mo = raw.slice(2, 4);
  const yy = raw.slice(4, 6);
  return `20${yy}-${mo}-${dd}`;
}

function nmeaChecksumOk(line: string): boolean {
  const star = line.indexOf("*");
  if (star < 0) {
    return true;
  }
  if (star + 3 > line.length) {
    return false;
  }
  let sum = 0;
  for (let i = 1; i < star; i++) {
    sum ^= line.charCodeAt(i);
  }
  const expected = parseInt(line.slice(star + 1, star + 3), 16);
  return Number.isFinite(expected) && (sum & 0xff) === expected;
}

function sentenceType(line: string): string | null {
  const m = line.match(/^\$([A-Za-z0-9]{2})(GGA|RMC|GSA|VTG|GSV)/);
  return m ? m[2]! : null;
}

function applyGga(fix: GpsFix, fields: string[]): void {
  const lat = parseLatLon(fields[2], fields[3]);
  const lon = parseLatLon(fields[4], fields[5]);
  const quality = parseIntField(fields[6]);
  const sats = parseIntField(fields[7]);
  const hdop = parseNum(fields[8]);
  const alt = parseNum(fields[9]);
  const geoid = parseNum(fields[11]);

  if (fields[1]) {
    fix.utcTime = formatNmeaTime(fields[1]);
  }
  if (lat !== null) {
    fix.lat = lat;
  }
  if (lon !== null) {
    fix.lon = lon;
  }
  if (quality !== null) {
    fix.fixQuality = quality;
    fix.fixValid = quality > 0 && lat !== null && lon !== null;
  }
  if (sats !== null) {
    fix.satsUsed = sats;
  }
  if (hdop !== null) {
    fix.hdop = hdop;
  }
  if (alt !== null) {
    fix.altitudeM = alt;
  }
  if (geoid !== null) {
    fix.geoidSepM = geoid;
  }
  fix.lastSentence = "GGA";
}

function applyRmc(fix: GpsFix, fields: string[]): void {
  const status = fields[2]?.toUpperCase();
  const lat = parseLatLon(fields[3], fields[4]);
  const lon = parseLatLon(fields[5], fields[6]);
  const sog = parseNum(fields[7]);
  const cog = parseNum(fields[8]);
  const magVar = parseNum(fields[10]);
  const magHemi = fields[11]?.toUpperCase();

  if (fields[1]) {
    fix.utcTime = formatNmeaTime(fields[1]);
  }
  if (fields[9]) {
    fix.utcDate = formatNmeaDate(fields[9]);
  }
  if (lat !== null) {
    fix.lat = lat;
  }
  if (lon !== null) {
    fix.lon = lon;
  }
  if (status === "A") {
    fix.fixValid = lat !== null && lon !== null;
  } else if (status === "V") {
    fix.fixValid = false;
  }
  if (sog !== null) {
    fix.sogKnots = sog;
  }
  if (cog !== null) {
    fix.cogDeg = cog;
  }
  if (magVar !== null) {
    fix.magneticVariationDeg = magHemi === "W" ? -magVar : magVar;
  }
  fix.lastSentence = "RMC";
}

function applyGsa(fix: GpsFix, fields: string[]): void {
  if (fields[1]) {
    fix.fixMode = fields[1].toUpperCase();
  }
  const fixType = parseIntField(fields[2]);
  if (fixType !== null) {
    fix.fixType = fixType;
    if (fixType === 1) {
      fix.fixValid = false;
    }
  }
  const pdop = parseNum(fields[15]);
  const hdop = parseNum(fields[16]);
  const vdop = parseNum(fields[17]);
  if (pdop !== null) {
    fix.pdop = pdop;
  }
  if (hdop !== null) {
    fix.hdop = hdop;
  }
  if (vdop !== null) {
    fix.vdop = vdop;
  }
  fix.lastSentence = "GSA";
}

function applyVtg(fix: GpsFix, fields: string[]): void {
  const cog = parseNum(fields[1]);
  const sog = parseNum(fields[5]);
  if (cog !== null) {
    fix.cogDeg = cog;
  }
  if (sog !== null) {
    fix.sogKnots = sog;
  }
  fix.lastSentence = "VTG";
}

function applyGsv(fix: GpsFix, fields: string[]): void {
  const inView = parseIntField(fields[3]);
  if (inView !== null) {
    fix.satsInView = inView;
  }
  fix.lastSentence = "GSV";
}

/** Firmware PPS tick: $PREGPPS,<mono_us>,<count>[,<utc_us>[,<cap_ticks>,<cap_delta_us>]] (no checksum). */
function applyPregpps(fix: GpsFix, fields: string[]): void {
  const us = parseNum(fields[1]);
  const count = parseIntField(fields[2]);
  const utcUs = fields[3] !== undefined && fields[3].length > 0 ? parseNum(fields[3]) : null;
  const capTicks = fields[4] !== undefined ? parseIntField(fields[4]) : null;
  const capDeltaUs = fields[5] !== undefined ? parseIntField(fields[5]) : null;
  if (count !== null) {
    fix.ppsCount = count;
  }
  if (us !== null) {
    fix.ppsLastEdgeUs = us;
  }
  if (utcUs !== null) {
    fix.ppsUtcUs = utcUs;
  }
  if (capTicks !== null) {
    fix.ppsCapTicks = capTicks;
  }
  if (capDeltaUs !== null) {
    fix.ppsCapDeltaUs = capDeltaUs;
  }
  fix.ppsUpdatedAtMs = performance.now();
  fix.lastSentence = "PPS";
}

/** Merge one NMEA line into `fix` (mutates and returns the same object). */
export function applyNmeaLine(fix: GpsFix, rawLine: string): GpsFix {
  const line = rawLine.trim();
  if (!line.startsWith("$")) {
    return fix;
  }
  if (line.startsWith("$PREGPPS,")) {
    const fields = line.split(",");
    applyPregpps(fix, fields);
    return fix;
  }
  if (!nmeaChecksumOk(line)) {
    return fix;
  }
  const star = line.indexOf("*");
  const body = star >= 0 ? line.slice(0, star) : line;
  const fields = body.split(",");
  const type = sentenceType(line);
  if (!type) {
    return fix;
  }

  switch (type) {
    case "GGA":
      applyGga(fix, fields);
      break;
    case "RMC":
      applyRmc(fix, fields);
      break;
    case "GSA":
      applyGsa(fix, fields);
      break;
    case "VTG":
      applyVtg(fix, fields);
      break;
    case "GSV":
      applyGsv(fix, fields);
      break;
  }
  fix.updatedAtMs = performance.now();
  return fix;
}
