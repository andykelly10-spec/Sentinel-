// Air raids in the Russia–Ukraine war, from three public sources:
//  - Ukraine's official air-raid alert status for each oblast, as republished
//    by vadimklimenko.com (the data behind most public alert maps);
//  - the Ukrainian Air Force's Telegram channel, which posts each missile,
//    drone and guided-bomb threat as it happens;
//  - the Russian Defence Ministry's Telegram channel, which reports drones and
//    missiles shot down over Russian regions.
// Telegram posts are in Ukrainian or Russian; they are labelled in English by
// rule, with the original kept and a translation link alongside.

import { getSetting, setSetting } from "../db";
import { distanceMiles } from "../geo";
import { stripHtml, truncate } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS, nearestSite } from "./common";

export const ALERT_STATUS_URL = "https://vadimklimenko.com/map/statuses.json";
export const AIR_FORCE_URL = "https://t.me/s/kpszsu";
export const RUSSIA_MOD_URL = "https://t.me/s/mod_russia";

// Alerts on longer than this are standing alerts over occupied areas
// (Crimea, Sevastopol and Luhansk have been "on" since 2022).
const STANDING_MS = 7 * 24 * HOUR_MS;
// Telegram threats shown on the map and turned into alerts.
const THREAT_WINDOW_MS = 3 * HOUR_MS;
const RUSSIA_WINDOW_MS = 24 * HOUR_MS;
// Regions that can be under alert (the standing ones never clear).
const ALERTABLE_REGIONS = 24;
export const MASS_RAID_REGIONS = 12;
export const MAJOR_RAID_REGIONS = 18;
// How far a site can be from the action for an attack to be reported against it.
const SITE_REACH_MILES = 400;

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

interface Oblast extends Place {
  uk: string;
  // Matches the region in Ukrainian Air Force posts (case-sensitive stems).
  pattern: RegExp;
  west?: boolean;
}

const stem = (source: string) => new RegExp(`(?<!\\p{L})(?:${source})`, "u");

