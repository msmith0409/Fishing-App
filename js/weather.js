// National Weather Service (api.weather.gov), a free public API with no key.
// Forecasts are cached on the device so the last one still shows when you're offline.
import { db } from './db.js';

const API = 'https://api.weather.gov';
const HEADERS = { Accept: 'application/geo+json' };
const KMH_TO_MPH = 0.621371;

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const dirToDeg = (d) => { const i = DIRS.indexOf(d); return i < 0 ? null : i * 22.5; };
export const degToDir = (deg) => (deg == null ? null : DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

export function skyBucket(text = '') {
  const t = text.toLowerCase();
  if (/thunder|t-storm/.test(t)) return 'storm';
  if (/rain|shower|drizzle|sleet|snow/.test(t)) return 'rain';
  if (/partly|mostly sunny|mostly clear/.test(t)) return 'partly';
  if (/cloud|overcast|fog|haze/.test(t)) return 'cloudy';
  if (/sunny|clear|fair/.test(t)) return 'sunny';
  return 'unknown';
}
export const SKY_LABEL = { sunny: 'Sunny/clear', partly: 'Partly cloudy', cloudy: 'Cloudy', rain: 'Rain', storm: 'Storms', unknown: '?' };

export function windBucket(mph) {
  if (mph == null) return 'unknown';
  if (mph < 5) return 'calm';
  if (mph < 12) return 'breezy';
  return 'windy';
}
export const WIND_LABEL = { calm: 'Calm (<5)', breezy: 'Breezy (5–11)', windy: 'Windy (12+)', unknown: '?' };

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS, cache: 'no-store' });
  if (!r.ok) throw new Error(`NWS ${r.status} for ${url.replace(API, '')}`);
  return r.json();
}

async function getPoint(lake) {
  const key = `point:${lake.lat.toFixed(4)},${lake.lon.toFixed(4)}`;
  const cached = await db.kvGet(key);
  if (cached && Date.now() - cached.at < 30 * 86400000) return cached;
  const j = await getJSON(`${API}/points/${lake.lat.toFixed(4)},${lake.lon.toFixed(4)}`);
  const p = j.properties;
  const point = {
    at: Date.now(),
    hourly: p.forecastHourly,
    grid: p.forecastGridData,
    stations: p.observationStations,
    office: p.gridId,
    near: p.relativeLocation ? `${p.relativeLocation.properties.city}, ${p.relativeLocation.properties.state}` : '',
  };
  await db.kvSet(key, point);
  return point;
}

// "2026-11-04T01:00:00+00:00/PT1H" → [startMs, endMs]
function parseValidTime(v) {
  const [start, dur] = v.split('/');
  const s = Date.parse(start);
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(dur) || [];
  const ms = ((+m[1] || 0) * 24 * 60 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 60000;
  return [s, s + ms];
}
function gridSeries(prop) {
  if (!prop || !prop.values) return [];
  return prop.values.map((v) => { const [s, e] = parseValidTime(v.validTime); return { s, e, v: v.value }; });
}
const lookup = (series, t) => { const x = series.find((p) => t >= p.s && t < p.e); return x ? x.v : null; };

const mphFrom = (s) => { const n = (s || '').match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; };

/** Returns { hours[], alerts[], fetchedAt, updated, near, office, stale, error } */
export async function getForecast(lake, { force = false } = {}) {
  const cacheKey = `wx:${lake.id}:${lake.lat},${lake.lon}`;
  const cached = await db.kvGet(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < 20 * 60000) return { ...cached, stale: false };
  try {
    const point = await getPoint(lake);
    const [hourly, grid, alerts] = await Promise.all([
      getJSON(point.hourly),
      getJSON(point.grid).catch(() => null),
      getJSON(`${API}/alerts/active?point=${lake.lat.toFixed(4)},${lake.lon.toFixed(4)}`).catch(() => null),
    ]);
    const gust = gridSeries(grid && grid.properties.windGust);
    const thunder = gridSeries(grid && grid.properties.probabilityOfThunder);
    const hours = hourly.properties.periods.map((p) => {
      const t = Date.parse(p.startTime);
      const g = lookup(gust, t);
      return {
        t,
        tempF: p.temperature,
        windMph: mphFrom(p.windSpeed),
        windDir: p.windDirection,
        gustMph: g == null ? null : Math.round(g * KMH_TO_MPH),
        pop: p.probabilityOfPrecipitation ? p.probabilityOfPrecipitation.value : null,
        thunder: lookup(thunder, t),
        short: p.shortForecast,
        sky: skyBucket(p.shortForecast),
        isDay: p.isDaytime,
      };
    });
    const out = {
      fetchedAt: Date.now(),
      updated: hourly.properties.updateTime || hourly.properties.generatedAt,
      near: point.near,
      office: point.office,
      hours,
      alerts: alerts ? alerts.features.map((f) => ({
        event: f.properties.event,
        headline: f.properties.headline,
        severity: f.properties.severity,
        ends: f.properties.ends || f.properties.expires,
        description: f.properties.description,
      })) : null,
    };
    await db.kvSet(cacheKey, out);
    return { ...out, stale: false };
  } catch (err) {
    if (cached) return { ...cached, stale: true, error: String(err.message || err) };
    throw err;
  }
}

/** Latest observation at the nearest NWS station. Real measurement, can be 1+ hour old. */
export async function getObservation(lake) {
  const point = await getPoint(lake);
  const st = await getJSON(point.stations);
  const station = st.features && st.features[0];
  if (!station) throw new Error('No station');
  const id = station.properties.stationIdentifier;
  const o = (await getJSON(`${API}/stations/${id}/observations/latest`)).properties;
  const kmh = (x) => (x && x.value != null ? Math.round(x.value * KMH_TO_MPH) : null);
  return {
    source: 'observed',
    station: id,
    at: o.timestamp,
    tempF: o.temperature && o.temperature.value != null ? Math.round(o.temperature.value * 9 / 5 + 32) : null,
    windMph: kmh(o.windSpeed),
    windDir: degToDir(o.windDirection && o.windDirection.value),
    gustMph: kmh(o.windGust),
    pressureMb: o.barometricPressure && o.barometricPressure.value != null ? Math.round(o.barometricPressure.value / 10) / 10 : null,
    short: o.textDescription,
    sky: skyBucket(o.textDescription),
  };
}

/** Best-effort weather for a moment: observation if it's recent, else the cached forecast hour. */
export async function weatherSnapshot(lake, when = Date.now()) {
  if (Math.abs(Date.now() - when) < 90 * 60000 && navigator.onLine) {
    try {
      const obs = await getObservation(lake);
      if (obs.windMph != null || obs.tempF != null) return obs;
    } catch { /* fall through to forecast */ }
  }
  try {
    const fc = await getForecast(lake);
    const h = fc.hours.find((x) => when >= x.t && when < x.t + 3600000);
    if (h) return { source: 'forecast', at: new Date(h.t).toISOString(), tempF: h.tempF, windMph: h.windMph, windDir: h.windDir, gustMph: h.gustMph, short: h.short, sky: h.sky };
  } catch { /* offline with no cache */ }
  return null;
}
