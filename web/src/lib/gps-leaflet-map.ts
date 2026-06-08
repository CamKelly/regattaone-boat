import L from "leaflet";

const DEFAULT_ZOOM = 16;
const MAP_STYLE_STORAGE_KEY = "regattaone-gps-map-style";
/** Min lat/lon delta before moving the marker (~1 m). */
const POSITION_EPS = 1e-5;

export type GpsLeafletMapStyle = "street" | "satellite";

const TILE_LAYERS: Record<
  GpsLeafletMapStyle,
  { url: string; maxZoom: number; attribution: string }
> = {
  street: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 19,
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, USDA, USGS, AeroGRID, IGN, and the GIS User Community",
  },
};

let map: L.Map | null = null;
let marker: L.CircleMarker | null = null;
let streetLayer: L.TileLayer | null = null;
let satelliteLayer: L.TileLayer | null = null;
let mapStyle: GpsLeafletMapStyle = "street";
let followMode = true;
let lastLat: number | null = null;
let lastLon: number | null = null;

function mapElement(): HTMLElement | null {
  return document.getElementById("gps-map");
}

function recenterButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("#gps-map-recenter");
}

function mapStyleControls(): HTMLElement | null {
  return document.getElementById("gps-map-style");
}

function createTileLayer(style: GpsLeafletMapStyle): L.TileLayer {
  const cfg = TILE_LAYERS[style];
  return L.tileLayer(cfg.url, {
    maxZoom: cfg.maxZoom,
    attribution: cfg.attribution,
    ...(style === "street" ? { subdomains: "abc" } : {}),
  });
}

function syncRecenterButton(): void {
  const btn = recenterButton();
  if (!btn) {
    return;
  }
  btn.hidden = !map || followMode || lastLat === null || lastLon === null;
}

function syncMapStyleControls(): void {
  const group = mapStyleControls();
  if (!group) {
    return;
  }
  group.hidden = !map || lastLat === null || lastLon === null;
  for (const style of ["street", "satellite"] as const) {
    const btn = document.querySelector<HTMLButtonElement>(`#gps-map-style-${style}`);
    if (!btn) {
      continue;
    }
    const active = mapStyle === style;
    btn.classList.toggle("gps-map-style-btn--active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
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

function activeTileLayer(): L.TileLayer | null {
  return mapStyle === "street" ? streetLayer : satelliteLayer;
}

function inactiveTileLayer(): L.TileLayer | null {
  return mapStyle === "street" ? satelliteLayer : streetLayer;
}

function applyMapStyle(style: GpsLeafletMapStyle): void {
  mapStyle = style;
  if (!map || !streetLayer || !satelliteLayer) {
    syncMapStyleControls();
    return;
  }

  const show = activeTileLayer();
  const hide = inactiveTileLayer();
  if (hide && map.hasLayer(hide)) {
    map.removeLayer(hide);
  }
  if (show && !map.hasLayer(show)) {
    show.addTo(map);
  }
  marker?.bringToFront();
  syncMapStyleControls();
}

function loadStoredMapStyle(): GpsLeafletMapStyle {
  try {
    const stored = localStorage.getItem(MAP_STYLE_STORAGE_KEY);
    if (stored === "street" || stored === "satellite") {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "street";
}

function storeMapStyle(style: GpsLeafletMapStyle): void {
  try {
    localStorage.setItem(MAP_STYLE_STORAGE_KEY, style);
  } catch {
    /* ignore */
  }
}

function ensureMap(lat: number, lon: number): void {
  const el = mapElement();
  if (!el || map) {
    return;
  }

  map = L.map(el, { zoomControl: false, attributionControl: true }).setView([lat, lon], DEFAULT_ZOOM);
  streetLayer = createTileLayer("street");
  satelliteLayer = createTileLayer("satellite");
  applyMapStyle(mapStyle);

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

/** Restore saved map style before the first fix creates the map. */
export function initGpsLeafletMapStyle(): GpsLeafletMapStyle {
  mapStyle = loadStoredMapStyle();
  syncMapStyleControls();
  return mapStyle;
}

export function getGpsLeafletMapStyle(): GpsLeafletMapStyle {
  return mapStyle;
}

export function setGpsLeafletMapStyle(style: GpsLeafletMapStyle): void {
  if (style !== "street" && style !== "satellite") {
    return;
  }
  if (style === mapStyle) {
    return;
  }
  storeMapStyle(style);
  applyMapStyle(style);
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
    syncRecenterButton();
    syncMapStyleControls();
    return;
  }

  marker.setLatLng([lat, lon]);

  if (followMode) {
    const zoom = map.getZoom();
    map.setView([lat, lon], zoom, { animate: true, duration: 0.35 });
  }

  syncRecenterButton();
  syncMapStyleControls();
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
    streetLayer = null;
    satelliteLayer = null;
  }
  lastLat = null;
  lastLon = null;
  followMode = true;
  setMapVisible(false);
  syncRecenterButton();
  syncMapStyleControls();
}
