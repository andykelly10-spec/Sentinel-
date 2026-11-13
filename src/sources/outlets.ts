import { mentionsPlace } from "../geo";
import { normalizeTitle, stripHtml, truncate } from "../text";
import type { RawItem } from "../types";
import { getText, toIso } from "./http";
import { rssItems, tagText } from "./rss";

export interface Outlet {
  id: string;
  name: string;
  url: string;
  // World outlets count only for stories naming a brand or a site's place;
  // local outlets cover a site's area, so any incident story counts.
  scope: "world" | "local";
  region: string;
}

// Every feed here was checked to answer from Cloudflare.
export const OUTLETS: Outlet[] = [
  { id: "bbc-world", name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml", scope: "world", region: "World" },
  { id: "bbc-us", name: "BBC News US & Canada", url: "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml", scope: "world", region: "US" },
  { id: "bbc-uk", name: "BBC News UK", url: "https://feeds.bbci.co.uk/news/uk/rss.xml", scope: "world", region: "UK" },
  { id: "guardian-world", name: "The Guardian", url: "https://www.theguardian.com/world/rss", scope: "world", region: "World" },
  { id: "guardian-us", name: "The Guardian US", url: "https://www.theguardian.com/us-news/rss", scope: "world", region: "US" },
  { id: "aljazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", scope: "world", region: "World" },
  { id: "npr", name: "NPR", url: "https://feeds.npr.org/1001/rss.xml", scope: "world", region: "US" },
  { id: "dw", name: "DW", url: "https://rss.dw.com/xml/rss-en-all", scope: "world", region: "World" },
  { id: "france24", name: "France 24", url: "https://www.france24.com/en/rss", scope: "world", region: "World" },
  { id: "cbc", name: "CBC News", url: "https://www.cbc.ca/webfeed/rss/rss-world", scope: "world", region: "World" },
  { id: "abc-au", name: "ABC News Australia", url: "https://www.abc.net.au/news/feed/2942460/rss.xml", scope: "world", region: "Australia" },
  { id: "nyt-world", name: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", scope: "world", region: "World" },
  { id: "cbs-news", name: "CBS News", url: "https://www.cbsnews.com/latest/rss/main", scope: "world", region: "US" },
  { id: "latimes", name: "Los Angeles Times", url: "https://www.latimes.com/california/rss2.0.xml", scope: "local", region: "Los Angeles" },
  { id: "nbc-la", name: "NBC Los Angeles", url: "https://www.nbclosangeles.com/?rss=y", scope: "local", region: "Los Angeles" },
  { id: "cbs-la", name: "CBS Los Angeles", url: "https://www.cbsnews.com/losangeles/latest/rss/main", scope: "local", region: "Los Angeles" },
  { id: "nbc-washington", name: "NBC Washington", url: "https://www.nbcwashington.com/?rss=y", scope: "local", region: "Washington DC" },
  { id: "wtop", name: "WTOP", url: "https://wtop.com/feed/", scope: "local", region: "Washington DC" },
  { id: "nbc-ny", name: "NBC New York", url: "https://www.nbcnewyork.com/?rss=y", scope: "local", region: "New York" },
  { id: "nypost-metro", name: "New York Post", url: "https://nypost.com/metro/feed/", scope: "local", region: "New York" },
  { id: "nyt-nyregion", name: "The New York Times (New York)", url: "https://rss.nytimes.com/services/xml/rss/nyt/NYRegion.xml", scope: "local", region: "New York" },
  { id: "cbs-ny", name: "CBS New York", url: "https://www.cbsnews.com/newyork/latest/rss/main", scope: "local", region: "New York" },
  { id: "standard", name: "Evening Standard", url: "https://www.standard.co.uk/news/london/rss", scope: "local", region: "London" },
  { id: "bbc-london", name: "BBC News London", url: "https://feeds.bbci.co.uk/news/england/london/rss.xml", scope: "local", region: "London" },
];

export interface Headline {
  outlet: string;
  region: string;
  scope: Outlet["scope"];
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
}

export function parseOutlet(xml: string, outlet: Outlet): Headline[] {
  return rssItems(xml).map((block) => ({
    outlet: outlet.name,
    region: outlet.region,
    scope: outlet.scope,
    title: stripHtml(tagText(block, "title")),
    url: tagText(block, "link"),
    summary: truncate(stripHtml(tagText(block, "description")), 600),
    publishedAt: toIso(tagText(block, "pubDate") || tagText(block, "dc:date")),
  }));
}

export async function fetchOutlet(outlet: Outlet): Promise<Headline[]> {
  return parseOutlet(await getText(outlet.url), outlet);
}

function mentionsAny(text: string, phrases: string[]): boolean {
  const normalized = ` ${normalizeTitle(text)} `;
  return phrases.some((phrase) => normalized.includes(` ${normalizeTitle(phrase)} `));
}

export interface StoryFilter {
  brandTerms: string[];
  incidentTerms: string[];
  places: string[];
}

// Only stories that could become alerts are passed on, which keeps the
// classifier from reading every headline in the world.
export function relevantStory(story: Headline, filter: StoryFilter): boolean {
  const text = `${story.title} ${story.summary}`;
  if (mentionsAny(text, filter.brandTerms)) return true;
  if (!mentionsAny(text, filter.incidentTerms)) return false;
  return story.scope === "local" || mentionsPlace(text, filter.places);
}

export async function fetchOutletStories(outlets: Outlet[], filter: StoryFilter): Promise<RawItem[]> {
  const pages = await Promise.all(outlets.map(fetchOutlet));
  return pages.flat().filter((story) => relevantStory(story, filter)).map((story) => ({
    source: "rss",
    url: story.url,
    title: story.title,
    snippet: story.summary,
    author: story.outlet,
    publishedAt: story.publishedAt,
  }));
}
