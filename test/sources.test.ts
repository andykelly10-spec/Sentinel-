import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateId, collect } from "../src/sources";
import { parseBingNewsRss } from "../src/sources/bingNews";
import { parseBluesky } from "../src/sources/bluesky";
import { parseGoogleNewsRss } from "../src/sources/googleNews";
import { parseHackerNews } from "../src/sources/hackerNews";
import { parseLemmy } from "../src/sources/lemmy";
import type { RawItem } from "../src/types";
import { WATCHLIST } from "../src/watchlist";
import { listSites } from "../src/db";
import { BING_NEWS_RSS, BLUESKY_JSON, createTestDb, GOOGLE_NEWS_RSS, HN_JSON, LEMMY_JSON, NOW, sourceResponse } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("parseGoogleNewsRss", () => {
  it("extracts items, decodes entities and drops the publisher suffix", () => {
    const items = parseGoogleNewsRss(GOOGLE_NEWS_RSS);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      source: "google_news",
      url: "https://news.google.com/rss/articles/AAA111?oc=5",
      title: "Protesters plan demonstration outside Skydance Animation premiere",
      snippet: "",
      author: "Example Times",
      publishedAt: "2026-11-12T09:30:00.000Z",
    });
    expect(items[1]!.title).toBe("Skydance & partners unveil the studio's 2027 film slate");
    expect(items[2]!.title).toBe("Old story about Skydance from last month");
  });

  it("rejects Google's block page", () => {
    expect(() => parseGoogleNewsRss("<html><head><title>Sorry...</title></head></html>")).toThrow(/not an RSS feed/);
  });
});

describe("parseBingNewsRss", () => {
  it("unwraps the tracking link and reads the publisher and description", () => {
    const items = parseBingNewsRss(BING_NEWS_RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      source: "bing_news",
      url: "https://www.syndicated.example/protest-premiere?a=1&b=2",
      title: "Protesters plan demonstration outside Skydance Animation premiere",
      snippet: "Organisers say they will gather outside Saturday's premiere & have published the venue address.",
      author: "Syndicated Wire",
      publishedAt: "2026-11-12T10:15:00.000Z",
    });
  });
});

describe("parseBluesky", () => {
  it("builds a web link and uses the post text as the headline", () => {
    expect(parseBluesky(BLUESKY_JSON)).toEqual([
      {
        source: "bluesky",
        url: "https://bsky.app/profile/filmfan.bsky.social/post/3n24sblfsas26",
        title: "Just saw the new Skydance trailer. Looks great!",
        snippet: "Just saw the new Skydance trailer. Looks great!",
        author: "@filmfan.bsky.social",
        publishedAt: "2026-11-12T11:35:18.901Z",
      },
    ]);
  });
});

describe("parseLemmy", () => {
  it("returns posts and comments", () => {
    const [post, comment] = parseLemmy(LEMMY_JSON);
    expect(post).toEqual({
      source: "lemmy",
      url: "https://lemmy.example/post/78350329",
      title: "Skydance sets release date for its next animated feature",
      snippet: "",
      author: "c/tvmovies · grainne",
      publishedAt: "2026-11-12T10:21:30.374Z",
    });
    expect(comment).toMatchObject({
      url: "https://lemmus.example/comment/20675265",
      title: "Comment on: Studio merger talks reported",
      snippet: "Another acquisition for the Skydance conglomerate. What could go wrong?",
      author: "c/technology · thor_whale",
    });
  });
});

describe("parseHackerNews", () => {
  it("handles stories and comments", () => {
    const [story, comment] = parseHackerNews(HN_JSON);
    expect(story).toMatchObject({
      title: "Skydance open-sources its render pipeline",
      url: "https://news.ycombinator.com/item?id=41000001",
      snippet: "",
    });
    expect(comment).toMatchObject({
      title: "Comment on: Ask HN: studio security practices",
      snippet: "I heard Skydance had a phishing wave & reset everyone's passwords.",
    });
  });
});

