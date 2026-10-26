"use strict";
const API = "https://api.weather.gov";
const MAX_SAVED = 5;
const STALE_MS = 10 * 60 * 1000;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const NON_CONUS = new Set(["AK", "HI", "PR", "VI", "GU", "AS", "MP"]);

/* ---------- time helpers (per-location time zone) ---------- */
let TZ = "America/Denver";
let fDateKey, fHour, fTime, fWeekday, fShortDay, fWhen, fLong;
function setTZ(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); TZ = tz; } catch { TZ = "America/Denver"; }
  const fmt = opts => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts });
  fDateKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  fHour = fmt({ hour: "numeric" });
  fTime = fmt({ hour: "numeric", minute: "2-digit", timeZoneName: undefined });
  fWeekday = fmt({ weekday: "long" });
  fShortDay = fmt({ weekday: "short" });
  fWhen = fmt({ weekday: "short", hour: "numeric", minute: "2-digit" });
  fLong = fmt({ weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
setTZ(TZ);
const dateKey = d => fDateKey.format(new Date(d));
const hourLabel = d => fHour.format(new Date(d)).replace(" AM", "a").replace(" PM", "p");
const noonOf = key => new Date(key + "T12:00:00-07:00");
const localMonth = () => +dateKey(Date.now()).slice(5, 7);

/* ---------- geometry ---------- */
function distKm(a, b, c, d) {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

/* ---------- network ---------- */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) { const e = new Error(r.status + " " + url); e.status = r.status; throw e; }
  return r.json();
}
// Sites that don't allow cross-site reads are fetched through the host's relay (see _redirects), then directly as a fallback.
// Some sources (CSU stations, SPC risk areas) may not allow phone apps to read them directly.
// If one is blocked, skip it for 6 hours instead of asking again on every refresh.
const BLOCK_MS = 6 * 3600e3;
const isBlocked = name => Date.now() - (store.get("nwsb.blocked." + name) || 0) < BLOCK_MS;
async function getDirect(name, url) {
  if (isBlocked(name)) throw new Error(name + " skipped");
  try { return await getJSON(url); }
  catch (e) {
    if (e instanceof TypeError && navigator.onLine !== false) store.set("nwsb.blocked." + name, Date.now());
    throw e;
  }
}
async function getPoints(lat, lon) {
  const key = `nwsb.pts2.${lat.toFixed(3)},${lon.toFixed(3)}`;
  const c = store.get(key);
  if (c && Date.now() - c.t < 7 * 864e5) return c.v;
  const j = await getJSON(`${API}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const p = j.properties, rl = p.relativeLocation && p.relativeLocation.properties || {};
  const v = {
    forecast: p.forecast, hourly: p.forecastHourly, grid: p.forecastGridData, radar: p.radarStation,
    office: p.gridId || p.cwa, tz: p.timeZone || "America/Denver", stationsUrl: p.observationStations,
    city: rl.city || "", state: rl.state || ""
  };
  try {
    const st = await getJSON(v.stationsUrl);
    v.stations = (st.features || []).slice(0, 30).map(f => ({
      id: f.properties.stationIdentifier, name: f.properties.name,
      lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
      lon: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
      elev: f.properties.elevation && f.properties.elevation.value != null ? f.properties.elevation.value : null   // meters
    }));
  } catch { v.stations = []; }
  try {
    const of = await getJSON(`${API}/offices/${v.office}`);
    v.officeName = of.name || "";
  } catch { v.officeName = ""; }
  store.set(key, { t: Date.now(), v });
  return v;
}
async function latestProduct(type, office) {
  const list = await getJSON(`${API}/products/types/${type}/locations/${office}`);
  const first = (list["@graph"] || [])[0];
  if (!first) return null;
  return getJSON(first["@id"]);
}
/* ---------- current conditions: automatic station choice ----------
   Rules: closest station first, within 25 miles, within 1,000 ft of this location's elevation,
   and reporting within the last 90 minutes. Official NWS stations everywhere, plus CSU's
   5-minute CoAgMET stations around Fort Collins. Nothing qualifies -> hourly forecast. */
const OBS_MAX_KM = 40.2, OBS_MAX_ELEV_M = 305, OBS_MAX_AGE = 90 * 60e3;
const COAG = [
  { id: "fcl01", name: "CSU campus (Fort Collins)", lat: 40.5762, lon: -105.0857, elev: 4997 / 3.281 },
  { id: "ftc01", name: "CSU AERC (Fort Collins)", lat: 40.5947, lon: -105.1370, elev: 5120 / 3.281 },
  { id: "fcc01", name: "Christman Field (Fort Collins)", lat: 40.5917, lon: -105.1418, elev: 5148 / 3.281 }
];
// CSU station readings, copied every 15 minutes by this site's GitHub relay (.github/workflows/station-relay.yml)
const RELAY_URL = "https://raw.githubusercontent.com/MoveBeyondFPTP/nwscast/data/coagmet.json";
let relayP = null, relayAt = 0;
function coagRelay() {
  if (!relayP || Date.now() - relayAt > 5 * 60e3) {
    relayAt = Date.now();
    relayP = getJSON(RELAY_URL).catch(() => null);
  }
  return relayP;
}
const fresh = t => !isNaN(t) && Date.now() - t < OBS_MAX_AGE && t < Date.now() + 10 * 60e3;
function rankStations(pts, lat, lon, elevM) {
  const all = (pts.stations || []).filter(s => s.lat != null).map(s => ({ ...s, kind: "nws" }))
    .concat(COAG.map(s => ({ ...s, kind: "coag" })))
    .map(s => ({ ...s, d: distKm(lat, lon, s.lat, s.lon) }));
  return all.filter(s => s.d <= OBS_MAX_KM && (elevM == null || s.elev == null || Math.abs(s.elev - elevM) <= OBS_MAX_ELEV_M))
    .sort((a, b) => a.d - b.d);
}
async function pickObs(pts, lat, lon, elevM) {
  for (const s of rankStations(pts, lat, lon, elevM).slice(0, 5)) {
    try {
      if (s.kind === "coag") {
        const relay = await coagRelay();
        const raw = relay && relay.stations && relay.stations[s.id];
        const L = parseCoag(raw || await getDirect("coagmet", `https://coagmet.colostate.edu/data/latest/${s.id}.json`));
        if (fresh(L.time)) return { kind: "coag", name: s.name, d: s.d, ...L };
      } else {
        const p = (await getJSON(`${API}/stations/${s.id}/observations/latest`)).properties;
        const t = Date.parse(p && p.timestamp);
        if (p && p.temperature && p.temperature.value != null && fresh(t)) {
          const v = k => p[k] && p[k].value != null ? p[k].value : null;
          const feels = v("windChill") ?? v("heatIndex");
          return { kind: "nws", name: s.name, d: s.d, time: t, desc: p.textDescription || "", icon: p.icon || "",
            t: cToF(v("temperature")), dewpt: v("dewpoint") != null ? cToF(v("dewpoint")) : null,
            windSpeed: v("windSpeed") != null ? v("windSpeed") / 1.609 : null, windDir: v("windDirection"),
            gustSpeed: v("windGust") != null ? v("windGust") / 1.609 : null, feels: feels != null ? cToF(feels) : null };
        }
      }
    } catch {}
  }
  return { none: true };
}
// CoAgMET "latest" JSON: scalars or one-element arrays; -999 = missing; US units (°F, mph); times in MST.
function parseCoag(j) {
  const src = Array.isArray(j) ? j[0] : (j && Array.isArray(j.data) ? j.data[0] : j);
  if (!src) throw new Error("no data");
  const pick = k => { let v = src[k]; if (Array.isArray(v)) v = v[v.length - 1]; v = v == null || v === "" ? null : +v; return v == null || isNaN(v) || v <= -998 ? null : v; };
  let t = src.time; if (Array.isArray(t)) t = t[t.length - 1];
  if (!t) throw new Error("no time");
  t = String(t).replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += "-07:00";
  const out = { time: Date.parse(t), t: pick("t"), dewpt: pick("dewpt"), windSpeed: pick("windSpeed"), windDir: pick("windDir"), gustSpeed: pick("gustSpeed") };
  if (out.t == null) throw new Error("incomplete");
  const wc = windChillF(out.t, out.windSpeed);
  out.feels = wc != null ? wc : null;
  return out;
}

