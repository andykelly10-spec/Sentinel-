// Alerts from the ops board's feeds: threats aimed at the brands (ransomware
// leak-site claims, live phishing sites, data breaches), a change in the UK
// terrorism threat level, and tropical storms approaching a site.

import { getSetting, setSetting } from "../db";
import { truncate } from "../text";
import type { HazardItem, Severity, Site } from "../types";
import { getText } from "../sources/http";
import { MI5_URL, OPENPHISH_URL, parseMi5, parseRansomware, parseStorms, phishingHits, RANSOMWARE_URL, STORMS_URL, UK_LEVELS } from "../intel";
import { WATCHLIST } from "../watchlist";
import type { HazardCheck } from ".";
import { hazardItem, HOUR_MS, miles, nearestSite } from "./common";

export const BREACHES_URL = "https://haveibeenpwned.com/api/v3/breaches";

// Breaches of the company's own domains. The catalogue is over a megabyte, so
// it is searched as text for each domain rather than parsed whole.
export function brandBreaches(text: string): Array<{ name: string; domain: string; added: string; count: number }> {
  const found = [];
  for (const domain of WATCHLIST.domainWatch.official) {
    const at = text.indexOf(`"Domain":"${domain}"`);
    if (at < 0) continue;
    const start = text.lastIndexOf("{", at);
    const record = text.slice(start, text.indexOf("}", at) + 1);
    const field = (name: string) => record.match(new RegExp(`"${name}":"([^"]*)"`))?.[1] ?? "";
    found.push({ name: field("Title") || field("Name"), domain, added: field("AddedDate"), count: Number(record.match(/"PwnCount":(\d+)/)?.[1] ?? 0) });
  }
  return found;
}

// Hourly: ransomware claims, phishing and breaches naming the brands.
export async function brandThreatHazards(now: Date): Promise<HazardItem[]> {
  const [victims, phishing, breaches] = await Promise.allSettled([
    getText(RANSOMWARE_URL, 20_000).then(parseRansomware),
    getText(OPENPHISH_URL).then(phishingHits),
    getText(BREACHES_URL, 20_000).then(brandBreaches),
  ]);
  if ([victims, phishing, breaches].every((result) => result.status === "rejected")) {
    throw new Error("No brand-threat feed answered");
  }
  const items: HazardItem[] = [];
  if (victims.status === "fulfilled") {
    for (const victim of victims.value.filter((each) => each.brand)) {
      items.push(
        await hazardItem({
          key: `ransomware:${victim.group}:${victim.victim}`,
          source: "brand_threats",
          category: "cyber",
          severity: "critical",
          title: `Ransomware group ${victim.group} claims ${victim.victim}`,
          summary: `The ${victim.group} ransomware group lists "${victim.victim}" on its leak site${victim.country ? ` (${victim.country})` : ""}. Leak-site claims are made by the criminals themselves and are not confirmed; check with the security team.`,
          incident: `Ransomware claim: ${victim.victim}`,
          url: victim.url,
          author: "ransomware.live",
          publishedAt: victim.discovered || now.toISOString(),
          expiresAt: null,
          ongoing: false,
        }),
      );
    }
  }
  if (phishing.status === "fulfilled") {
    for (const hit of phishing.value.hits) {
      items.push(
        await hazardItem({
          key: `phishing:${hit.host}`,
          source: "brand_threats",
          category: "cyber",
          severity: "medium",
          title: `Phishing site using "${hit.brand}": ${hit.host}`,
          summary: `OpenPhish lists a live phishing page at ${hit.host} that uses the name "${hit.brand}". It may be collecting staff or customer logins; consider a takedown request and a warning to staff.`,
          incident: `Phishing: ${hit.host}`,
          url: "https://openphish.com/",
          author: "OpenPhish",
          snippet: hit.url,
          publishedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 7 * 24 * HOUR_MS).toISOString(),
          ongoing: true,
        }),
      );
    }
  }
  if (breaches.status === "fulfilled") {
    for (const breach of breaches.value) {
      items.push(
        await hazardItem({
          key: `breach:${breach.domain}:${breach.added}`,
          source: "brand_threats",
          category: "cyber",
          severity: "high",
          title: `Data breach listed for ${breach.domain}: ${breach.name}`,
          summary: `Have I Been Pwned lists a breach of ${breach.domain} ("${breach.name}") affecting ${breach.count.toLocaleString("en-US")} accounts, added ${breach.added.slice(0, 10)}.`,
          incident: `Data breach: ${breach.domain}`,
          url: "https://haveibeenpwned.com/PwnedWebsites",
          author: "Have I Been Pwned",
          publishedAt: breach.added || now.toISOString(),
          expiresAt: null,
          ongoing: false,
        }),
      );
    }
  }
  return items;
}

