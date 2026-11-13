import { getSetting, setSetting } from "../db";
import { decodeEntities } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS } from "./common";
import type { HazardCheck } from "./index";

// State Department names for the countries sites are most likely to be in.
const COUNTRY_NAMES: Record<string, string[]> = {
  AE: ["United Arab Emirates"],
  AR: ["Argentina"],
  AT: ["Austria"],
  AU: ["Australia"],
  BE: ["Belgium"],
  BR: ["Brazil"],
  CA: ["Canada"],
  CH: ["Switzerland"],
  CL: ["Chile"],
  CN: ["Mainland China, Hong Kong & Macau", "China"],
  CO: ["Colombia"],
  CZ: ["Czechia", "Czech Republic"],
  DE: ["Germany"],
  DK: ["Denmark"],
  EG: ["Egypt"],
  ES: ["Spain"],
  FR: ["France"],
  GB: ["United Kingdom"],
  GR: ["Greece"],
  HK: ["Hong Kong", "Mainland China, Hong Kong & Macau"],
  HU: ["Hungary"],
  ID: ["Indonesia"],
  IE: ["Ireland"],
  IL: ["Israel, the West Bank and Gaza", "Israel"],
  IN: ["India"],
  IT: ["Italy"],
  JP: ["Japan"],
  KR: ["South Korea", "Korea, South"],
  MX: ["Mexico"],
  MY: ["Malaysia"],
  NL: ["Netherlands", "The Netherlands"],
  NO: ["Norway"],
  NZ: ["New Zealand"],
  PE: ["Peru"],
  PH: ["Philippines"],
  PL: ["Poland"],
  PT: ["Portugal"],
  RO: ["Romania"],
  SA: ["Saudi Arabia"],
  SE: ["Sweden"],
  SG: ["Singapore"],
  TH: ["Thailand"],
  TR: ["Türkiye", "Turkey"],
  TW: ["Taiwan"],
  VN: ["Vietnam"],
  ZA: ["South Africa"],
};

const SETTING = "advisory_levels";

export interface Advisory {
  country: string;
  level: number;
  label: string;
  link: string;
  published: string;
}

export function parseAdvisories(xml: string): Advisory[] {
  const advisories: Advisory[] = [];
  for (const [, block = ""] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").trim();
    const match = title.match(/^(.*?)\s+-\s+Level\s+(\d):\s*(.*)$/);
    if (!match) continue;
    advisories.push({
      country: match[1]!.trim(),
      level: Number(match[2]),
      label: match[3]!.trim(),
      link: (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim(),
      published: (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "").trim(),
    });
  }
  return advisories;
}

function severityFor(level: number): Severity {
  return level >= 4 ? "high" : level === 3 ? "medium" : "low";
}

// Alerts when the advisory for a country with sites changes level, and the
// first time a country is seen at Level 3 or 4.
export async function advisoryChanges(
  advisories: Advisory[],
  sites: Site[],
  previous: Record<string, number>,
  now: Date,
): Promise<{ items: HazardItem[]; levels: Record<string, number> }> {
  const levels = { ...previous };
  const items: HazardItem[] = [];
  const byName = new Map(advisories.map((advisory) => [advisory.country.toLowerCase(), advisory]));
  for (const code of [...new Set(sites.map((site) => site.country))].sort()) {
    const advisory = (COUNTRY_NAMES[code] ?? []).map((name) => byName.get(name.toLowerCase())).find(Boolean);
    if (!advisory) continue;
    const before = previous[code];
    levels[code] = advisory.level;
    if (before === advisory.level || (before === undefined && advisory.level < 3)) continue;
    const inCountry = sites.filter((site) => site.country === code);
    const change =
      before === undefined ? "" : advisory.level > before ? `, raised from Level ${before}` : `, lowered from Level ${before}`;
    const link = advisory.link.startsWith("https://") ? advisory.link : "https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html";
    items.push(
      await hazardItem({
        key: `advisory:${code}:${advisory.level}:${advisory.published}`,
        source: "travel_advisory",
        category: "hazard",
        severity: before !== undefined && advisory.level < before ? "low" : severityFor(advisory.level),
        title: `${advisory.country} - Level ${advisory.level}: ${advisory.label}`,
        summary: `The US State Department rates ${advisory.country} at Level ${advisory.level} (${advisory.label})${change}. Company sites there: ${inCountry.slice(0, 5).map((site) => site.name).join(", ")}${inCountry.length > 5 ? ` and ${inCountry.length - 5} more` : ""}.`,
        incident: `${advisory.country} travel advisory`,
        url: link,
        author: "US Department of State",
        publishedAt: Number.isNaN(Date.parse(advisory.published)) ? null : new Date(advisory.published).toISOString(),
        place: advisory.country,
        site: inCountry[0]!.name,
        expiresAt: new Date(now.getTime() + 7 * 24 * HOUR_MS).toISOString(),
        ongoing: false,
      }),
    );
  }
  return { items, levels };
}

export async function advisoryHazards(db: D1Database, sites: Site[], now: Date): Promise<HazardCheck> {
  const previous = JSON.parse((await getSetting(db, SETTING)) ?? "{}") as Record<string, number>;
  const advisories = parseAdvisories(await getText("https://travel.state.gov/_res/rss/TAsTWs.xml"));
  const { items, levels } = await advisoryChanges(advisories, sites, previous, now);
  return { items, commit: () => setSetting(db, SETTING, JSON.stringify(levels)) };
}