/* ---------- weather icons ---------- */
const CLOUD = "M16 50h32a11 11 0 0 0 1.5-21.9A15 15 0 0 0 20.6 25 12.6 12.6 0 0 0 16 50z";
function sun(cx, cy, r) {
  let rays = "";
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, r1 = r + 4, r2 = r + 9;
    rays += `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}" x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}"/>`;
  }
  return `<g stroke="var(--sun)" stroke-width="3.2" stroke-linecap="round">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--sun)"/>`;
}
function moon(cx, cy, r) {
  return `<path fill="var(--moon)" d="M${cx + r * .35} ${cy - r}a${r} ${r} 0 1 0 ${r * .65} ${r * 1.55} ${r * .85} ${r * .85} 0 0 1-${r * .65}-${r * 1.55}z"/>`;
}
const cloud = (x, y, s, fill = "var(--cloud)") => `<path d="${CLOUD}" fill="${fill}" transform="translate(${x} ${y}) scale(${s})"/>`;
function drops(n = 3, y = 52) {
  const xs = n === 2 ? [26, 38] : [21, 32, 43];
  return `<g stroke="var(--rain)" stroke-width="3.2" stroke-linecap="round">${xs.map(x => `<line x1="${x}" y1="${y}" x2="${x - 3}" y2="${y + 8}"/>`).join("")}</g>`;
}
function flake(x, y, s = 5) {
  let g = "";
  for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3; g += `<line x1="${(x - Math.cos(a) * s).toFixed(1)}" y1="${(y - Math.sin(a) * s).toFixed(1)}" x2="${(x + Math.cos(a) * s).toFixed(1)}" y2="${(y + Math.sin(a) * s).toFixed(1)}"/>`; }
  return `<g stroke="var(--snow)" stroke-width="2.4" stroke-linecap="round">${g}</g>`;
}
const flakes = () => flake(21, 53) + flake(33, 57) + flake(45, 52);
const bolt = `<path d="M34 44l-7 11h6l-3 8 10-13h-6l4-6z" fill="var(--bolt)"/>`;
const fogLines = y => `<g stroke="var(--fog)" stroke-width="3" stroke-linecap="round"><line x1="10" y1="${y}" x2="54" y2="${y}"/><line x1="16" y1="${y + 7}" x2="48" y2="${y + 7}"/></g>`;
const windLines = `<g fill="none" stroke="var(--fog)" stroke-width="3" stroke-linecap="round"><path d="M8 54h30a5 5 0 1 0-5-5"/><path d="M14 61h22"/></g>`;
const celestial = (day, cx, cy, r) => day ? sun(cx, cy, r) : moon(cx, cy, r);
function classify(iconUrl, text) {
  let code = "";
  const m = /\/(day|night)\/([^/?,]+)/.exec(iconUrl || "");
  if (m) code = m[2];
  const t = (text || "").toLowerCase();
  if (!code) {
    if (/thunder|t-storm/.test(t)) code = "tsra";
    else if (/snow|flurr|blizzard/.test(t) && /rain|sleet|freezing/.test(t)) code = "rain_snow";
    else if (/snow|flurr|blizzard/.test(t)) code = "snow";
    else if (/sleet|freezing/.test(t)) code = "sleet";
    else if (/shower/.test(t)) code = "rain_showers";
    else if (/rain|drizzle/.test(t)) code = "rain";
    else if (/fog/.test(t)) code = "fog";
    else if (/smoke|haze|dust/.test(t)) code = "haze";
    else if (/mostly cloudy|considerable/.test(t)) code = "bkn";
    else if (/partly/.test(t)) code = "sct";
    else if (/mostly (sunny|clear)/.test(t)) code = "few";
    else if (/cloudy|overcast/.test(t)) code = "ovc";
    else code = "skc";
  }
  const windy = code.startsWith("wind_");
  return { code: code.replace("wind_", ""), windy };
}
function iconSVG(iconUrl, text, isDay = true) {
  const { code, windy } = classify(iconUrl, text);
  let g;
  switch (code) {
    case "skc": case "hot": case "cold": g = celestial(isDay, 32, 32, isDay ? 12 : 15); break;
    case "few": g = celestial(isDay, 28, 26, isDay ? 11 : 13) + cloud(22, 22, .62); break;
    case "sct": g = celestial(isDay, 24, 22, isDay ? 10 : 12) + cloud(12, 16, .78); break;
    case "bkn": g = celestial(isDay, 20, 18, isDay ? 8 : 10) + cloud(2, 6, .95); break;
    case "ovc": g = cloud(8, -4, .85, "var(--cloud-2)") + cloud(0, 6, .95); break;
    case "rain": g = cloud(0, -6, .95, "var(--cloud-2)") + drops(3, 50); break;
    case "rain_showers": case "rain_showers_hi": g = celestial(isDay, 18, 16, isDay ? 8 : 9) + cloud(2, -2, .9) + drops(2, 50); break;
    case "tsra": case "tsra_sct": case "tsra_hi": case "tornado": case "hurricane": case "tropical_storm":
      g = cloud(0, -8, .95, "var(--cloud-2)") + bolt + `<g stroke="var(--rain)" stroke-width="3" stroke-linecap="round"><line x1="20" y1="48" x2="17" y2="56"/><line x1="48" y1="48" x2="45" y2="56"/></g>`; break;
    case "snow": case "blizzard": g = cloud(0, -8, .95) + flakes(); break;
    case "rain_snow": case "snow_sleet": case "rain_sleet": case "sleet": case "fzra": case "rain_fzra": case "snow_fzra":
      g = cloud(0, -8, .95) + `<g stroke="var(--rain)" stroke-width="3.2" stroke-linecap="round"><line x1="24" y1="50" x2="21" y2="58"/></g>` + flake(40, 55); break;
    case "fog": g = cloud(0, -10, .9) + fogLines(48); break;
    case "dust": case "smoke": case "haze": g = celestial(isDay, 32, 26, 10) + fogLines(46); break;
    default: g = celestial(isDay, 32, 32, 12);
  }
  if (windy) g += windLines;
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${g}</svg>`;
}

/* ---------- temperature color scale (°F) ---------- */
const TSTOPS = [[-10,[123,108,255]],[20,[92,140,255]],[35,[95,196,232]],[50,[125,211,168]],[65,[242,201,76]],[80,[242,153,74]],[95,[235,87,87]],[110,[190,40,80]]];
function tempColor(f) {
  if (f <= TSTOPS[0][0]) return `rgb(${TSTOPS[0][1]})`;
  for (let i = 1; i < TSTOPS.length; i++) {
    const [t1, c1] = TSTOPS[i];
    if (f <= t1) { const [t0, c0] = TSTOPS[i - 1], k = (f - t0) / (t1 - t0); return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",")})`; }
  }
  return `rgb(${TSTOPS.at(-1)[1]})`;
}

/* ---------- locations ---------- */
let locs = store.get("nwsb.locs");
if (!Array.isArray(locs)) { locs = []; store.set("nwsb.locs", locs); }        // new users start on current location
let activeId = store.get("nwsb.active") || (locs[0] ? locs[0].id : "current");
if (activeId !== "current" && !locs.some(l => l.id === activeId)) activeId = locs[0] ? locs[0].id : "current";
let geo = store.get("nwsb.geo");         // last known current position {lat, lon, t, name}
let geoError = "";

function activeLoc() {
  if (activeId === "current") return { id: "current", label: "Current location", name: geo && geo.name || "", lat: geo && geo.lat, lon: geo && geo.lon, current: true };
  return locs.find(l => l.id === activeId) || locs[0] || { id: "current", label: "Current location", name: "", lat: geo && geo.lat, lon: geo && geo.lon, current: true };
}
function locKey(l) { return l.lat == null ? "none" : `${(+l.lat).toFixed(2)},${(+l.lon).toFixed(2)}`; }
function geolocate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Location isn't available on this device."));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude, t: Date.now() }),
      e => rej(new Error(e.code === 1
        ? "Location access is turned off for this app. On iPhone, go to Settings › Privacy & Security › Location Services › Safari Websites and choose “While Using the App”, then tap refresh."
        : "Couldn't find your location. Check that Location Services is on, then tap refresh.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60e3 });
  });
}

/* ---------- state ---------- */
const S = { data: {}, pts: null, loading: false, lastLoad: 0, errors: {}, token: 0 };
let currentTab = store.get("nwsb.tab") || "week";
if (currentTab === "winter") currentTab = "season";
let radarSite = null, spcDay = 1, wpcDay = 1, nhcDays = 7, cpcRange = "610", fireDay = 1, seasonOverride = null;

function save() {
  const l = activeLoc();
  const { forecast, hourly, obs, alerts, afd, hwo, grid, spc, two, hls, updated, at } = S.data;
  store.set("nwsb.cache." + locKey(l), { pts: S.pts, forecast, hourly, obs, alerts, afd, hwo, grid, spc, two, hls, updated, at });
}
function restore() {
  const c = store.get("nwsb.cache." + locKey(activeLoc()));
  S.data = c || {};
  if (!S.data.at) S.data.at = {};
  S.pts = c && c.pts || null;
  if (S.pts) setTZ(S.pts.tz);
}

/* ---------- load everything for the active location ---------- */
// How long each kind of data is reused before fetching again (automatic refreshes; the refresh button gets everything).
const MAX_AGE = { grid: 60, afd: 30, hwo: 30, two: 60, hls: 30, spc: 30 };
const isFresh = k => S.data[k] != null && S.data.at && Date.now() - (S.data.at[k] || 0) < MAX_AGE[k] * 60e3;
async function loadAll(force = false) {
  const token = ++S.token;
  S.loading = true; S.errors = {};
  $("#refresh").classList.add("spin");
  renderChrome();
  const done = () => { if (token !== S.token) return; S.loading = false; S.lastLoad = Date.now(); $("#refresh").classList.remove("spin"); renderAll(); };
  try {
    let loc = activeLoc();
    if (loc.current) {
      try {
        const pos = await geolocate();
        if (token !== S.token) return;
        geoError = "";
        const moved = !geo || distKm(geo.lat, geo.lon, pos.lat, pos.lon) > 1;
        geo = { ...(moved ? {} : geo), ...pos };
        store.set("nwsb.geo", geo);
        if (moved) restore();
        loc = activeLoc();
      } catch (e) {
        geoError = e.message;
        if (!geo) { S.errors.points = e; return done(); }
      }
    }
    const pts = await getPoints(+loc.lat, +loc.lon);
    if (token !== S.token) return;
    S.pts = pts; setTZ(pts.tz);
    if (loc.current && geo) { geo.name = [pts.city, pts.state].filter(Boolean).join(", "); store.set("nwsb.geo", geo); }
    if (!radarSite || !RADAR_ALT[pts.radar] || ![pts.radar, RADAR_ALT[pts.radar]].includes(radarSite)) radarSite = pts.radar;
    renderAll();
    if (!S.data.at) S.data.at = {};
    const fcP = getJSON(pts.forecast).then(j => j.properties);
    const jobs = {
      forecast: fcP,
      hourly: getJSON(pts.hourly).then(j => j.properties),
      obs: fcP.catch(() => null).then(fc => pickObs(pts, +loc.lat, +loc.lon, fc && fc.elevation ? fc.elevation.value : null)),
      alerts: getJSON(`${API}/alerts/active?point=${(+loc.lat).toFixed(4)},${(+loc.lon).toFixed(4)}`).then(j => j.features.map(f => f.properties))
    };
    const want = (k, fn) => { if (force || !isFresh(k)) jobs[k] = fn(); };
    want("grid", () => getJSON(pts.grid).then(j => summarizeGrid(j.properties)));
    want("afd", () => latestProduct("AFD", pts.office).then(p => p && { text: p.productText, time: p.issuanceTime }));
    want("hwo", () => latestProduct("HWO", pts.office).then(p => p && { text: p.productText, time: p.issuanceTime }));
    const basin = tropicalBasin(pts);
    if (basin) {
      want("two", () => loadTWO(basin));
      want("hls", () => latestProduct("HLS", pts.office).then(p => p && Date.now() - Date.parse(p.issuanceTime) < 36 * 3600e3 ? { text: p.productText, time: p.issuanceTime } : null));
    } else { S.data.two = null; S.data.hls = null; }
    if (currentTab === "severe") ensureSPC(force);
    await Promise.all(Object.entries(jobs).map(([k, p]) =>
      p.then(v => { if (token !== S.token) return; S.data[k] = v; S.data.at[k] = Date.now(); renderAll(); })
       .catch(e => { if (token !== S.token) return; S.errors[k] = e; console.warn(k, e); })
    ));
    if (token !== S.token) return;
    if (S.data.forecast || S.data.hourly) S.data.updated = Date.now();
    save();
  } catch (e) {
    if (token !== S.token) return;
    S.errors.points = e; console.warn(e);
  }
  done();
}

