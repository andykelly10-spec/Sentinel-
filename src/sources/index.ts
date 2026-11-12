import { isHttpUrl, normalizeTitle, sha256Hex } from "../text";
import { placeWords, priorityAreas } from "../geo";
import type { Candidate, RawItem, Site, SourceName, SourceResult } from "../types";
import { MAX_AREA_SEARCHES, type Watchlist } from "../watchlist";
import { fetchBingLocal, fetchBingNews } from "./bingNews";
import { fetchBluesky, fetchBlueskyUrgent } from "./bluesky";
import { fetchGoogleNews } from "./googleNews";
import { fetchHackerNews } from "./hackerNews";
import { fetchLemmy } from "./lemmy";

const MAX_AGE_MS = 3 * 86_400_000;

interface Watch extends Watchlist {
  sites: Site[];
}

const SOURCES: Array<{ name: SourceName; fetch: (watch: Watch, now: Date) => Promise<RawItem[]> }> = [
  { name: "bing_news", fetch: (watch) => fetchBingNews(watch.searchTerms) },
  {
    name: "bing_local",
    fetch: async (watch) =>
      watch.sites.length === 0
        ? []
        : fetchBingLocal(
            priorityAreas(watch.sites, MAX_AREA_SEARCHES),
            watch.incidentTerms,
            watch.urgentTerms,
            placeWords(watch.sites),
          ),
  },
  { name: "google_news", fetch: (watch) => fetchGoogleNews(watch.searchTerms) },
  { name: "bluesky", fetch: (watch, now) => fetchBluesky(watch.searchTerms, now) },
  {
    name: "bluesky_urgent",
    fetch: async (watch, now) =>
      watch.sites.length === 0 ? [] : fetchBlueskyUrgent(watch.urgentTerms, placeWords(watch.sites), now),
  },
  { name: "lemmy", fetch: (watch) => fetchLemmy(watch.searchTerms) },
  { name: "hackernews", fetch: (watch, now) => fetchHackerNews(watch.searchTerms, now) },
];

// News stories are syndicated under one headline across many URLs, so a
// distinctive headline is their identity. Social posts are identified by URL.
export async function candidateId(item: RawItem): Promise<string> {
  const title = normalizeTitle(item.title);
  const isNews = item.source === "google_news" || item.source === "bing_news" || item.source === "bing_local";
  const key = isNews && title.length >= 25 ? `t:${title}` : `u:${item.url}`;
  return (await sha256Hex(key)).slice(0, 32);
}

export async function collect(
  watch: Watch,
  now: Date,
): Promise<{ candidates: Candidate[]; sources: SourceResult[] }> {
  const settled = await Promise.allSettled(SOURCES.map((source) => source.fetch(watch, now)));

  const sources: SourceResult[] = [];
  const byId = new Map<string, Candidate>();
  for (const [index, result] of settled.entries()) {
    const name = SOURCES[index]!.name;
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      sources.push({ source: name, count: 0, error: message });
      continue;
    }
    const usable = result.value.filter(
      (item) =>
        item.title !== "" &&
        isHttpUrl(item.url) &&
        (item.publishedAt === null || now.getTime() - Date.parse(item.publishedAt) <= MAX_AGE_MS),
    );
    sources.push({ source: name, count: usable.length, error: null });
    for (const item of usable) {
      const id = await candidateId(item);
      if (!byId.has(id)) byId.set(id, { ...item, id });
    }
  }
  return { candidates: [...byId.values()], sources };
}