// Each oblast's administrative centre stands in for the oblast.
export const OBLASTS: Oblast[] = [
  { uk: "АР Крим", name: "Crimea", lat: 44.952, lon: 34.102, pattern: stem("Крим") },
  { uk: "Севастополь", name: "Sevastopol", lat: 44.616, lon: 33.525, pattern: stem("Севастопол") },
  { uk: "Вінницька область", name: "Vinnytsia", lat: 49.233, lon: 28.468, pattern: stem("Вінниц|Вінничч") },
  { uk: "Волинська область", name: "Volyn", lat: 50.747, lon: 25.325, pattern: stem("Волин|Луцьк"), west: true },
  { uk: "Дніпропетровська область", name: "Dnipropetrovsk", lat: 48.464, lon: 35.046, pattern: stem("Дніпр|Павлоград|Кривий Ріг|Кривого Рогу|Кривому Розі|Нікопол") },
  { uk: "Донецька область", name: "Donetsk", lat: 48.5, lon: 37.6, pattern: stem("Донеч|Донецьк|Краматорськ|Слов'янськ|Слов’янськ") },
  { uk: "Житомирська область", name: "Zhytomyr", lat: 50.254, lon: 28.659, pattern: stem("Житомир") },
  { uk: "Закарпатська область", name: "Zakarpattia", lat: 48.621, lon: 22.288, pattern: stem("Закарпат|Ужгород"), west: true },
  { uk: "Запорізька область", name: "Zaporizhzhia", lat: 47.839, lon: 35.14, pattern: stem("Запоріж") },
  { uk: "Івано-Франківська область", name: "Ivano-Frankivsk", lat: 48.923, lon: 24.711, pattern: stem("Івано-Франків|Прикарпатт") },
  { uk: "Київська область", name: "Kyiv region", lat: 50.3, lon: 30.25, pattern: stem("Київщин|Київськ|Бориспіл|Біла Церкв|Білої Церкв|Бровар|Вишгород|Глевах|Баришівк") },
  { uk: "Кіровоградська область", name: "Kirovohrad", lat: 48.508, lon: 32.262, pattern: stem("Кіровоград|Кропивниц") },
  { uk: "Луганська область", name: "Luhansk", lat: 48.574, lon: 39.308, pattern: stem("Луган") },
  { uk: "Львівська область", name: "Lviv", lat: 49.84, lon: 24.03, pattern: stem("Львів|Львов"), west: true },
  { uk: "Миколаївська область", name: "Mykolaiv", lat: 46.975, lon: 31.995, pattern: stem("Миколаїв|Миколає|Очаків|Очакова") },
  { uk: "Одеська область", name: "Odesa", lat: 46.482, lon: 30.723, pattern: stem("Одес|Одещин|Татарбунар|Ізмаїл|Чорноморськ|Подільськ") },
  { uk: "Полтавська область", name: "Poltava", lat: 49.588, lon: 34.551, pattern: stem("Полтав|Кременчу|Миргород") },
  { uk: "Рівненська область", name: "Rivne", lat: 50.619, lon: 26.251, pattern: stem("Рівне|Рівного|Рівненщин|Рівненськ"), west: true },
  { uk: "Сумська область", name: "Sumy", lat: 50.907, lon: 34.798, pattern: stem("Сум(?:и|ах|ська|ську|ській|ської|щин)|Шостк|Конотоп") },
  { uk: "Тернопільська область", name: "Ternopil", lat: 49.553, lon: 25.594, pattern: stem("Тернопіл|Тернопол"), west: true },
  { uk: "Харківська область", name: "Kharkiv", lat: 49.994, lon: 36.231, pattern: stem("Харків|Харков|Чугу|Ізюм|Куп['’]янськ") },
  { uk: "Херсонська область", name: "Kherson", lat: 46.635, lon: 32.616, pattern: stem("Херсон") },
  { uk: "Хмельницька область", name: "Khmelnytskyi", lat: 49.422, lon: 26.987, pattern: stem("Хмельниц|Старокостянтинів"), west: true },
  { uk: "Черкаська область", name: "Cherkasy", lat: 49.444, lon: 32.059, pattern: stem("Черкас|Черкащ|Умань|Умані") },
  { uk: "Чернівецька область", name: "Chernivtsi", lat: 48.292, lon: 25.935, pattern: stem("Чернів(?:ц|ець)|Буковин"), west: true },
  { uk: "Чернігівська область", name: "Chernihiv", lat: 51.498, lon: 31.289, pattern: stem("Чернігів|Чернігов") },
  { uk: "м. Київ", name: "Kyiv", lat: 50.45, lon: 30.523, pattern: stem("Київ(?!щин|ськ)|Києв|Київу|Оболон|Лук['’]янів|Троєщин|Позняк|Дарниц|Святошин|Солом['’]ян|Печерськ|Голосі|Осокорк|Виноградар") },
];

const BLACK_SEA: Place = { name: "Black Sea", lat: 44.5, lon: 31.5 };

