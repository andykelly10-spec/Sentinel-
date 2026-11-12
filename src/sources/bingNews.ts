import { stripHtml, truncate } from "../text";
import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";
import { rssItems, tagText } from "./rss";

// Bing wraps each article in a click-tracking link; the article is in `url`.
function articleUrl(link: string): string {
  try {
    return new URL(link).searchParams.get("url") ?? link;
  } catch {
    return link;
  }
}

export function parseBingNewsRss(xml: string): RawItem[] {
  return rssItems(xml).map((block) => ({
    source: "bing_news",
    url: articleUrl(tagText(block, "link")),
    title: tagText(block, "title"),
    snippet: truncate(stripHtml(tagText(block, "description")), 600),
    author: tagText(block, "News:Source"),
    publishedAt: toIso(tagText(block, "pubDate")),
  }));
}

// Each response holds about a dozen articles, so every term gets its own request.
export async function fetchBingNews(terms: string[]): Promise<RawItem[]> {
  const pages = await Promise.all(
    quoted(terms).map((phrase) =>
      getText(
        `https://www.bing.com/news/search?q=${encodeURIComponent(phrase)}&format=rss&qft=${encodeURIComponent('sortbydate="1"')}`,
      ),
    ),
  );
  return pages.flatMap(parseBingNewsRss);
}
