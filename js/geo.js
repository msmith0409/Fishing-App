// Distance/bearing math, GPX read/write, and .zip reading (MDC ships GPX inside zips).

const R = 6371000; // m
const rad = (d) => (d * Math.PI) / 180;

/** Distance in meters between two {lat, lon} points. */
export function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial compass bearing (0-360, 0 = north) from a to b. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (deg) => CARD[Math.round(deg / 22.5) % 16];

/** "120 yd" under a quarter mile, otherwise "1.3 mi". */
export function fmtDist(m) {
  const yd = m * 1.09361;
  if (yd < 440) return `${Math.round(yd)} yd`;
  const mi = m / 1609.344;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** Which lake a point is on: inside a lake's bounds, else null. */
export function lakeForPoint(lakes, p) {
  const hit = lakes.find((l) => l.bounds && p.lat >= l.bounds[0][0] && p.lat <= l.bounds[1][0] && p.lon >= l.bounds[0][1] && p.lon <= l.bounds[1][1]);
  return hit ? hit.id : null;
}

/** Parse GPX text into waypoints [{lat, lon, name, desc, time}]. Track/route points are ignored. */
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error("That file isn't valid GPX");
  const txt = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : ''; };
  return [...doc.getElementsByTagName('wpt')].map((w) => ({
    lat: Number(w.getAttribute('lat')), lon: Number(w.getAttribute('lon')),
    name: txt(w, 'name'), desc: txt(w, 'desc'), time: txt(w, 'time'),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
}

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Build GPX 1.1 text from [{lat, lon, name, desc, time}]. */
export function toGPX(points, creator = 'Fishing Planner') {
  const w = points.map((p) => `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.time ? `\n    <time>${xml(p.time)}</time>` : ''}
    <name>${xml(p.name)}</name>${p.desc ? `\n    <desc>${xml(p.desc)}</desc>` : ''}
  </wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${xml(creator)}" xmlns="http://www.topografix.com/GPX/1/1">\n${w}\n</gpx>\n`;
}

/** Read every .gpx file inside a .zip (stored or deflate). Returns [{name, text}]. */
export async function gpxFromZip(buf) {
  const v = new DataView(buf);
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That file isn't a readable .zip");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.gpx$/i.test(name) || name.startsWith('__MACOSX')) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = new Uint8Array(buf, start, csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push({ name, text: new TextDecoder().decode(bytes) });
  }
  if (!out.length) throw new Error('No GPX file found inside that .zip');
  return out;
}

/** Read a picked .gpx or .zip file into waypoints. */
export async function readWaypointsFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const texts = isZip ? (await gpxFromZip(buf)).map((f) => f.text) : [new TextDecoder().decode(buf)];
  return texts.flatMap(parseGPX);
}
