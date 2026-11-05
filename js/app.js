import { db, uid, requestPersistence } from './db.js';
import { DEFAULT_LAKES, GENERAL_LINKS, LINKS_VERIFIED, SPECIES, ALL_SPECIES, speciesName } from './lakes.js';
import { LURES, lureLabel, PLAYBOOK } from './playbook.js';
import { getForecast, weatherSnapshot, dirToDeg, SKY_LABEL, skyBucket } from './weather.js';
import { sunTimes } from './sun.js';
import { suggest, summarizeWindow, detectPostFront, pickPhase } from './suggest.js';
import { computeStats, smallSample, tripHours } from './stats.js';

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
let data = { trips: [], catches: [] };
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
  const [trips, catches] = await Promise.all([db.all('trips'), db.all('catches')]);
  data.trips = trips.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  data.catches = catches.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}
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
  if (r === 'trip') { main.innerHTML = await renderTrip(routeArg()); return; }
  main.innerHTML = await (routes[r] || renderPlan)();
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
      <span class="small muted">${fmtTime(c.time)}${c.weather ? ` · ${c.weather.windMph ?? '?'} mph ${esc(c.weather.windDir || '')}` : ''}${c.lat ? ' · 📍' : ''}${c.photoId ? ' · 📷' : ''}</span>
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
  dlg.innerHTML = `<form method="dialog" id="catchform" class="form">
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
    <label>Photo <input type="file" name="photo" accept="image/*" capture="environment"></label>
    ${photoUrl ? `<img src="${photoUrl}" class="thumb" alt="Catch photo">` : ''}
    <label>Notes <input name="notes" value="${esc(c.notes || '')}" placeholder="spot, structure, etc."></label>
    <div class="row sticky">
      <button type="button" class="btn ghost" data-act="closesheet">Cancel</button>
      ${existing ? `<button type="button" class="btn danger" data-act="delfish" data-id="${existing.id}">Delete</button>` : ''}
      <button type="submit" class="btn">Save</button>
    </div>
  </form>`;
  dlg.showModal();
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
    info.textContent = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)} (±${Math.round(p.coords.accuracy)} m)`;
  }, (e) => { info.textContent = `No location: ${e.message}`; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
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
  const s = computeStats(data.trips, enrichedCatches(), lakes(), statsSpecies);
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
      <p>Privacy: trips, catches, GPS spots, and photos are stored on this device only. Nothing is uploaded. The only network calls are to the NWS for weather.</p>
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
  const out = { app: 'fishing-intel', version: 1, exportedAt: new Date().toISOString(), settings, trips: data.trips, catches: data.catches, photos };
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
  for (const p of j.photos || []) { const blob = await (await fetch(p.dataUrl)).blob(); await db.put('photos', { id: p.id, blob, type: blob.type }); }
  await loadData();
  return { trips: (j.trips || []).length, catches: (j.catches || []).length, newTrips };
}

function exportCatchesCSV() {
  const head = ['date', 'time', 'lake', 'species', 'length_in', 'weight_lb', 'lure_type', 'lure_name', 'color', 'depth_ft', 'released', 'phase', 'wind_mph', 'wind_from', 'gust_mph', 'air_f', 'sky', 'weather_source', 'clarity', 'water_f', 'lat', 'lon', 'notes', 'trip_id', 'catch_id'];
  const rows = enrichedCatches().map((c) => {
    const t = tripById(c.tripId) || {};
    const w = c.weather || {};
    return [ymd(c.time), fmtTime(c.time), lakeById(c.lakeId).name, speciesName(c.species), c.lengthIn, c.weightLb, lureLabel(c.lureType), c.lureName, c.color, c.depthFt, c.released ? 'yes' : 'no', c.phase, w.windMph, w.windDir, w.gustMph, w.tempF, w.sky, w.source, c.clarity, t.waterTemp, c.lat, c.lon, c.notes, c.tripId, c.id];
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
      toast(`Restored ${r.trips} trips (${r.newTrips} new), ${r.catches} fish`);
      render();
    } catch (e) { alert(`Restore failed: ${e.message}`); }
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
window._fish = { db, data: () => data, suggest, skyBucket };