/* ---------- gridpoint summary: snow, ice, feels-like ---------- */
function isoDurHours(d) {
  const m = /P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(d) || [];
  return (+(m[1] || 0)) * 24 + (+(m[2] || 0)) || 1;
}
function perDay(layer, factor, mode = "sum") {
  const out = {};
  if (!layer || !layer.values) return out;
  for (const { validTime, value } of layer.values) {
    if (value == null) continue;
    const [start, dur] = validTime.split("/");
    const hrs = isoDurHours(dur), t0 = Date.parse(start);
    for (let h = 0; h < hrs; h++) {
      const k = dateKey(t0 + h * 3600e3);
      if (mode === "sum") { if (value) out[k] = (out[k] || 0) + value * factor / hrs; }
      else { const v = factor(value); out[k] = out[k] == null ? v : Math.max(out[k], v); }
    }
  }
  return out;
}
function lenFactor(uom) { return /mm/.test(uom || "") ? 1 / 25.4 : /cm/.test(uom || "") ? 1 / 2.54 : /:m$/.test(uom || "") ? 39.37 : 1 / 25.4; }
const cToF = c => c * 9 / 5 + 32;
function summarizeGrid(p) {
  const sf = p.snowfallAmount, ice = p.iceAccumulation;
  const snow = perDay(sf, lenFactor(sf && sf.uom)), iceD = perDay(ice, lenFactor(ice && ice.uom));
  const tconv = layer => layer && /degF/.test(layer.uom || "") ? (v => v) : cToF;
  const feels = perDay(p.apparentTemperature, tconv(p.apparentTemperature), "max");
  const highs = perDay(p.temperature, tconv(p.temperature), "max");
  const keys = [];
  for (let i = 0; i < 7; i++) keys.push(dateKey(Date.now() + i * 864e5));
  const days = keys.map(k => ({ key: k, snow: snow[k] || 0, ice: iceD[k] || 0, feels: feels[k] ?? null, high: highs[k] ?? null }));
  let snowLevel = null;
  if (p.snowLevel && p.snowLevel.values) {
    const lim = Date.now() + 3 * 864e5;
    const lv = p.snowLevel.values.filter(v => Date.parse(v.validTime.split("/")[0]) < lim && v.value != null).map(v => v.value);
    if (lv.length) snowLevel = Math.round(Math.min(...lv) * 3.281 / 100) * 100;
  }
  const elevFt = p.elevation && p.elevation.value != null ? Math.round(p.elevation.value * 3.281) : null;
  return { days, snowLevel, elevFt };
}

/* ---------- SPC outlook (risk at this location) ---------- */
const SPC_CATS = {
  TSTM: { name: "Thunderstorms", c: "#c1e9c1", r: 1 }, MRGL: { name: "Marginal", c: "#66a366", r: 2 },
  SLGT: { name: "Slight", c: "#f6f67f", r: 3 }, ENH: { name: "Enhanced", c: "#e6c27f", r: 4 },
  MDT: { name: "Moderate", c: "#e67f7f", r: 5 }, HIGH: { name: "High", c: "#ff66ff", r: 6 }
};
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(pt, g) {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some(poly => inRing(pt, poly[0]) && !poly.slice(1).some(h => inRing(pt, h)));
}
async function loadSPC(lat, lon) {
  const pt = [lon, lat], out = {};
  await Promise.all([1, 2, 3].map(async d => {
    try {
      const j = await getDirect("spc", `https://www.spc.noaa.gov/products/outlook/day${d}otlk_cat.nolyr.geojson`);
      let best = null;
      for (const f of j.features || []) {
        const lab = f.properties && f.properties.LABEL, cat = SPC_CATS[lab];
        if (cat && inGeom(pt, f.geometry) && (!best || cat.r > SPC_CATS[best].r)) best = lab;
      }
      out[d] = best || "NONE";
    } catch { out[d] = null; }
  }));
  if (Object.values(out).every(v => v === null)) throw new Error("SPC unavailable");
  return out;
}

let spcLoading = false;
async function ensureSPC(force = false) {
  if (!S.pts || NON_CONUS.has(S.pts.state) || spcLoading || (!force && isFresh("spc"))) return;
  const token = S.token, loc = activeLoc();
  spcLoading = true;
  try {
    const v = await loadSPC(+loc.lat, +loc.lon);
    if (token === S.token) { S.data.spc = v; S.data.at.spc = Date.now(); save(); }
  } catch (e) { if (token === S.token) S.errors.spc = e; }
  spcLoading = false;
  if (token === S.token) { renderSevere(); renderChrome(); }
}

/* ---------- tropical (NHC / CPHC) ---------- */
const ATLANTIC_OFFICES = new Set(["BRO","CRP","HGX","LCH","LIX","MOB","TAE","TBW","MFL","KEY","MLB","JAX","CHS","ILM","MHX","AKQ","LWX","PHI","OKX","BOX","GYX","CAR","SJU"]);
const TROPICAL_RX = /hurricane|tropical storm|storm surge|typhoon|tropical depression/i;
function tropicalBasin(pts) {
  if (!pts) return null;
  if (pts.office === "HFO") return "cpac";
  if (ATLANTIC_OFFICES.has(pts.office)) return "atl";
  if ((S.data.alerts || []).some(a => TROPICAL_RX.test(a.event))) return pts.state === "HI" ? "cpac" : "atl";
  return null;
}
async function loadTWO(basin) {
  const wmo = basin === "cpac" ? "ACPN50" : "ABNT20";
  const list = await getJSON(`${API}/products/types/TWO`);
  const hit = (list["@graph"] || []).find(p => p.wmoCollectiveId === wmo);
  if (!hit) return null;
  const p = await getJSON(hit["@id"]);
  return { text: p.productText, time: p.issuanceTime, basin };
}
const inHurricaneSeason = () => { const m = localMonth(); return m >= 6 && m <= 11; };

