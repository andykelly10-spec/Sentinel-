// The ops board's situational feeds: national threat levels, threats aimed
// at the brands, natural hazards beyond the map layers, markets and air
// quality at sites. Each feed is small, read on the server and combined into
// one answer that the dashboard asks for every few minutes. The two large
// catalogues (CISA's exploited vulnerabilities and Have I Been Pwned's
// breaches) are passed straight to the browser instead; see feeds.ts.

import { getSetting, setSetting } from "./db";
import { decodeEntities, stripHtml, truncate } from "./text";
import type { Site } from "./types";
import { getText } from "./sources/http";
import { WATCHLIST } from "./watchlist";

export const MI5_URL = "https://www.mi5.gov.uk/UKThreatLevel/UKThreatLevel.xml";
export const RANSOMWARE_URL = "https://api.ransomware.live/v2/recentvictims";
export const OPENPHISH_URL = "https://raw.githubusercontent.com/openphish/public_feed/refs/heads/main/feed.txt";
export const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
export const STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json";
export const VOLCANOES_URL = "https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes";
const yahoo = (symbol: string) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=15m`;

// The company's own ticker after the merger, a peer and the market as a whole.
export const MARKETS = [
  { symbol: "PSKY", name: "Paramount Skydance" },
  { symbol: "NFLX", name: "Netflix" },
  { symbol: "^GSPC", name: "S&P 500" },
];

// ---------- national threat levels ----------

export const UK_LEVELS = ["LOW", "MODERATE", "SUBSTANTIAL", "SEVERE", "CRITICAL"] as const;

export interface UkThreat {
  level: string;
  northernIreland: string | null;
}

export function parseMi5(xml: string): UkThreat | null {
  const description = decodeEntities(stripHtml(decodeEntities(xml.match(/<item>[\s\S]*?<description>([\s\S]*?)<\/description>/)?.[1] ?? "")));
  const title = xml.match(/<item>[\s\S]*?<title>([^<]*)<\/title>/)?.[1] ?? "";
  const level = (title.match(/Threat Level:\s*([A-Z]+)/i)?.[1] ?? description.match(/national threat level is\s+([A-Z]+)/i)?.[1] ?? "").toUpperCase();
  if (!(UK_LEVELS as readonly string[]).includes(level)) return null;
  const ni = description.match(/Northern Ireland[^.]*?is\s+([A-Z]+)/i)?.[1]?.toUpperCase() ?? null;
  return { level, northernIreland: ni };
}

// ---------- threats aimed at the brands ----------

// Names a ransomware group might list a company under. Kept specific: a bare
// "Discovery" or "Max" would match unrelated firms.
const BRAND_PATTERN =
  /\b(Paramount (Skydance|Global|Pictures|Plus|\+)|Skydance|Warner ?Bros|Warner Brothers|Warner ?Media|WarnerMedia|HBO|CBS (Broadcasting|News|Interactive|Studios|Sports|Corporation)|Nickelodeon|Showtime Networks|Pluto ?TV|Turner Broadcasting|Comedy Central|Discovery Communications|Discovery,? Inc)\b/i;

const officialDomain = (host: string) => WATCHLIST.domainWatch.official.some((domain) => host === domain || host.endsWith(`.${domain}`));

export interface RansomwareVictim {
  victim: string;
  group: string;
  country: string;
  sector: string;
  discovered: string;
  url: string;
  brand: boolean;
}

export function parseRansomware(body: string): RansomwareVictim[] {
  return (JSON.parse(body) as Array<Record<string, unknown>>).map((entry) => {
    const victim = String(entry.victim ?? "").trim();
    const domain = String(entry.domain ?? "").toLowerCase().replace(/^www\./, "");
    const text = `${victim} ${String(entry.description ?? "").slice(0, 300)}`;
    return {
      victim,
      group: String(entry.group ?? ""),
      country: String(entry.country ?? ""),
      sector: String(entry.activity ?? ""),
      discovered: String(entry.discovered ?? entry.attackdate ?? ""),
      url: typeof entry.url === "string" && entry.url.startsWith("https://www.ransomware.live/") ? entry.url : "https://www.ransomware.live/",
      brand: BRAND_PATTERN.test(victim) || (domain !== "" && officialDomain(domain)) || BRAND_PATTERN.test(text.slice(0, 120)),
    };
  });
}

export interface PhishingHit {
  url: string;
  host: string;
  brand: string;
}

// Live phishing URLs whose address uses a brand name, on a domain the company does not own.
export function phishingHits(feed: string): { total: number; hits: PhishingHit[] } {
  const lines = feed.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\//.test(line));
  const hits: PhishingHit[] = [];
  for (const line of lines) {
    let host: string;
    try {
      host = new URL(line).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (officialDomain(host)) continue;
    const squashed = line.toLowerCase().replace(/[^a-z0-9]/g, "");
    const token = WATCHLIST.domainWatch.tokens.find(({ term, strict }) => squashed.includes(term) && (!strict || /login|signin|verify|account|secure|update|billing|support/.test(squashed)));
    if (token) hits.push({ url: truncate(line, 200), host, brand: token.term });
  }
  return { total: lines.length, hits };
}

// ---------- natural hazards ----------

export interface SpaceWeather {
  kp: number;
  scale: string;
  series: number[];
  at: string;
}

// NOAA's geomagnetic storm scale: Kp 5 is G1 (minor) up to Kp 9 at G5 (extreme).
export function geomagneticScale(kp: number): string {
  return kp >= 9 ? "G5" : kp >= 8 ? "G4" : kp >= 7 ? "G3" : kp >= 6 ? "G2" : kp >= 5 ? "G1" : "G0";
}

export function parseKp(body: string): SpaceWeather | null {
  const rows = (JSON.parse(body) as Array<{ time_tag?: string; Kp?: number }>).filter((row) => typeof row.Kp === "number");
  const last = rows.at(-1);
  if (!last) return null;
  return { kp: last.Kp!, scale: geomagneticScale(last.Kp!), series: rows.slice(-24).map((row) => row.Kp!), at: `${last.time_tag}Z` };
}

export interface Storm {
  name: string;
  kind: string;
  windKt: number | null;
  lat: number | null;
  lon: number | null;
  url: string;
}

const STORM_KINDS: Record<string, string> = { TD: "Tropical depression", TS: "Tropical storm", HU: "Hurricane", MH: "Major hurricane", STS: "Subtropical storm", STD: "Subtropical depression", PTC: "Potential tropical cyclone" };

export function parseStorms(body: string): Storm[] {
  return ((JSON.parse(body) as { activeStorms?: Array<Record<string, unknown>> }).activeStorms ?? []).map((storm) => ({
    name: String(storm.name ?? "Unnamed"),
    kind: STORM_KINDS[String(storm.classification)] ?? String(storm.classification ?? "Storm"),
    windKt: Number.isFinite(Number(storm.intensity)) ? Number(storm.intensity) : null,
    lat: Number.isFinite(Number(storm.latitudeNumeric)) ? Number(storm.latitudeNumeric) : null,
    lon: Number.isFinite(Number(storm.longitudeNumeric)) ? Number(storm.longitudeNumeric) : null,
    url: "https://www.nhc.noaa.gov/",
  }));
}

export interface Volcano {
  name: string;
  level: string;
  colour: string;
  observatory: string;
}

export function parseVolcanoes(body: string): Volcano[] {
  return (JSON.parse(body) as Array<Record<string, unknown>>).map((volcano) => ({
    name: String(volcano.volcano_name ?? ""),
    level: String(volcano.alert_level ?? ""),
    colour: String(volcano.color_code ?? ""),
    observatory: String(volcano.obs_abbr ?? "").toUpperCase(),
  }));
}

// ---------- markets ----------

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  series: number[];
}

export function parseQuote(body: string, symbol: string, name: string): Quote | null {
  const result = (JSON.parse(body) as { chart?: { result?: Array<Record<string, any>> } }).chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  const previous = Number(meta?.chartPreviousClose ?? meta?.previousClose);
  if (!Number.isFinite(price) || !Number.isFinite(previous) || previous === 0) return null;
  const closes = ((result?.indicators?.quote?.[0]?.close ?? []) as Array<number | null>).filter((value): value is number => typeof value === "number");
  return { symbol, name, price, changePct: Math.round(((price - previous) / previous) * 1000) / 10, series: closes.slice(-40) };
}

// ---------- air quality ----------

export interface AirQuality {
  site: string;
  aqi: number;
}

async function airQuality(sites: Site[]): Promise<AirQuality[]> {
  const chosen = sites.filter((site) => site.priority).slice(0, 12);
  if (!chosen.length) return [];
  const lat = chosen.map((site) => site.lat.toFixed(3)).join(",");
  const lon = chosen.map((site) => site.lon.toFixed(3)).join(",");
  const body = JSON.parse(await getText(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi`));
  const rows = (Array.isArray(body) ? body : [body]) as Array<{ current?: { us_aqi?: number } }>;
  return rows
    .map((row, index) => ({ site: chosen[index]!.name, aqi: Number(row.current?.us_aqi) }))
    .filter((entry) => Number.isFinite(entry.aqi))
    .sort((a, b) => b.aqi - a.aqi);
}

