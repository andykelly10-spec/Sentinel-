// Sentinel Pre-Cog's engine: turns police open-data records into a picture of
// where and when crime is recorded along each candidate route, and predicts
// the risk of making the trip at a given hour on a weekday or at the weekend.
//
// The prediction is statistical: each recorded incident within a short
// distance of the route counts toward the risk, weighted by how serious it was
// (violent crime counts three times), by how close its time of day is to the
// planned time (a smooth curve, so 21:00 counts fully for a 21:00 trip and
// partly for 19:00), and by whether it happened on the same kind of day. The
// total is scaled to a 30-day rate per kilometre so routes and cities compare.
// Records lag reality and reflect what was reported, so it is advice, not fact.

// Calibrated on walks through downtown Chicago, Manhattan, LA, Seattle,
// Philadelphia, DC and London: quiet residential streets score under 15,
// busy downtowns 40 to 90 by day, the worst corridors at their peak hours 90+.
export const LEVELS = [
  { id: "low", label: "Low", below: 15, color: "#3fb950" },
  { id: "moderate", label: "Moderate", below: 40, color: "#d29922" },
  { id: "elevated", label: "Elevated", below: 90, color: "#f0883e" },
  { id: "high", label: "High", below: Infinity, color: "#f85149" },
];
export const levelFor = (score) => LEVELS.find((level) => score < level.below);

// How close to the route an incident must be to count.
export const CORRIDOR_M = { walk: 80, drive: 50 };
// Open Sentinel alerts this close to a route count too, whatever the hour.
export const LIVE_RADIUS_M = 300;
const LIVE_POINTS = { critical: 40, high: 20, medium: 8, low: 0 };
const VIOLENT_WEIGHT = 3;

const VIOLENT = /homicide|murder|manslaughter|rape|sex(ual)? (abuse|assault|offen)|criminal sexual|sodomy|robbery|assault|battery|weapon|firearm|shoot|gun|kidnap|abduct|traffick|stalk|intimidat|violen|carjack|menacing/i;
export const isViolent = (type) => VIOLENT.test(type);
// Records that say nothing about safety on the street: fraud, shoplifting,
// paperwork and the like. They are left out.
const OFF_STREET = /deceptive|fraud|identity|forger|counterfeit|embezzl|shoplift|retail theft|bad check|credit card|impersonat|liquor|gambling|lost property|non-criminal|warrant|recovered vehicle|case closure|courtesy|suspicious occ|license|registration|bunco|computer|extortion|bribery|false (report|pretense)|child support|family offense|miscellaneous investigation/i;
export const offStreet = (text) => OFF_STREET.test(text);

// Block names as the cities write them: "005XX S STATE ST" → "500 block of S State St".
export function placeName(raw) {
  let text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text || /redacted|unknown/i.test(text)) return "";
  text = text.replace(/^0*(\d*)X+\s+(BLOCK OF\s+)?/i, (_, digits) => (digits ? `${digits}00 block of ` : ""));
  text = text.replace(/^(\d+) - \d+ BLOCK OF /i, "$1 block of ").replace(/^(\d+) BLOCK (OF )?/i, "$1 block of ");
  return text.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Nw|Ne|Sw|Se)\b/g, (d) => d.toUpperCase()).replace(/ Block Of /, " block of ");
}

const DAY_MS = 86_400_000;
const M_PER_DEGREE = 111_320;

// ---------- reading the police data ----------

const formatters = new Map();
// The hour and kind of day of an instant, in a source's time zone.
export function localTime(ms, tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric", weekday: "short" }));
  }
  const parts = Object.fromEntries(formatters.get(tz).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { hour: Number(parts.hour) % 24, weekend: parts.weekday === "Sat" || parts.weekday === "Sun" };
}

// Most portals give local times with no zone ("2026-11-15T21:40:00.000"),
// some with the time in a separate field ("21:40:00" or "2140").
function fromLocal(dateText, timeText) {
  const date = String(dateText ?? "").slice(0, 10);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const time = String(timeText ?? String(dateText).slice(11, 16)).replace(":", "");
  const hour = /^\d{3,4}/.test(time) ? Number(time.padStart(4, "0").slice(0, 2)) : null;
  const day = new Date(ms).getUTCDay();
  return { date: ms, hour: hour !== null && hour < 24 ? hour : null, weekend: day === 0 || day === 6 };
}