// Russian regions as the Defence Ministry names them (genitive stems).
const RUSSIAN_REGIONS: Array<Place & { pattern: RegExp }> = [
  ["Белгородск", "Belgorod", 50.6, 36.6],
  ["Курск", "Kursk", 51.73, 36.19],
  ["Брянск", "Bryansk", 53.25, 34.37],
  ["Орловск", "Oryol", 52.97, 36.07],
  ["Воронежск", "Voronezh", 51.67, 39.18],
  ["Ростовск", "Rostov", 47.24, 39.71],
  ["Краснодарск", "Krasnodar", 45.04, 38.98],
  ["Республики Крым|Крым", "Crimea", 44.95, 34.1],
  ["Тульск", "Tula", 54.19, 37.62],
  ["Калужск", "Kaluga", 54.51, 36.26],
  ["Смоленск", "Smolensk", 54.78, 32.05],
  ["Псковск", "Pskov", 57.82, 28.33],
  ["Ленинградск", "Leningrad", 59.93, 30.36],
  ["Московск|Москв", "Moscow", 55.75, 37.62],
  ["Липецк", "Lipetsk", 52.61, 39.6],
  ["Тамбовск", "Tambov", 52.72, 41.45],
  ["Рязанск", "Ryazan", 54.63, 39.74],
  ["Саратовск", "Saratov", 51.53, 46.03],
  ["Волгоградск", "Volgograd", 48.71, 44.51],
  ["Самарск", "Samara", 53.2, 50.15],
  ["Нижегородск", "Nizhny Novgorod", 56.33, 44.0],
  ["Ярославск", "Yaroslavl", 57.63, 39.87],
  ["Тверск", "Tver", 56.86, 35.9],
  ["Новгородск", "Novgorod", 58.52, 31.27],
  ["Пензенск", "Penza", 53.2, 45.0],
  ["Ульяновск", "Ulyanovsk", 54.32, 48.4],
  ["Татарстан", "Tatarstan", 55.79, 49.12],
  ["Башкортостан", "Bashkortostan", 54.73, 55.95],
  ["Чуваш", "Chuvashia", 56.13, 47.25],
  ["Астраханск", "Astrakhan", 46.35, 48.04],
  ["Владимирск", "Vladimir", 56.13, 40.4],
  ["Ивановск", "Ivanovo", 57.0, 40.97],
  ["Костромск", "Kostroma", 57.77, 40.93],
  ["Оренбургск", "Orenburg", 51.77, 55.1],
  ["Ставропольск", "Stavropol", 45.04, 41.97],
  ["Адыге", "Adygea", 44.6, 40.1],
  ["Мордови", "Mordovia", 54.18, 45.18],
  ["Чечен", "Chechnya", 43.32, 45.69],
  ["Дагестан", "Dagestan", 42.98, 47.5],
  ["Калининградск", "Kaliningrad", 54.71, 20.51],
  ["Мурманск", "Murmansk", 68.97, 33.08],
  ["Вологодск", "Vologda", 59.22, 39.89],
  ["Пермск", "Perm", 58.01, 56.25],
  ["Кировск", "Kirov", 58.6, 49.66],
  ["Удмурт", "Udmurtia", 56.85, 53.2],
  ["Азовск\\p{L}* мор", "Sea of Azov", 46.0, 36.5],
  ["Черн\\p{L}* мор", "Black Sea", 44.5, 34.0],
].map(([source, name, lat, lon]) => ({ pattern: stem(source as string), name: name as string, lat: lat as number, lon: lon as number }));

function placesIn(text: string, places: Array<Place & { pattern: RegExp }>): Place[] {
  return places
    .map((place) => ({ place, at: text.search(place.pattern) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ place }) => ({ name: place.name, lat: place.lat, lon: place.lon }));
}

// ---------- oblast alert status ----------

export type OblastState = "active" | "partial" | "standing" | "clear";

export interface OblastStatus extends Place {
  uk: string;
  state: OblastState;
  since: string | null;
  // Districts under alert when only part of the oblast is.
  districts: number;
  west: boolean;
}

interface StatusEntry {
  enabled?: boolean;
  enabled_at?: string | null;
  districts?: Record<string, { enabled?: boolean }>;
}

export function parseAlertStatus(body: string, now: Date): OblastStatus[] {
  const states = (JSON.parse(body) as { states?: Record<string, StatusEntry> }).states ?? {};
  return OBLASTS.map((oblast) => {
    const entry = states[oblast.uk] ?? {};
    const since = entry.enabled_at ?? null;
    const districts = Object.values(entry.districts ?? {}).filter((district) => district.enabled).length;
    let state: OblastState = "clear";
    if (entry.enabled) state = since && now.getTime() - Date.parse(since) > STANDING_MS ? "standing" : "active";
    else if (districts > 0) state = "partial";
    return { uk: oblast.uk, name: oblast.name, lat: oblast.lat, lon: oblast.lon, state, since: entry.enabled ? since : null, districts, west: Boolean(oblast.west) };
  });
}

// ---------- Telegram channels ----------

export interface TelegramPost {
  id: string;
  url: string;
  time: string;
  text: string;
}

// Reads the public web preview of a Telegram channel (t.me/s/<channel>).
export function parseTelegram(html: string): TelegramPost[] {
  const posts: TelegramPost[] = [];
  for (const chunk of html.split('data-post="').slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const body = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    const time = chunk.match(/<time datetime="([^"]+)"/)?.[1];
    if (!/^[\w]+\/\d+$/.test(id) || body === undefined || !time) continue;
    const text = stripHtml(body.replace(/<br\s*\/?>/g, "\n")).replace(/[ \t]+/g, " ").trim();
    const iso = new Date(time);
    if (!text || Number.isNaN(iso.getTime())) continue;
    posts.push({ id, url: `https://t.me/${id}`, time: iso.toISOString(), text });
  }
  return posts;
}

