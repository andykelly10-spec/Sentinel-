import { mentionsPlace } from "../geo";
import { stripHtml, truncate } from "../text";
import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";
import { rssItems, tagText } from "./rss";

// Bing wraps each article in a click-tracking link; the article is in `url`.
function searchUrl(query: string): string {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&qft=${encodeURIComponent('sortbydate="1"')}`;
}

function articleUrl(link: string): string {
  try {
    return new URL(link).searchParams.get("url") ?? link;
  } catch {
    return link;
  }
}

export function parseBingNewsRss(xml: string, source: "bing_news" | "bing_local" = "bing_news"): RawItem[] {
  return rssItems(xml).map((block) => ({
    source,
    url: articleUrl(tagText(block, "link")),
    title: tagText(block, "title"),
    snippet: truncate(stripHtml(tagText(block, "description")), 600),
    author: tagText(block, "News:Source"),
    publishedAt: toIso(tagText(block, "pubDate")),
  }));
}

// Each response holds about a dozen articles, so every term gets its own request.
export async function fetchBingNews(terms: string[]): Promise<RawItem[]> {
  const pages = await Promise.all(quoted(terms).map((phrase) => getText(searchUrl(phrase))));
  return pages.flatMap((page) => parseBingNewsRss(page));
}

// News of violent or disruptive incidents near sites, found two ways: a search
// of each priority area, and searches for urgent terms anywhere that are kept
// only when the report mentions a place belonging to a site. The area must be
// quoted or Bing ignores the incident terms.
export async function fetchBingLocal(
  areas: string[],
  incidentTerms: string[],
  urgentTerms: string[],
  places: string[],
): Promise<RawItem[]> {
  const incidents = `(${quoted(incidentTerms).join(" OR ")})`;
  const [areaPages, urgentPages] = await Promise.all([
    Promise.all(quoted(areas).map((area) => getText(searchUrl(`${area} ${incidents}`)))),
    Promise.all(quoted(urgentTerms).map((term) => getText(searchUrl(term)))),
  ]);
  const nearby = urgentPages
    .flatMap((page) => parseBingNewsRss(page, "bing_local"))
    .filter((item) => mentionsPlace(`${item.title} ${item.snippet}`, places));
  return [...areaPages.flatMap((page) => parseBingNewsRss(page, "bing_local")), ...nearby];
}