function crime(lat, lon, when, type, violent, place, detail = "") {
  lat = Number(lat);
  lon = Number(lon);
  // Several cities blank the position of sensitive crimes, or set it to 0 or -1.
  if (!when || !Number.isFinite(lat) || !Number.isFinite(lon) || (Math.abs(lat) <= 1 && Math.abs(lon) <= 1)) return null;
  const kind = String(type ?? "").trim().replace(/\s+/g, " ");
  // Numeric categories ("999" in Seattle) are administrative.
  if (!kind || /^\d+$/.test(kind) || offStreet(`${kind} ${detail}`)) return null;
  return {
    lat,
    lon,
    date: when.date,
    hour: when.hour,
    weekend: when.weekend,
    type: kind,
    violent: violent ?? isViolent(kind),
    place: placeName(place),
  };
}

const rows = (body) => (Array.isArray(body) ? body : []);

const PARSERS = {
  dc: (body) =>
    (body?.features ?? []).map(({ attributes: a = {}, geometry: g = {} }) => {
      const at = Number(a.REPORT_DAT);
      const when = Number.isFinite(at) && at > 0 ? { date: at, ...localTime(at, "America/New_York") } : null;
      const method = a.METHOD && a.METHOD !== "OTHERS" ? ` (${String(a.METHOD).toLowerCase()})` : "";
      return crime(g.y, g.x, when, `${a.OFFENSE ?? ""}${method}`, undefined, a.BLOCK);
    }),
  chicago: (body) => rows(body).map((row) => crime(row.latitude, row.longitude, fromLocal(row.date), row.primary_type, undefined, row.block, row.description)),
  "nyc:complaints": (body) => rows(body).map((row) => crime(row.latitude, row.longitude, fromLocal(row.cmplnt_fr_dt, row.cmplnt_fr_tm), row.ofns_desc)),
  "nyc:shootings": (body) => rows(body).map((row) => crime(row.latitude, row.longitude, fromLocal(row.occur_date, row.occur_time), "Shooting", true)),
  la: (body) =>
    rows(body).map((row) => {
      // "211 - PC - F - Robbery - 120" → "Robbery"
      const parts = String(row.nibr_description ?? "").split(" - ");
      const type = parts.length >= 5 ? parts.slice(3, -1).join(" - ") : String(row.nibr_description ?? "");
      const violent = row.crime_against === "Person" || isViolent(type) || /firearm|gun|knife|revolver|pistol/i.test(String(row.weapon_desc ?? ""));
      return crime(row.hndrdth_lat, row.hndrdth_lon, fromLocal(row.date_occ, row.time_occ), type, violent, row.hndrdth_loc_chk);
    }),
  sf: (body) => rows(body).map((row) => crime(row.latitude, row.longitude, fromLocal(row.incident_datetime), row.incident_category, undefined, row.intersection)),
  seattle: (body) =>
    rows(body).map((row) =>
      crime(row.latitude, row.longitude, fromLocal(row.offense_date), row.offense_sub_category, row.nibrs_crime_against_category === "PERSON" || isViolent(String(row.offense_sub_category ?? "")), row.block_address),
    ),
  philadelphia: (body) => (body?.rows ?? []).map((row) => crime(row.point_y, row.point_x, fromLocal(row.dispatch_date, row.dispatch_time), row.text_general_code, undefined, row.location_block)),
  uk: (body) =>
    rows(body).map((row) => {
      const date = Date.parse(`${row.month}-15T12:00:00Z`);
      const when = Number.isFinite(date) ? { date, hour: null, weekend: null } : null;
      const place = String(row.location?.street?.name ?? "").replace(/^On or near /i, "");
      return crime(row.location?.latitude, row.location?.longitude, when, String(row.category ?? "").replace(/-/g, " "), ["violent-crime", "robbery", "possession-of-weapons"].includes(row.category), place);
    }),
};