export const translateUrl = (text: string) =>
  `https://translate.google.com/?sl=auto&tl=en&op=translate&text=${encodeURIComponent(truncate(text, 1500))}`;

export type ThreatKind = "kinzhal" | "ballistic" | "cruise" | "missile" | "bombers" | "kab" | "jet_drone" | "drone" | "other";

const THREATS: Array<{ kind: ThreatKind; pattern: RegExp; label: string }> = [
  { kind: "kinzhal", pattern: /МіГ-31К|МиГ-31К|Міг-31К|Кинджал/iu, label: "MiG-31K airborne: Kinzhal hypersonic missile threat" },
  { kind: "ballistic", pattern: /балістик|балістичн/iu, label: "Ballistic missile threat" },
  { kind: "cruise", pattern: /[Кк]рилат\p{L}* ракет|(?<!\p{L})КР(?!\p{L})/u, label: "Cruise missiles" },
  { kind: "missile", pattern: /ракет|швидкісн\p{L}* ціл/iu, label: "Missile threat" },
  { kind: "bombers", pattern: /Ту-95|Ту-160|Ту-22|стратегічн\p{L}* авіац|Калібр/iu, label: "Russian strategic bombers or missile ships active" },
  { kind: "kab", pattern: /керован\p{L}* авіаційн\p{L}* бомб|(?<!\p{L})КАБ/u, label: "Guided aerial bombs launched" },
  { kind: "jet_drone", pattern: /реактивн\p{L}* БпЛА/iu, label: "Jet-powered attack drone" },
  { kind: "drone", pattern: /БпЛА|шахед|дрон/iu, label: "Attack drones" },
];

export const MISSILE_KINDS: ThreatKind[] = ["kinzhal", "ballistic", "cruise", "missile", "bombers"];

export interface Threat extends TelegramPost {
  kind: ThreatKind;
  label: string;
  missile: boolean;
  regions: Place[];
  translate: string;
}

export function readThreat(post: TelegramPost): Threat {
  const match = THREATS.find((threat) => threat.pattern.test(post.text));
  const kind = match?.kind ?? "other";
  const regions = placesIn(post.text, OBLASTS);
  if (regions.length === 0 && /Чорн\p{L}* мор/u.test(post.text)) regions.push(BLACK_SEA);
  return {
    ...post,
    kind,
    label: match?.label ?? "Air Force update",
    missile: MISSILE_KINDS.includes(kind),
    regions,
    translate: translateUrl(post.text),
  };
}

export interface Interception extends TelegramPost {
  count: number | null;
  regions: Place[];
  summary: string;
  translate: string;
}

const RUSSIAN_NUMBERS: Record<string, number> = {
  один: 1, одного: 1, два: 2, двух: 2, три: 3, трех: 3, трёх: 3, четыре: 4, четырех: 4, четырёх: 4, пять: 5, шесть: 6,
  семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
  пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20,
};

// "...силами ПВО уничтожены семь украинских беспилотных летательных аппаратов
// самолетного типа над территориями Белгородской, Курской областей..."
export function readInterception(post: TelegramPost): Interception | null {
  if (!/(уничтожен|перехвачен|сбит)\p{L}*/iu.test(post.text) || !/ПВО/u.test(post.text)) return null;
  const regions = placesIn(post.text, RUSSIAN_REGIONS);
  if (regions.length === 0) return null;
  const counted = post.text.match(/(?:уничтожен|перехвачен|сбит)\p{L}*\s+(\d[\d\s]*|\p{L}+)/iu)?.[1]?.trim().toLowerCase() ?? "";
  const count = /^\d/.test(counted) ? Number(counted.replace(/\s/g, "")) : (RUSSIAN_NUMBERS[counted] ?? null);
  const weapon = /ракет/iu.test(post.text) && !/беспилот|БПЛА/iu.test(post.text) ? "missiles" : "drones";
  const where = regions.map((region) => region.name).join(", ");
  return {
    ...post,
    count,
    regions,
    summary: `Russian air defence reports ${count ?? "several"} Ukrainian ${weapon} destroyed over ${where}.`,
    translate: translateUrl(post.text),
  };
}

