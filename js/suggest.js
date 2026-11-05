// Turns the playbook + forecast + your own catches into ranked, explained suggestions.
import { PLAYBOOK, LURES, COLOR_ADVICE, lureLabel } from './playbook.js';
import { windBucket } from './weather.js';

const RISING_MONTHS = [1, 2, 3, 4, 5, 6, 7];

/** Pick the seasonal phase for a species from the month and (optional) water temp. */
export function pickPhase(species, month, waterTemp) {
  const phases = PLAYBOOK[species];
  if (!phases) return null;
  const byMonth = phases.filter((p) => p.months.includes(month));
  if (waterTemp != null && !Number.isNaN(waterTemp)) {
    const trend = RISING_MONTHS.includes(month) ? 'rising' : 'falling';
    const byTemp = phases.filter((p) => waterTemp >= p.temp[0] && waterTemp <= p.temp[1] && (p.trend === 'any' || p.trend === trend));
    const both = byTemp.filter((p) => byMonth.includes(p));
    const pick = both[0] || byTemp[0];
    if (pick) return { phase: pick, basis: `water temp ${waterTemp}°F` };
  }
  if (byMonth.length) {
    // Shoulder months appear in two phases; earlier half of the month → first listed.
    return { phase: byMonth[0], basis: 'time of year (enter water temp to refine)', alt: byMonth[1] };
  }
  return { phase: phases[0], basis: 'default' };
}

