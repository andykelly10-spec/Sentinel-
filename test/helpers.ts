import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Env } from "../src/types";

// A D1 stand-in backed by SQLite, loaded with the real migration and
// enforcing D1's limit of 100 bound parameters per statement.
export function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("migrations/0001_init.sql", "utf8"));

  const statement = (sql: string, params: SQLInputValue[]) => {
    if (params.length > 100) throw new Error(`too many bound parameters: ${params.length}`);
    return {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      first: async () => sqlite.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
    };
  };

  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const each of statements) results.push(await each.run());
      return results;
    },
  } as unknown as D1Database;
}

export function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createTestDb(),
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ANTHROPIC_API_KEY: "test-key",
    DASHBOARD_PASSWORD: "hunter2",
    CLASSIFIER_MODEL: "claude-opus-5-5",
    MIN_EMAIL_SEVERITY: "medium",
    DASHBOARD_URL: "https://sentinel.example",
    ALERT_EMAIL_FROM: "",
    ALERT_EMAIL_TO: "",
    ALERT_SMS_TO: "",
    TWILIO_FROM_NUMBER: "",
    ...overrides,
  };
}

export const NOW = new Date("2026-11-12T12:00:00Z");

// Sample payloads in each source's real response format. The content is invented.
export const GOOGLE_NEWS_RSS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<title>"Skydance" - Google News</title>
<item><title>Protesters plan demonstration outside Skydance Animation premiere - Example Times</title><link>https://news.google.com/rss/articles/AAA111?oc=5</link><guid isPermaLink="false">AAA111</guid><pubDate>Thu, 12 Nov 2026 09:30:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/AAA111"&gt;Protesters plan demonstration&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Example Times&lt;/font&gt;</description><source url="https://www.exampletimes.com">Example Times</source></item>
<item><title>Skydance &amp; partners unveil the studio&#39;s 2027 film slate - Trade Daily</title><link>https://news.google.com/rss/articles/BBB222?oc=5</link><guid isPermaLink="false">BBB222</guid><pubDate>Wed, 11 Nov 2026 18:00:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/BBB222"&gt;slate&lt;/a&gt;</description><source url="https://www.tradedaily.com">Trade Daily</source></item>
<item><title><![CDATA[Old story about Skydance from last month - Archive Post]]></title><link>https://news.google.com/rss/articles/CCC333?oc=5</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate><source url="https://archive.example">Archive Post</source></item>
</channel></rss>`;

export const GDELT_JSON = JSON.stringify({
  articles: [
    {
      url: "https://www.syndicated.example/protest-premiere",
      title: "Protesters plan demonstration outside Skydance Animation premiere",
      seendate: "20261112T101500Z",
      domain: "syndicated.example",
      language: "English",
    },
    {
      url: "https://security.example/skydance-breach-claim",
      title: "Hacking group claims breach of Skydance Games internal servers",
      seendate: "20261112T080000Z",
      domain: "security.example",
      language: "English",
    },
  ],
});

export const REDDIT_JSON = JSON.stringify({
  kind: "Listing",
  data: {
    children: [
      {
        kind: "t3",
        data: {
          title: "Skydance trailer discussion",
          selftext: "What did   everyone think?\n\nI liked it.",
          permalink: "/r/movies/comments/abc123/skydance_trailer_discussion/",
          subreddit_name_prefixed: "r/movies",
          author: "filmfan",
          created_utc: 1794484800,
        },
      },
    ],
  },
});

export const HN_JSON = JSON.stringify({
  hits: [
    {
      objectID: "41000001",
      title: "Skydance open-sources its render pipeline",
      story_text: null,
      author: "alice",
      created_at: "2026-11-12T07:00:00Z",
      _tags: ["story"],
    },
    {
      objectID: "41000002",
      title: null,
      story_title: "Ask HN: studio security practices",
      comment_text: "I heard <i>Skydance</i> had a phishing wave &amp; reset everyone&#x27;s passwords.",
      author: "bob",
      created_at: "2026-11-12T06:00:00Z",
      _tags: ["comment"],
    },
  ],
});
