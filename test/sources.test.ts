import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateId, collect } from "../src/sources";
import { parseBingNewsRss } from "../src/sources/bingNews";
import { parseBluesky } from "../src/sources/bluesky";
import { parseGoogleNewsRss } from "../src/sources/googleNews";
import { parseHackerNews } from "../src/sources/hackerNews";
import { parseLemmy } from "../src/sources/lemmy";
import type { RawItem } from "../src/types";
import { BING_NEWS_RSS, BLUESKY_JSON, GOOGLE_NEWS_RSS, HN_JSON, LEMMY_JSON, NOW } from "./helpers";

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
  const bodies: Record<string, string> = {
    "www.bing.com": BING_NEWS_RSS,
    "news.google.com": GOOGLE_NEWS_RSS,
    "api.bsky.app": BLUESKY_JSON,
    "lemmy.world": LEMMY_JSON,
    "hn.algolia.com": HN_JSON,
  };
  vi.stubGlobal("fetch", async (input: string) => {
    requested.push(input);
    const { hostname } = new URL(input);
    return overrides[hostname]?.() ?? new Response(bodies[hostname]);
  });
}

describe("collect", () => {
  it("merges sources, drops stale items and isolates a failing source", async () => {
    const requested: string[] = [];
    stubSources(requested, { "news.google.com": () => new Response("<html>Sorry...</html>", { status: 503 }) });

    const { candidates, sources } = await collect(["Skydance"], NOW);

    expect(sources).toEqual([
      { source: "bing_news", count: 2, error: null },
      { source: "google_news", count: 0, error: "HTTP 503" },
      { source: "bluesky", count: 1, error: null },
      { source: "lemmy", count: 2, error: null },
      { source: "hackernews", count: 2, error: null },
    ]);
    expect(candidates).toHaveLength(7);
  });

  it("keeps one copy of a story reported by two news sources", async () => {
    stubSources([]);
    const { candidates, sources } = await collect(["Skydance"], NOW);
    // Google's month-old item is dropped, and its protest story duplicates Bing's.
    expect(sources.find((source) => source.source === "google_news")).toEqual({ source: "google_news", count: 2, error: null });
    expect(candidates.map((c) => c.title).sort()).toEqual([
      "Comment on: Ask HN: studio security practices",
      "Comment on: Studio merger talks reported",
      "Hacking group claims breach of Skydance Games internal servers",
      "Just saw the new Skydance trailer. Looks great!",
      "Protesters plan demonstration outside Skydance Animation premiere",
      "Skydance & partners unveil the studio's 2027 film slate",
      "Skydance open-sources its render pipeline",
      "Skydance sets release date for its next animated feature",
    ]);
    expect(candidates.find((c) => c.title.startsWith("Protesters"))!.source).toBe("bing_news");
  });

  it("builds each source's query from the search terms", async () => {
    const requested: string[] = [];
    stubSources(requested);
    await collect(["Skydance", "David Ellison"], NOW);
    const byHost = (host: string) => requested.map((url) => new URL(url)).filter((url) => url.hostname === host);

    expect(byHost("news.google.com").map((url) => url.searchParams.get("q"))).toEqual(['"Skydance" OR "David Ellison" when:2d']);
    expect(byHost("www.bing.com").map((url) => url.searchParams.get("q"))).toEqual(['"Skydance"', '"David Ellison"']);
    expect(byHost("www.bing.com")[0]!.searchParams.get("qft")).toBe('sortbydate="1"');
    expect(byHost("api.bsky.app").map((url) => url.searchParams.get("q"))).toEqual(['"Skydance"', '"David Ellison"']);
    expect(byHost("api.bsky.app")[0]!.searchParams.get("since")).toBe("2026-11-10T12:00:00.000Z");
    expect(byHost("lemmy.world").map((url) => url.searchParams.get("q"))).toEqual(["Skydance", "David Ellison"]);
    expect(byHost("hn.algolia.com")).toHaveLength(2);
  });
});