// ---------- the combined picture ----------

export interface AirRaidPicture {
  updatedAt: string;
  oblasts: OblastStatus[];
  activeCount: number;
  threats: Threat[];
  interceptions: Interception[];
  errors: Record<string, string>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function airRaidPicture(now: Date): Promise<AirRaidPicture> {
  const [status, airForce, russia] = await Promise.allSettled([
    getText(ALERT_STATUS_URL),
    getText(AIR_FORCE_URL),
    getText(RUSSIA_MOD_URL),
  ]);
  const errors: Record<string, string> = {};
  const oblasts = status.status === "fulfilled" ? parseAlertStatus(status.value, now) : [];
  if (status.status === "rejected") errors.status = message(status.reason);
  const recent = (post: TelegramPost, window: number) => now.getTime() - Date.parse(post.time) <= window;
  const threats =
    airForce.status === "fulfilled" ? parseTelegram(airForce.value).filter((post) => recent(post, THREAT_WINDOW_MS)).map(readThreat).reverse() : [];
  if (airForce.status === "rejected") errors.airForce = message(airForce.reason);
  const interceptions =
    russia.status === "fulfilled"
      ? parseTelegram(russia.value)
          .filter((post) => recent(post, RUSSIA_WINDOW_MS))
          .map(readInterception)
          .filter((item): item is Interception => item !== null)
          .reverse()
      : [];
  if (russia.status === "rejected") errors.russia = message(russia.reason);
  return {
    updatedAt: now.toISOString(),
    oblasts,
    activeCount: oblasts.filter((oblast) => oblast.state === "active").length,
    threats,
    interceptions,
    errors,
  };
}

const CACHE_KEY = "airraid_cache";
const CACHE_MS = 60_000;

// What the dashboard shows, kept for a minute so open dashboards share one fetch.
export async function cachedAirRaidPicture(db: D1Database, now: Date = new Date()): Promise<AirRaidPicture> {
  const cached = JSON.parse((await getSetting(db, CACHE_KEY)) ?? "null") as AirRaidPicture | null;
  if (cached && now.getTime() - Date.parse(cached.updatedAt) < CACHE_MS) return cached;
  const picture = await airRaidPicture(now);
  await setSetting(db, CACHE_KEY, JSON.stringify(picture));
  return picture;
}

// ---------- alerts ----------

// One name per night of attacks (they run through the night, Kyiv time),
// so every report from it groups into one incident.
export function attackNight(iso: string): string {
  const shifted = new Date(Date.parse(iso) + 2 * HOUR_MS - 12 * HOUR_MS);
  return shifted.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const incidentName = (iso: string) => `Russian air attack on Ukraine, night of ${attackNight(iso)}`;

function nearSite(sites: Site[], places: Place[]): { site: Site; miles: number } | null {
  let best: { site: Site; miles: number } | null = null;
  for (const place of places) {
    const near = nearestSite(sites, place.lat, place.lon, SITE_REACH_MILES);
    if (near && (!best || near.miles < best.miles)) best = near;
  }
  return best;
}

export async function airRaidItems(picture: AirRaidPicture, sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  const active = picture.oblasts.filter((oblast) => oblast.state === "active");
  const nowIso = now.toISOString();

  // A mass raid: many regions under alert at once.
  if (active.length >= MASS_RAID_REGIONS) {
    const west = active.filter((oblast) => oblast.west);
    const severity: Severity = active.length >= MAJOR_RAID_REGIONS || west.length > 0 ? "high" : "medium";
    const start = active.map((oblast) => oblast.since ?? nowIso).sort()[0]!;
    const focus = west[0] ?? active.find((oblast) => oblast.name === "Kyiv") ?? active[0]!;
    const near = nearSite(sites, west.length ? west : active);
    const westNote = west.length
      ? ` Regions on the Polish border are under alert (${west.map((oblast) => oblast.name).join(", ")}); during such attacks Poland often scrambles aircraft and may close airspace near Rzeszów and Lublin.`
      : "";
    items.push(
      await hazardItem({
        key: `airraid:mass:${attackNight(start)}:${severity}`,
        source: "air_raids",
        category: "hazard",
        severity,
        title: `Air raid alert across ${active.length} of ${ALERTABLE_REGIONS} Ukrainian regions`,
        summary: truncate(
          `Air raid alerts are in effect across ${active.length} Ukrainian regions, a sign of a large Russian missile or drone attack: ${active.map((oblast) => oblast.name).join(", ")}.${westNote}`,
          600,
        ),
        incident: incidentName(start),
        url: "https://alerts.in.ua/en",
        author: "Ukraine air raid alert system",
        publishedAt: start,
        place: "Ukraine",
        lat: focus.lat,
        lon: focus.lon,
        site: near?.site.name ?? "",
        distanceMi: near?.miles ?? null,
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        ongoing: true,
      }),
    );
  }

  // A site (or you) inside a region under alert.
  for (const site of sites) {
    const oblast = picture.oblasts
      .map((each) => ({ each, miles: distanceMiles(site.lat, site.lon, each.lat, each.lon) }))
      .sort((a, b) => a.miles - b.miles)[0];
    if (!oblast || oblast.miles > 120 || site.country !== "UA" || oblast.each.state !== "active") continue;
    items.push(
      await hazardItem({
        key: `airraid:site:${site.name}:${oblast.each.since}`,
        source: "air_raids",
        category: "hazard",
        severity: "critical",
        title: `Air raid alert in ${oblast.each.name}: ${site.name}`,
        summary: `An air raid alert is in effect in ${oblast.each.name}, where ${site.name} is. Staff should go to shelter until the all-clear.`,
        incident: incidentName(oblast.each.since ?? nowIso),
        url: "https://alerts.in.ua/en",
        author: "Ukraine air raid alert system",
        publishedAt: oblast.each.since,
        place: oblast.each.name,
        lat: site.lat,
        lon: site.lon,
        site: site.name,
        distanceMi: 0,
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        ongoing: true,
      }),
    );
  }

  // Each missile threat the Air Force reports (drone and bomb posts stay on the map).
  for (const threat of picture.threats.filter((each) => each.missile)) {
    const near = nearSite(sites, threat.regions);
    const where = threat.regions.map((region) => region.name).join(", ");
    items.push(
      await hazardItem({
        key: `uaaf:${threat.id}`,
        source: "air_raids",
        category: "hazard",
        severity: threat.kind === "bombers" ? "medium" : "high",
        title: `${threat.label}${where ? `: ${where}` : ""}`,
        summary: truncate(`Ukrainian Air Force: ${threat.label.toLowerCase()}${where ? ` (${where})` : ""}. Original: "${threat.text}"`, 600),
        incident: incidentName(threat.time),
        url: threat.url,
        author: "Ukrainian Air Force",
        publishedAt: threat.time,
        snippet: threat.text,
        place: where || "Ukraine",
        lat: threat.regions[0]?.lat ?? null,
        lon: threat.regions[0]?.lon ?? null,
        site: near?.site.name ?? "",
        distanceMi: near?.miles ?? null,
        expiresAt: new Date(Date.parse(threat.time) + THREAT_WINDOW_MS).toISOString(),
        ongoing: false,
      }),
    );
  }

  // Drones or missiles shot down over Russia, when a site (or you) is nearby.
  for (const interception of picture.interceptions) {
    const near = nearSite(sites, interception.regions);
    if (!near || near.miles > 150) continue;
    items.push(
      await hazardItem({
        key: `ruair:${interception.id}`,
        source: "air_raids",
        category: "hazard",
        severity: "medium",
        title: `Drone attack reported over ${interception.regions.map((region) => region.name).join(", ")}`,
        summary: interception.summary,
        incident: `Ukrainian drone attack on Russia, ${attackNight(interception.time)}`,
        url: interception.url,
        author: "Russian Defence Ministry",
        publishedAt: interception.time,
        snippet: interception.text,
        place: interception.regions[0]!.name,
        lat: interception.regions[0]!.lat,
        lon: interception.regions[0]!.lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(Date.parse(interception.time) + RUSSIA_WINDOW_MS).toISOString(),
        ongoing: false,
      }),
    );
  }
  return items;
}

export async function airRaidHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  const picture = await airRaidPicture(now);
  // With no source answering there is nothing to judge; report that as a failure.
  if (Object.keys(picture.errors).length === 3) throw new Error(Object.values(picture.errors).join("; "));
  return airRaidItems(picture, sites, now);
}