// ---------- the combined board ----------

export interface Intel {
  updatedAt: string;
  ukThreat: UkThreat | null;
  ransomware: { day: number; groups: Array<{ name: string; count: number }>; latest: RansomwareVictim[]; brand: RansomwareVictim[] } | null;
  phishing: { total: number; hits: PhishingHit[] } | null;
  space: SpaceWeather | null;
  storms: Storm[] | null;
  volcanoes: Volcano[] | null;
  markets: Quote[];
  air: AirQuality[] | null;
  errors: Record<string, string>;
}

const CACHE_KEY = "intel_cache";
const CACHE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function buildIntel(sites: Site[], now: Date): Promise<Intel> {
  const errors: Record<string, string> = {};
  const attempt = async <T>(name: string, task: () => Promise<T>): Promise<T | null> => {
    try {
      return await task();
    } catch (error) {
      errors[name] = message(error);
      return null;
    }
  };
  const [ukThreat, victims, phishing, space, storms, volcanoes, air, ...quotes] = await Promise.all([
    attempt("ukThreat", async () => parseMi5(await getText(MI5_URL))),
    attempt("ransomware", async () => parseRansomware(await getText(RANSOMWARE_URL, 20_000))),
    attempt("phishing", async () => phishingHits(await getText(OPENPHISH_URL))),
    attempt("space", async () => parseKp(await getText(KP_URL))),
    attempt("storms", async () => parseStorms(await getText(STORMS_URL))),
    attempt("volcanoes", async () => parseVolcanoes(await getText(VOLCANOES_URL))),
    attempt("air", () => airQuality(sites)),
    ...MARKETS.map((market) => attempt(`market:${market.symbol}`, async () => parseQuote(await getText(yahoo(market.symbol)), market.symbol, market.name))),
  ]);
  const recent = (victims ?? []).filter((victim) => now.getTime() - Date.parse(victim.discovered) <= DAY_MS);
  const groups = new Map<string, number>();
  for (const victim of recent) groups.set(victim.group, (groups.get(victim.group) ?? 0) + 1);
  return {
    updatedAt: now.toISOString(),
    ukThreat,
    ransomware: victims
      ? {
          day: recent.length,
          groups: [...groups.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5),
          latest: victims.slice(0, 8),
          brand: victims.filter((victim) => victim.brand),
        }
      : null,
    phishing: phishing ? { total: phishing.total, hits: phishing.hits.slice(0, 20) } : null,
    space,
    storms,
    volcanoes,
    markets: quotes.filter((quote): quote is Quote => quote !== null),
    air,
    errors,
  };
}

export async function cachedIntel(db: D1Database, sites: Site[], now: Date = new Date()): Promise<Intel> {
  const cached = JSON.parse((await getSetting(db, CACHE_KEY)) ?? "null") as Intel | null;
  if (cached && now.getTime() - Date.parse(cached.updatedAt) < CACHE_MS) return cached;
  const intel = await buildIntel(sites, now);
  await setSetting(db, CACHE_KEY, JSON.stringify(intel));
  return intel;
}
