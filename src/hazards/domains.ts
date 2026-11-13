import { getSetting, setSetting } from "../db";
import type { HazardItem } from "../types";
import { getText } from "../sources/http";
import { WATCHLIST } from "../watchlist";
import { hazardItem } from "./common";
import type { HazardCheck } from "./index";

// Searched a couple at a time, because the certificate log search is slow.
export const TOKENS_PER_RUN = 2;
const SETTING = "domain_rotation";

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "com.au", "net.au", "co.jp", "com.br", "com.mx", "co.in", "co.nz", "com.sg", "com.hk",
  "co.za", "com.ar", "com.co", "com.tr",
]);

// Free hosting where every customer gets a subdomain of the same name.
const PLATFORM_SUFFIXES = new Set([
  "pages.dev", "workers.dev", "vercel.app", "netlify.app", "github.io", "web.app", "firebaseapp.com", "herokuapp.com",
  "azurewebsites.net", "blogspot.com", "wixsite.com", "weebly.com", "glitch.me", "onrender.com", "ngrok-free.app",
  "ngrok.io", "myshopify.com", "square.site", "framer.app", "webflow.io", "carrd.co",
]);

const PHISHING_WORDS = [
  "login", "log-in", "signin", "sign-in", "verify", "verification", "account", "secure", "support", "billing",
  "payment", "update", "activate", "activation", "auth", "sso", "password", "reset", "renew", "subscription",
  "refund", "helpdesk", "giveaway", "promo", "gift", "free",
];

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function registeredDomain(name: string): string {
  const labels = name.split(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) || PLATFORM_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

interface CertRow {
  name_value?: string;
  not_before?: string;
}

export interface Lookalike {
  domain: string;
  token: string;
  names: string[];
  firstSeen: string;
  words: string[];
}

export function findLookalikes(body: string, token: string, official: string[]): Lookalike[] {
  const officialSet = new Set(official);
  const found = new Map<string, Lookalike>();
  for (const row of JSON.parse(body) as CertRow[]) {
    for (const raw of (row.name_value ?? "").split("\n")) {
      const name = raw.trim().toLowerCase().replace(/^\*\./, "");
      if (!DOMAIN.test(name) || !name.includes(token)) continue;
      const domain = registeredDomain(name);
      if (officialSet.has(domain)) continue;
      const entry = found.get(domain) ?? { domain, token, names: [], firstSeen: row.not_before ?? "", words: [] };
      if (!entry.names.includes(name)) entry.names.push(name);
      if (row.not_before && row.not_before < entry.firstSeen) entry.firstSeen = row.not_before;
      found.set(domain, entry);
    }
  }
  for (const entry of found.values()) {
    entry.words = PHISHING_WORDS.filter((word) => entry.names.some((name) => name.includes(word)));
  }
  return [...found.values()];
}

export async function lookalikeItem(entry: Lookalike, strict: boolean): Promise<HazardItem | null> {
  // A brand that is also a common word only counts with a phishing word beside it.
  if (strict && entry.words.length === 0) return null;
  const date = entry.firstSeen.slice(0, 10);
  const names = entry.names.slice(0, 6).join(", ") + (entry.names.length > 6 ? ` and ${entry.names.length - 6} more` : "");
  return hazardItem({
    key: `domain:${entry.domain}`,
    source: "domains",
    category: "cyber",
    severity: entry.words.length ? "medium" : "low",
    title: `Lookalike domain: ${entry.domain}`,
    summary:
      `A security certificate${date ? ` issued on ${date}` : ""} covers ${names}, which uses the "${entry.token}" name but is not an official company domain.` +
      (entry.words.length ? ` Words like "${entry.words[0]}" in the name are typical of phishing pages.` : ""),
    incident: `Lookalike domain: ${entry.domain}`,
    url: `https://crt.sh/?q=${encodeURIComponent(entry.domain)}`,
    author: "Certificate transparency logs (crt.sh)",
    publishedAt: entry.firstSeen ? `${entry.firstSeen}Z` : null,
    snippet: entry.names.join(" "),
    expiresAt: null,
    ongoing: false,
  });
}

export async function domainHazards(db: D1Database): Promise<HazardCheck> {
  const { tokens, official } = WATCHLIST.domainWatch;
  const start = Number((await getSetting(db, SETTING)) ?? "0") % tokens.length;
  const batch = Array.from({ length: Math.min(TOKENS_PER_RUN, tokens.length) }, (_, i) => tokens[(start + i) % tokens.length]!);
  const pages = await Promise.allSettled(
    batch.map(({ term }) =>
      getText(`https://crt.sh/?q=${encodeURIComponent(`%${term}%`)}&output=json&exclude=expired&deduplicate=Y`, 45_000),
    ),
  );
  const advance = () => setSetting(db, SETTING, String((start + batch.length) % tokens.length));
  // The search service is often overloaded; move on to other names either way
  // rather than retrying the same ones every hour.
  if (pages.every((page) => page.status === "rejected")) {
    await advance();
    throw (pages[0] as PromiseRejectedResult).reason;
  }
  const items: HazardItem[] = [];
  for (const [index, page] of pages.entries()) {
    if (page.status === "rejected") continue;
    for (const entry of findLookalikes(page.value, batch[index]!.term, official)) {
      const item = await lookalikeItem(entry, batch[index]!.strict);
      if (item) items.push(item);
    }
  }
  return { items, commit: advance };
}
