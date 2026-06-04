import L from "leaflet";

const DEFAULT_ZOOM = 16;
/** Min lat/lon delta before moving the marker (~1 m). */
const POSITION_EPS = 1e-5;

let map: L.Map | null = null;
let marker: L.CircleMarker | null = null;
let followMode = true;
let lastLat: number | null = null;
let lastLon: number | null = null;

function mapElement(): HTMLElement | null {
  return document.getElementById("gps-map");
}

function recenterButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("#gps-map-recenter");
}

function syncRecenterButton(): void {
  const btn = recenterButton();
  if (!btn) {
    return;
  }
  btn.hidden = !map || followMode || lastLat === null || lastLon === null;
}

function setMapVisible(visible: boolean): void {
  const el = mapElement();
  if (el) {
    el.classList.toggle("gps-map--hidden", !visible);
  }
}

function disableFollowMode(): void {
  if (!followMode) {
    return;
  }
  followMode = false;
  syncRecenterButton();
}

function ensureMap(lat: number, lon: number): void {
  const el = mapElement();
  if (!el || map) {
    return;
  }

  map = L.map(el, { zoomControl: true, attributionControl: true }).setView([lat, lon], DEFAULT_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  marker = L.circleMarker([lat, lon], {
    radius: 8,
    color: "#ffffff",
    weight: 2,
    fillColor: "#1677ff",
    fillOpacity: 1,
  }).addTo(map);

  map.on("dragstart", disableFollowMode);
  map.on("zoomstart", (ev: L.LeafletEvent) => {
    if ("originalEvent" in ev && ev.originalEvent) {
      disableFollowMode();
    }
  });

  requestAnimationFrame(() => map?.invalidateSize());
}

/** Create or update boat position; tiles load once, marker moves without reload. */
export function updateGpsLeafletMap(lat: number, lon: number): void {
  setMapVisible(true);
  ensureMap(lat, lon);
  if (!map || !marker) {
    return;
  }

  const moved =
    lastLat === null ||
    lastLon === null ||
    Math.abs(lat - lastLat) > POSITION_EPS ||
    Math.abs(lon - lastLon) > POSITION_EPS;

  lastLat = lat;
  lastLon = lon;

  if (!moved) {
    return;
  }

  marker.setLatLng([lat, lon]);

  if (followMode) {
    const zoom = map.getZoom();
    map.setView([lat, lon], zoom, { animate: true, duration: 0.35 });
  }

  syncRecenterButton();
}

/** Center map on current fix at default zoom and resume follow mode. */
export function recenterGpsLeafletMap(): void {
  if (!map || lastLat === null || lastLon === null) {
    return;
  }
  followMode = true;
  map.setView([lastLat, lastLon], DEFAULT_ZOOM, { animate: true, duration: 0.4 });
  syncRecenterButton();
}

export function invalidateGpsLeafletMapSize(): void {
  map?.invalidateSize();
}

export function clearGpsLeafletMap(): void {
  if (map) {
    map.remove();
    map = null;
    marker = null;
  }
  lastLat = null;
  lastLon = null;
  followMode = true;
  setMapVisible(false);
  syncRecenterButton();
}