const UK_SETTING = "uk_threat_level";

// Every run: an alert when the UK national terrorism threat level changes.
export async function threatLevelHazards(db: D1Database, now: Date): Promise<HazardCheck> {
  const current = parseMi5(await getText(MI5_URL));
  if (!current) throw new Error("UK threat level not found");
  const previous = await getSetting(db, UK_SETTING);
  const commit = async () => setSetting(db, UK_SETTING, current.level);
  if (!previous || previous === current.level) return { items: [], commit };
  const raised = UK_LEVELS.indexOf(current.level as (typeof UK_LEVELS)[number]) > UK_LEVELS.indexOf(previous as (typeof UK_LEVELS)[number]);
  const severity: Severity = raised ? (current.level === "CRITICAL" ? "critical" : "high") : "medium";
  const item = await hazardItem({
    key: `uk-threat:${previous}:${current.level}:${now.toISOString().slice(0, 10)}`,
    source: "threat_levels",
    category: "hazard",
    severity,
    title: `UK terrorism threat level ${raised ? "raised" : "lowered"} to ${current.level}`,
    summary: `MI5 has ${raised ? "raised" : "lowered"} the UK national terrorism threat level from ${previous} to ${current.level}${current.level === "CRITICAL" ? ", meaning an attack is highly likely in the near future" : current.level === "SEVERE" ? ", meaning an attack is highly likely" : ""}. This affects the London sites.`,
    incident: `UK threat level ${current.level}`,
    url: "https://www.mi5.gov.uk/threats-and-advice/threat-levels",
    author: "MI5",
    publishedAt: now.toISOString(),
    place: "United Kingdom",
    expiresAt: null,
    ongoing: false,
  });
  return { items: [item], commit };
}

// Every run: tropical storms and hurricanes within 400 miles of a site.
export async function stormHazards(sites: Site[], now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  for (const storm of parseStorms(await getText(STORMS_URL))) {
    if (storm.lat === null || storm.lon === null) continue;
    const near = nearestSite(sites, storm.lat, storm.lon, 400);
    if (!near) continue;
    const severity: Severity = storm.kind === "Major hurricane" || near.miles < 100 ? "critical" : storm.kind === "Hurricane" || near.miles < 200 ? "high" : "medium";
    items.push(
      await hazardItem({
        key: `storm:${storm.name}:${severity}`,
        source: "nhc",
        category: "hazard",
        severity,
        title: `${storm.kind} ${storm.name}, ${miles(near.miles)} from ${near.site.name}`,
        summary: truncate(`${storm.kind} ${storm.name}${storm.windKt ? ` with ${storm.windKt}-knot winds` : ""} is ${miles(near.miles)} from ${near.site.name}. Follow the National Hurricane Center's forecast track and local evacuation orders.`, 400),
        incident: `${storm.kind} ${storm.name}`,
        url: storm.url,
        author: "National Hurricane Center",
        publishedAt: now.toISOString(),
        place: storm.name,
        lat: storm.lat,
        lon: storm.lon,
        site: near.site.name,
        distanceMi: near.miles,
        expiresAt: new Date(now.getTime() + 6 * HOUR_MS).toISOString(),
        ongoing: true,
      }),
    );
  }
  return items;
}
