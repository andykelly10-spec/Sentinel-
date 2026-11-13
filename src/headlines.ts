import { getSetting, setSetting } from "./db";
import { isHttpUrl } from "./text";
import { fetchOutlet, OUTLETS, type Headline } from "./sources/outlets";

const CACHE_KEY = "headlines_cache";
const CACHE_MS = 5 * 60_000;
const PER_OUTLET = 12;
const MAX_HEADLINES = 200;

export interface HeadlineList {
  fetchedAt: string;
  headlines: Headline[];
  failed: string[];
}

// The latest stories from every outlet, newest first. Reading all of them
// takes a couple of dozen requests, so the result is kept for a few minutes.
export async function latestHeadlines(db: D1Database, now: Date = new Date()): Promise<HeadlineList> {
  const cached = JSON.parse((await getSetting(db, CACHE_KEY)) ?? "null") as HeadlineList | null;
  if (cached && now.getTime() - Date.parse(cached.fetchedAt) < CACHE_MS) return cached;

  const results = await Promise.allSettled(OUTLETS.map(fetchOutlet));
  const headlines = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value.slice(0, PER_OUTLET) : []))
    .filter((story) => story.title && isHttpUrl(story.url))
    .map(({ summary, ...story }) => ({ ...story, summary: summary.slice(0, 240) }))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, MAX_HEADLINES);
  const list: HeadlineList = {
    fetchedAt: now.toISOString(),
    headlines,
    failed: OUTLETS.filter((_, index) => results[index]!.status === "rejected").map((outlet) => outlet.name),
  };
  await setSetting(db, CACHE_KEY, JSON.stringify(list));
  return list;
}