/* ---------- seasonal mode ---------- */
const WINTER_RX = /winter|snow|blizzard|ice storm|freez|frost|wind chill|extreme cold|cold weather/i;
const HEAT_RX = /heat|red flag|fire|smoke|air quality|dust|excessive/i;
const SEVERE_RX = /tornado|severe|thunderstorm|flash flood|flood|high wind|special weather|extreme wind/i;
const MODE_INFO = {
  hurricane: { label: "Hurricane", icon: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6"/><path d="M12 9.4c-1-3 1.5-5.6 5.5-5.9-2 1.4-3 3.2-2.9 5.3M14.6 12c3-1 5.6 1.5 5.9 5.5-1.4-2-3.2-3-5.3-2.9M12 14.6c1 3-1.5 5.6-5.5 5.9 2-1.4 3-3.2 2.9-5.3M9.4 12c-3 1-5.6-1.5-5.9-5.5 1.4 2 3.2 3 5.3 2.9"/></svg>` },
  winter: { label: "Winter", icon: `<svg viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5"/></svg>` },
  heat: { label: "Heat & Fire", icon: `<svg viewBox="0 0 24 24"><path d="M10 4.5a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0z"/><path d="M12 9v7"/><path d="M18 4l1.5-1.5M19.5 8H21M18 12l1.5 1.5"/></svg>` },
  outlook: { label: "Outlook", icon: `<svg viewBox="0 0 24 24"><path d="M10 4.5a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0z"/><path d="M12 9v7"/></svg>` }
};
function autoMode() {
  const d = S.data, pts = S.pts, al = d.alerts || [];
  const m = localMonth();
  if (al.some(a => TROPICAL_RX.test(a.event))) return { mode: "hurricane", why: "A tropical alert is in effect here." };
  if (pts && (pts.office === "HFO" || ATLANTIC_OFFICES.has(pts.office)) && inHurricaneSeason())
    return { mode: "hurricane", why: `It's hurricane season (June–November) and ${pts.city || "this location"} is in a hurricane-prone area.` };
  if (al.some(a => WINTER_RX.test(a.event))) return { mode: "winter", why: "A winter weather alert is in effect here." };
  const g = d.grid, lat = activeLoc().lat || 0, elev = g && g.elevFt || 0;
  if (g && g.days.some(x => x.snow >= .05 || x.ice >= .01)) return { mode: "winter", why: "Snow or ice is in the 7-day forecast." };
  if ([11, 12, 1, 2, 3].includes(m) && (lat >= 32 || elev >= 3000)) return { mode: "winter", why: "It's winter here." };
  if ([10, 4, 5].includes(m) && (lat >= 40 || elev >= 4500)) return { mode: "winter", why: "Snow is possible here this time of year." };
  if (al.some(a => HEAT_RX.test(a.event))) return { mode: "heat", why: "A heat or fire weather alert is in effect here." };
  if (m >= 5 && m <= 9) return { mode: "heat", why: "It's the warm season here." };
  return { mode: "outlook", why: "No snow or tropical threats expected. Here's what's ahead." };
}
function seasonMode() {
  const a = autoMode();
  if (seasonOverride && seasonOverride !== a.mode) return { mode: seasonOverride, why: "You picked this view.", auto: a.mode };
  return { ...a, auto: a.mode };
}

/* ---------- shared bits ---------- */
const chev = `<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`;
function sevColor(a) {
  const e = (a.event || "").toLowerCase();
  if (/warning|emergency/.test(e)) return "var(--warn)";
  if (/watch/.test(e)) return "var(--watch)";
  return "var(--advis)";
}
const unwrap = t => String(t || "").split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n");
function alertList(list, emptyMsg) {
  if (!list || !list.length) return emptyMsg ? `<p class="status">${emptyMsg}</p>` : "";
  return `<div class="alerts">${list.map(a => `
    <details class="alert" style="--sev:${sevColor(a)}">
      <summary><div><div class="ev">${esc(a.event)}</div>
        <div class="until">${a.ends || a.expires ? "Until " + esc(fWhen.format(new Date(a.ends || a.expires))) : ""}</div></div>${chev}</summary>
      <div class="body">${a.headline ? `<p style="margin:0 0 6px;font-weight:600">${esc(a.headline)}</p>` : ""}${esc(unwrap(a.description))}${a.instruction ? `<h4>What to do</h4>${esc(unwrap(a.instruction))}` : ""}</div>
    </details>`).join("")}</div>`;
}
function statusLine(key, what) {
  if (S.errors.points && !S.data[key]) return `<p class="status err">${esc(pointsError())}</p>`;
  if (S.errors[key] && !S.data[key]) return `<p class="status err">Couldn't load the ${what} from the National Weather Service. Check your connection, then tap refresh.</p>`;
  if (!S.data[key]) return `<p class="status">Loading the ${what}…</p>`;
  return "";
}
function pointsError() {
  const e = S.errors.points;
  if (!e) return "";
  if (activeLoc().current && geoError && !geo) return geoError;
  if (e.status === 404) return "The National Weather Service only forecasts for the United States and its territories. Pick another location.";
  return "Couldn't reach the National Weather Service. Check your connection, then tap refresh.";
}
function figure(src, alt, caption, link, linkText) {
  return `<div class="card figure"><div class="frame">
      <div class="ph">Loading image…</div>
      <img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" data-fig>
    </div><div class="cap"><span>${caption}</span>${link ? `<a class="btn-link" href="${esc(link)}" target="_blank" rel="noopener">${linkText} ↗</a>` : ""}</div></div>`;
}
function seg(attr, options, current) {
  return `<div class="seg" role="group">${options.map(([v, l]) => `<button data-${attr}="${v}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join("")}</div>`;
}
const isConus = () => S.pts && !NON_CONUS.has(S.pts.state);
const placeName = () => S.pts ? [S.pts.city, S.pts.state].filter(Boolean).join(", ") : (activeLoc().name || "");
const officeShort = () => {
  if (!S.pts) return "";
  const n = (S.pts.officeName || "").split(",")[0];
  return (n.split("/").pop() || S.pts.office || "").trim();
};
const compass = deg => ["N","NE","E","SE","S","SW","W","NW"][Math.round(deg / 45) % 8];
function windChillF(t, v) {
  if (t == null || v == null || t > 50 || v < 3) return null;
  const p = Math.pow(v, 0.16);
  return 35.74 + 0.6215 * t - 35.75 * p + 0.4275 * t * p;
}

/* ---------- 7-day tab ---------- */
const RIDGE = (() => {
  const pts = [[0,40],[18,30],[34,34],[50,20],[60,14],[66,8],[72,12],[80,10],[92,22],[110,26],[130,22],[150,30],[175,24],[200,30],[222,26],[240,34],[262,27],[280,31],[300,28],[320,36],[340,33],[360,38],[380,35],[400,40]];
  return `<svg class="ridge" viewBox="0 0 400 56" preserveAspectRatio="none" aria-hidden="true"><path d="M${pts.map(p => p.join(" ")).join("L")}L400 56L0 56z" fill="var(--ridge)"/></svg>`;
})();
function groupDays(periods) {
  const days = [];
  for (const p of periods) {
    const key = dateKey(p.startTime);
    let d = days.find(x => x.key === key);
    if (!d) { d = { key, day: null, night: null }; days.push(d); }
    if (p.isDaytime) d.day = p; else d.night = p;
  }
  return days;
}
// NWS station names are often ALL CAPS or "Fort Collins-Loveland Municipal Airport"; tidy the caps ones
const titleish = n => /[a-z]/.test(n) ? n : String(n).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
function renderWeek() {
  const el = $("#p-week"), d = S.data;
  const fc = d.forecast, periods = fc && fc.periods || [];
  let html = "";
  if (!locs.length) html += `<div class="card textprod"><h4>Welcome to NWScast</h4><p>You're seeing the National Weather Service forecast for where you are right now. Save up to ${MAX_SAVED} places, like Home or Office, to switch between them with one tap.</p><button class="btn primary" data-open-sheet>Add your locations</button></div>`;
  if (activeLoc().current && geoError) html += `<p class="status err">${esc(geoError)}${geo ? " Showing your last known location." : ""}</p>`;
  const h0 = d.hourly && d.hourly.periods && d.hourly.periods.find(p => Date.parse(p.endTime) > Date.now());
  const o = d.obs && !d.obs.none && fresh(d.obs.time) ? d.obs : null;
  if (o || h0) {
    const fromStation = !!o;
    const temp = o ? Math.round(o.t) : h0.temperature;
    // CSU stations don't report sky conditions, so the sky comes from this hour's forecast
    const desc = (o && o.desc) || (h0 && h0.shortForecast) || "";
    const icon = (o && o.icon) || (h0 && h0.icon);
    const isDay = h0 ? h0.isDaytime : true;
    const wind = o && o.windSpeed != null ? Math.round(o.windSpeed) : null;
    const dir = o && o.windDir != null ? compass(o.windDir) : "";
    const gust = o && o.gustSpeed != null && o.gustSpeed > (o.windSpeed || 0) + 5 ? Math.round(o.gustSpeed) : null;
    const dp = o && o.dewpt != null ? Math.round(o.dewpt) : (h0 && h0.dewpoint && h0.dewpoint.value != null ? Math.round(cToF(h0.dewpoint.value)) : null);
    const feels = o && o.feels != null && Math.abs(o.feels - o.t) >= 2 ? Math.round(o.feels) : null;
    const td = groupDays(periods)[0];
    const mi = o ? o.d / 1.609 : 0;
    const src = fromStation
      ? `Observed ${esc(fTime.format(new Date(o.time)))} at ${esc(titleish(o.name))}, ${mi < 1 ? "under 1" : mi.toFixed(1)} mi away${o.kind === "coag" ? ". Sky from the NWS hourly forecast." : ""}`
      : (d.obs && d.obs.none ? "No weather station within 25 miles and 1,000 ft of this elevation has reported recently, so this is the NWS hourly forecast." : "From the NWS hourly forecast.");
    html += `<div class="card hero">${RIDGE}
      <div class="hero-row">
        <div class="hero-temp num">${temp ?? "–"}<sup>°F</sup></div>
        <div class="hero-icon">${iconSVG(icon, desc, isDay)}</div>
      </div>
      <div class="hero-desc">${esc(desc)}</div>
      <div class="hero-meta num">
        ${td ? `<span>${td.day ? `High <b>${td.day.temperature}°</b>` : ""}${td.day && td.night ? " · " : ""}${td.night ? `Low <b>${td.night.temperature}°</b>` : ""}</span>` : ""}
        ${feels != null ? `<span>Feels like <b>${feels}°</b></span>` : ""}
        ${wind != null ? `<span>Wind <b>${wind ? dir + " " + wind : "Calm"}${gust ? `, gusts ${gust}` : ""}${wind ? " mph" : ""}</b></span>` : (h0 ? `<span>Wind <b>${esc(h0.windDirection)} ${esc(h0.windSpeed)}</b></span>` : "")}
        ${dp != null ? `<span>Dew point <b>${dp}°</b></span>` : ""}
      </div>
      <div class="hero-src">${src}</div>
    </div>`;
  }
  html += alertList(d.alerts);
  html += statusLine("forecast", "7-day forecast");
  if (periods.length) {
    const days = groupDays(periods).slice(0, 8);
    const all = days.flatMap(x => [x.day, x.night]).filter(Boolean).map(p => p.temperature);
    const mn = Math.min(...all), mx = Math.max(...all), span = Math.max(1, mx - mn);
    const H = 230, pad = 26, y = t => pad + (1 - (t - mn) / span) * (H - 2 * pad);
    if (wkSel >= days.length) wkSel = 0;
    const popOf = p => p && p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value || 0;
    const half = (p, isDay) => p
      ? `<span class="wk-ic">${iconSVG(p.icon, p.shortForecast, isDay)}</span><span class="wk-pp ${popOf(p) < 10 ? "dry" : ""}">${popOf(p)}%</span>`
      : `<span class="wk-empty"></span>`;
    const cols = days.map((dy, i) => {
      const main = dy.day || dy.night, when = new Date(main.startTime);
      const hi = dy.day ? dy.day.temperature : null, lo = dy.night ? dy.night.temperature : null;
      const top = y(hi ?? lo), bot = y(lo ?? hi);
      const barH = Math.max(12, bot - top), barTop = hi != null && lo != null ? top : top - 6;
      const name = i === 0 ? (dy.day ? "Today" : "Tonight") : fShortDay.format(when);
      const label = `${fWeekday.format(when)}: ${dy.day ? dy.day.shortForecast + ", high " + hi + "°" : ""}${dy.day && dy.night ? "; " : ""}${dy.night ? "night " + dy.night.shortForecast + ", low " + lo + "°" : ""}`;
      return `<button class="wk-c ${i === 0 ? "today" : ""}" data-wk="${i}" aria-pressed="${i === wkSel}" aria-label="${esc(label)}">
        <span class="wk-dn">${name}</span><span class="wk-dd">${esc(fmtDayNum(when))}</span>
        ${half(dy.day, true)}
        <span class="wk-track">
          ${hi != null ? `<span class="wk-hi" style="top:${barTop - 24}px">${hi}°</span>` : ""}
          <span class="wk-bar" style="top:${barTop}px;height:${barH}px;background:linear-gradient(${tempColor(hi ?? lo)},${tempColor(lo ?? hi)})"></span>
          ${lo != null ? `<span class="wk-lo" style="top:${barTop + barH + 4}px">${lo}°</span>` : ""}
        </span>
        ${half(dy.night, false)}
      </button>`;
    }).join("");
    html += `<h2 class="h2">7-Day Forecast · ${esc(placeName())}</h2>
      <div class="card wk ${days.length > 7 ? "dense" : ""}" style="--n:${days.length}">
        <div class="wk-cols">${cols}</div>
        <div class="wk-detail" id="wk-detail">${wkDetail(days[wkSel])}</div>
      </div>
      <p class="note">Tap a day for the full forecast. Forecast issued ${esc(fLong.format(new Date(fc.updateTime || fc.generatedAt)))}.</p>`;
    el._days = days;
  }
  el.innerHTML = html;
  el.querySelectorAll("[data-open-sheet]").forEach(b => b.addEventListener("click", openSheet));
  el.querySelectorAll("[data-wk]").forEach(b => b.addEventListener("click", () => {
    wkSel = +b.dataset.wk;
    el.querySelectorAll("[data-wk]").forEach(x => x.setAttribute("aria-pressed", x === b));
    $("#wk-detail").innerHTML = wkDetail(el._days[wkSel]);
  }));
}
let wkSel = 0;
const fmtDayNum = d => new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" }).format(d);
function wkDetail(dy) {
  return [dy.day, dy.night].filter(Boolean).map(p => `<p><b>${esc(p.name)}</b>${esc(p.detailedForecast)}</p>`).join("");
}

/* ---------- hourly tab ---------- */
function renderHourly() {
  const el = $("#p-hourly"), hp = S.data.hourly && S.data.hourly.periods || [];
  let html = statusLine("hourly", "hourly forecast");
  const list = hp.filter(p => Date.parse(p.endTime) > Date.now());
  if (list.length) {
    const next = list.slice(0, 48), W = 52, H = 70;
    const temps = next.map(p => p.temperature);
    const mn = Math.min(...temps), sp = Math.max(1, Math.max(...temps) - mn);
    const y = t => 8 + (1 - (t - mn) / sp) * (H - 16);
    const pts = next.map((p, i) => [i * W + W / 2, y(p.temperature)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    const area = line + `L${pts.at(-1)[0]} ${H}L${pts[0][0]} ${H}Z`;
    const total = next.length * W;
    html += `<h2 class="h2">Next 48 hours · ${esc(placeName())}</h2>
    <div class="card strip-wrap"><div class="strip" style="width:${total}px">
      <svg class="line" width="${total}" height="${H}" viewBox="0 0 ${total} ${H}">
        <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
        <path d="${area}" fill="url(#tg)"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>
        ${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="var(--surface)" stroke="var(--accent)" stroke-width="1.8"/>`).join("")}
      </svg>
      <div class="cols">${next.map((p, i) => {
        const pop = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value || 0;
        const newDay = i > 0 && dateKey(p.startTime) !== dateKey(next[i - 1].startTime);
        return `<div class="col">
          <span class="daylabel">${newDay ? esc(fShortDay.format(new Date(p.startTime))) : ""}</span>
          <span class="t ${i === 0 ? "now" : ""}">${i === 0 ? "Now" : hourLabel(p.startTime)}</span>
          <span class="ic">${iconSVG(p.icon, p.shortForecast, p.isDaytime)}</span>
          <span class="sp"></span>
          <span class="tp num">${p.temperature}°</span>
          <span class="pp num">${pop ? pop + "%" : ""}</span>
          <span class="bar"><i style="height:${pop}%"></i></span>
        </div>`;
      }).join("")}</div>
    </div></div>
    <p class="note">Line shows temperature; blue bars show the chance of precipitation. Times are local to ${esc(placeName() || "this location")}.</p>`;
    const groups = [];
    for (const p of list) {
      const k = dateKey(p.startTime);
      let g = groups.at(-1);
      if (!g || g.k !== k) { g = { k, items: [] }; groups.push(g); }
      g.items.push(p);
    }
    html += `<h2 class="h2">Hour by hour</h2><div class="card hours">${groups.map(g => `
      <div class="hgroup-h">${esc(fWeekday.format(new Date(g.items[0].startTime)))}</div>
      ${g.items.map(p => {
        const pop = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value || 0;
        return `<div class="hrow">
          <span class="ti num">${esc(fHour.format(new Date(p.startTime)))}</span>
          <span class="ic">${iconSVG(p.icon, p.shortForecast, p.isDaytime)}</span>
          <span class="sf">${esc(p.shortForecast)}<small>${esc(p.windDirection)} ${esc(p.windSpeed)}${p.dewpoint && p.dewpoint.value != null ? ` · Dew pt ${Math.round(cToF(p.dewpoint.value))}°` : ""}</small></span>
          <span class="pp num">${pop ? pop + "%" : ""}</span>
          <span class="tp num">${p.temperature}°</span>
        </div>`;
      }).join("")}`).join("")}</div>`;
  }
  el.innerHTML = html;
}

/* ---------- radar tab ---------- */
const RADAR_ALT = { KFTG: "KCYS", KCYS: "KFTG" };
const RADAR_NAMES = { KFTG: "Denver", KCYS: "Cheyenne" };
function renderRadar() {
  const el = $("#p-radar");
  if (!S.pts) { el.innerHTML = statusLine("forecast", "radar"); return; }
  const site = radarSite || S.pts.radar, t = Math.floor(Date.now() / 120000);
  const alt = RADAR_ALT[S.pts.radar];
  let html = "";
  if (alt) html += seg("site", [[S.pts.radar, `${RADAR_NAMES[S.pts.radar] || ""} (${S.pts.radar})`], [alt, `${RADAR_NAMES[alt] || ""} (${alt})`]], site);
  html += figure(`https://radar.weather.gov/ridge/standard/${site}_loop.gif?t=${t}`, `${site} radar loop`,
    `Nearest radar to ${esc(placeName())}: ${site}. Loop of the last hour.`, `https://radar.weather.gov/station/${site.toLowerCase()}/standard`, "Interactive radar");
  if (isConus()) html += figure(`https://radar.weather.gov/ridge/standard/CONUS-LARGE_loop.gif?t=${t}`, "National radar loop", "National mosaic", "https://radar.weather.gov/", "Full map");
  html += `<p class="note">Radar images refresh every couple of minutes. Tap refresh at the top for the newest loop.</p>`;
  el.innerHTML = html;
  el.querySelectorAll("[data-site]").forEach(b => b.addEventListener("click", () => { radarSite = b.dataset.site; renderRadar(); }));
}

/* ---------- forecast discussion tab ---------- */
function titleCase(s) {
  const keep = /^(BOU|NWS|CO|UTC|NHC|CPHC|TAF|TAFS|VFR|MVFR|IFR)$/;
  return s.toLowerCase().replace(/\b[a-z]+/g, w => keep.test(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
}
function parseAFD(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = { issued: "", sections: [], authors: "" };
  const secRx = /^\.([A-Z][A-Z0-9 \/&\-]*?)\s*(\/[^/]*\/)?\s*\.\.\.(.*)$/;
  let cur = null, after$$ = false, authors = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!out.issued && /^\d{3,4} (AM|PM) [A-Z]{3,4} /.test(line)) { out.issued = line; continue; }
    if (after$$) { if (line.trim()) authors.push(line.trim()); continue; }
    if (line.startsWith("$$")) { after$$ = true; cur = null; continue; }
    if (line.trim() === "&&") { cur = null; continue; }
    const m = secRx.exec(line);
    if (m) {
      cur = { title: titleCase(m[1]), issued: (m[2] || "").replace(/\//g, "").replace(/^Issued\s*/i, "").trim(), lines: [] };
      if (m[3].trim()) cur.lines.push(m[3].trim());
      out.sections.push(cur); continue;
    }
    if (cur) cur.lines.push(line);
  }
  out.authors = authors.join("\n");
  return out;
}
function bodyHTML(lines) {
  const paras = lines.join("\n").split(/\n\s*\n/).map(p => p.replace(/^\n+|\n+$/g, "")).filter(p => p.trim());
  return paras.map(p => {
    const ls = p.split("\n");
    if (/^\s*[-*]\s/.test(ls[0]) && ls.every(l => /^\s*[-*]\s|^\s{2,}\S/.test(l))) {
      const items = [];
      for (const l of ls) { if (/^\s*[-*]\s/.test(l)) items.push(l.replace(/^\s*[-*]\s+/, "")); else items[items.length - 1] += " " + l.trim(); }
      return `<ul>${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>`;
    }
    if (ls.filter(l => / {3,}\S/.test(l.trim())).length >= 2) return `<pre>${esc(p)}</pre>`;
    return `<p>${esc(ls.map(l => l.trim()).join(" "))}</p>`;
  }).join("");
}
function renderAFD() {
  const el = $("#p-afd"), a = S.data.afd;
  let html = statusLine("afd", "forecast discussion");
  if (a) {
    const p = parseAFD(a.text), office = S.pts ? S.pts.office : "";
    html += `<div><h2 class="h2">Area Forecast Discussion</h2>
      <div class="afd-meta">NWS ${esc(S.pts && S.pts.officeName || office)} · ${esc(p.issued || fLong.format(new Date(a.time)))}</div></div>
      ${p.sections.length ? p.sections.map((s, i) => `
        <details class="card afd-sec" ${i < 2 || /key/i.test(s.title) ? "open" : ""}>
          <summary><span class="tt">${esc(s.title)}</span>${s.issued ? `<span class="is">${esc(s.issued)}</span>` : ""}${chev}</summary>
          <div class="afd-body">${bodyHTML(s.lines)}</div>
        </details>`).join("")
        : `<div class="card afd-sec"><div class="afd-body"><pre>${esc(a.text)}</pre></div></div>`}
      ${p.authors ? `<div class="afd-authors">${esc(p.authors)}</div>` : ""}
      <a class="btn-link" href="https://forecast.weather.gov/product.php?site=${office}&issuedby=${office}&product=AFD" target="_blank" rel="noopener">Read on weather.gov ↗</a>`;
  }
  el.innerHTML = html;
}

/* ---------- text products (HWO, HLS, TWO) ---------- */
function textProductHTML(prod, cityHint) {
  const segs = String(prod.text).replace(/\r/g, "").split(/\n\$\$\s*\n/);
  const seg = (cityHint && segs.find(s => s.toLowerCase().includes(cityHint.toLowerCase()))) || segs[0] || "";
  const sl = seg.split("\n");
  let start = sl.findIndex(l => /^(This Hazardous Weather Outlook|For the North Atlantic|For the Central North Pacific|\.?(DAY ONE|NEW INFORMATION|SITUATION OVERVIEW)\b)/i.test(l.trim().replace(/^\*\s*/, "")));
  if (start < 0) {
    const iss = sl.findIndex(l => /^\d{3,4} (AM|PM) [A-Z]{3,4} /.test(l));
    start = iss >= 0 ? iss + 1 : 0;
  }
  let html = `<p class="afd-meta">Issued ${esc(fLong.format(new Date(prod.time)))}</p>`;
  for (const para of sl.slice(start).join("\n").split(/\n\s*\n/)) {
    const t = para.trim();
    if (!t || /^\$\$|^&&$|^[A-Z]{3}\d{3}[->]/.test(t)) continue;
    const m = /^\*?\s*\.?([A-Z][A-Z0-9 ,'\/\-]+?)\.\.\.\s*([\s\S]*)$/.exec(t);
    if (m && m[1].length < 60) {
      html += `<h4>${esc(titleCase(m[1]))}</h4>`;
      if (m[2].trim()) html += `<p>${esc(m[2].replace(/\s*\n\s*/g, " "))}</p>`;
    } else html += `<p>${esc(t.replace(/\s*\n\s*/g, " "))}</p>`;
  }
  return html;
}

/* ---------- seasonal tab ---------- */
function renderSeason() {
  const el = $("#p-season"), sm = seasonMode(), info = MODE_INFO[sm.mode];
  const modes = [["hurricane", "Hurricane"], ["winter", "Winter"], [["heat", "outlook"].includes(sm.auto) ? sm.auto : (localMonth() >= 5 && localMonth() <= 9 ? "heat" : "outlook"), "Heat & Fire"]];
  let html = `<div class="card season-why">${info.icon}<div><b>${info.label}</b><span>${esc(sm.why)}</span></div></div>`;
  html += seg("mode", modes.map(([v, l]) => [v, (v === "outlook" ? "Outlook" : l) + (v === sm.auto ? " •" : "")]), sm.mode);
  if (sm.mode === "hurricane") html += hurricaneHTML();
  else if (sm.mode === "winter") html += winterHTML();
  else html += heatHTML();
  html += `<p class="note">The dot marks the view chosen automatically for ${esc(placeName() || "this location")} and season.</p>`;
  el.innerHTML = html;
  el.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {
    seasonOverride = b.dataset.mode === sm.auto ? null : b.dataset.mode; renderSeason(); renderChrome();
  }));
  el.querySelectorAll("[data-wpc]").forEach(b => b.addEventListener("click", () => { wpcDay = +b.dataset.wpc; renderSeason(); }));
  el.querySelectorAll("[data-nhc]").forEach(b => b.addEventListener("click", () => { nhcDays = +b.dataset.nhc; renderSeason(); }));
  el.querySelectorAll("[data-cpc]").forEach(b => b.addEventListener("click", () => { cpcRange = b.dataset.cpc; renderSeason(); }));
  el.querySelectorAll("[data-fire]").forEach(b => b.addEventListener("click", () => { fireDay = +b.dataset.fire; renderSeason(); }));
}
function hurricaneHTML() {
  const d = S.data, al = (d.alerts || []).filter(a => TROPICAL_RX.test(a.event));
  const basin = (d.two && d.two.basin) || (S.pts && S.pts.office === "HFO" ? "cpac" : "atl");
  const basinName = basin === "cpac" ? "Central Pacific" : "Atlantic";
  const t = Math.floor(Date.now() / 6e5);
  let html = `<h2 class="h2">Tropical alerts</h2>` + alertList(al, d.alerts ? `No hurricane or tropical storm alerts for ${esc(placeName())} right now.` : "Checking for alerts…");
  if (d.hls) html += `<details class="card afd-sec" open><summary><span class="tt">Hurricane Local Statement</span>${chev}</summary><div class="textprod">${textProductHTML(d.hls)}</div></details>`;
  html += `<h2 class="h2">${basin === "cpac" ? "Central Pacific Hurricane Center" : "National Hurricane Center"} outlook</h2>
    ${seg("nhc", [[2, "Next 2 days"], [7, "Next 7 days"]], nhcDays)}
    ${figure(`https://www.nhc.noaa.gov/xgtwo/resize/xgtwo_${basin}_${nhcDays}d0_w1024.png?t=${t}`, `${basinName} ${nhcDays}-day tropical weather outlook`,
      `${basinName} areas to watch, next ${nhcDays} days`, basin === "cpac" ? "https://www.nhc.noaa.gov/cphc/" : "https://www.nhc.noaa.gov/", basin === "cpac" ? "CPHC" : "NHC")}`;
  if (d.two) html += `<h2 class="h2">Tropical Weather Outlook</h2><div class="card textprod">${textProductHTML(d.two)}</div>`;
  else if (S.errors.two) html += `<p class="status">The written tropical outlook isn't available right now. The map above shows the latest.</p>`;
  if (!inHurricaneSeason()) html += `<p class="note">Hurricane season runs June 1 through November 30.</p>`;
  return html;
}
function winterHTML() {
  const d = S.data, wAlerts = (d.alerts || []).filter(a => WINTER_RX.test(a.event));
  let html = `<h2 class="h2">Winter alerts</h2>` + alertList(wAlerts, d.alerts ? `No winter weather alerts for ${esc(placeName())} right now.` : "Checking for alerts…");
  html += `<h2 class="h2">Snowfall, next 7 days · ${esc(placeName())}</h2>`;
  if (d.grid) {
    const days = d.grid.days, tot = days.reduce((s, x) => s + x.snow, 0), ice = days.reduce((s, x) => s + x.ice, 0);
    const maxDay = days.reduce((m, x) => x.snow > m.snow ? x : m, days[0]);
    html += `<div class="stat-row">
      <div class="card stat"><div class="k">7-day total</div><div class="v num">${fmtIn(tot)}<small>in</small></div><div class="d">${tot < .05 ? "No accumulating snow forecast" : "Snow forecast here"}</div></div>
      <div class="card stat"><div class="k">${ice >= .01 ? "Ice" : "Snowiest day"}</div><div class="v num">${ice >= .01 ? fmtIn(ice) + "<small>in</small>" : (maxDay.snow >= .05 ? esc(fShortDay.format(noonOf(maxDay.key))) : "—")}</div><div class="d">${ice >= .01 ? "Ice accumulation forecast" : (maxDay.snow >= .05 ? fmtIn(maxDay.snow) + " in expected" : "Nothing to measure")}</div></div>
      ${d.grid.snowLevel != null ? `<div class="card stat"><div class="k">Lowest snow level</div><div class="v num">${d.grid.snowLevel.toLocaleString()}<small>ft</small></div><div class="d">Next 3 days${d.grid.elevFt ? ` · you're at ~${(Math.round(d.grid.elevFt / 100) * 100).toLocaleString()} ft` : ""}</div></div>` : ""}
    </div>
    <div class="card chart">${barChart(days.map(x => x.snow), days, { unit: '"', color: "var(--snow)", stroke: "var(--rain)", fmt: fmtIn, label: "Daily snowfall forecast in inches", minTop: 1 })}</div>`;
  } else html += statusLine("grid", "snowfall forecast");
  const snowy = (d.forecast && d.forecast.periods || []).filter(p => /snow|flurr|blizzard|sleet|freezing/i.test(p.detailedForecast));
  if (snowy.length) html += `<h2 class="h2">Forecast periods with snow or ice</h2><div class="card textprod">${snowy.map(p => `<p><b>${esc(p.name)}:</b> ${esc(p.detailedForecast)}</p>`).join("")}</div>`;
  if (isConus()) {
    html += `<h2 class="h2">Weather Prediction Center outlook</h2>
      ${seg("wpc", [[1, "Day 1"], [2, "Day 2"], [3, "Day 3"]], wpcDay)}
      ${figure(`https://www.wpc.ncep.noaa.gov/wwd/day${wpcDay}_psnow_gt_04_conus.gif?t=${Math.floor(Date.now() / 6e5)}`, `Day ${wpcDay} probability of 4 inches or more of snow`,
        `Chance of 4"+ of snow, Day ${wpcDay}`, "https://www.wpc.ncep.noaa.gov/wwd/winter_wx.shtml", "WPC winter")}
      <a class="btn-link" href="https://www.wpc.ncep.noaa.gov/wwd/wssi/wssi.php" target="_blank" rel="noopener">Winter Storm Severity Index ↗</a>`;
  }
  return html;
}
function heatHTML() {
  const d = S.data, hAlerts = (d.alerts || []).filter(a => HEAT_RX.test(a.event));
  let html = `<h2 class="h2">Heat &amp; fire alerts</h2>` + alertList(hAlerts, d.alerts ? `No heat or fire weather alerts for ${esc(placeName())} right now.` : "Checking for alerts…");
  html += `<h2 class="h2">Feels-like highs, next 7 days · ${esc(placeName())}</h2>`;
  if (d.grid && d.grid.days.some(x => x.feels != null)) {
    const days = d.grid.days, vals = days.map(x => x.feels ?? x.high ?? null), known = vals.filter(v => v != null);
    const peak = days.reduce((m, x) => (x.feels ?? -999) > (m.feels ?? -999) ? x : m, days[0]);
    html += `<div class="stat-row">
      <div class="card stat"><div class="k">Hottest feels-like</div><div class="v num">${Math.round(peak.feels)}<small>°F</small></div><div class="d">${esc(fWeekday.format(noonOf(peak.key)))}</div></div>
      <div class="card stat"><div class="k">Heat concern</div><div class="v" style="font-size:24px;padding-top:6px">${heatWord(peak.feels)}</div><div class="d">Based on the NWS heat index scale</div></div>
    </div>
    <div class="card chart">${barChart(vals, days, { unit: "°", colorFn: tempColor, fmt: v => Math.round(v), label: "Daily feels-like high temperature", floor: Math.min(...known) - 10 })}</div>`;
  } else html += statusLine("grid", "temperature forecast");
  if (isConus()) {
    html += `<h2 class="h2">Fire weather outlook</h2>
      ${seg("fire", [[1, "Day 1"], [2, "Day 2"]], fireDay)}
      ${figure(`https://www.spc.noaa.gov/products/fire_wx/day${fireDay}otlk_fire.gif?t=${Math.floor(Date.now() / 6e5)}`, `SPC Day ${fireDay} fire weather outlook`,
        `Storm Prediction Center, Day ${fireDay}`, "https://www.spc.noaa.gov/products/fire_wx/", "Details")}`;
  }
  const cpc = cpcRange === "610" ? "610day/610" : "814day/814";
  html += `<h2 class="h2">Climate Prediction Center outlook</h2>
    ${seg("cpc", [["610", "6–10 days"], ["814", "8–14 days"]], cpcRange)}
    ${figure(`https://www.cpc.ncep.noaa.gov/products/predictions/${cpc}temp.new.gif?t=${Math.floor(Date.now() / 36e5)}`, "Temperature outlook", "Chance of above or below normal temperature",
      `https://www.cpc.ncep.noaa.gov/products/predictions/${cpcRange}day/`, "CPC")}
    ${figure(`https://www.cpc.ncep.noaa.gov/products/predictions/${cpc}prcp.new.gif?t=${Math.floor(Date.now() / 36e5)}`, "Precipitation outlook", "Chance of above or below normal precipitation")}`;
  return html;
}
function heatWord(f) {
  if (f == null) return "—";
  if (f >= 125) return "Extreme danger";
  if (f >= 103) return "Danger";
  if (f >= 90) return "Extreme caution";
  if (f >= 80) return "Caution";
  return "Low";
}
const fmtIn = v => v < .05 ? "0" : v < 10 ? v.toFixed(1) : Math.round(v).toString();
function barChart(vals, days, o) {
  const W = 340, H = 150, padL = 32, padB = 26, padT = 18;
  const floor = o.floor != null ? Math.floor(o.floor / 10) * 10 : 0;
  let mx = Math.max(o.minTop || 0, ...vals.filter(v => v != null));
  const step = mx - floor <= 1 ? 0.5 : mx - floor <= 2 ? 1 : mx - floor <= 4 ? 2 : mx - floor <= 8 ? 4 : mx - floor <= 40 ? 10 : 20;
  const top = floor + Math.ceil((mx - floor) / step) * step || floor + step;
  const bw = (W - padL - 8) / days.length;
  const y = v => padT + (1 - (v - floor) / (top - floor)) * (H - padT - padB);
  const ticks = [];
  for (let t = floor; t <= top + 1e-9; t += step) ticks.push(+t.toFixed(2));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}">
    ${ticks.map(t => `<line x1="${padL}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/>
      <text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${t}${o.unit}</text>`).join("")}
    ${days.map((d, i) => {
      const v = vals[i], x = padL + 4 + i * bw, lab = i === 0 ? "Today" : fShortDay.format(noonOf(d.key));
      if (v == null) return `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${lab}</text>`;
      const h = Math.max(0, y(floor) - y(Math.max(floor, v)));
      const fill = o.colorFn ? o.colorFn(v) : o.color;
      const show = o.colorFn ? true : v >= .05;
      return `<rect x="${x + bw * .18}" y="${y(floor) - h}" width="${bw * .64}" height="${h}" rx="4" fill="${fill}" ${o.stroke ? `stroke="${o.stroke}" stroke-width="1"` : ""}/>
        ${show ? `<text x="${x + bw / 2}" y="${y(floor) - h - 5}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink)">${o.fmt(v)}${o.unit}</text>` : ""}
        <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${lab}</text>`;
    }).join("")}
  </svg>`;
}