// The worker's /api/precog/crime answer → incidents, each carrying `rate`:
// how much one incident adds to a 30-day count for its source.
export function readCrime(response) {
  const crimes = [];
  const sources = [];
  for (const entry of response?.sources ?? []) {
    const parse = PARSERS[`${entry.id}:${entry.part}`] ?? PARSERS[entry.id];
    const label = entry.part && entry.part !== "crime" ? `${entry.name} (${entry.part})` : entry.name;
    if (!parse || entry.error || entry.body === null || entry.body === undefined) {
      sources.push({ id: entry.id, name: label, tz: entry.tz, lag: entry.lag, count: 0, days: entry.days, from: null, to: null, error: entry.error || "No data" });
      continue;
    }
    let found = [];
    try {
      found = parse(entry.body).filter(Boolean);
    } catch {
      sources.push({ id: entry.id, name: label, tz: entry.tz, lag: entry.lag, count: 0, days: entry.days, from: null, to: null, error: "Unreadable answer" });
      continue;
    }
    const dates = found.map((each) => each.date);
    const from = dates.length ? Math.min(...dates) : null;
    const to = dates.length ? Math.max(...dates) : null;
    // A full page means older records were cut off: the window is what came back.
    const truncated = found.length >= (entry.maxRows ?? Infinity) * 0.98 && from !== null;
    const days = entry.id === "uk" ? 30 : truncated ? Math.max(1, (to - from) / DAY_MS) : entry.days;
    const rate = 30 / days;
    for (const each of found) crimes.push({ ...each, rate, source: entry.id });
    sources.push({ id: entry.id, name: label, tz: entry.tz, lag: entry.lag, count: found.length, days: Math.round(days), from, to, error: null, truncated });
  }
  return { crimes, sources };
}

// ---------- routes ----------

export function decodePolyline6(text) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < text.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = text.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < text.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}

// OSRM: GeoJSON [lon, lat] lines, metres and seconds.
export const readOsrm = (body) =>
  (body?.routes ?? []).map((route) => ({ coords: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]), distanceM: route.distance, durationS: route.duration, kind: "osrm" }));

// Valhalla: polyline6, kilometres and seconds.
export function readValhalla(body) {
  const trip = body?.trip;
  if (!trip?.legs?.length) return [];
  return [{ coords: trip.legs.flatMap((leg) => decodePolyline6(leg.shape)), distanceM: trip.summary.length * 1000, durationS: trip.summary.time, kind: "avoid" }];
}

function metres([lat1, lon1], [lat2, lon2]) {
  const x = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(lat2 - lat1, x) * M_PER_DEGREE;
}

export const lengthM = (coords) => coords.reduce((total, point, index) => (index ? total + metres(coords[index - 1], point) : 0), 0);

