import { db, uid, requestPersistence } from './db.js';
import { DEFAULT_LAKES, GENERAL_LINKS, LINKS_VERIFIED, SPECIES, ALL_SPECIES, speciesName } from './lakes.js';
import { LURES, lureLabel, PLAYBOOK } from './playbook.js';
import { getForecast, weatherSnapshot, dirToDeg, SKY_LABEL, skyBucket } from './weather.js';
import { sunTimes } from './sun.js';
import { suggest, summarizeWindow, detectPostFront, pickPhase } from './suggest.js';
import { computeStats, smallSample, tripHours } from './stats.js';
import { ATTRACTORS, ATTRACTOR_TYPES, ATTRACTOR_SOURCE } from './attractors.js';
import { distM, bearing, cardinal, fmtDist, lakeForPoint, toGPX, readWaypointsFile } from './geo.js';
import { createMap, SPOT_TYPES, spotType, SPECIES_COLOR } from './map.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtHour = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' }).replace(' ', '').toLowerCase();
const fmtDate = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtDateTime = (t) => `${fmtDate(t)} ${fmtTime(t)}`;
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const toLocalInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const round1 = (x) => (x == null ? '–' : (Math.round(x * 10) / 10).toString());
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 48) return `${h} hr ago`; return `${Math.round(h / 24)} days ago`; };

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- state ----------
const DEFAULT_SETTINGS = { windCaution: 10, windNoGo: 16, gustNoGo: 25, autoGps: false, lakeOverrides: {} };
let settings = { ...DEFAULT_SETTINGS };
let plan = { lakeId: 'jacomo', dayOffset: 0, startHour: 6, endHour: 12, species: 'walleye', waterTemp: null, clarity: '', postFront: 'auto' };
let data = { trips: [], catches: [], spots: [] };
let attractorOverrides = {}; // lakeId -> { points: [[lat, lon, desc]], importedAt } from a newer MDC file
let mapState = { ctl: null, creating: false, lakeId: null, base: 'sat', show: { spots: true, catches: true, attractors: true }, view: null, follow: false, centerOnFix: false, listAt: 0 };
let wxCache = {}; // lakeId -> forecast result
let wxLoading = {};
let wxError = {};

const lakes = () => DEFAULT_LAKES.map((l) => ({ ...l, ...(settings.lakeOverrides[l.id] || {}) }));
const lakeById = (id) => lakes().find((l) => l.id === id) || lakes()[0];
const activeTrip = () => data.trips.find((t) => !t.end);
const tripById = (id) => data.trips.find((t) => t.id === id);

function enrichedCatches() {
  return data.catches.map((c) => {
    const t = tripById(c.tripId) || {};
    return { ...c, weather: c.weather || t.weather || null, clarity: c.clarity || t.clarity || '', lakeId: c.lakeId || t.lakeId };
  });
}

async function loadData() {
  const [trips, catches, spots] = await Promise.all([db.all('trips'), db.all('catches'), db.all('spots')]);
  data.trips = trips.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  data.catches = catches.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  data.spots = spots.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- spots / location helpers ----------
const spotById = (id) => data.spots.find((s) => s.id === id);
const SPOT_RADIUS_M = 75; // a catch within this distance of a spot counts as "at" the spot
/** Where a catch was: its own GPS, else the saved spot it was tagged with. */
function catchPos(c) {
  if (c.lat != null && c.lon != null) return { lat: c.lat, lon: c.lon };
  const s = c.spotId && spotById(c.spotId);
  return s ? { lat: s.lat, lon: s.lon } : null;
}
function catchesAtSpot(spot) {
  return enrichedCatches().filter((c) => {
    if (c.spotId === spot.id) return true;
    if (c.spotId) return false; // tagged to a different spot
    const p = catchPos(c);
    return p && distM(p, spot) <= SPOT_RADIUS_M;
  });
}
/** The spot a catch belongs to (tagged, else nearest within the radius). */
function spotForCatch(c) {
  if (c.spotId) return spotById(c.spotId) || null;
  const p = catchPos(c);
  if (!p) return null;
  let best = null, bd = Infinity;
  for (const s of data.spots) { const d = distM(p, s); if (d < bd) { bd = d; best = s; } }
  return bd <= SPOT_RADIUS_M ? best : null;
}
function attractorsFor(lakeId) {
  const o = attractorOverrides[lakeId];
  if (o) return o.points.map(([lat, lon, desc]) => ({ lat, lon, desc }));
  return (ATTRACTORS[lakeId] || []).map(([lat, lon, t]) => ({ lat, lon, desc: ATTRACTOR_TYPES[t] }));
}

// Shared GPS watch: runs only while something on screen needs it (map tab, spot guide).
let here = null; // { lat, lon, acc, heading, speed, t }
let geoWatch = null, geoError = null;
const geoSubs = new Map();
function geoSubscribe(key, fn) {
  geoSubs.set(key, fn);
  if (geoWatch != null || !navigator.geolocation) return;
  geoWatch = navigator.geolocation.watchPosition((p) => {
    here = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, t: Date.now() };
    geoError = null;
    geoSubs.forEach((f) => f());
  }, (e) => { geoError = e.message || 'Location unavailable'; geoSubs.forEach((f) => f()); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function geoUnsubscribe(key) {
  geoSubs.delete(key);
  if (!geoSubs.size && geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
}
/** One fresh position (reuses the live watch if it's recent). */
function currentPosition() {
  if (here && Date.now() - here.t < 15000) return Promise.resolve(here);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('GPS not available')); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      here = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, t: Date.now() };
      resolve(here);
    }, (e) => reject(new Error(e.message || 'Location unavailable')), { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  });
}
const distLabel = (p) => { if (!here || !p) return ''; const b = bearing(here, p); return `${fmtDist(distM(here, p))} ${cardinal(b)}`; };
const savePlan = () => db.kvSet('plan', plan);
const saveSettings = () => db.kvSet('settings', settings);