/* ---------- severe tab ---------- */
function renderSevere() {
  const el = $("#p-severe"), d = S.data;
  const sAlerts = (d.alerts || []).filter(a => SEVERE_RX.test(a.event) && !WINTER_RX.test(a.event) && !TROPICAL_RX.test(a.event));
  let html = `<h2 class="h2">Severe weather alerts</h2>` + alertList(sAlerts, d.alerts ? `No severe weather alerts for ${esc(placeName())} right now.` : "Checking for alerts…");
  if (S.pts && !isConus()) {
    html += `<p class="status">Storm Prediction Center outlooks cover the lower 48 states only. Alerts above still apply here.</p>`;
  } else {
    html += `<h2 class="h2">Storm Prediction Center risk · ${esc(placeName())}</h2>`;
    if (d.spc) {
      html += `<div class="risk-row">${[1, 2, 3].map(n => {
        const v = d.spc[n], c = SPC_CATS[v];
        const lab = n === 1 ? "Today" : n === 2 ? "Tomorrow" : fShortDay.format(new Date(Date.now() + 2 * 864e5));
        return `<div class="risk"><div class="k">${lab}</div>${c ? `<span class="chip2" style="--chip:${c.c}">${c.name}</span>` : `<span class="chip2 none">${v === "NONE" ? "No risk" : "—"}</span>`}</div>`;
      }).join("")}</div>`;
    } else if (S.errors.spc) html += `<p class="status">The risk summary isn't available right now. The outlook maps below show the latest.</p>`;
    else html += `<p class="status">Checking the outlook…</p>`;
    html += seg("spc", [[1, "Day 1"], [2, "Day 2"], [3, "Day 3"]], spcDay) +
      figure(`https://www.spc.noaa.gov/products/outlook/day${spcDay}otlk.gif?t=${Math.floor(Date.now() / 6e5)}`, `SPC Day ${spcDay} convective outlook`,
        `SPC Day ${spcDay} convective outlook`, `https://www.spc.noaa.gov/products/outlook/day${spcDay}otlk.html`, "Details") +
      `<div class="legend">${Object.values(SPC_CATS).map(c => `<span><i style="background:${c.c}"></i>${c.name}</span>`).join("")}</div>`;
  }
  html += `<h2 class="h2">Hazardous Weather Outlook · NWS ${esc(officeShort())}</h2>`;
  if (d.hwo) html += `<div class="card textprod">${textProductHTML(d.hwo, S.pts && S.pts.city)}</div>`;
  else html += statusLine("hwo", "hazardous weather outlook");
  el.innerHTML = html;
  el.querySelectorAll("[data-spc]").forEach(b => b.addEventListener("click", () => { spcDay = +b.dataset.spc; renderSevere(); }));
}

