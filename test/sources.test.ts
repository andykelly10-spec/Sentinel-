import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateId, collect } from "../src/sources";
import { parseGdelt } from "../src/sources/gdelt";
import { parseGoogleNewsRss } from "../src/sources/googleNews";
import { parseHackerNews } from "../src/sources/hackerNews";
import { parseReddit } from "../src/sources/reddit";
import type { RawItem } from "../src/types";
import { GDELT_JSON, GOOGLE_NEWS_RSS, HN_JSON, NOW, REDDIT_JSON } from "./helpers";

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

  it("rejects a response that is not a feed", () => {
    expect(() => parseGoogleNewsRss("<html><body>Before you continue</body></html>")).toThrow(/not an RSS feed/);
  });
});

describe("parseGdelt", () => {
  it("maps articles and converts the seen date", () => {
    const items = parseGdelt(GDELT_JSON);
    expect(items[1]).toMatchObject({
      source: "gdelt",
      url: "https://security.example/skydance-breach-claim",
      author: "security.example",
      publishedAt: "2026-11-12T08:00:00.000Z",
    });
  });

  it("treats an empty result as no articles", () => {
    expect(parseGdelt("{}")).toEqual([]);
  });

  it("surfaces GDELT's plain-text errors", () => {
    expect(() => parseGdelt("Please limit requests to one every 5 seconds.")).toThrow(/limit requests/);
  });
});

describe("parseReddit", () => {
  it("builds a permalink and collapses whitespace in the body", () => {
    expect(parseReddit(REDDIT_JSON)).toEqual([
      {
        source: "reddit",
        url: "https://www.reddit.com/r/movies/comments/abc123/skydance_trailer_discussion/",
        title: "Skydance trailer discussion",
        snippet: "What did everyone think? I liked it.",
        author: "r/movies · u/filmfan",
        publishedAt: "2026-11-12T12:00:00.000Z",
      },
    ]);
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
    source: "gdelt",
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

describe("collect", () => {
  it("merges sources, drops stale items and isolates a failing source", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      requested.push(input);
      if (url.hostname === "news.google.com") return new Response(GOOGLE_NEWS_RSS);
      if (url.hostname === "api.gdeltproject.org") return new Response(GDELT_JSON);
      if (url.hostname === "www.reddit.com") return new Response("blocked", { status: 403 });
      return new Response(HN_JSON);
    });

    const { candidates, sources } = await collect(["Skydance"], NOW);

    expect(sources).toEqual([
      { source: "google_news", count: 2, error: null },
      { source: "gdelt", count: 2, error: null },
      { source: "reddit", count: 0, error: "HTTP 403" },
      { source: "hackernews", count: 2, error: null },
    ]);
    // The protest story appears in both news sources and is kept once.
    expect(candidates.map((c) => c.title).sort()).toEqual([
      "Comment on: Ask HN: studio security practices",
      "Hacking group claims breach of Skydance Games internal servers",
      "Protesters plan demonstration outside Skydance Animation premiere",
      "Skydance & partners unveil the studio's 2027 film slate",
      "Skydance open-sources its render pipeline",
    ]);
    expect(new URL(requested[0]!).searchParams.get("q")).toBe('"Skydance" when:2d');
    expect(new URL(requested[1]!).searchParams.get("query")).toBe('"Skydance"');
  });

  it("ORs several terms for sources that support it", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      requested.push(input);
      return new Response("{}", { status: 500 });
    });
    await collect(["Skydance", "David Ellison"], NOW);
    const byHost = (host: string) => requested.filter((url) => new URL(url).hostname === host).map((url) => new URL(url));
    expect(byHost("news.google.com")[0]!.searchParams.get("q")).toBe('"Skydance" OR "David Ellison" when:2d');
    expect(byHost("api.gdeltproject.org")[0]!.searchParams.get("query")).toBe('("Skydance" OR "David Ellison")');
    expect(byHost("hn.algolia.com")).toHaveLength(2);
  });
});
