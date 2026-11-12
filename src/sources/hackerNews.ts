import { stripHtml, truncate } from "../text";
import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";

interface HnResponse {
  hits?: Array<{
    objectID?: string;
    title?: string | null;
    story_title?: string | null;
    story_text?: string | null;
    comment_text?: string | null;
    author?: string;
    created_at?: string;
  }>;
}

export function parseHackerNews(body: string): RawItem[] {
  const response = JSON.parse(body) as HnResponse;
  return (response.hits ?? []).map((hit) => {
    const isComment = !hit.title;
    return {
      source: "hackernews",
      url: hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : "",
      title: isComment ? `Comment on: ${hit.story_title ?? "Hacker News thread"}` : (hit.title ?? ""),
      snippet: truncate(stripHtml((isComment ? hit.comment_text : hit.story_text) ?? ""), 600),
      author: hit.author ?? "",
      publishedAt: toIso(hit.created_at),
    };
  });
}

// Algolia has no OR operator, so each term is its own request.
export async function fetchHackerNews(terms: string[], now: Date): Promise<RawItem[]> {
  const since = Math.floor(now.getTime() / 1000) - 2 * 86_400;
  const pages = await Promise.all(
    quoted(terms).map((phrase) =>
      getText(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(phrase)}` +
          `&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=50`,
      ),
    ),
  );
  return pages.flatMap(parseHackerNews);
}