// ---------- routing ----------
const routes = { plan: renderPlan, log: renderLog, stats: renderStats, more: renderMore };
function route() { return (location.hash.replace('#', '').split('/')[0]) || 'plan'; }
function routeArg() { return location.hash.replace('#', '').split('/')[1]; }
async function render() {
  const r = route();
  document.querySelectorAll('nav.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.r === r));
  const main = $('#main');
  if (r === 'map') { await renderMapTab(); return; }
  if (mapState.ctl) teardownMap();
  if (r === 'trip') { main.innerHTML = await renderTrip(routeArg()); return; }
  main.innerHTML = await (routes[r] || renderPlan)();
}

// ---------- MAP ----------
const saveMapPrefs = () => db.kvSet('mapPrefs', { lakeId: mapState.lakeId, base: mapState.base, show: mapState.show, view: mapState.view });

function teardownMap() {
  if (!mapState.ctl) return;
  mapState.view = mapState.ctl.view();
  saveMapPrefs();
  mapState.ctl.destroy();
  mapState.ctl = null;
  geoUnsubscribe('map');
}

function mapCatchList() {
  return enrichedCatches().map((c) => {
    const p = catchPos(c);
    if (!p) return null;
    const s = spotForCatch(c);
    return { ...p, species: c.species, popup: `<b>${esc(speciesName(c.species))}${c.lengthIn ? ` ${c.lengthIn}"` : ''}${c.weightLb ? ` ${c.weightLb} lb` : ''}</b><br>${esc(lureLabel(c.lureType))}${c.lureName ? ` (${esc(c.lureName)})` : ''}${c.color ? `, ${esc(c.color)}` : ''}${c.depthFt != null ? ` · ${c.depthFt} ft` : ''}<br><span class="muted">${fmtDateTime(c.time)}${s ? ` · ${esc(s.name)}` : ''}</span>` };
  }).filter(Boolean);
}

function mapAttractorList(lakeId) {
  return attractorsFor(lakeId).map((a) => ({ ...a, popup: `<b>MDC fish attractor</b><br>${esc(a.desc || 'Type not listed')}<br><span class="muted">${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}</span><br><button class="btn ghost small" data-act="attr2spot" data-lat="${a.lat}" data-lon="${a.lon}" data-desc="${esc(a.desc)}">Save as my spot</button>` }));
}

function mapRefreshLayers() {
  const c = mapState.ctl;
  if (!c) return;
  c.setSpots(data.spots);
  c.setCatches(mapCatchList());
  c.setAttractors(mapAttractorList(mapState.lakeId));
  for (const k of Object.keys(mapState.show)) c.show(k, mapState.show[k]);
  if (here) c.setMe(here);
}

function mapChrome() {
  const lake = lakeById(mapState.lakeId);
  const spotsHere = data.spots.filter((s) => s.lakeId === lake.id).length;
  const catchesWithPos = enrichedCatches().filter((c) => catchPos(c)).length;
  const attrN = attractorsFor(lake.id).length;
  $('#map-lakes').innerHTML = lakes().map((l) => `<button class="chip ${l.id === lake.id ? 'on' : ''}" data-act="maplake" data-v="${l.id}">${esc(l.name)}</button>`).join('');
  const layerChip = (k, label) => `<button class="chip ${mapState.show[k] ? 'on' : ''}" data-act="maplayer" data-v="${k}" aria-pressed="${mapState.show[k]}">${label}</button>`;
  $('#map-layers').innerHTML = layerChip('spots', `My spots (${spotsHere})`) + layerChip('catches', `My catches (${catchesWithPos})`) + layerChip('attractors', `MDC attractors (${attrN})`);
  const zoomedOut = mapState.ctl && mapState.ctl.map.getZoom() < mapState.ctl.attrMinZoom;
  $('#map-hint').innerHTML = [
    mapState.show.attractors && attrN && zoomedOut ? 'Zoom in to see the MDC attractors.' : '',
    'Long-press the map to save a spot anywhere.',
    geoError ? `Location: ${esc(geoError)}` : '',
  ].filter(Boolean).join(' ');
  $('#mapbase').textContent = mapState.base === 'sat' ? '🗺 Street' : '🛰 Satellite';
  renderSpotList();
}

function renderSpotList() {
  const el = $('#map-spots');
  if (!el) return;
  mapState.listAt = Date.now();
  const lake = lakeById(mapState.lakeId);
  const sortByDist = (arr) => (here ? [...arr].sort((a, b) => distM(here, a) - distM(here, b)) : arr);
  const row = (s) => {
    const n = catchesAtSpot(s).length;
    return `<li><button class="rowbtn" data-act="openspot" data-id="${s.id}">
      <b>${spotType(s.type).icon} ${esc(s.name)}</b>
      <span class="small">${esc(spotType(s.type).name)}${s.depthFt != null ? ` · ${s.depthFt} ft` : ''}${n ? ` · ${n} fish` : ''}</span>
      ${here ? `<span class="small muted">${distLabel(s)}</span>` : ''}
    </button></li>`;
  };
  const mine = sortByDist(data.spots.filter((s) => s.lakeId === lake.id));
  const other = sortByDist(data.spots.filter((s) => !s.lakeId));
  el.innerHTML = `<h2>My spots on ${esc(lake.name)}</h2>
    ${mine.length ? `<ul class="list">${mine.map(row).join('')}</ul>` : '<p class="muted small">No saved spots on this lake yet. Tap "Save a spot where I am" on the water, or long-press the map.</p>'}
    ${other.length ? `<h3>Not on one of your lakes</h3><ul class="list">${other.map(row).join('')}</ul>` : ''}
    <p class="small muted">Spots are private and saved on this phone only. MDC attractor data downloaded ${esc(attractorOverrides[lake.id] ? ymd(attractorOverrides[lake.id].importedAt) + ' (your import)' : ATTRACTOR_SOURCE.downloaded)}.</p>`;
}

function onMapGeo() {
  if (!mapState.ctl) return;
  if (here) {
    mapState.ctl.setMe(here);
    if (mapState.centerOnFix) { mapState.centerOnFix = false; mapState.follow = true; mapState.ctl.flyTo(here.lat, here.lon, 16); }
    else if (mapState.follow) mapState.ctl.map.panTo([here.lat, here.lon], { animate: true });
  }
  if (Date.now() - mapState.listAt > 10000) mapChrome();
}

async function renderMapTab() {
  const main = $('#main');
  if (!mapState.lakeId) mapState.lakeId = plan.lakeId;
  if (!$('#map', main)) {
    mapState.ctl = null;
    main.innerHTML = `
      <section class="card mapcard">
        <div class="chips scroll" id="map-lakes" role="group" aria-label="Lake"></div>
        <div class="mapbox">
          <div id="map" aria-label="Map"></div>
          <div class="map-btns">
            <button class="mapbtn" id="mapbase" data-act="mapbase">Street</button>
            <button class="mapbtn" data-act="mapme" aria-label="Center on my location">◎ Me</button>
          </div>
        </div>
        <div class="chips" id="map-layers" role="group" aria-label="Layers"></div>
        <p class="small muted" id="map-hint"></p>
      </section>
      <button class="btn big" data-act="spothere">+ Save a spot where I am</button>
      <section class="card" id="map-spots"></section>`;
  }
  mapChrome();
  geoSubscribe('map', onMapGeo);
  if (mapState.ctl) { mapRefreshLayers(); return; }
  if (mapState.creating) return;
  mapState.creating = true;
  const el = $('#map');
  try {
    const ctl = await createMap(el, {
      view: mapState.view, base: mapState.base,
      handlers: {
        onLongPress: (lat, lon) => openSpotForm({ lat, lon }),
        onSpot: (id) => openSpotSheet(id),
        onUserMove: () => { mapState.follow = false; },
        onAction: (btn) => { const fn = actions[btn.dataset.act]; if (fn) fn(btn); },
      },
    });
    if (route() !== 'map' || !document.body.contains(el)) { ctl.destroy(); return; }
    mapState.ctl = ctl;
    ctl.map.on('zoomend moveend', () => { mapState.view = ctl.view(); mapChrome(); });
    if (!mapState.view) ctl.fitBounds(lakeById(mapState.lakeId).bounds);
    if (mapState.pendingFly) { ctl.flyTo(mapState.pendingFly.lat, mapState.pendingFly.lon, 17); mapState.pendingFly = null; }
    mapRefreshLayers();
    mapChrome();
  } catch (e) {
    el.innerHTML = `<p class="pad">The map couldn't load (${esc(e.message)}). It needs a signal the first time; after that it works offline. Your spots are listed below.</p>`;
  } finally { mapState.creating = false; }
}

function showOnMap(lat, lon, lakeId) {
  if (lakeId) mapState.lakeId = lakeId;
  if (route() === 'map' && mapState.ctl) { mapState.follow = false; mapState.ctl.flyTo(lat, lon, 17); mapChrome(); mapRefreshLayers(); return; }
  mapState.pendingFly = { lat, lon };
  location.hash = '#map';
}

// ---------- spot form & sheet ----------
function openSpotForm(draft) {
  const existing = draft.id ? spotById(draft.id) : null;
  const s = existing || { name: '', type: 'other', depthFt: null, notes: '', ...draft };
  if (!existing && !s.lakeId) s.lakeId = lakeForPoint(lakes(), s);
  const dlg = $('#sheet');
  dlg.innerHTML = `<form method="dialog" id="spotform" class="form">
    <h2>${existing ? 'Edit spot' : 'Save a spot'}</h2>
    <label>Name <input name="name" value="${esc(s.name)}" placeholder="e.g. North cove brush pile" maxlength="60"></label>
    <div class="chips" role="group" aria-label="Type">${SPOT_TYPES.map((t) => `<label class="chip radio"><input type="radio" name="type" value="${t.id}" ${t.id === s.type ? 'checked' : ''}><span>${t.icon} ${esc(t.name)}</span></label>`).join('')}</div>
    <div class="row">
      <label>Lake <select name="lakeId"><option value="">Other</option>${lakes().map((l) => `<option value="${l.id}" ${l.id === s.lakeId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>Depth ft <input type="number" step="0.5" inputmode="decimal" name="depthFt" value="${s.depthFt ?? ''}"></label>
    </div>
    <div class="row">
      <label>Latitude <input type="number" step="any" inputmode="decimal" name="lat" value="${s.lat != null ? s.lat.toFixed(6) : ''}" required></label>
      <label>Longitude <input type="number" step="any" inputmode="decimal" name="lon" value="${s.lon != null ? s.lon.toFixed(6) : ''}" required></label>
    </div>
    <div class="row">
      <button type="button" class="btn ghost" data-act="spotgps">📍 Use my location</button>
      <span class="small muted" id="spotgpsinfo">${s.acc ? `GPS accuracy ±${Math.round(s.acc)} m` : ''}</span>
    </div>
    <label>Notes <textarea name="notes" rows="2" placeholder="what's here, how to approach it, best wind">${esc(s.notes)}</textarea></label>
    <div class="row sticky">
      <button type="button" class="btn ghost" data-act="closesheet">Cancel</button>
      ${existing ? `<button type="button" class="btn danger" data-act="delspot" data-id="${existing.id}">Delete</button>` : ''}
      <button type="submit" class="btn">Save</button>
    </div>
  </form>`;
  if (!dlg.open) dlg.showModal();

  $('#spotform').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const lat = num(f.get('lat')), lon = num(f.get('lon'));
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('Enter a valid latitude and longitude'); return; }
    const type = f.get('type') || 'other';
    const rec = existing ? { ...existing } : { id: uid(), createdAt: Date.now() };
    rec.lat = lat; rec.lon = lon; rec.type = type;
    rec.lakeId = f.get('lakeId') || null;
    rec.depthFt = num(f.get('depthFt'));
    rec.notes = f.get('notes').trim();
    rec.name = f.get('name').trim() || `${spotType(type).name} ${data.spots.filter((x) => x.type === type).length + (existing ? 0 : 1)}`;
    rec.updatedAt = Date.now();
    await db.put('spots', rec);
    dlg.close();
    await loadData();
    if (route() === 'map') { if (rec.lakeId && rec.lakeId !== mapState.lakeId) mapState.lakeId = rec.lakeId; mapRefreshLayers(); mapChrome(); } else render();
    toast(existing ? 'Spot updated' : `Saved "${rec.name}"`);
  });
}

async function spotFormGps() {
  const info = $('#spotgpsinfo');
  info.textContent = 'Getting location…';
  try {
    const p = await currentPosition();
    const f = $('#spotform'); if (!f) return;
    f.lat.value = p.lat.toFixed(6); f.lon.value = p.lon.toFixed(6);
    const lk = lakeForPoint(lakes(), p);
    if (lk) f.lakeId.value = lk;
    info.textContent = `GPS accuracy ±${Math.round(p.acc)} m`;
  } catch (e) { info.textContent = `No location: ${e.message}`; }
}

// Compass for the "guide me" arrow (Android Chrome gives true-north heading via deviceorientationabsolute).
let compass = null;
const onOrient = (e) => { if (e.absolute && e.alpha != null) { compass = (360 - e.alpha + (screen.orientation ? screen.orientation.angle : 0)) % 360; updateGuide(); } };

let guideSpot = null;
function updateGuide() {
  const el = $('#guide');
  if (!el || !guideSpot) return;
  if (!here) { el.innerHTML = `<div class="guide-txt">${geoError ? `No location: ${esc(geoError)}` : 'Waiting for GPS…'}</div>`; return; }
  const d = distM(here, guideSpot), b = bearing(here, guideSpot);
  const moving = here.speed != null && here.speed > 1.5 && here.heading != null && !Number.isNaN(here.heading);
  const heading = moving ? here.heading : compass;
  const rot = heading != null ? b - heading : b;
  const onIt = d <= Math.max(12, here.acc || 0);
  el.innerHTML = `
    <div class="guide-arrow" style="transform:rotate(${Math.round(rot)}deg)" aria-hidden="true">${onIt ? '◎' : '⬆'}</div>
    <div class="guide-txt">
      <div class="guide-dist">${onIt ? "You're on it" : fmtDist(d)}</div>
      <div>${Math.round(b)}° ${cardinal(b)} · GPS ±${Math.round(here.acc)} m</div>
      <div class="small muted">${heading == null ? 'Arrow: north is up (no compass reading)' : moving ? 'Arrow follows the boat’s direction of travel' : 'Arrow uses the phone compass (keep it flat, away from the motor)'}</div>
    </div>`;
}

function openSpotSheet(id) {
  const s = spotById(id);
  if (!s) return;
  const t = spotType(s.type);
  const cs = catchesAtSpot(s);
  const trips = new Set(cs.map((c) => c.tripId)).size;
  const count = (key) => { const m = {}; for (const c of cs) { const k = key(c); if (k) m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bySp = count((c) => speciesName(c.species));
  const byLure = count((c) => `${lureLabel(c.lureType)}${c.color ? `, ${c.color}` : ''}`).slice(0, 3);
  const dlg = $('#sheet');
  dlg.innerHTML = `<div class="form">
    <h2>${t.icon} ${esc(s.name)}</h2>
    <p class="small muted">${esc(t.name)}${s.depthFt != null ? ` · ${s.depthFt} ft` : ''} · ${esc(s.lakeId ? lakeById(s.lakeId).name : 'Other')} · ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</p>
    ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
    <div class="guide" id="guide"></div>
    <h3>Fish here</h3>
    ${cs.length ? `<p><b>${cs.length}</b> fish on <b>${trips}</b> trip${trips === 1 ? '' : 's'}${trips < 3 ? ' <span class="tag">small sample</span>' : ''}. Last one ${fmtDate(cs[0].time)}.</p>
      <p class="small">${bySp.map(([k, n]) => `${esc(k)}: ${n}`).join(' · ')}</p>
      ${byLure.length ? `<p class="small"><b>Top baits:</b> ${byLure.map(([k, n]) => `${esc(k)} (${n})`).join('; ')}</p>` : ''}
      ${catchList(cs.slice(0, 5))}`
      : `<p class="small muted">No fish logged here yet. Fish count toward this spot when you pick it in the catch form or save their GPS within about ${Math.round(SPOT_RADIUS_M * 1.09)} yards.</p>`}
    <div class="row sticky">
      <button type="button" class="btn ghost" data-act="closesheet">Close</button>
      <a class="btn ghost" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}" target="_blank" rel="noopener">Drive</a>
      <button type="button" class="btn ghost" data-act="spotonmap" data-id="${s.id}">Map</button>
      <button type="button" class="btn" data-act="editspot" data-id="${s.id}">Edit</button>
    </div>
  </div>`;
  if (!dlg.open) dlg.showModal();
  guideSpot = s;
  updateGuide();
  geoSubscribe('guide', updateGuide);
  window.addEventListener('deviceorientationabsolute', onOrient);
  const stop = () => {
    // the sheet's content may be swapped (Edit, a catch) while it stays open; stop guiding once it's gone
    if (dlg.open && $('#guide')) return;
    guideSpot = null; compass = null;
    geoUnsubscribe('guide');
    window.removeEventListener('deviceorientationabsolute', onOrient);
    dlg.removeEventListener('close', stop);
    mo.disconnect();
  };
  const mo = new MutationObserver(stop);
  mo.observe(dlg, { childList: true });
  dlg.addEventListener('close', stop);
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ---------- PLAN ----------
function planTimes() {
  const lake = lakeById(plan.lakeId);
  const day = dayStart(Date.now()) + plan.dayOffset * 86400000;
  const d = new Date(day);
  const sun = sunTimes(d, lake.lat, lake.lon);
  const start = day + plan.startHour * 3600000;
  const end = day + plan.endHour * 3600000;
  return { lake, day, sun: { sunrise: sun.sunrise.getTime(), sunset: sun.sunset.getTime() }, start, end };
}

function loadWeather(lake, force = false) {
  if (wxLoading[lake.id]) return;
  wxLoading[lake.id] = true;
  getForecast(lake, { force })
    .then((r) => { wxCache[lake.id] = r; wxError[lake.id] = r.stale ? r.error : null; })
    .catch((e) => { wxError[lake.id] = String(e.message || e); })
    .finally(() => { wxLoading[lake.id] = false; if (route() === 'plan') render(); });
}

function boatRating(c) {
  if (!c) return null;
  const reasons = [];
  let level = 'good';
  if (c.maxThunder >= 30) { level = 'nogo'; reasons.push(`thunder chance ${c.maxThunder}%`); }
  if (c.maxWind >= settings.windNoGo) { level = 'nogo'; reasons.push(`wind to ${c.maxWind} mph`); }
  if (c.maxGust != null && c.maxGust >= settings.gustNoGo) { level = 'nogo'; reasons.push(`gusts to ${c.maxGust} mph`); }
  if (level === 'good') {
    if (c.maxWind >= settings.windCaution) { level = 'caution'; reasons.push(`wind to ${c.maxWind} mph`); }
    if (c.maxGust != null && c.maxGust >= settings.windCaution + 8) { level = 'caution'; reasons.push(`gusts to ${c.maxGust} mph`); }
    if (c.maxThunder >= 10) { level = 'caution'; reasons.push(`thunder chance ${c.maxThunder}%`); }
  }
  const text = { good: 'Looks good for the boat', caution: 'Caution: choppy on open water', nogo: 'Rough: think twice in a 16 ft boat' }[level];
  return { level, text, reasons };
}

const arrow = (dir) => { const d = dirToDeg(dir); return d == null ? '' : `<span class="arrow" style="transform:rotate(${d + 180}deg)" aria-hidden="true">↑</span>`; };

async function renderPlan() {
  const { lake, day, sun, start, end } = planTimes();
  const wx = wxCache[lake.id];
  if (!wx && !wxLoading[lake.id] && !wxError[lake.id]) loadWeather(lake);
  if (wx && Date.now() - wx.fetchedAt > 20 * 60000 && navigator.onLine) loadWeather(lake);

  const dayChips = [...Array(7)].map((_, i) => {
    const t = dayStart(Date.now()) + i * 86400000;
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    return `<button class="chip ${plan.dayOffset === i ? 'on' : ''}" data-act="day" data-v="${i}">${label}</button>`;
  }).join('');
  const hourOpts = (sel) => [...Array(25)].map((_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${h === 0 || h === 24 ? '12am' : h < 12 ? h + 'am' : h === 12 ? '12pm' : (h - 12) + 'pm'}</option>`).join('');

  let wxHtml;
  let cond = null;
  if (wx) {
    cond = summarizeWindow(wx.hours, start, end, sun);
    const rating = boatRating(cond);
    const dayHours = wx.hours.filter((h) => h.t >= day && h.t < day + 86400000);
    wxHtml = `
      ${wx.stale ? `<div class="banner warn">Offline: showing the forecast from ${ago(wx.fetchedAt)}.</div>` : ''}
      ${wx.alerts && wx.alerts.length ? wx.alerts.map((a) => `<details class="banner ${a.severity === 'Severe' || a.severity === 'Extreme' ? 'bad' : 'warn'}"><summary><b>${esc(a.event)}</b>${a.ends ? `, until ${fmtDateTime(a.ends)}` : ''}</summary><p>${esc(a.headline || '')}</p><p class="small pre">${esc(a.description || '')}</p></details>`).join('') : ''}
      ${cond ? `
        <div class="wind-hero ${rating.level}">
          <div class="wind-main">
            <div class="wind-num">${cond.maxWind}<small> mph</small></div>
            <div class="wind-dir">${arrow(cond.mainDir)} from ${esc(cond.mainDir || '?')}</div>
          </div>
          <div class="wind-side">
            <div><span class="lbl">Gusts</span> <b>${cond.maxGust != null ? cond.maxGust + ' mph' : '–'}</b></div>
            <div><span class="lbl">Avg wind</span> <b>${round1(cond.avgWind)} mph</b></div>
            <div><span class="lbl">Rain</span> <b>${cond.maxPop ?? 0}%</b> <span class="lbl">Thunder</span> <b>${cond.maxThunder ?? 0}%</b></div>
            <div><span class="lbl">Temp</span> <b>${cond.minTemp}–${cond.maxTemp}°F</b> · ${esc(SKY_LABEL[cond.sky])}</div>
          </div>
          <div class="rating">${rating.text}${rating.reasons.length ? `<span class="small">: ${rating.reasons.join(', ')}</span>` : ''}</div>
        </div>` : `<div class="banner warn">There's no forecast for this time window yet. NWS hourly forecasts only cover about 6 days.</div>`}
      <div class="hours" role="list">
        ${dayHours.map((h) => `<div class="hr ${h.t + 3600000 > start && h.t < end ? 'in' : ''} ${h.thunder >= 20 ? 'storm' : ''}" role="listitem">
          <div class="h-t">${fmtHour(h.t)}</div>
          <div class="h-w"><b>${h.windMph}</b>${arrow(h.windDir)}</div>
          <div class="h-g">${h.gustMph != null ? 'g' + h.gustMph : ''}</div>
          <div class="h-temp">${h.tempF}°</div>
          <div class="h-p">${h.pop ? h.pop + '%' : ''}${h.thunder >= 10 ? ' ⚡' : ''}</div>
        </div>`).join('')}
      </div>
      <p class="small muted">NWS forecast (${esc(wx.office)}), point near ${esc(wx.near)}. Fetched ${ago(wx.fetchedAt)}. Wind in mph; "g" means gust. <button class="link" data-act="refreshwx">Refresh</button></p>`;
  } else if (wxError[lake.id]) {
    wxHtml = `<div class="banner bad">Couldn't load the forecast: ${esc(wxError[lake.id])}. <button class="link" data-act="refreshwx">Try again</button></div>`;
  } else {
    wxHtml = '<p class="muted">Loading NWS forecast…</p>';
  }

  // Suggestions
  const month = new Date(start).getMonth() + 1;
  const autoFront = wx ? detectPostFront(wx.hours, day) : null;
  const postFront = plan.postFront === 'yes' ? true : plan.postFront === 'no' ? false : !!autoFront;
  const sug = suggest({ species: plan.species, lakeId: lake.id, month, waterTemp: plan.waterTemp, clarity: plan.clarity, cond, postFront }, enrichedCatches());
  const sugHtml = sug ? `
    <div class="phase"><b>${esc(speciesName(plan.species))}: ${esc(sug.phase.label)}</b> <span class="small muted">based on ${esc(sug.basis)}</span></div>
    <p><b>Where:</b> ${esc(sug.phase.where)}<br><b>Depth:</b> ${esc(sug.phase.depth)}</p>
    <ol class="baits">
      ${sug.items.slice(0, 5).map((it) => `<li>
        <div class="bait-h"><b>${esc(it.label)}</b>${it.personal ? `<span class="tag mine">You: ${it.personal.fish} fish / ${it.personal.trips} trip${it.personal.trips === 1 ? '' : 's'}</span>` : ''}${it.source === 'yours' ? '<span class="tag mine">from your log</span>' : ''}</div>
        <div class="small">${esc(it.note)}${it.colors ? ` · <i>${esc(it.colors)}</i>` : ''}${it.personal && it.personal.topColor ? ` · your best color: <i>${esc(it.personal.topColor)}</i>` : ''}</div>
        ${it.reasons.length ? `<div class="small muted">Why: ${esc(it.reasons.join('; '))}</div>` : ''}
      </li>`).join('')}
    </ol>
    ${sug.colorAdvice ? `<p class="small">${esc(sug.colorAdvice)}</p>` : ''}
    ${sug.notes.map((n) => `<p class="small note">${esc(n)}</p>`).join('')}
    <p class="small muted">${sug.personal.similarFish
      ? `Your log has ${sug.personal.similarFish} ${esc(speciesName(plan.species))} from ${sug.personal.similarTrips} trip${sug.personal.similarTrips === 1 ? '' : 's'} in similar conditions.${sug.personal.similarTrips < 3 ? ' That\'s a small sample, so treat it as a hint.' : ''}`
      : `General guidance from the playbook. No similar ${esc(speciesName(plan.species))} catches in your log yet. As you log fish, your own results get blended in.`}</p>
  ` : '';

  const linkSeen = (await db.kvGet('linksOpened', {})) || {};

  return `
    <section class="card">
      <div class="chips" role="group" aria-label="Lake">
        ${lakes().map((l) => `<button class="chip ${l.id === lake.id ? 'on' : ''}" data-act="lake" data-v="${l.id}">${esc(l.name)}</button>`).join('')}
      </div>
      <div class="chips scroll" role="group" aria-label="Day">${dayChips}</div>
      <div class="row">
        <label>From <select data-bind="startHour">${hourOpts(plan.startHour)}</select></label>
        <label>to <select data-bind="endHour">${hourOpts(plan.endHour)}</select></label>
      </div>
      <p class="small muted">Sunrise ${fmtTime(sun.sunrise)} · Sunset ${fmtTime(sun.sunset)}</p>
    </section>

    <section class="card"><h2>Weather on the water</h2>${wxHtml}</section>

    <section class="card">
      <h2>What to throw</h2>
      <div class="chips" role="group" aria-label="Species">
        ${SPECIES.map((s) => `<button class="chip ${s.id === plan.species ? 'on' : ''}" data-act="species" data-v="${s.id}">${esc(s.name)}</button>`).join('')}
      </div>
      <div class="row">
        <label>Water temp °F <input type="number" inputmode="numeric" data-bind="waterTemp" value="${plan.waterTemp ?? ''}" placeholder="optional" style="width:6em"></label>
        <label>Clarity <select data-bind="clarity">
          <option value="" ${!plan.clarity ? 'selected' : ''}>?</option>
          ${['clear', 'stained', 'muddy'].map((c) => `<option ${plan.clarity === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select></label>
        <label>Cold front <select data-bind="postFront">
          <option value="auto" ${plan.postFront === 'auto' ? 'selected' : ''}>auto${autoFront == null ? '' : autoFront ? ' (yes)' : ' (no)'}</option>
          <option value="yes" ${plan.postFront === 'yes' ? 'selected' : ''}>just passed</option>
          <option value="no" ${plan.postFront === 'no' ? 'selected' : ''}>no</option>
        </select></label>
      </div>
      ${sugHtml}
    </section>

    <section class="card">
      <h2>${esc(lake.name)}</h2>
      <p class="small">${esc(lake.note)}</p>
      <ul class="links">
        ${[...lake.links, ...GENERAL_LINKS.filter((g) => !lake.links.find((l) => l.url === g.url))].map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener" data-link="${esc(l.url)}">${esc(l.label)}</a>
          <span class="small muted">${linkSeen[l.url] ? `you opened ${ago(linkSeen[l.url])}` : 'not opened yet'}</span></li>`).join('')}
      </ul>
      <p class="small muted">Links verified ${LINKS_VERIFIED}. Always check current MDC regulations and lake rules. This app doesn't show regulations.</p>
    </section>

    ${activeTrip() ? `<a class="btn big" href="#log">Trip in progress: log a fish →</a>`
      : `<button class="btn big" data-act="starttrip">Start a trip at ${esc(lake.name)}</button>`}
  `;
}

// ---------- LOG ----------
async function renderLog() {
  const t = activeTrip();
  const past = data.trips.filter((x) => x.end);
  const fishCount = (id) => data.catches.filter((c) => c.tripId === id).length;
  let top = '';
  if (t) {
    const lake = lakeById(t.lakeId);
    const cs = data.catches.filter((c) => c.tripId === t.id);
    top = `<section class="card active-trip">
      <h2>On the water: ${esc(lake.name)}</h2>
      <p>Started ${fmtTime(t.start)} (${round1((Date.now() - Date.parse(t.start)) / 3600000)} hr) · <b>${cs.length}</b> fish</p>
      <button class="btn big" data-act="addfish" data-trip="${t.id}">+ Log a fish</button>
      ${catchList(cs)}
      <div class="row">
        <a class="btn ghost" href="#trip/${t.id}">Trip details</a>
        <button class="btn ghost" data-act="endtrip" data-trip="${t.id}">End trip</button>
      </div>
    </section>`;
  } else {
    top = `<section class="card">
      <h2>Start a trip</h2>
      <div class="chips">${lakes().map((l) => `<button class="chip" data-act="starttrip" data-lake="${l.id}">${esc(l.name)}</button>`).join('')}</div>
      <p class="small muted">Tap the lake you're at. The start time and current weather are saved automatically.</p>
      <button class="btn ghost" data-act="pasttrip">+ Add a past trip</button>
    </section>`;
  }
  return `${top}
    <section class="card">
      <h2>Trips</h2>
      ${past.length ? `<ul class="list">${past.map((p) => `<li><a href="#trip/${p.id}">
        <b>${fmtDate(p.start)}</b> · ${esc(lakeById(p.lakeId).name)}
        <span class="small muted">${round1(tripHours(p))} hr · ${fishCount(p.id)} fish</span></a></li>`).join('')}</ul>`
      : '<p class="muted">No finished trips yet.</p>'}
    </section>`;
}

function catchList(cs) {
  if (!cs.length) return '';
  return `<ul class="list catches">${cs.map((c) => `<li>
    <button class="rowbtn" data-act="editfish" data-id="${c.id}">
      <b>${esc(speciesName(c.species))}</b>${c.lengthIn ? ` ${c.lengthIn}"` : ''}${c.weightLb ? ` ${c.weightLb} lb` : ''}
      <span class="small">${esc(lureLabel(c.lureType))}${c.lureName ? ` (${esc(c.lureName)})` : ''}${c.color ? `, ${esc(c.color)}` : ''}${c.depthFt != null ? ` · ${c.depthFt} ft` : ''}</span>
      <span class="small muted">${fmtTime(c.time)}${c.weather ? ` · ${c.weather.windMph ?? '?'} mph ${esc(c.weather.windDir || '')}` : ''}${c.spotId && spotById(c.spotId) ? ` · 📍 ${esc(spotById(c.spotId).name)}` : c.lat ? ' · 📍' : ''}${c.photoId ? ' · 📷' : ''}</span>
    </button></li>`).join('')}</ul>`;
}

async function startTrip(lakeId) {
  if (activeTrip()) { location.hash = '#log'; return; }
  const lake = lakeById(lakeId);
  const t = { id: uid(), lakeId: lake.id, start: new Date().toISOString(), end: null, clarity: plan.lakeId === lake.id ? plan.clarity : '', waterTemp: plan.lakeId === lake.id ? plan.waterTemp : null, notes: '', weather: null, createdAt: Date.now() };
  await db.put('trips', t);
  await loadData();
  location.hash = '#log';
  render();
  weatherSnapshot(lake).then(async (w) => { if (w) { t.weather = w; await db.put('trips', t); await loadData(); } });
}

async function endTrip(id) {
  const t = tripById(id);
  if (!t) return;
  t.end = new Date().toISOString();
  await db.put('trips', t);
  await loadData();
  toast('Trip saved');
  location.hash = `#trip/${id}`;
}

async function renderTrip(id) {
  const t = tripById(id);
  if (!t) return '<p>Trip not found.</p>';
  const cs = data.catches.filter((c) => c.tripId === id);
  const w = t.weather || {};
  return `<section class="card">
    <a href="#log" class="small">← Trips</a>
    <h2>${esc(lakeById(t.lakeId).name)}: ${fmtDate(t.start)}</h2>
    <form id="tripform" class="form">
      <label>Lake <select name="lakeId">${lakes().map((l) => `<option value="${l.id}" ${l.id === t.lakeId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>Start <input type="datetime-local" name="start" value="${toLocalInput(t.start)}"></label>
      <label>End <input type="datetime-local" name="end" value="${t.end ? toLocalInput(t.end) : ''}"></label>
      <div class="row">
        <label>Water °F <input type="number" inputmode="numeric" name="waterTemp" value="${t.waterTemp ?? ''}"></label>
        <label>Clarity <select name="clarity"><option value="">?</option>${['clear', 'stained', 'muddy'].map((c) => `<option ${t.clarity === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <fieldset><legend>Weather <span class="small muted">${w.source ? `(${w.source === 'observed' ? 'observed at ' + esc(w.station) : 'NWS forecast'}, editable)` : '(enter if known)'}</span></legend>
        <div class="row">
          <label>Wind mph <input type="number" inputmode="numeric" name="windMph" value="${w.windMph ?? ''}"></label>
          <label>From <select name="windDir"><option value="">?</option>${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'NNE', 'ENE', 'ESE', 'SSE', 'SSW', 'WSW', 'WNW', 'NNW'].map((d) => `<option ${w.windDir === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label>Air °F <input type="number" inputmode="numeric" name="tempF" value="${w.tempF ?? ''}"></label>
          <label>Sky <select name="sky">${Object.entries(SKY_LABEL).map(([k, v]) => `<option value="${k}" ${w.sky === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
      </fieldset>
      <label>Notes <textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
      <div class="row"><button class="btn" type="submit">Save trip</button></div>
    </form>
  </section>
  <section class="card">
    <h2>Fish (${cs.length})</h2>
    <button class="btn" data-act="addfish" data-trip="${t.id}">+ Add a fish</button>
    ${catchList(cs)}
  </section>
  <section class="card"><button class="btn danger" data-act="deltrip" data-trip="${t.id}">Delete this trip and its fish</button></section>`;
}

// ---------- catch form ----------
async function openCatchForm({ tripId, catchId }) {
  const existing = catchId ? data.catches.find((c) => c.id === catchId) : null;
  const trip = tripById(existing ? existing.tripId : tripId);
  const last = data.catches[0] || {};
  const c = existing || { species: last.species || plan.species, lureType: last.lureType || '', lureName: last.lureName || '', color: last.color || '', depthFt: last.depthFt ?? null, released: true, time: trip.end ? trip.start : new Date().toISOString() };
  // recent lure types first
  const recent = [...new Set(data.catches.map((x) => x.lureType).filter(Boolean))].slice(0, 6);
  const lureOpts = [...recent.map((k) => [k, true]), ...Object.keys(LURES).filter((k) => !recent.includes(k)).map((k) => [k, false])];
  const names = [...new Set(data.catches.map((x) => x.lureName).filter(Boolean))];
  const colors = [...new Set(data.catches.map((x) => x.color).filter(Boolean))];
  const photoUrl = existing && existing.photoId ? await photoURL(existing.photoId) : null;

  const dlg = $('#sheet');
  dlg.innerHTML = `<form method="dialog" id="catchform" class="form" data-trip="${trip.id}">
    <h2>${existing ? 'Edit fish' : 'Log a fish'}</h2>
    <div class="chips" role="group" aria-label="Species">${ALL_SPECIES.map((s) => `<label class="chip radio"><input type="radio" name="species" value="${s.id}" ${s.id === c.species ? 'checked' : ''}><span>${esc(s.name)}</span></label>`).join('')}</div>
    <label>Lure / bait <select name="lureType" required>
      <option value="">Choose…</option>
      ${recent.length ? '<optgroup label="Recent">' + lureOpts.filter((x) => x[1]).map(([k]) => `<option value="${k}" ${k === c.lureType ? 'selected' : ''}>${esc(lureLabel(k))}</option>`).join('') + '</optgroup>' : ''}
      <optgroup label="All">${lureOpts.filter((x) => !x[1]).map(([k]) => `<option value="${k}" ${k === c.lureType ? 'selected' : ''}>${esc(lureLabel(k))}</option>`).join('')}</optgroup>
    </select></label>
    <div class="row">
      <label>Name/model <input name="lureName" list="dl-names" value="${esc(c.lureName)}" placeholder="optional"></label>
      <label>Color <input name="color" list="dl-colors" value="${esc(c.color)}" placeholder="optional"></label>
    </div>
    <datalist id="dl-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <datalist id="dl-colors">${colors.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="row">
      <label>Length in <input type="number" step="0.25" inputmode="decimal" name="lengthIn" value="${c.lengthIn ?? ''}"></label>
      <label>Weight lb <input type="number" step="0.01" inputmode="decimal" name="weightLb" value="${c.weightLb ?? ''}"></label>
      <label>Depth ft <input type="number" step="0.5" inputmode="decimal" name="depthFt" value="${c.depthFt ?? ''}"></label>
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" name="released" ${c.released ? 'checked' : ''}> Released</label>
      <label>Time <input type="datetime-local" name="time" value="${toLocalInput(c.time)}"></label>
    </div>
    <div class="row">
      <button type="button" class="btn ghost" data-act="gps">${c.lat ? '📍 Location saved (update)' : '📍 Save my location'}</button>
      <span class="small muted" id="gpsinfo">${c.lat ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` : 'Private, saved on this phone only'}</span>
    </div>
    <input type="hidden" name="lat" value="${c.lat ?? ''}"><input type="hidden" name="lon" value="${c.lon ?? ''}">
    <label>Spot <select name="spotId">${catchSpotOptions(trip.lakeId, c.lat != null ? c : here, c.spotId)}</select></label>
    <label>Photo <input type="file" name="photo" accept="image/*" capture="environment"></label>
    ${photoUrl ? `<img src="${photoUrl}" class="thumb" alt="Catch photo">` : ''}
    <label>Notes <input name="notes" value="${esc(c.notes || '')}" placeholder="spot, structure, etc."></label>
    <div class="row sticky">
      <button type="button" class="btn ghost" data-act="closesheet">Cancel</button>
      ${existing ? `<button type="button" class="btn danger" data-act="delfish" data-id="${existing.id}">Delete</button>` : ''}
      <button type="submit" class="btn">Save</button>
    </div>
  </form>`;
  if (!dlg.open) dlg.showModal();
  if (!existing && settings.autoGps) getGps();

  $('#catchform').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    if (!f.get('lureType')) { toast('Pick a lure/bait type'); return; }
    const rec = existing ? { ...existing } : { id: uid(), tripId: trip.id, createdAt: Date.now() };
    rec.lakeId = trip.lakeId;
    rec.species = f.get('species');
    rec.lureType = f.get('lureType');
    rec.lureName = f.get('lureName').trim();
    rec.color = f.get('color').trim();
    rec.lengthIn = num(f.get('lengthIn'));
    rec.weightLb = num(f.get('weightLb'));
    rec.depthFt = num(f.get('depthFt'));
    rec.released = !!f.get('released');
    rec.time = fromLocalInput(f.get('time')) || new Date().toISOString();
    rec.lat = num(f.get('lat')); rec.lon = num(f.get('lon'));
    rec.spotId = f.get('spotId') || null;
    rec.notes = f.get('notes').trim();
    rec.month = new Date(rec.time).getMonth() + 1;
    const ph = pickPhase(rec.species, rec.month, trip.waterTemp);
    rec.phase = ph ? ph.phase.id : null;
    const file = f.get('photo');
    if (file && file.size) {
      try {
        const blob = await compressImage(file);
        const pid = rec.photoId || uid();
        await db.put('photos', { id: pid, blob, type: blob.type });
        rec.photoId = pid;
      } catch { toast('Photo could not be saved'); }
    }
    await db.put('catches', rec);
    dlg.close();
    await loadData();
    render();
    toast(existing ? 'Updated' : `${speciesName(rec.species)} logged`);
    if (!rec.weather && !trip.end) {
      weatherSnapshot(lakeById(trip.lakeId), Date.parse(rec.time)).then(async (w) => { if (w) { rec.weather = w; await db.put('catches', rec); await loadData(); } });
    }
  });
}

function getGps() {
  const info = $('#gpsinfo');
  if (!navigator.geolocation) { info.textContent = 'GPS not available'; return; }
  info.textContent = 'Getting location…';
  navigator.geolocation.getCurrentPosition((p) => {
    const f = $('#catchform');
    if (!f) return;
    f.lat.value = p.coords.latitude; f.lon.value = p.coords.longitude;
    const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
    info.textContent = `${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)} (±${Math.round(p.coords.accuracy)} m)`;
    // re-sort the spot list by distance and pick the nearest saved spot if it's close
    const sel = f.spotId, chosen = sel.value;
    const trip = tripById(f.dataset.trip);
    sel.innerHTML = catchSpotOptions(trip ? trip.lakeId : null, pos, chosen);
    if (!chosen) {
      const near = data.spots.map((s) => [s, distM(pos, s)]).filter(([, d]) => d <= SPOT_RADIUS_M).sort((a, b) => a[1] - b[1])[0];
      if (near) { sel.value = near[0].id; info.textContent += ` · at ${near[0].name}`; }
    }
  }, (e) => { info.textContent = `No location: ${e.message}`; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

/** <option>s for the catch form's Spot picker: this lake's spots, nearest first when we know where we are. */
function catchSpotOptions(lakeId, pos, selected) {
  let list = data.spots.filter((s) => s.lakeId === lakeId || s.id === selected);
  if (pos && pos.lat != null) list = list.map((s) => ({ s, d: distM(pos, s) })).sort((a, b) => a.d - b.d).map((x) => ({ ...x.s, _d: x.d }));
  return `<option value="">None</option>${list.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${spotType(s.type).icon} ${esc(s.name)}${s._d != null ? ` (${fmtDist(s._d)})` : ''}</option>`).join('')}`;
}

async function compressImage(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.78));
}
const photoUrls = {};
async function photoURL(id) {
  if (photoUrls[id]) return photoUrls[id];
  const p = await db.get('photos', id);
  if (!p) return null;
  return (photoUrls[id] = URL.createObjectURL(p.blob));
}

// ---------- STATS ----------
let statsSpecies = '';
async function renderStats() {
  const s = computeStats(data.trips, enrichedCatches(), lakes(), statsSpecies, spotForCatch);
  const table = (rows, rate = true) => rows.length ? `<table><thead><tr><th></th><th>Fish</th><th>Trips</th>${rate ? '<th>Hours</th><th>Fish/hr</th>' : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr class="${smallSample(r) ? 'thin' : ''}"><td>${esc(r.label)}${smallSample(r) ? ' <span class="tag">small sample</span>' : ''}</td><td>${r.fish}</td><td>${r.trips}</td>${rate ? `<td>${round1(r.hours)}</td><td><b>${r.perHour == null ? '–' : round1(r.perHour)}</b></td>` : ''}</tr>`).join('')}
  </tbody></table>` : '<p class="muted small">Nothing yet.</p>';
  return `
    <section class="card">
      <h2>What worked for me</h2>
      <div class="chips"><button class="chip ${!statsSpecies ? 'on' : ''}" data-act="statsp" data-v="">All</button>${SPECIES.map((x) => `<button class="chip ${statsSpecies === x.id ? 'on' : ''}" data-act="statsp" data-v="${x.id}">${esc(x.name)}</button>`).join('')}</div>
      <p><b>${s.fish}</b> fish · <b>${s.trips}</b> finished trips · <b>${round1(s.hours)}</b> hours on the water${s.hours >= 0.5 ? ` · <b>${round1(s.fish / s.hours)}</b> fish/hr` : ''}</p>
      ${s.trips < 5 ? '<p class="small note">Early days: a few trips can\'t separate a good lure from a lucky day. These numbers get meaningful after about 10 or more trips per lake or season.</p>' : ''}
    </section>
    <section class="card"><h3>By lake</h3>${table(s.byLake)}</section>
    <section class="card"><h3>By lure (fish caught)</h3>${table(s.byLure.slice(0, 12), false)}</section>
    <section class="card"><h3>By lure + color</h3>${table(s.byLureColor.slice(0, 12), false)}</section>
    ${data.spots.length ? `<section class="card"><h3>By spot (fish caught)</h3>${table(s.bySpot.slice(0, 12), false)}<p class="small muted">A fish counts toward a spot if you picked the spot when logging it, or its GPS is within about ${Math.round(SPOT_RADIUS_M * 1.09)} yards.</p></section>` : ''}
    ${!statsSpecies ? `<section class="card"><h3>By species</h3>${table(s.bySpecies, false)}</section>` : ''}
    <section class="card"><h3>By month</h3>${table(s.byMonth)}</section>
    <section class="card"><h3>By wind at trip start</h3>${table(s.byWind)}</section>
    <section class="card"><h3>By sky at trip start</h3>${table(s.bySky)}</section>
    ${s.biggest.length ? `<section class="card"><h3>Biggest</h3><ul class="list">${s.biggest.map((c) => `<li>${c.lengthIn}" ${esc(speciesName(c.species))} · ${esc(lureLabel(c.lureType))} · ${fmtDate(c.time)} · ${esc(lakeById(c.lakeId).name)}</li>`).join('')}</ul></section>` : ''}
    <p class="small muted pad">Fish/hr counts all logged fish divided by the hours of finished trips. Only finished trips are counted.</p>`;
}

// ---------- MORE ----------
async function renderMore() {
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1048576).toFixed(1)} MB used`; } catch { /* */ }
  const lastBackup = await db.kvGet('lastBackup');
  return `
    <section class="card">
      <h2>Backup</h2>
      <p class="small">Your log lives <b>only on this phone</b>. Back it up regularly by saving the file to Google Drive, emailing it to yourself, or copying it to the PC.</p>
      <p class="small ${!lastBackup || Date.now() - lastBackup > 14 * 86400000 ? 'note' : 'muted'}">Last backup: ${lastBackup ? ago(lastBackup) : 'never'}</p>
      <div class="row">
        <button class="btn" data-act="backup">Save full backup (.json)</button>
        <label class="check"><input type="checkbox" id="bk-photos" checked> include photos</label>
      </div>
      <div class="row">
        <button class="btn ghost" data-act="csv-catches">Catches CSV</button>
        <button class="btn ghost" data-act="csv-trips">Trips CSV</button>
        <label class="btn ghost">Restore backup… <input type="file" id="restore" accept="application/json,.json" hidden></label>
      </div>
      <p class="small muted">Storage: ${persisted ? 'protected from automatic cleanup' : 'not yet protected. Install the app to your home screen.'}${est ? ` · ${est}` : ''}</p>
    </section>

    <section class="card">
      <h2>Spots &amp; map data</h2>
      <p class="small">You have <b>${data.spots.length}</b> saved spot${data.spots.length === 1 ? '' : 's'}. GPX is the standard waypoint file that most GPS units, fish finders and mapping apps can read.</p>
      <div class="row">
        <button class="btn ghost" data-act="gpx-spots" ${data.spots.length ? '' : 'disabled'}>Export my spots (.gpx)</button>
        <button class="btn ghost" data-act="gpx-catches">Export catches with GPS (.gpx)</button>
        <label class="btn ghost">Import GPX as my spots… <input type="file" id="import-spots" accept=".gpx,.zip,application/gpx+xml,application/zip" hidden></label>
      </div>
      <h3>MDC fish attractors</h3>
      <p class="small">Built in: MDC's attractor files for all six lakes, downloaded ${ATTRACTOR_SOURCE.downloaded}. MDC adds new brush piles every year. To refresh, download a lake's file from the <a href="${ATTRACTOR_SOURCE.url}" target="_blank" rel="noopener">MDC attractor page</a> and load it here. A .zip file is fine.</p>
      <ul class="small">${lakes().map((l) => `<li>${esc(l.name)}: ${attractorsFor(l.id).length}${attractorOverrides[l.id] ? ` (your import, ${ymd(attractorOverrides[l.id].importedAt)})` : ''}</li>`).join('')}</ul>
      <div class="row">
        <label class="btn ghost">Update MDC attractors… <input type="file" id="import-attractors" accept=".gpx,.zip,application/gpx+xml,application/zip" hidden></label>
        ${Object.keys(attractorOverrides).length ? '<button class="btn ghost" data-act="resetattractors">Go back to built-in data</button>' : ''}
      </div>
    </section>

    <section class="card">
      <h2>Boat wind limits</h2>
      <p class="small">Your own thresholds for the 16 ft boat. They set the green/yellow/red rating on the Plan screen.</p>
      <div class="row">
        <label>Caution at <input type="number" inputmode="numeric" data-set="windCaution" value="${settings.windCaution}"> mph</label>
        <label>Rough at <input type="number" inputmode="numeric" data-set="windNoGo" value="${settings.windNoGo}"> mph</label>
        <label>Gusts rough at <input type="number" inputmode="numeric" data-set="gustNoGo" value="${settings.gustNoGo}"> mph</label>
      </div>
      <label class="check"><input type="checkbox" data-set="autoGps" ${settings.autoGps ? 'checked' : ''}> Save location automatically on each new fish</label>
    </section>

    <section class="card">
      <h2>Lake forecast points</h2>
      <p class="small">The coordinates used for each lake's forecast. Lake of the Ozarks is long, so set it to the arm you fish. Tip: long-press a spot in Google Maps to copy its coordinates.</p>
      ${lakes().map((l) => `<div class="row lakepos">
        <b>${esc(l.name)}</b>
        <input type="number" step="0.0001" data-lake="${l.id}" data-k="lat" value="${l.lat}" aria-label="${esc(l.name)} latitude">
        <input type="number" step="0.0001" data-lake="${l.id}" data-k="lon" value="${l.lon}" aria-label="${esc(l.name)} longitude">
        ${settings.lakeOverrides[l.id] ? `<button class="link" data-act="resetlake" data-v="${l.id}">reset</button>` : ''}
      </div>`).join('')}
    </section>

    <section class="card">
      <h2>The playbook</h2>
      <p class="small">Bait suggestions start from this written-out list of general seasonal patterns for Missouri reservoirs. It's general guidance, not a prediction. Your own catches gradually take over as you log more.</p>
      ${Object.entries(PLAYBOOK).map(([sp, phases]) => `<details><summary>${esc(speciesName(sp))}</summary>
        ${phases.map((p) => `<div class="pb"><b>${esc(p.label)}</b> <span class="small muted">months ${p.months.join(', ')} · water ${p.temp[0]}–${p.temp[1]}°F</span>
        <div class="small">${esc(p.where)} (${esc(p.depth)})</div>
        <ul class="small">${p.baits.map(([t, n, col]) => `<li>${esc(lureLabel(t))}: ${esc(n)}${col ? ` · <i>${esc(col)}</i>` : ''}</li>`).join('')}</ul></div>`).join('')}
      </details>`).join('')}
    </section>

    <section class="card small">
      <h2>About</h2>
      <p>Weather comes from the National Weather Service (api.weather.gov), with no account or tracking. Fishing info links go to official Missouri Department of Conservation pages. The app does <b>not</b> know where fish are, and it does not show regulations.</p>
      <p>Privacy: trips, catches, saved spots, and photos are stored on this device only. Nothing is uploaded. The app contacts the NWS for weather and, when the map is open, the map tile servers (Esri for satellite and OpenStreetMap for streets). Those servers see which map area is being viewed, like any map website, but never your spots or catches. Fish attractor locations are from MDC.</p>
      <p class="muted">Version <span id="ver"></span></p>
    </section>`;
}

// ---------- export / import ----------
function download(name, text, type) {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
const blobToDataURL = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

async function exportBackup(withPhotos) {
  const photos = [];
  if (withPhotos) for (const p of await db.all('photos')) photos.push({ id: p.id, dataUrl: await blobToDataURL(p.blob) });
  const out = { app: 'fishing-intel', version: 2, exportedAt: new Date().toISOString(), settings, trips: data.trips, catches: data.catches, spots: data.spots, attractorOverrides, photos };
  download(`fishing-backup-${ymd(Date.now())}.json`, JSON.stringify(out), 'application/json');
  await db.kvSet('lastBackup', Date.now());
}

async function importBackup(file) {
  const j = JSON.parse(await file.text());
  if (j.app !== 'fishing-intel') throw new Error('Not a fishing app backup');
  const existing = new Set(data.trips.map((t) => t.id));
  let newTrips = 0;
  for (const t of j.trips || []) { if (!existing.has(t.id)) newTrips++; await db.put('trips', t); }
  for (const c of j.catches || []) await db.put('catches', c);
  for (const s of j.spots || []) await db.put('spots', s);
  if (j.attractorOverrides && typeof j.attractorOverrides === 'object') {
    attractorOverrides = { ...attractorOverrides, ...j.attractorOverrides };
    await db.kvSet('attractorOverrides', attractorOverrides);
  }
  for (const p of j.photos || []) { const blob = await (await fetch(p.dataUrl)).blob(); await db.put('photos', { id: p.id, blob, type: blob.type }); }
  await loadData();
  return { trips: (j.trips || []).length, catches: (j.catches || []).length, spots: (j.spots || []).length, newTrips };
}

function exportSpotsGPX() {
  const pts = data.spots.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name, time: new Date(s.createdAt).toISOString(),
    desc: [spotType(s.type).name, s.depthFt != null ? `${s.depthFt} ft` : '', s.lakeId ? lakeById(s.lakeId).name : '', s.notes].filter(Boolean).join(' · ') }));
  download(`fishing-spots-${ymd(Date.now())}.gpx`, toGPX(pts), 'application/gpx+xml');
}
function exportCatchesGPX() {
  const pts = enrichedCatches().map((c) => {
    const p = catchPos(c);
    if (!p) return null;
    return { ...p, time: c.time, name: `${speciesName(c.species)}${c.lengthIn ? ` ${c.lengthIn}in` : ''}`,
      desc: [lureLabel(c.lureType), c.lureName, c.color, c.depthFt != null ? `${c.depthFt} ft` : '', fmtDate(c.time)].filter(Boolean).join(' · ') };
  }).filter(Boolean);
  if (!pts.length) { toast('No catches with a location yet'); return; }
  download(`fishing-catches-${ymd(Date.now())}.gpx`, toGPX(pts), 'application/gpx+xml');
}

async function importSpotsFile(file) {
  const wpts = await readWaypointsFile(file);
  if (!wpts.length) throw new Error('No waypoints found in that file');
  if (wpts.length > 300 && !confirm(`That file has ${wpts.length} points. Import them all as your own spots? (For MDC attractor files, use "Update MDC attractors" instead.)`)) return null;
  let added = 0, skipped = 0;
  for (const w of wpts) {
    const name = (w.name || '').slice(0, 60) || 'Imported spot';
    if (data.spots.some((s) => s.name === name && distM(s, w) < 5)) { skipped++; continue; }
    const rec = { id: uid(), name, type: 'other', lat: w.lat, lon: w.lon, lakeId: lakeForPoint(lakes(), w), depthFt: null, notes: w.desc || '', createdAt: Date.now(), updatedAt: Date.now(), imported: file.name };
    await db.put('spots', rec); data.spots.push(rec); added++;
  }
  await loadData();
  return { added, skipped };
}

async function importAttractorsFile(file) {
  const wpts = await readWaypointsFile(file);
  const byLake = {};
  let outside = 0;
  for (const w of wpts) {
    const lk = lakeForPoint(lakes(), w);
    if (!lk) { outside++; continue; }
    (byLake[lk] ||= []).push([Math.round(w.lat * 1e6) / 1e6, Math.round(w.lon * 1e6) / 1e6, w.desc && w.desc !== 'NA' ? w.desc : '']);
  }
  const ids = Object.keys(byLake);
  if (!ids.length) throw new Error(`None of the ${wpts.length} points are on one of your lakes`);
  for (const id of ids) attractorOverrides[id] = { points: byLake[id], importedAt: Date.now(), file: file.name };
  await db.kvSet('attractorOverrides', attractorOverrides);
  return { lakes: ids.map((id) => `${lakeById(id).name} (${byLake[id].length})`), outside };
}

function exportCatchesCSV() {
  const head = ['date', 'time', 'lake', 'species', 'length_in', 'weight_lb', 'lure_type', 'lure_name', 'color', 'depth_ft', 'released', 'phase', 'wind_mph', 'wind_from', 'gust_mph', 'air_f', 'sky', 'weather_source', 'clarity', 'water_f', 'lat', 'lon', 'spot', 'notes', 'trip_id', 'catch_id'];
  const rows = enrichedCatches().map((c) => {
    const t = tripById(c.tripId) || {};
    const w = c.weather || {};
    return [ymd(c.time), fmtTime(c.time), lakeById(c.lakeId).name, speciesName(c.species), c.lengthIn, c.weightLb, lureLabel(c.lureType), c.lureName, c.color, c.depthFt, c.released ? 'yes' : 'no', c.phase, w.windMph, w.windDir, w.gustMph, w.tempF, w.sky, w.source, c.clarity, t.waterTemp, c.lat, c.lon, (spotForCatch(c) || {}).name, c.notes, c.tripId, c.id];
  });
  download(`catches-${ymd(Date.now())}.csv`, toCSV([head, ...rows]), 'text/csv');
}
function exportTripsCSV() {
  const head = ['date', 'lake', 'start', 'end', 'hours', 'fish', 'wind_mph', 'wind_from', 'air_f', 'sky', 'clarity', 'water_f', 'notes', 'trip_id'];
  const rows = data.trips.map((t) => { const w = t.weather || {}; return [ymd(t.start), lakeById(t.lakeId).name, fmtTime(t.start), t.end ? fmtTime(t.end) : '', round1(tripHours(t)), data.catches.filter((c) => c.tripId === t.id).length, w.windMph, w.windDir, w.tempF, w.sky, t.clarity, t.waterTemp, t.notes, t.id]; });
  download(`trips-${ymd(Date.now())}.csv`, toCSV([head, ...rows]), 'text/csv');
}

// ---------- events ----------
const actions = {
  lake: (el) => { plan.lakeId = el.dataset.v; savePlan(); render(); },
  day: (el) => { plan.dayOffset = +el.dataset.v; savePlan(); render(); },
  species: (el) => { plan.species = el.dataset.v; savePlan(); render(); },
  refreshwx: () => { const l = lakeById(plan.lakeId); wxError[l.id] = null; loadWeather(l, true); toast('Refreshing forecast…'); },
  starttrip: (el) => startTrip(el.dataset.lake || plan.lakeId),
  endtrip: (el) => { if (confirm('End this trip now?')) endTrip(el.dataset.trip); },
  addfish: (el) => openCatchForm({ tripId: el.dataset.trip }),
  editfish: (el) => openCatchForm({ catchId: el.dataset.id }),
  closesheet: () => $('#sheet').close(),
  gps: () => getGps(),
  delfish: async (el) => {
    if (!confirm('Delete this fish?')) return;
    const c = data.catches.find((x) => x.id === el.dataset.id);
    if (c && c.photoId) await db.del('photos', c.photoId);
    await db.del('catches', el.dataset.id);
    $('#sheet').close(); await loadData(); render(); toast('Deleted');
  },
  deltrip: async (el) => {
    const id = el.dataset.trip;
    const cs = data.catches.filter((c) => c.tripId === id);
    if (!confirm(`Delete this trip and its ${cs.length} fish? This can't be undone (unless you have a backup).`)) return;
    for (const c of cs) { if (c.photoId) await db.del('photos', c.photoId); await db.del('catches', c.id); }
    await db.del('trips', id);
    await loadData(); location.hash = '#log'; toast('Trip deleted');
  },
  pasttrip: async () => {
    const start = new Date(); start.setHours(6, 0, 0, 0); start.setDate(start.getDate() - 1);
    const end = new Date(start); end.setHours(11);
    const t = { id: uid(), lakeId: plan.lakeId, start: start.toISOString(), end: end.toISOString(), clarity: '', waterTemp: null, notes: '', weather: null, createdAt: Date.now() };
    await db.put('trips', t); await loadData();
    location.hash = `#trip/${t.id}`;
    toast('Set the date and times, then add the fish');
  },
  statsp: (el) => { statsSpecies = el.dataset.v; render(); },
  backup: () => exportBackup($('#bk-photos') ? $('#bk-photos').checked : true).then(() => { toast('Backup saved to Downloads'); render(); }),
  'csv-catches': () => exportCatchesCSV(),
  'csv-trips': () => exportTripsCSV(),
  resetlake: (el) => { delete settings.lakeOverrides[el.dataset.v]; saveSettings(); wxCache = {}; render(); },
  // map & spots
  maplake: (el) => {
    mapState.lakeId = el.dataset.v; mapState.follow = false; saveMapPrefs();
    if (mapState.ctl) { mapState.ctl.fitBounds(lakeById(mapState.lakeId).bounds); mapRefreshLayers(); }
    mapChrome();
  },
  maplayer: (el) => { const k = el.dataset.v; mapState.show[k] = !mapState.show[k]; if (mapState.ctl) mapState.ctl.show(k, mapState.show[k]); saveMapPrefs(); mapChrome(); },
  mapbase: () => { mapState.base = mapState.base === 'sat' ? 'street' : 'sat'; if (mapState.ctl) mapState.ctl.setBase(mapState.base); saveMapPrefs(); mapChrome(); },
  mapme: () => {
    if (!mapState.ctl) return;
    if (here && Date.now() - here.t < 60000) { mapState.follow = true; mapState.ctl.flyTo(here.lat, here.lon, 16); }
    else { mapState.centerOnFix = true; toast(geoError ? `Location: ${geoError}` : 'Getting your location…'); }
  },
  spothere: async () => {
    toast('Getting your location…', 15000);
    try { const p = await currentPosition(); $('#toast').hidden = true; openSpotForm({ lat: p.lat, lon: p.lon, acc: p.acc }); }
    catch (e) { toast(`No location: ${e.message}`); }
  },
  attr2spot: (el) => {
    if (mapState.ctl) mapState.ctl.map.closePopup();
    openSpotForm({ lat: +el.dataset.lat, lon: +el.dataset.lon, type: 'brush', name: `MDC ${el.dataset.desc || 'attractor'}`.slice(0, 60), notes: 'MDC fish attractor' });
  },
  openspot: (el) => openSpotSheet(el.dataset.id),
  editspot: (el) => openSpotForm({ id: el.dataset.id }),
  spotgps: () => spotFormGps(),
  spotonmap: (el) => { const s = spotById(el.dataset.id); $('#sheet').close(); if (s) showOnMap(s.lat, s.lon, s.lakeId); },
  delspot: async (el) => {
    const s = spotById(el.dataset.id);
    if (!s || !confirm(`Delete the spot "${s.name}"? Fish logged there are kept.`)) return;
    for (const c of data.catches.filter((x) => x.spotId === s.id)) {
      // keep the location on fish that only had the spot's position
      if (c.lat == null) { c.lat = s.lat; c.lon = s.lon; }
      c.spotId = null; await db.put('catches', c);
    }
    await db.del('spots', s.id);
    $('#sheet').close(); await loadData(); render(); toast('Spot deleted');
  },
  'gpx-spots': () => exportSpotsGPX(),
  'gpx-catches': () => exportCatchesGPX(),
  resetattractors: async () => {
    if (!confirm('Go back to the MDC attractor data built into the app?')) return;
    attractorOverrides = {}; await db.kvSet('attractorOverrides', {}); render(); toast('Using built-in MDC data');
  },
};

document.addEventListener('click', (ev) => {
  const link = ev.target.closest('a[data-link]');
  if (link) {
    db.kvGet('linksOpened', {}).then((m) => { m = m || {}; m[link.dataset.link] = Date.now(); db.kvSet('linksOpened', m); });
    return;
  }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  ev.preventDefault();
  const fn = actions[el.dataset.act];
  if (fn) fn(el);
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.bind) {
    const k = el.dataset.bind;
    let v = el.value;
    if (k === 'startHour' || k === 'endHour') v = +v;
    if (k === 'waterTemp') v = num(v);
    plan[k] = v;
    if (plan.endHour <= plan.startHour) plan.endHour = Math.min(24, plan.startHour + 1);
    savePlan(); render();
  } else if (el.dataset.set) {
    const k = el.dataset.set;
    settings[k] = el.type === 'checkbox' ? el.checked : num(el.value) ?? DEFAULT_SETTINGS[k];
    saveSettings(); toast('Saved');
  } else if (el.dataset.lake && el.dataset.k) {
    const id = el.dataset.lake;
    const v = num(el.value);
    if (v == null) return;
    settings.lakeOverrides[id] = { ...(settings.lakeOverrides[id] || {}), [el.dataset.k]: v };
    saveSettings(); wxCache = {}; toast('Lake point saved');
  } else if (el.id === 'restore' && el.files[0]) {
    try {
      const r = await importBackup(el.files[0]);
      toast(`Restored ${r.trips} trips (${r.newTrips} new), ${r.catches} fish, ${r.spots} spots`);
      render();
    } catch (e) { alert(`Restore failed: ${e.message}`); }
  } else if (el.id === 'import-spots' && el.files[0]) {
    try {
      const r = await importSpotsFile(el.files[0]);
      if (r) toast(`Added ${r.added} spot${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already saved)` : ''}`, 4000);
      render();
    } catch (e) { alert(`Import failed: ${e.message}`); }
    el.value = '';
  } else if (el.id === 'import-attractors' && el.files[0]) {
    try {
      const r = await importAttractorsFile(el.files[0]);
      toast(`Updated MDC attractors: ${r.lakes.join(', ')}${r.outside ? `. ${r.outside} points weren't on your lakes and were skipped` : ''}`, 5000);
      render();
    } catch (e) { alert(`Import failed: ${e.message}`); }
    el.value = '';
  }
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'tripform') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const t = tripById(routeArg());
  t.lakeId = f.get('lakeId');
  t.start = fromLocalInput(f.get('start')) || t.start;
  t.end = fromLocalInput(f.get('end'));
  if (t.end && Date.parse(t.end) <= Date.parse(t.start)) { toast('End must be after start'); return; }
  t.waterTemp = num(f.get('waterTemp'));
  t.clarity = f.get('clarity');
  t.notes = f.get('notes').trim();
  const w = { ...(t.weather || {}) };
  const nw = { windMph: num(f.get('windMph')), windDir: f.get('windDir') || null, tempF: num(f.get('tempF')), sky: f.get('sky') };
  const changed = ['windMph', 'windDir', 'tempF', 'sky'].some((k) => (nw[k] ?? null) !== (w[k] ?? null));
  if (changed) Object.assign(w, nw, { source: w.source ? `${w.source}, edited` : 'manual' });
  t.weather = (w.windMph != null || w.tempF != null || (w.sky && w.sky !== 'unknown')) ? w : null;
  // keep phases on this trip's fish consistent with the water temp
  for (const c of data.catches.filter((x) => x.tripId === t.id)) {
    const ph = pickPhase(c.species, c.month || new Date(c.time).getMonth() + 1, t.waterTemp);
    if (ph && ph.phase.id !== c.phase) { c.phase = ph.phase.id; c.lakeId = t.lakeId; await db.put('catches', c); }
  }
  await db.put('trips', t); await loadData(); toast('Trip saved'); render();
});

window.addEventListener('online', () => { $('#offline').hidden = true; if (route() === 'plan') { wxError = {}; render(); } });
window.addEventListener('offline', () => { $('#offline').hidden = false; });

// ---------- boot ----------
async function boot() {
  const s = await db.kvGet('settings');
  if (s) settings = { ...DEFAULT_SETTINGS, ...s, lakeOverrides: s.lakeOverrides || {} };
  const p = await db.kvGet('plan');
  if (p) plan = { ...plan, ...p, dayOffset: 0 };
  const mp = await db.kvGet('mapPrefs');
  if (mp) mapState = { ...mapState, lakeId: mp.lakeId || null, base: mp.base || 'sat', show: { ...mapState.show, ...(mp.show || {}) }, view: mp.view || null };
  attractorOverrides = (await db.kvGet('attractorOverrides')) || {};
  await loadData();
  $('#offline').hidden = navigator.onLine;
  await render();
  requestPersistence();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('App updated. It will refresh next time you open it.', 5000); });
      });
    }).catch(() => {});
  }
  fetch('./version.txt', { cache: 'no-store' }).then((r) => r.text()).then((v) => { window.APP_VERSION = v.trim(); }).catch(() => {});
  new MutationObserver(() => { const v = $('#ver'); if (v && window.APP_VERSION) v.textContent = window.APP_VERSION; }).observe($('#main'), { childList: true });
}
boot();

// exported for quick testing in the console
window._fish = { db, data: () => data, suggest, skyBucket, map: () => mapState };