/** Summarize forecast hours in a time window into fishing conditions. */
export function summarizeWindow(hours, startMs, endMs, sun) {
  const win = hours.filter((h) => h.t + 3600000 > startMs && h.t < endMs);
  if (!win.length) return null;
  const max = (k) => Math.max(...win.map((h) => h[k] ?? -1));
  const avg = (k) => { const v = win.map((h) => h[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const dirCount = {};
  win.forEach((h) => { if (h.windDir) dirCount[h.windDir] = (dirCount[h.windDir] || 0) + 1; });
  const mainDir = Object.entries(dirCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const skyCount = {};
  win.forEach((h) => { skyCount[h.sky] = (skyCount[h.sky] || 0) + 1; });
  let sky = Object.entries(skyCount).sort((a, b) => b[1] - a[1])[0][0];
  if (skyCount.storm) sky = 'storm';
  // Only the part of the window that's still ahead counts (e.g. "today 6am–noon" at 11am)
  startMs = Math.max(startMs, win[0].t);
  endMs = Math.min(endMs, win[win.length - 1].t + 3600000);
  const lowLight = sun && (Math.abs(startMs - sun.sunrise) < 5400000 || Math.abs(endMs - sun.sunset) < 5400000 ||
    startMs < sun.sunrise || endMs > sun.sunset);
  return {
    hours: win,
    avgWind: avg('windMph'),
    maxWind: max('windMph'),
    maxGust: max('gustMph') < 0 ? null : max('gustMph'),
    mainDir,
    sky,
    maxPop: max('pop') < 0 ? null : max('pop'),
    maxThunder: max('thunder') < 0 ? null : max('thunder'),
    minTemp: Math.min(...win.map((h) => h.tempF)),
    maxTemp: max('tempF'),
    lowLight,
  };
}

/** Did a cold front pass? Compare the planned day's high with the previous day's (forecast days only). */
export function detectPostFront(hours, dayStartMs) {
  const dayMax = (s) => { const v = hours.filter((h) => h.t >= s && h.t < s + 86400000).map((h) => h.tempF); return v.length > 12 ? Math.max(...v) : null; };
  const today = dayMax(dayStartMs), prev = dayMax(dayStartMs - 86400000);
  if (today == null || prev == null) return null;
  return prev - today >= 10;
}

const OPPOSITE = { N: 'south', NNE: 'south-southwest', NE: 'southwest', ENE: 'west-southwest', E: 'west', ESE: 'west-northwest', SE: 'northwest', SSE: 'north-northwest',
  S: 'north', SSW: 'north-northeast', SW: 'northeast', WSW: 'east-northeast', W: 'east', WNW: 'east-southeast', NW: 'southeast', NNW: 'south-southeast' };

function similarity(c, ctx) {
  let s = 0;
  if (c.phase === ctx.phaseId) s += 2; else if (c.month && Math.abs(c.month - ctx.month) <= 1) s += 1;
  const w = c.weather ? windBucket(c.weather.windMph) : 'unknown';
  if (w !== 'unknown' && w === ctx.windB) s += 1;
  const sky = c.weather && c.weather.sky;
  if (sky && sky !== 'unknown' && (sky === ctx.sky || (['cloudy', 'rain'].includes(sky) && ['cloudy', 'rain'].includes(ctx.sky)))) s += 1;
  if (c.lakeId === ctx.lakeId) s += 0.5;
  if (c.clarity && c.clarity === ctx.clarity) s += 0.5;
  return s;
}

/**
 * @param ctx { species, lakeId, month, waterTemp, clarity, cond (from summarizeWindow), postFront }
 * @param catches all logged catches
 */
export function suggest(ctx, catches) {
  const ph = pickPhase(ctx.species, ctx.month, ctx.waterTemp);
  if (!ph) return null;
  const phase = ph.phase;
  const cond = ctx.cond;
  const windB = cond ? windBucket(cond.avgWind) : 'unknown';
  const sky = cond ? cond.sky : 'unknown';
  const warm = !['winter'].includes(phase.id) && !(ctx.waterTemp != null && ctx.waterTemp < 58);
  const notes = [];

  // Personal history in similar conditions
  const mine = catches.filter((c) => c.species === ctx.species);
  const sctx = { phaseId: phase.id, month: ctx.month, windB, sky, lakeId: ctx.lakeId, clarity: ctx.clarity };
  const similar = mine.filter((c) => similarity(c, sctx) >= 2.5);
  const byLure = {};
  for (const c of similar) {
    const k = c.lureType || 'other';
    byLure[k] ||= { fish: 0, trips: new Set(), colors: {} };
    byLure[k].fish++;
    byLure[k].trips.add(c.tripId);
    if (c.color) byLure[k].colors[c.color.toLowerCase()] = (byLure[k].colors[c.color.toLowerCase()] || 0) + 1;
  }

  const items = phase.baits.map(([type, note, colors], i) => ({ type, label: lureLabel(type), note, colors, score: 10 - i * 1.5, reasons: [], source: 'playbook' }));
  // Add your own lures that aren't in the playbook list
  for (const [type, r] of Object.entries(byLure)) {
    if (!items.find((x) => x.type === type) && r.fish >= 2) {
      items.push({ type, label: lureLabel(type), note: 'From your catch log', colors: '', score: 4, reasons: [], source: 'yours' });
    }
  }

  for (const it of items) {
    const tags = (LURES[it.type] || { tags: [] }).tags;
    if (cond) {
      if (windB === 'windy' && tags.includes('moving')) { it.score += 2; it.reasons.push('wind favors moving baits'); }
      if (windB === 'calm' && sky === 'sunny' && tags.includes('finesse')) { it.score += 2; it.reasons.push('calm + bright favors finesse'); }
      if (windB === 'calm' && sky === 'sunny' && tags.includes('topwater') && !cond.lowLight) { it.score -= 2; it.reasons.push('bright midday: topwater weaker'); }
      if (['cloudy', 'rain'].includes(sky) && tags.includes('moving')) { it.score += 1; it.reasons.push('cloud cover: fish roam'); }
      if (tags.includes('topwater')) {
        if (cond.lowLight && warm) { it.score += 2; it.reasons.push('low-light window'); }
        if (!warm) { it.score -= 3; it.reasons.push('water likely too cold for topwater'); }
      }
    }
    if (ctx.clarity === 'muddy' && tags.includes('vibration')) { it.score += 2; it.reasons.push('muddy water: vibration helps'); }
    if (ctx.clarity === 'muddy' && tags.includes('natural') && ctx.species === 'catfish') { it.score += 1; it.reasons.push('scent bait in muddy water'); }
    if (ctx.postFront && tags.includes('finesse')) { it.score += 2; it.reasons.push('post-front: slow down'); }
    if (ctx.postFront && tags.includes('moving') && !tags.includes('finesse')) { it.score -= 1; it.reasons.push('post-front: fish less aggressive'); }

    const p = byLure[it.type];
    if (p) {
      it.personal = { fish: p.fish, trips: p.trips.size, topColor: Object.entries(p.colors).sort((a, b) => b[1] - a[1])[0]?.[0] };
      // Your data takes over gradually: weight grows with trips, capped
      const boost = Math.min(6, p.fish * 0.5 + p.trips.size * 1);
      it.score += boost;
      it.reasons.push(`you caught ${p.fish} in similar conditions (${p.trips.size} trip${p.trips.size === 1 ? '' : 's'})`);
    }
  }
  items.sort((a, b) => b.score - a.score);

  if (cond) {
    if (cond.mainDir && cond.avgWind >= 8) {
      notes.push(`Wind from the ${cond.mainDir}: ${OPPOSITE[cond.mainDir] || 'downwind'}-facing banks and points are windblown. Baitfish get pushed there, which is often good for ${ctx.species === 'walleye' ? 'walleye' : ctx.species === 'whitebass' ? 'white bass' : 'active fish'}. Fish the downwind side only when it's safe.`);
    }
    if (cond.lowLight) notes.push('Your window includes dawn or dusk, usually the best feeding period.');
    if (sky === 'sunny' && windB === 'calm') notes.push('Bright and calm: fish hold deeper and tighter to cover, so use lighter line and natural colors.');
  }
  if (ctx.postFront) notes.push('Looks like a cold front just passed (big temperature drop). Expect a tougher bite. Slow down and fish deeper.');
  if (ph.alt) notes.push(`Transition month: some fish may already be in "${ph.alt.label}" mode.`);

  const totalSpecies = mine.length;
  return {
    phase, basis: ph.basis, items, notes,
    colorAdvice: ctx.clarity ? COLOR_ADVICE[ctx.clarity] : null,
    personal: { similarFish: similar.length, similarTrips: new Set(similar.map((c) => c.tripId)).size, totalSpecies },
  };
}