describe("candidateId", () => {
  const news = (url: string, title: string): RawItem => ({
    source: "bing_news",
    url,
    title,
    snippet: "",
    author: "",
    publishedAt: null,
  });

  it("gives syndicated copies of a headline the same id", async () => {
    const a = await candidateId(news("https://a.example/1", "Hacking group claims breach of Skydance Games"));
    const b = await candidateId(news("https://b.example/2", "Hacking group claims breach of Skydance Games!"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps short headlines and social posts distinct by URL", async () => {
    expect(await candidateId(news("https://a.example/1", "Skydance news"))).not.toBe(
      await candidateId(news("https://b.example/2", "Skydance news")),
    );
    const post = (url: string): RawItem => ({ ...news(url, "Comment on: Ask HN: studio security practices"), source: "hackernews" });
    expect(await candidateId(post("https://news.ycombinator.com/item?id=1"))).not.toBe(
      await candidateId(post("https://news.ycombinator.com/item?id=2")),
    );
  });
});

function stubSources(requested: string[], overrides: Record<string, () => Response> = {}) {
  vi.stubGlobal("fetch", async (input: string) => {
    requested.push(input);
    const url = new URL(input);
    return overrides[url.hostname]?.() ?? sourceResponse(url)!;
  });
}

const SITES = await listSites(createTestDb());
const watch = (searchTerms: string[], sites = SITES) => ({ ...WATCHLIST, searchTerms, sites });

describe("collect", () => {
  it("merges sources, drops stale items and isolates a failing source", async () => {
    const requested: string[] = [];
    stubSources(requested, { "news.google.com": () => new Response("<html>Sorry...</html>", { status: 503 }) });

    const { candidates, sources } = await collect(watch(["Skydance"]), NOW);

    expect(sources).toEqual([
      { source: "bing_news", count: 2, error: null },
      { source: "bing_local", count: 2, error: null },
      { source: "google_news", count: 0, error: "HTTP 503" },
      { source: "bluesky", count: 1, error: null },
      // The Milwaukee reports use an urgent term but are not near any site.
      { source: "bluesky_urgent", count: 1, error: null },
      // No outlets were scheduled for this run.
      { source: "rss", count: 0, error: null },
      { source: "lemmy", count: 2, error: null },
      { source: "hackernews", count: 2, error: null },
    ]);
    expect(candidates).toHaveLength(10);
  });

  it("keeps one copy of a story reported by two news sources", async () => {
    stubSources([]);
    const { candidates, sources } = await collect(watch(["Skydance"]), NOW);
    // Google's month-old item is dropped, and its protest story duplicates Bing's.
    expect(sources.find((source) => source.source === "google_news")).toEqual({ source: "google_news", count: 2, error: null });
    expect(candidates.map((c) => c.title).sort()).toEqual([
      "Active shooter reported near Farragut Square in DC. Avoid the area.",
      "Comment on: Ask HN: studio security practices",
      "Comment on: Studio merger talks reported",
      "Hacking group claims breach of Skydance Games internal servers",
      "Just saw the new Skydance trailer. Looks great!",
      "Protesters plan demonstration outside Skydance Animation premiere",
      "Road closures announced for weekend marathon in Washington DC",
      "Shooting reported near Farragut Square in Washington DC, suspect at large",
      "Skydance & partners unveil the studio's 2027 film slate",
      "Skydance open-sources its render pipeline",
      "Skydance sets release date for its next animated feature",
    ]);
    expect(candidates.find((c) => c.title.startsWith("Protesters"))!.source).toBe("bing_news");
  });

  it("builds each source's query from the watchlist", async () => {
    const requested: string[] = [];
    stubSources(requested);
    await collect(watch(["Skydance", "David Ellison"]), NOW);
    const queries = (host: string) =>
      requested.map((url) => new URL(url)).filter((url) => url.hostname === host).map((url) => url.searchParams.get("q"));
    const incidents = '("active shooter" OR "shooting" OR "bomb threat" OR "explosion" OR "evacuation" OR "lockdown")';

    expect(queries("news.google.com")).toEqual(['"Skydance" OR "David Ellison" when:2d']);
    // Brand searches, then each priority area, then urgent terms everywhere.
    expect(queries("www.bing.com")).toEqual([
      '"Skydance"',
      '"David Ellison"',
      `"Manhattan" ${incidents}`,
      `"Washington DC" ${incidents}`,
      `"Hollywood" ${incidents}`,
      `"Santa Monica" ${incidents}`,
      '"active shooter"',
      '"bomb threat"',
      '"shelter in place"',
      '"mass shooting"',
    ]);
    expect(queries("api.bsky.app")).toEqual([
      '"Skydance"',
      '"David Ellison"',
      '"active shooter"',
      '"bomb threat"',
      '"shelter in place"',
      '"mass shooting"',
    ]);
    expect(queries("lemmy.world")).toEqual(["Skydance", "David Ellison"]);
    expect(queries("hn.algolia.com")).toHaveLength(2);
    const bluesky = requested.map((url) => new URL(url)).find((url) => url.hostname === "api.bsky.app")!;
    expect(bluesky.searchParams.get("since")).toBe("2026-11-10T12:00:00.000Z");
  });

  it("skips incident searches when there are no sites", async () => {
    const requested: string[] = [];
    stubSources(requested);
    const { sources } = await collect(watch(["Skydance"], []), NOW);
    expect(sources.find((source) => source.source === "bing_local")).toEqual({ source: "bing_local", count: 0, error: null });
    expect(requested.filter((url) => new URL(url).hostname === "www.bing.com")).toHaveLength(1);
  });
});
