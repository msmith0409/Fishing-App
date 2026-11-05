// Map tab: Leaflet (vendored in /vendor/leaflet, loaded only when the map is opened).
// Base maps: Esri World Imagery (satellite) and OpenStreetMap (street). Only the map area you look at is
// requested; tiles you've viewed are kept by the service worker so the map works with no signal.

let leafletP;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'vendor/leaflet/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = () => { leafletP = null; reject(new Error('Map library failed to load')); };
    document.head.appendChild(s);
  });
  return leafletP;
}

export const BASES = {
  sat: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxNativeZoom: 19, maxZoom: 20, attribution: 'Imagery: Esri, Vantor, Earthstar Geographics, GIS User Community' },
  },
  street: {
    label: 'Street',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxNativeZoom: 19, maxZoom: 20, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
  },
};

export const SPOT_TYPES = [
  { id: 'ramp', name: 'Boat ramp', icon: '⚓' },
  { id: 'brush', name: 'Brush / attractor', icon: '🌲' },
  { id: 'point', name: 'Point', icon: '◆' },
  { id: 'ledge', name: 'Drop-off / ledge', icon: '⤵' },
  { id: 'channel', name: 'Channel edge', icon: '〰' },
  { id: 'flat', name: 'Flat', icon: '▭' },
  { id: 'hump', name: 'Hump / rock pile', icon: '⛰' },
  { id: 'dock', name: 'Dock / bridge', icon: '⌂' },
  { id: 'timber', name: 'Standing timber', icon: '🪵' },
  { id: 'weeds', name: 'Weeds / grass', icon: '🌿' },
  { id: 'other', name: 'Other', icon: '★' },
];
export const spotType = (id) => SPOT_TYPES.find((t) => t.id === id) || SPOT_TYPES[SPOT_TYPES.length - 1];

export const SPECIES_COLOR = {
  walleye: '#d4a017', bass: '#2e8b3a', crappie: '#8e44ad', whitebass: '#9aa5b1', catfish: '#6b4f2a',
  hybrid: '#2b6cb0', bluegill: '#e67e22', drum: '#7f8c8d', other: '#e84393',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Create the map inside `el`.
 * handlers: { onLongPress(lat, lon), onSpot(id), onUserMove(), onAction(buttonEl) }
 * Returns a controller; call destroy() when leaving the tab.
 */
export async function createMap(el, { view, base = 'sat', handlers }) {
  const L = await loadLeaflet();
  const map = L.map(el, { zoomControl: false, preferCanvas: true, attributionControl: true, tapHold: true });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  if (view && view.center) map.setView(view.center, view.zoom);
  else map.setView([38.6, -93.6], 7);

  const tiles = {};
  for (const [k, b] of Object.entries(BASES)) tiles[k] = L.tileLayer(b.url, { ...b.opts, crossOrigin: true, keepBuffer: 3 });
  let current = base;
  tiles[current].addTo(map);

  const renderer = L.canvas({ padding: 0.3 });
  const groups = { spots: L.layerGroup().addTo(map), catches: L.layerGroup().addTo(map), attractors: L.layerGroup().addTo(map) };
  const shown = { spots: true, catches: true, attractors: true };
  const meLayer = L.layerGroup().addTo(map);
  let meDot = null, meAcc = null;

  map.on('contextmenu', (e) => handlers.onLongPress && handlers.onLongPress(e.latlng.lat, e.latlng.lng));
  map.on('dragstart', () => handlers.onUserMove && handlers.onUserMove());
  // Leaflet stops clicks inside popups from bubbling, so wire popup buttons up directly.
  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (el) el.querySelectorAll('[data-act]').forEach((btn) => { btn.onclick = (ev) => { ev.preventDefault(); handlers.onAction && handlers.onAction(btn); }; });
  });

  // MDC attractors are dense (2,000+ on Smithville); only draw them when zoomed in enough to be useful.
  const ATTR_MIN_ZOOM = 12;
  const syncAttrVisibility = () => {
    const want = shown.attractors && map.getZoom() >= ATTR_MIN_ZOOM;
    if (want && !map.hasLayer(groups.attractors)) map.addLayer(groups.attractors);
    if (!want && map.hasLayer(groups.attractors)) map.removeLayer(groups.attractors);
  };
  map.on('zoomend', syncAttrVisibility);

  const ctl = {
    map,
    get base() { return current; },
    setBase(k) {
      if (!tiles[k] || k === current) return;
      map.removeLayer(tiles[current]); tiles[k].addTo(map); current = k;
    },
    show(name, on) {
      shown[name] = on;
      if (name === 'attractors') return syncAttrVisibility();
      if (on) map.addLayer(groups[name]); else map.removeLayer(groups[name]);
    },
    attrMinZoom: ATTR_MIN_ZOOM,
    setSpots(spots) {
      groups.spots.clearLayers();
      for (const s of spots) {
        const t = spotType(s.type);
        const icon = L.divIcon({ className: '', html: `<div class="spot-pin t-${esc(s.type)}"><span>${t.icon}</span></div><div class="spot-label">${esc(s.name)}</div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
        L.marker([s.lat, s.lon], { icon, keyboard: false, title: s.name })
          .on('click', () => handlers.onSpot && handlers.onSpot(s.id)).addTo(groups.spots);
      }
    },
    setCatches(list) {
      groups.catches.clearLayers();
      for (const c of list) {
        L.circleMarker([c.lat, c.lon], { renderer, radius: 7, weight: 2, color: '#fff', fillColor: SPECIES_COLOR[c.species] || '#e84393', fillOpacity: 0.95 })
          .bindPopup(c.popup).addTo(groups.catches);
      }
    },
    setAttractors(list) {
      groups.attractors.clearLayers();
      for (const a of list) {
        L.circleMarker([a.lat, a.lon], { renderer, radius: 5, weight: 1.5, color: '#fff', fillColor: '#ea580c', fillOpacity: 0.9 })
          .bindPopup(a.popup).addTo(groups.attractors);
      }
      syncAttrVisibility();
    },
    setMe(pos) {
      if (!pos) return;
      const ll = [pos.lat, pos.lon];
      if (!meDot) {
        meAcc = L.circle(ll, { radius: pos.acc || 20, weight: 1, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false }).addTo(meLayer);
        meDot = L.circleMarker(ll, { radius: 8, weight: 3, color: '#fff', fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(meLayer);
      } else { meDot.setLatLng(ll); meAcc.setLatLng(ll); meAcc.setRadius(pos.acc || 20); }
    },
    fitBounds(b) { map.fitBounds(b, { padding: [10, 10] }); },
    flyTo(lat, lon, zoom) { map.flyTo([lat, lon], Math.max(zoom || 16, map.getZoom()), { duration: 0.6 }); },
    view() { const c = map.getCenter(); return { center: [c.lat, c.lng], zoom: map.getZoom() }; },
    invalidate() { map.invalidateSize(); },
    destroy() { map.remove(); },
  };
  return ctl;
}