/* ---------- header, chips, tabs ---------- */
const PIN = `<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>`;
const NAV = `<svg viewBox="0 0 24 24"><path d="M3 11l18-8-8 18-2-8z"/></svg>`;
function renderChips() {
  const chips = [`<button class="chip" data-loc="current" aria-pressed="${activeId === "current"}">${NAV}<span>Current</span></button>`]
    .concat(locs.map(l => `<button class="chip" data-loc="${esc(l.id)}" aria-pressed="${activeId === l.id}"><span>${esc(l.label)}</span></button>`))
    .concat(`<button class="chip ghost" id="manage">${PIN}<span>${locs.length < MAX_SAVED ? "Add / edit" : "Edit"}</span></button>`);
  $("#chips").innerHTML = chips.join("");
  $("#chips").querySelectorAll("[data-loc]").forEach(b => b.addEventListener("click", () => switchTo(b.dataset.loc)));
  $("#manage").addEventListener("click", openSheet);
}
function renderChrome() {
  const d = S.data, al = d.alerts || [];
  const sm = seasonMode();
  $("#season-label").textContent = MODE_INFO[sm.mode].label === "Heat & Fire" ? "Heat" : MODE_INFO[sm.mode].label;
  $("#season-icon").innerHTML = MODE_INFO[sm.mode].icon;
  const rx = sm.mode === "hurricane" ? TROPICAL_RX : sm.mode === "winter" ? WINTER_RX : HEAT_RX;
  const snowSoon = sm.mode === "winter" && d.grid && d.grid.days.slice(0, 3).some(x => x.snow >= .5);
  $("#dot-season").hidden = !(al.some(a => rx.test(a.event)) || snowSoon);
  const spcRisk = d.spc && [1, 2].some(n => SPC_CATS[d.spc[n]] && SPC_CATS[d.spc[n]].r >= 2);
  $("#dot-severe").hidden = !(al.some(a => SEVERE_RX.test(a.event) && !WINTER_RX.test(a.event) && !TROPICAL_RX.test(a.event)) || spcRisk);
  const short = officeShort();
  const l = activeLoc();
  let sub = (l.current ? "Near " : "") + (placeName() || (l.current ? "your location" : l.name));
  if (short) sub += " · NWS " + short;
  if (S.loading) sub += " · updating…";
  else if (d.updated) sub += " · " + fTime.format(new Date(d.updated));
  $("#sub").textContent = sub;
  document.documentElement.style.setProperty("--topbar-h", $("#topbar").offsetHeight + "px");
}
const RENDER = { week: renderWeek, hourly: renderHourly, radar: renderRadar, afd: renderAFD, season: renderSeason, severe: renderSevere };
function renderAll() {
  renderChrome();
  for (const [k, fn] of Object.entries(RENDER)) {
    if (k === "radar" && currentTab !== "radar") continue;   // radar loops are large; only load them when viewed
    fn();
  }
}
function showTab(tab) {
  if (!RENDER[tab]) tab = "week";
  currentTab = tab; store.set("nwsb.tab", tab);
  document.querySelectorAll(".panel").forEach(p => p.hidden = p.dataset.tab !== tab);
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.tab === tab));
  if (tab === "radar") renderRadar();
  if (tab === "severe") ensureSPC();
  window.scrollTo(0, 0);
}
function switchTo(id) {
  if (id === activeId && !S.errors.points) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  activeId = id; store.set("nwsb.active", id);
  seasonOverride = null; radarSite = null; geoError = ""; wkSel = 0;
  restore(); renderChips(); renderAll(); window.scrollTo(0, 0);
  loadAll();
}

