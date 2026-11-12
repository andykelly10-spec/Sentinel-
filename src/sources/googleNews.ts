import { decodeEntities } from "../text";
import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";

function tagText(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!match?.[1]) return "";
  const inner = match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(inner).trim();
}

export function parseGoogleNewsRss(xml: string): RawItem[] {
  if (!/<rss[\s>]/.test(xml)) {
    throw new Error("response was not an RSS feed");
  }
  const items: RawItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1] ?? "";
    const publisher = tagText(block, "source");
    let title = tagText(block, "title");
    const suffix = ` - ${publisher}`;
    if (publisher && title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length);
    }
    items.push({
      source: "google_news",
      url: tagText(block, "link"),
      title,
      // The feed's description only repeats the headline as a link.
      snippet: "",
      author: publisher,
      publishedAt: toIso(tagText(block, "pubDate")),
    });
  }
  return items;
}

export async function fetchGoogleNews(terms: string[]): Promise<RawItem[]> {
  const query = `${quoted(terms).join(" OR ")} when:2d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return parseGoogleNewsRss(await getText(url));
}
