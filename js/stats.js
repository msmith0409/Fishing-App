// "What worked for me": catch rates from your own log, honest about sample size.
import { windBucket, WIND_LABEL, SKY_LABEL } from './weather.js';
import { lureLabel } from './playbook.js';
import { speciesName } from './lakes.js';

export const tripHours = (t) => (t.start && t.end ? Math.max(0, (Date.parse(t.end) - Date.parse(t.start)) / 3600000) : 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function group(trips, catches, keyOfTrip) {
  const g = {};
  for (const t of trips) {
    const k = keyOfTrip(t);
    if (k == null) continue;
    g[k] ||= { trips: 0, hours: 0, fish: 0 };
    g[k].trips++;
    g[k].hours += tripHours(t);
  }
  const tripKey = Object.fromEntries(trips.map((t) => [t.id, keyOfTrip(t)]));
  for (const c of catches) { const k = tripKey[c.tripId]; if (k != null && g[k]) g[k].fish++; }
  return Object.entries(g).map(([key, v]) => ({ key, ...v, perHour: v.hours >= 0.5 ? v.fish / v.hours : null }));
}

export function computeStats(trips, catches, lakes, speciesFilter) {
  const done = trips.filter((t) => t.end);
  const doneIds = new Set(done.map((t) => t.id));
  const cs = catches.filter((c) => doneIds.has(c.tripId) && (!speciesFilter || c.species === speciesFilter));
  const lakeName = (id) => (lakes.find((l) => l.id === id) || { name: id }).name;
  const totalHours = done.reduce((a, t) => a + tripHours(t), 0);

  const byLake = group(done, cs, (t) => t.lakeId).map((r) => ({ ...r, label: lakeName(r.key) }));
  const byMonth = group(done, cs, (t) => new Date(t.start).getMonth()).map((r) => ({ ...r, label: MONTHS[r.key] })).sort((a, b) => a.key - b.key);
  const byWind = group(done, cs, (t) => windBucket(t.weather && t.weather.windMph)).map((r) => ({ ...r, label: WIND_LABEL[r.key] }));
  const bySky = group(done, cs, (t) => (t.weather && t.weather.sky) || 'unknown').map((r) => ({ ...r, label: SKY_LABEL[r.key] || r.key }));

  const count = (keyFn, labelFn) => {
    const g = {};
    for (const c of cs) {
      const k = keyFn(c);
      g[k] ||= { fish: 0, trips: new Set() };
      g[k].fish++; g[k].trips.add(c.tripId);
    }
    return Object.entries(g).map(([key, v]) => ({ key, label: labelFn(key), fish: v.fish, trips: v.trips.size })).sort((a, b) => b.fish - a.fish);
  };
  const bySpecies = count((c) => c.species, speciesName).map((r) => ({ ...r, perHour: totalHours >= 0.5 ? r.fish / totalHours : null }));
  const byLure = count((c) => c.lureType || 'other', lureLabel);
  const byLureColor = count((c) => `${c.lureType || 'other'}|${(c.color || '').toLowerCase()}`, (k) => { const [t, col] = k.split('|'); return `${lureLabel(t)}${col ? ` — ${col}` : ''}`; });

  const sized = cs.filter((c) => c.lengthIn);
  const biggest = [...sized].sort((a, b) => b.lengthIn - a.lengthIn).slice(0, 5);

  return { trips: done.length, hours: totalHours, fish: cs.length, byLake, byMonth, byWind, bySky, bySpecies, byLure, byLureColor, biggest };
}

export const smallSample = (r) => (r.trips != null && r.trips < 3) || (r.hours != null && r.hours < 8);