// Points every `step` metres along the line, ends included.
export function resample(coords, step) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let carry = 0;
  for (let index = 1; index < coords.length; index++) {
    const a = coords[index - 1];
    const b = coords[index];
    const span = metres(a, b);
    let at = step - carry;
    while (at < span) {
      const t = at / span;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      at += step;
    }
    carry = span - (at - step);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// Grid of incidents for nearby lookups.
const CELL = 0.0005;
export function indexCrimes(crimes) {
  const cells = new Map();
  crimes.forEach((each, index) => {
    const key = `${Math.floor(each.lat / CELL)},${Math.floor(each.lon / CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(index);
  });
  return { crimes, cells };
}

// Incidents within `radius` metres of the line, as a map from each one's
// index to how far along the route (0 to 1) it is first passed.
export function nearLine(coords, { crimes, cells }, radius) {
  const found = new Map();
  const reach = Math.ceil(radius / (CELL * M_PER_DEGREE));
  const samples = resample(coords, Math.max(10, radius / 3));
  samples.forEach((point, step) => {
    const row = Math.floor(point[0] / CELL);
    const col = Math.floor(point[1] / CELL);
    const reachLon = Math.ceil(reach / Math.max(0.2, Math.cos((point[0] * Math.PI) / 180)));
    for (let i = row - reach; i <= row + reach; i++) {
      for (let j = col - reachLon; j <= col + reachLon; j++) {
        for (const index of cells.get(`${i},${j}`) ?? []) {
          if (!found.has(index) && metres(point, [crimes[index].lat, crimes[index].lon]) <= radius) found.set(index, step / Math.max(1, samples.length - 1));
        }
      }
    }
  });
  return found;
}

// ---------- where crime is read ----------

// The areas the police sources cover (as in src/precog.ts), [south, west, north, east].
export const COVERED_AREAS = {
  dc: [38.79, -77.12, 39.0, -76.9],
  chicago: [41.64, -87.94, 42.03, -87.52],
  nyc: [40.49, -74.26, 40.92, -73.7],
  la: [33.7, -118.67, 34.34, -118.15],
  sf: [37.7, -122.52, 37.84, -122.35],
  seattle: [47.49, -122.44, 47.74, -122.23],
  philadelphia: [39.86, -75.29, 40.14, -74.95],
  uk: [49.9, -8.2, 55.8, 1.8],
};
const inBox = ([lat, lon], [s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e;
const covered = (point) => Object.values(COVERED_AREAS).some((area) => inBox(point, area));

const TILE = 0.1;
const TILE_PAD = 0.004;
export const MAX_TILES = 14;

// The boxes to read crime for: each 0.1° tile the routes cross inside a
// covered area, cut down to the stretch of route in it. Long trips keep the
// tiles nearest the start and the end, where the streets are.
export function crimeBoxes(routes) {
  const tiles = new Map();
  if (!routes.length) return [];
  const start = routes[0].coords[0];
  const end = routes[0].coords[routes[0].coords.length - 1];
  for (const route of routes) {
    for (const point of resample(route.coords, 150)) {
      if (!covered(point)) continue;
      const key = `${Math.floor(point[0] / TILE)},${Math.floor(point[1] / TILE)}`;
      const tile = tiles.get(key) ?? { s: 90, w: 180, n: -90, e: -180, near: Infinity };
      tile.s = Math.min(tile.s, point[0]);
      tile.n = Math.max(tile.n, point[0]);
      tile.w = Math.min(tile.w, point[1]);
      tile.e = Math.max(tile.e, point[1]);
      tile.near = Math.min(tile.near, metres(point, start), metres(point, end));
      tiles.set(key, tile);
    }
  }
  const round4 = (value) => Math.round(value * 1e4) / 1e4;
  return [...tiles.values()]
    .sort((a, b) => a.near - b.near)
    .slice(0, MAX_TILES)
    .map((tile) => [tile.s - TILE_PAD, tile.w - TILE_PAD, tile.n + TILE_PAD, tile.e + TILE_PAD].map(round4));
}

// Several boxes' answers as one: incidents read twice where boxes overlap are
// kept once, and each source's figures are added up.
export function mergeCrime(results) {
  const seen = new Set();
  const crimes = [];
  const sources = new Map();
  for (const { crimes: found, sources: from } of results) {
    for (const each of found) {
      const key = `${each.source}|${each.lat}|${each.lon}|${each.date}|${each.hour}|${each.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      crimes.push(each);
    }
    for (const source of from) {
      const merged = sources.get(source.name);
      if (!merged) {
        sources.set(source.name, { ...source });
        continue;
      }
      merged.count += source.count;
      merged.days = Math.max(merged.days, source.days);
      if (source.from !== null) merged.from = merged.from === null ? source.from : Math.min(merged.from, source.from);
      if (source.to !== null) merged.to = merged.to === null ? source.to : Math.max(merged.to, source.to);
      if (!source.error) merged.error = null;
      merged.truncated ||= source.truncated;
    }
  }
  return { crimes, sources: [...sources.values()] };
}

// Kilometres of the route inside boxes whose crime was read.
export function coveredKm(coords, boxes) {
  if (!boxes) return lengthM(coords) / 1000;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const mid = [(coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2];
    if (boxes.some((box) => inBox(mid, box))) total += metres(coords[i - 1], coords[i]);
  }
  return total / 1000;
}

// ---------- prediction ----------

// Time-of-day weight: a circular bell curve two hours wide, averaging 1 over the day.
const SIGMA_H = 1.5;
const KERNEL = Array.from({ length: 24 }, (_, d) => Math.exp(-(Math.min(d, 24 - d) ** 2) / (2 * SIGMA_H ** 2)));
const KERNEL_SUM = KERNEL.reduce((a, b) => a + b, 0);
export const hourWeight = (crimeHour, hour) => (crimeHour === null || crimeHour === undefined ? 1 : (24 * KERNEL[(hour - crimeHour + 24) % 24]) / KERNEL_SUM);

// Day weight: half the weight is shared, half goes to incidents on the same
// kind of day, scaled so that each weight averages 1 over a week.
export const dayWeight = (crimeWeekend, weekend) =>
  crimeWeekend === null || crimeWeekend === undefined ? 1 : 0.5 + 0.5 * (crimeWeekend === weekend ? (weekend ? 3.5 : 1.4) : 0);

// Nuisance and drug-possession records count half.
const NUISANCE = /anti social|public order|disorderly|drug|narcotic|paraphernalia|controlled substance|liquor|loitering|trespass/i;
export const severity = (each) => (each.violent ? VIOLENT_WEIGHT : NUISANCE.test(each.type) ? 0.5 : 1) * each.rate;

// Expected weighted incidents per 30 days, by hour of departure, for weekdays
// and weekends. `offsets` gives each incident's hours into the trip, so on a
// long drive the far end is judged at the hour you will reach it.
export function hourlyProfile(crimes, offsets = []) {
  const weekday = new Array(24).fill(0);
  const weekend = new Array(24).fill(0);
  crimes.forEach((each, i) => {
    const weight = severity(each);
    const offset = offsets[i] ?? 0;
    for (let hour = 0; hour < 24; hour++) {
      const byHour = weight * hourWeight(each.hour, (hour + offset) % 24);
      weekday[hour] += byHour * dayWeight(each.weekend, false);
      weekend[hour] += byHour * dayWeight(each.weekend, true);
    }
  });
  return { weekday, weekend };
}

// The `length`-hour window with the lowest (or highest) total, as its first hour.
export function window(values, length, highest = false) {
  let best = 0;
  let bestTotal = highest ? -Infinity : Infinity;
  for (let start = 0; start < 24; start++) {
    let total = 0;
    for (let k = 0; k < length; k++) total += values[(start + k) % 24];
    if (highest ? total > bestTotal : total < bestTotal) {
      best = start;
      bestTotal = total;
    }
  }
  return best;
}

const pad = (hour) => `${String(hour % 24).padStart(2, "0")}:00`;
export const windowLabel = (start, length) => `${pad(start)}–${pad(start + length)}`;

function counted(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

const titleCase = (text) => text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Clusters of incidents along the route, about 150 m across.
const HOTSPOT_CELL = 0.0014;
const HOTSPOT_MIN = 6;
export function hotspots(crimes, limit = 5) {
  const cells = new Map();
  for (const each of crimes) {
    const key = `${Math.floor(each.lat / HOTSPOT_CELL)},${Math.floor(each.lon / HOTSPOT_CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(each);
  }
  return [...cells.values()]
    .map((members) => {
      const weight = members.reduce((total, each) => total + severity(each), 0);
      const hours = new Array(24).fill(0);
      for (const each of members) if (each.hour !== null) hours[each.hour] += 1;
      const timed = hours.some(Boolean);
      return {
        lat: members.reduce((t, each) => t + each.lat, 0) / members.length,
        lon: members.reduce((t, each) => t + each.lon, 0) / members.length,
        perMonth: members.reduce((t, each) => t + each.rate, 0),
        violentPerMonth: members.filter((each) => each.violent).reduce((t, each) => t + each.rate, 0),
        weight,
        types: counted(members.map((each) => titleCase(each.type))).slice(0, 3),
        place: counted(members.map((each) => each.place))[0]?.[0] ?? "",
        peak: timed && members.length >= 4 ? windowLabel(window(hours, 3, true), 3) : null,
      };
    })
    .filter((spot) => spot.weight >= HOTSPOT_MIN)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

const round1 = (value) => Math.round(value * 10) / 10;

// Everything Pre-Cog says about one route at the planned hour and kind of day.
export function analyseRoute(route, { index, mode, hour, weekend, alerts = [] }) {
  const radius = CORRIDOR_M[mode];
  const passed = nearLine(route.coords, index, radius);
  const near = [...passed.keys()].map((i) => index.crimes[i]);
  const hours = route.durationS / 3600;
  const offsets = [...passed.values()].map((at) => Math.round(at * hours) % 24);
  const totalKm = route.distanceM / 1000;
  // Risk per km is over the stretch where crime was read (all of it on a walk in a covered city).
  const scoredKm = Math.min(totalKm, coveredKm(route.coords, index.boxes));
  const perKm = scoredKm > 0.05 ? Math.max(0.5, scoredKm) : 0;
  const profile = hourlyProfile(near, offsets);
  const lats = route.coords.map(([lat]) => lat);
  const lons = route.coords.map(([, lon]) => lon);
  const frame = [Math.min(...lats) - 0.01, Math.min(...lons) - 0.01, Math.max(...lats) + 0.01, Math.max(...lons) + 0.01];
  const live = alerts
    .filter((alert) => Number.isFinite(alert.lat) && Number.isFinite(alert.lon) && LIVE_POINTS[alert.severity] && inBox([alert.lat, alert.lon], frame))
    .map((alert) => ({ alert, distanceM: closest(route.coords, alert) }))
    .filter((each) => each.distanceM <= LIVE_RADIUS_M);
  const livePoints = live.reduce((total, each) => total + LIVE_POINTS[each.alert.severity], 0);
  const day = weekend ? profile.weekend : profile.weekday;
  const byHour = day.map((value) => round1((perKm ? value / perKm : 0) + livePoints));
  const score = byHour[hour];
  const perMonth = near.reduce((total, each) => total + each.rate, 0);
  const violentPerMonth = near.filter((each) => each.violent).reduce((total, each) => total + each.rate, 0);
  const timed = near.some((each) => each.hour !== null);
  return {
    ...route,
    radius,
    crimes: near,
    perMonth: round1(perMonth),
    violentPerMonth: round1(violentPerMonth),
    byHour,
    score,
    // The whole trip's share: intensity per km times the distance it applies to.
    exposure: round1(score * (perKm || 1)),
    scoredKm: round1(scoredKm),
    totalKm: round1(totalKm),
    arrival: hours >= 1 ? (hour + Math.round(hours)) % 24 : null,
    level: levelFor(score),
    dayAverage: round1(byHour.reduce((a, b) => a + b, 0) / 24),
    peak: timed ? windowLabel(window(day, 3, true), 3) : null,
    quiet: timed ? windowLabel(window(day, 3), 3) : null,
    types: counted(near.map((each) => titleCase(each.type))).slice(0, 4),
    hotspots: hotspots(near),
    live: live.map(({ alert, distanceM }) => ({ title: alert.title, severity: alert.severity, distanceM: Math.round(distanceM), lat: alert.lat, lon: alert.lon })),
  };
}

function closest(coords, { lat, lon }) {
  let best = Infinity;
  for (const point of resample(coords, 20)) best = Math.min(best, metres(point, [lat, lon]));
  return best;
}

const minutes = (seconds) => Math.max(1, Math.round(seconds / 60));
const share = (part, whole) => Math.round((100 * part) / whole);

export function reasons(route, hour) {
  const out = [];
  if (route.totalKm - route.scoredKm > 0.5) {
    out.push(
      route.scoredKm > 0
        ? `Crime records cover ${route.scoredKm} of this route's ${route.totalKm} km (the stretches in covered cities); live alerts count along all of it.`
        : `No crime records cover this route; it is compared on live Sentinel alerts only.`,
    );
  }
  if (route.arrival !== null) out.push(`A ${Math.round(route.durationS / 3600)}-hour trip: arriving around ${pad(route.arrival)}, and each stretch is predicted for the hour you reach it.`);
  if (!route.crimes.length && route.scoredKm > 0) {
    out.push(`No incidents recorded within ${route.radius} m of this route in the data available.`);
  } else if (route.crimes.length) {
    out.push(
      `About ${Math.round(route.perMonth)} incidents a month recorded within ${route.radius} m${route.violentPerMonth >= 0.5 ? `, ${Math.round(route.violentPerMonth)} of them violent` : ", almost none violent"}.`,
    );
    if (route.types.length) out.push(`Mostly ${route.types.slice(0, 3).map(([type, count]) => `${type.toLowerCase()} (${share(count, route.crimes.length)}%)`).join(", ")}.`);
    if (route.peak) out.push(`Recorded crime along it peaks ${route.peak} and is lowest ${route.quiet}; at ${pad(hour)} the predicted risk is ${route.score <= route.dayAverage ? "below" : "above"} its daily average.`);
  }
  for (const spot of route.hotspots.slice(0, 2)) {
    out.push(`Hotspot${spot.place ? ` at ${spot.place}` : ""}: about ${Math.round(spot.perMonth)} incidents a month, mostly ${spot.types[0]?.[0].toLowerCase() ?? "mixed"}${spot.peak ? `, peaking ${spot.peak}` : ""}.`);
  }
  for (const each of route.live.slice(0, 3)) out.push(`Live ${each.severity} alert ${each.distanceM} m from the route: ${each.title}`);
  return out;
}

// Labels the fastest and safest routes and picks one to recommend: the safest
// unless it costs much more time, in which case the safest of the rest.
export function compareRoutes(routes, mode) {
  if (!routes.length) return routes;
  // Routes are compared on the whole trip's exposure, so a long detour through
  // quieter streets does not look safer than it is.
  const risk = (route) => route.exposure ?? route.score;
  const lower = (a, b) => (risk(b) < risk(a) || (risk(b) === risk(a) && b.durationS < a.durationS) ? b : a);
  const fastest = routes.reduce((a, b) => (b.durationS < a.durationS ? b : a));
  const safest = routes.reduce(lower);
  const limit = fastest.durationS * (mode === "walk" ? 1.5 : 1.35) + 120;
  const recommended = routes.filter((route) => route.durationS <= limit).reduce(lower, fastest);
  return routes
    .map((route) => ({
      ...route,
      tags: routes.length === 1 ? ["Only route found"] : [route === recommended && "Recommended", route === fastest && "Fastest", route === safest && "Safest", route.kind === "avoid" && "Avoids hotspots"].filter(Boolean),
      extraMinutes: minutes(route.durationS) - minutes(fastest.durationS),
    }))
    .sort((a, b) => b.tags.includes("Recommended") - a.tags.includes("Recommended") || risk(a) - risk(b));
}

const percent = (value, base) => (base > 0 ? Math.round((100 * (value - base)) / base) : 0);
const signed = (value) => `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value)}%`;

// The headline numbers: why the recommended route was chosen, how each route
// compares with the fastest, and how the planned hour compares with the rest
// of the day. Percentages compare predicted trip exposure.
export function summarise(routes, hour) {
  if (!routes.length) return null;
  const recommended = routes.find((route) => route.tags.includes("Recommended")) ?? routes[0];
  const fastest = routes.find((route) => route.tags.includes("Fastest")) ?? recommended;
  const safest = routes.find((route) => route.tags.includes("Safest")) ?? recommended;
  const name = (route) => `Route ${route.letter}`;
  const vsFastest = percent(recommended.exposure, fastest.exposure);
  const extra = (route) => `${route.extraMinutes} more minute${route.extraMinutes === 1 ? "" : "s"}`;

  let why;
  if (routes.length === 1) why = "Only one route was found, so Pre-Cog rates it rather than choosing between routes.";
  else if (recommended === fastest && recommended === safest) why = "It is both the quickest route and the one with the least predicted exposure to recorded crime.";
  else if (recommended === fastest) {
    const saving = -percent(safest.exposure, fastest.exposure);
    why =
      safest === fastest || saving <= 0
        ? "It is the quickest, and no alternative lowers the predicted risk."
        : `It is the quickest. ${name(safest)} would cut predicted exposure by ${saving}%, but takes ${extra(safest)}, more than Pre-Cog trades for safety.`;
  } else if (recommended === safest) why = `It cuts predicted exposure by ${-vsFastest}% compared with the fastest route, ${name(fastest)}, for ${extra(recommended)}.`;
  else {
    why = `It cuts predicted exposure by ${-vsFastest}% compared with the fastest route, ${name(fastest)}, for ${extra(recommended)}. ${name(safest)} is safer still (${signed(percent(safest.exposure, fastest.exposure))}) but takes ${extra(safest)}.`;
  }

  const day = recommended.byHour;
  const average = day.reduce((a, b) => a + b, 0) / 24;
  const varies = Math.max(...day) - Math.min(...day) > 0.05 * Math.max(1, average);
  let timing = null;
  if (varies) {
    const best = day.indexOf(Math.min(...day));
    const worst = day.indexOf(Math.max(...day));
    timing = {
      hour: pad(hour),
      vsAverage: percent(day[hour], average),
      // Share of the day's hours that are less risky than the planned one.
      quieterHours: Math.round((100 * day.filter((value) => value < day[hour]).length) / 24),
      bestHour: pad(best),
      bestChange: percent(day[best], day[hour]),
      worstHour: pad(worst),
      worstChange: percent(day[worst], day[hour]),
    };
  }

  const crimesTotal = recommended.crimes.length;
  return {
    recommended: name(recommended),
    headline:
      routes.length === 1
        ? `${name(recommended)}: ${recommended.level.label.toLowerCase()} predicted risk at ${pad(hour)}.`
        : `Take ${name(recommended)}: ${recommended.level.label.toLowerCase()} predicted risk at ${pad(hour)}${recommended === fastest ? ", and the quickest" : `, ${Math.abs(vsFastest)}% ${vsFastest <= 0 ? "less" : "more"} exposure than the fastest route for ${extra(recommended)}`}.`,
    why,
    violentShare: crimesTotal ? Math.round((100 * recommended.crimes.filter((each) => each.violent).length) / crimesTotal) : 0,
    timing,
    rows: routes.map((route) => ({
      route: name(route),
      tags: route.tags,
      minutes: minutes(route.durationS),
      extraMinutes: route.extraMinutes,
      km: round1(route.distanceM / 1000),
      level: route.level,
      score: route.score,
      exposure: route.exposure,
      vsFastest: percent(route.exposure, fastest.exposure),
      violentShare: route.crimes.length ? Math.round((100 * route.crimes.filter((each) => each.violent).length) / route.crimes.length) : 0,
      hotspots: route.hotspots.length,
      live: route.live.length,
      scoredKm: route.scoredKm,
      totalKm: route.totalKm,
    })),
  };
}

export const formatChange = signed;

// Hotspots shared by the routes, as zones for a detour to keep out of; the
// start and end are never excluded.
export function avoidZones(routes, from, to) {
  const zones = [];
  for (const spot of routes.flatMap((route) => route.hotspots).sort((a, b) => b.weight - a.weight)) {
    if ([from, to].some((end) => metres([end.lat, end.lon], [spot.lat, spot.lon]) < 250)) continue;
    if (zones.some((zone) => metres([zone.lat, zone.lon], [spot.lat, spot.lon]) < 120)) continue;
    zones.push({ lat: Math.round(spot.lat * 1e5) / 1e5, lon: Math.round(spot.lon * 1e5) / 1e5, radiusM: 110 });
    if (zones.length >= 12) break;
  }
  return zones;
}

// A Google Maps link that follows the route, through up to eight points on it.
export function directionsLink(route, mode) {
  const coords = route.coords;
  const at = ([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const params = new URLSearchParams({ api: "1", origin: at(coords[0]), destination: at(coords[coords.length - 1]), travelmode: mode === "walk" ? "walking" : "driving" });
  const via = [];
  for (let k = 1; k <= 8 && coords.length > 10; k++) via.push(at(coords[Math.round((k * (coords.length - 1)) / 9)]));
  if (via.length) params.set("waypoints", via.join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}

// The compact picture sent for the written assessment.
export function assessmentInput({ routes, mode, hour, weekend, sources, from, to }) {
  const summary = summarise(routes, hour);
  return {
    pickedByRules: summary && { recommended: summary.recommended, why: summary.why, violentShareOfIncidentsPercent: summary.violentShare, timing: summary.timing, comparison: summary.rows.map(({ level, ...row }) => ({ ...row, level: level.label })) },
    trip: { mode, from: from.label, to: to.label, plannedHour: pad(hour), dayType: weekend ? "weekend" : "weekday" },
    scale: "risk is weighted incidents per km per 30 days at the planned time (violent x3); levels: Low <15, Moderate <40, Elevated <90, High 90+. exposure is risk x km, the whole trip's share; routes are compared on exposure. Percentages compare exposure with the fastest route.",
    routes: routes.map((route) => ({
      label: route.label,
      tags: route.tags,
      minutes: minutes(route.durationS),
      extraMinutes: route.extraMinutes,
      km: round1(route.distanceM / 1000),
      kmWithCrimeRecords: route.scoredKm,
      arrivalHour: route.arrival === null ? null : pad(route.arrival),
      risk: route.score,
      exposure: route.exposure,
      level: route.level.label,
      riskByHour: route.byHour.map(Math.round),
      dailyAverage: route.dayAverage,
      incidentsPerMonth: route.perMonth,
      violentPerMonth: route.violentPerMonth,
      peak: route.peak,
      quietest: route.quiet,
      commonTypes: route.types.map(([type, count]) => `${type} (${count})`),
      hotspots: route.hotspots.map((spot) => ({ place: spot.place || null, perMonth: round1(spot.perMonth), violentPerMonth: round1(spot.violentPerMonth), types: spot.types.map(([type]) => type), peak: spot.peak })),
      liveAlerts: route.live,
    })),
    sources: sources.map((source) => ({
      name: source.name,
      records: source.count,
      days: source.days,
      from: source.from ? new Date(source.from).toISOString().slice(0, 10) : null,
      to: source.to ? new Date(source.to).toISOString().slice(0, 10) : null,
      lag: source.lag,
      error: source.error,
    })),
  };
}
