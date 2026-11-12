import { isHttpUrl, normalizeTitle, sha256Hex } from "../text";
import type { Candidate, RawItem, SourceName, SourceResult } from "../types";
import { fetchBingNews } from "./bingNews";
import { fetchBluesky } from "./bluesky";
import { fetchGoogleNews } from "./googleNews";
import { fetchHackerNews } from "./hackerNews";
import { fetchLemmy } from "./lemmy";

const MAX_AGE_MS = 3 * 86_400_000;

const SOURCES: Array<{ name: SourceName; fetch: (terms: string[], now: Date) => Promise<RawItem[]> }> = [
  { name: "bing_news", fetch: fetchBingNews },
  { name: "google_news", fetch: fetchGoogleNews },
  { name: "bluesky", fetch: fetchBluesky },
  { name: "lemmy", fetch: fetchLemmy },
  { name: "hackernews", fetch: fetchHackerNews },
];

// News stories are syndicated under one headline across many URLs, so a
// distinctive headline is their identity. Social posts are identified by URL.
export async function candidateId(item: RawItem): Promise<string> {
  const title = normalizeTitle(item.title);
  const isNews = item.source === "google_news" || item.source === "bing_news";
  const key = isNews && title.length >= 25 ? `t:${title}` : `u:${item.url}`;
  return (await sha256Hex(key)).slice(0, 32);
}

export async function collect(
  terms: string[],
  now: Date,
): Promise<{ candidates: Candidate[]; sources: SourceResult[] }> {
  const settled = await Promise.allSettled(SOURCES.map((source) => source.fetch(terms, now)));

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
