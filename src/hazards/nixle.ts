// Nixle carries messages from local police, sheriffs and emergency agencies
// (it is run by Everbridge). Its public ZIP-code page lists the latest
// messages from every agency serving that ZIP. Agencies use Nixle's own
// "Alert" and "Advisory" labels loosely, so posts are judged by what they say.

import { stripHtml, truncate } from "../text";
import type { HazardItem, Severity } from "../types";
import { getText } from "../sources/http";
import { hazardItem, HOUR_MS } from "./common";
import { MY_SITE_NAME, type MyLocation } from "../me";

const MAX_AGE_MS = 24 * HOUR_MS;
const EXPIRES_AFTER_MS = 12 * HOUR_MS;

export interface NixlePost {
  id: string;
  level: string;
  agency: string;
  text: string;
  url: string;
  ageMs: number;
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
  month: 30 * 24 * HOUR_MS,
  year: 365 * 24 * HOUR_MS,
};

// "Entered: 2 days, 20 hours ago" → milliseconds.
export function parseAge(text: string): number | null {
  const parts = [...text.matchAll(/(\d+)\s+(second|minute|hour|day|week|month|year)s?/g)];
  if (parts.length === 0) return /just now|moments? ago/i.test(text) ? 0 : null;
  return parts.reduce((sum, [, count, unit]) => sum + Number(count) * UNIT_MS[unit!]!, 0);
}

export function parseNixleZip(html: string): NixlePost[] {
  const posts: NixlePost[] = [];
  const pattern =
    /<li id="pub_(\d+)"[\s\S]*?<span class="priority (\w+)">[\s\S]*?<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p class="time">([\s\S]*?)<\/p>\s*<p>([\s\S]*?)<a href="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    const [, id, level, agency, time, text, url] = match;
    const ageMs = parseAge(time!);
    if (ageMs === null) continue;
    let link: string;
    try {
      const parsed = new URL(url!);
      link = parsed.protocol === "https:" && /(^|\.)nixle\.(us|com)$/.test(parsed.hostname) ? parsed.href : `https://local.nixle.com/`;
    } catch {
      link = "https://local.nixle.com/";
    }
    posts.push({ id: id!, level: level!, agency: stripHtml(agency!), text: stripHtml(text!), url: link, ageMs });
  }
  return posts;
}

export function nixleSeverity(text: string): Severity | null {
  if (/active shooter|shooting|shots fired|gunman|gunfire|armed (suspect|man|woman|person)|barricad|stabbing|explosi|\bbomb\b|shelter[- ]in[- ]place|evacuat|lockdown|hostage|collapse/i.test(text)) return "high";
  if (/police activity|avoid the area|suspicious (package|device|item)|hazmat|hazardous material|gas leak|\bfire\b|closed due to police/i.test(text)) return "medium";
  return null;
}

export async function nixlePostsToItems(posts: NixlePost[], me: MyLocation, now: Date): Promise<HazardItem[]> {
  const items: HazardItem[] = [];
  for (const post of posts) {
    if (post.ageMs > MAX_AGE_MS) continue;
    const severity = nixleSeverity(post.text);
    if (!severity) continue;
    const posted = new Date(now.getTime() - post.ageMs).toISOString();
    items.push(
      await hazardItem({
        key: `nixle:${post.id}`,
        source: "nixle",
        category: "physical",
        severity,
        title: truncate(post.text, 200),
        summary: truncate(`${post.agency} posted on Nixle for the area around you (ZIP ${me.postcode}): "${post.text}"`, 400),
        incident: truncate(`${post.agency}: ${post.text}`, 120),
        url: post.url,
        author: post.agency,
        publishedAt: posted,
        place: [me.city, me.region].filter(Boolean).join(", "),
        // Nixle gives the agency, not the spot, so no position or distance is claimed.
        lat: null,
        lon: null,
        site: MY_SITE_NAME,
        distanceMi: null,
        expiresAt: new Date(Date.parse(posted) + EXPIRES_AFTER_MS).toISOString(),
        ongoing: false,
      }),
    );
  }
  return items;
}

export async function nixleHazards(me: MyLocation | null, now: Date): Promise<HazardItem[]> {
  if (!me || me.country !== "US" || !/^\d{5}$/.test(me.postcode)) return [];
  const html = await getText(`https://local.nixle.com/zipcode/${me.postcode}/`);
  return nixlePostsToItems(parseNixleZip(html), me, now);
}