/* ---------- locations sheet ---------- */
const LABEL_SUGG = ["Home", "Office", "Vacation home", "Family", "Cabin", "Airport"];
const STATE_ABBR = {"Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT","Delaware":"DE","District of Columbia":"DC","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY","Puerto Rico":"PR","United States Virgin Islands":"VI","Guam":"GU","American Samoa":"AS","Northern Mariana Islands":"MP"};
let form = null;   // { id|null, label, place|null, query, results, searching, error }
function openSheet() { form = null; $("#scrim").hidden = false; $("#sheet").hidden = false; document.body.classList.add("sheet-open"); renderSheet(); }
function closeSheet() { $("#scrim").hidden = true; $("#sheet").hidden = true; document.body.classList.remove("sheet-open"); form = null; }
$("#scrim").addEventListener("click", closeSheet);
function renderSheet() {
  const sh = $("#sheet");
  if (!form) {
    sh.innerHTML = `<div class="grab"></div>
      <div class="sheet-h"><h3 id="sheet-title">Locations</h3><button class="btn" id="sh-done">Done</button></div>
      <div class="card loclist">
        <div class="locrow"><button class="pick" data-pick="current"><span class="radio ${activeId === "current" ? "on" : ""}"></span>
          <span class="lt"><b>Current location</b><span>${geo && geo.name ? "Last seen near " + esc(geo.name) : "Uses your iPhone's location"}</span></span></button></div>
        ${locs.map(l => `<div class="locrow"><button class="pick" data-pick="${esc(l.id)}"><span class="radio ${activeId === l.id ? "on" : ""}"></span>
          <span class="lt"><b>${esc(l.label)}</b><span>${esc(l.name)}${l.detail ? " · " + esc(l.detail) : ""}</span></span></button>
          <button class="edit" data-edit="${esc(l.id)}">Edit</button></div>`).join("")}
      </div>
      <button class="btn primary" id="sh-add" ${locs.length >= MAX_SAVED ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add a location</button>
      <p class="fine">${locs.length} of ${MAX_SAVED} saved. Saved locations stay on this phone.${locs.length >= MAX_SAVED ? " Delete one to add another." : ""}</p>`;
    $("#sh-done").addEventListener("click", closeSheet);
    $("#sh-add").addEventListener("click", () => { form = { id: null, label: "", place: null, query: "", results: [], searching: false, error: "" }; renderSheet(); });
    sh.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => { closeSheet(); switchTo(b.dataset.pick); }));
    sh.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
      const l = locs.find(x => x.id === b.dataset.edit);
      form = { id: l.id, label: l.label, place: { name: l.name, detail: l.detail || "", lat: l.lat, lon: l.lon }, query: "", results: [], searching: false, error: "" };
      renderSheet();
    }));
    return;
  }
  const f = form;
  sh.innerHTML = `<div class="grab"></div>
    <div class="sheet-h"><h3 id="sheet-title">${f.id ? "Edit location" : "Add a location"}</h3><button class="btn" id="sh-back">Cancel</button></div>
    <div class="card form">
      <div class="field"><label for="f-label">Label</label>
        <input class="input" id="f-label" maxlength="24" placeholder="Home, Office, Vacation home…" value="${esc(f.label)}" autocomplete="off">
        <div class="sugg">${LABEL_SUGG.map(s => `<button type="button" data-sugg="${esc(s)}">${esc(s)}</button>`).join("")}</div>
      </div>
      <div class="field"><label for="f-q">Place</label>
        ${f.place ? `<div class="chosen">Selected: <b>${esc(f.place.name)}</b>${f.place.detail ? " · " + esc(f.place.detail) : ""}</div>` : ""}
        <form class="searchrow" id="f-search"><input class="input" id="f-q" type="search" placeholder="Address, city, or ZIP code" value="${esc(f.query)}" autocomplete="off" enterkeyhint="search">
          <button class="btn" type="submit" ${f.searching ? "disabled" : ""}>${f.searching ? "Searching…" : "Search"}</button></form>
        <button class="btn" type="button" id="f-here"><svg viewBox="0 0 24 24"><path d="M3 11l18-8-8 18-2-8z"/></svg>Use where I am now</button>
        ${f.error ? `<p class="status err">${esc(f.error)}</p>` : ""}
        ${f.results.length ? `<div class="results">${f.results.map((r, i) => `<button type="button" data-res="${i}" aria-pressed="${!!(f.place && f.place.lat === r.lat && f.place.lon === r.lon)}"><b>${esc(r.name)}</b><span>${esc(r.detail || r.full)}</span></button>`).join("")}</div>` : ""}
      </div>
      <div class="form-actions">
        <button class="btn primary" id="f-save" ${f.place && f.label.trim() ? "" : "disabled"}>Save</button>
        ${f.id ? `<button class="btn danger" id="f-del">Delete</button>` : ""}
      </div>
      <p class="fine">Searches are looked up with OpenStreetMap. Your saved locations are stored only on this phone.</p>
    </div>`;
  const lab = $("#f-label"), q = $("#f-q");
  lab.addEventListener("input", () => { f.label = lab.value; $("#f-save").disabled = !(f.place && f.label.trim()); });
  q.addEventListener("input", () => { f.query = q.value; });
  sh.querySelectorAll("[data-sugg]").forEach(b => b.addEventListener("click", () => { f.label = b.dataset.sugg; lab.value = f.label; $("#f-save").disabled = !(f.place && f.label.trim()); }));
  $("#f-search").addEventListener("submit", e => { e.preventDefault(); q.blur(); searchPlaces(); });
  $("#f-here").addEventListener("click", useHere);
  sh.querySelectorAll("[data-res]").forEach(b => b.addEventListener("click", () => { f.place = f.results[+b.dataset.res]; renderSheet(); }));
  $("#sh-back").addEventListener("click", () => { form = null; renderSheet(); });
  $("#f-save").addEventListener("click", saveForm);
  if (f.id) $("#f-del").addEventListener("click", () => {
    if (!f.confirmDel) { f.confirmDel = true; $("#f-del").textContent = "Tap again to delete"; return; }
    locs = locs.filter(l => l.id !== f.id); store.set("nwsb.locs", locs);
    if (activeId === f.id) { activeId = locs[0] ? locs[0].id : "current"; store.set("nwsb.active", activeId); restore(); loadAll(); }
    form = null; renderChips(); renderAll(); renderSheet();
  });
}
async function searchPlaces() {
  const f = form, qv = (f.query || "").trim();
  if (!qv) return;
  f.searching = true; f.error = ""; f.results = []; renderSheet();
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=us,pr,vi,gu,as,mp&q=${encodeURIComponent(qv)}`;
    const r = await fetch(url, { headers: { "Accept-Language": "en-US" } });
    if (!r.ok) throw new Error();
    const j = await r.json();
    f.results = j.map(x => {
      const a = x.address || {};
      const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || x.name || "";
      const st = STATE_ABBR[a.state] || a.state || "";
      const street = [a.house_number, a.road].filter(Boolean).join(" ");
      return { name: [town, st].filter(Boolean).join(", "), detail: street, full: x.display_name, lat: +(+x.lat).toFixed(4), lon: +(+x.lon).toFixed(4) };
    });
    if (!f.results.length) f.error = "No matches. Try a city and state, like “Miami, FL”, or a ZIP code.";
    if (f.results.length === 1) f.place = f.results[0];
  } catch { f.error = "Search isn't working right now. Check your connection and try again."; }
  f.searching = false;
  if (form === f) renderSheet();
}
async function useHere() {
  const f = form;
  f.error = ""; f.searching = true; renderSheet();
  try {
    const pos = await geolocate();
    let name = "My location";
    try { const pts = await getPoints(pos.lat, pos.lon); name = [pts.city, pts.state].filter(Boolean).join(", ") || name; } catch {}
    f.place = { name, detail: "", lat: +pos.lat.toFixed(4), lon: +pos.lon.toFixed(4) };
    f.results = [];
  } catch (e) { f.error = e.message; }
  f.searching = false;
  if (form === f) renderSheet();
}
function saveForm() {
  const f = form;
  if (!f.place || !f.label.trim()) return;
  const rec = { id: f.id || ("l" + Date.now().toString(36)), label: f.label.trim().slice(0, 24), name: f.place.name, detail: f.place.detail || "", lat: f.place.lat, lon: f.place.lon };
  if (f.id) locs = locs.map(l => l.id === f.id ? rec : l);
  else { if (locs.length >= MAX_SAVED) return; locs.push(rec); }
  store.set("nwsb.locs", locs);
  form = null; renderChips();
  if (activeId === rec.id) { restore(); renderAll(); loadAll(); } else renderAll();   // also clears the welcome prompt
  renderSheet();
}

/* ---------- boot ---------- */
document.addEventListener("load", e => { if (e.target.matches && e.target.matches("img[data-fig]")) e.target.previousElementSibling.hidden = true; }, true);
document.addEventListener("error", e => {
  if (e.target.matches && e.target.matches("img[data-fig]")) { e.target.previousElementSibling.textContent = "Image unavailable right now."; e.target.hidden = true; }
}, true);
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
  if (t.dataset.tab === currentTab) window.scrollTo({ top: 0, behavior: "smooth" }); else showTab(t.dataset.tab);
}));
$("#refresh").addEventListener("click", () => loadAll(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - S.lastLoad > STALE_MS) loadAll();
});
window.addEventListener("resize", () => document.documentElement.style.setProperty("--topbar-h", $("#topbar").offsetHeight + "px"));
restore();
renderChips();
showTab(currentTab);
renderAll();
loadAll();
