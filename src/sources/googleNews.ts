import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";
import { rssItems, tagText } from "./rss";

export function parseGoogleNewsRss(xml: string): RawItem[] {
  return rssItems(xml).map((block) => {
    const publisher = tagText(block, "source");
    let title = tagText(block, "title");
    const suffix = ` - ${publisher}`;
    if (publisher && title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length);
    }
    return {
      source: "google_news",
      url: tagText(block, "link"),
      title,
      // The feed's description only repeats the headline as a link.
      snippet: "",
      author: publisher,
      publishedAt: toIso(tagText(block, "pubDate")),
    };
  });
}

// Google intermittently refuses requests from shared cloud addresses, so this
// stays a single request per run and is expected to fail some of the time.
export async function fetchGoogleNews(terms: string[]): Promise<RawItem[]> {
  const query = `${quoted(terms).join(" OR ")} when:2d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return parseGoogleNewsRss(await getText(url));
}
