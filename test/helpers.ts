import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Env } from "../src/types";

// A D1 stand-in backed by SQLite, loaded with the real migrations and
// enforcing D1's limit of 100 bound parameters per statement.
export function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }

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

export const BING_NEWS_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=%22Skydance%22&amp;format=rss"><channel><title>&quot;Skydance&quot; - BingNews</title><link>https://www.bing.com/news/search?q=%22Skydance%22&amp;format=rss</link>
<item><title>Protesters plan demonstration outside Skydance Animation premiere</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=6af5e89bc5e14c0fa079a4cc1058546e&amp;url=https%3a%2f%2fwww.syndicated.example%2fprotest-premiere%3fa%3d1%26b%3d2&amp;c=5457326848369086104&amp;mkt=en-us</link><description>Organisers say they will gather outside Saturday&#39;s premiere &amp; have published the venue address.</description><pubDate>Thu, 12 Nov 2026 10:15:00 GMT</pubDate><News:Source>Syndicated Wire</News:Source><News:Image>http://www.bing.com/th?id=ONUT.x&amp;pid=News</News:Image></item>
<item><title>Hacking group claims breach of Skydance Games internal servers</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=aaaa&amp;url=https%3a%2f%2fsecurity.example%2fskydance-breach-claim&amp;c=1&amp;mkt=en-us</link><description>The group says it holds source code.</description><pubDate>Thu, 12 Nov 2026 08:00:00 GMT</pubDate><News:Source>Security Example</News:Source></item>
</channel></rss>`;

export const BLUESKY_JSON = JSON.stringify({
  posts: [
    {
      uri: "at://did:plc:abc123/app.bsky.feed.post/3n24sblfsas26",
      cid: "bafyexample",
      author: { did: "did:plc:abc123", handle: "filmfan.bsky.social", displayName: "Film Fan" },
      record: {
        $type: "app.bsky.feed.post",
        createdAt: "2026-11-12T11:35:18.901Z",
        text: "Just saw the new Skydance trailer.\n\nLooks great!",
      },
      indexedAt: "2026-11-12T11:35:20.000Z",
    },
  ],
  cursor: "1",
  hitsTotal: 1,
});

export const LEMMY_JSON = JSON.stringify({
  type_: "All",
  comments: [
    {
      comment: {
        id: 26823342,
        content: "Another acquisition for the Skydance conglomerate. What could go wrong?",
        published: "2026-11-12T07:09:38.369641Z",
        ap_id: "https://lemmus.example/comment/20675265",
      },
      creator: { id: 1, name: "thor_whale" },
      post: { id: 54307121, name: "Studio merger talks reported" },
      community: { id: 2478, name: "technology" },
    },
  ],
  posts: [
    {
      post: {
        id: 54327583,
        name: "Skydance sets release date for its next animated feature",
        url: "https://trade.example/release-date",
        body: null,
        ap_id: "https://lemmy.example/post/78350329",
        published: "2026-11-12T10:21:30.374540Z",
      },
      creator: { id: 2, name: "grainne" },
      community: { id: 3, name: "tvmovies" },
    },
  ],
  communities: [],
  users: [],
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

export const BING_LOCAL_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>local - BingNews</title>
<item><title>Shooting reported near Farragut Square in Washington DC, suspect at large</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2flocal.example%2ffarragut-shooting&amp;c=1</link><description>Police are asking people to avoid the area around 17th and K streets.</description><pubDate>Thu, 12 Nov 2026 11:40:00 GMT</pubDate><News:Source>Local Example</News:Source></item>
<item><title>Road closures announced for weekend marathon in Washington DC</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2flocal.example%2fmarathon&amp;c=1</link><description>Expect delays downtown.</description><pubDate>Thu, 12 Nov 2026 09:00:00 GMT</pubDate><News:Source>Local Example</News:Source></item>
</channel></rss>`;

export const EMPTY_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>none</title></channel></rss>`;

export const BLUESKY_URGENT_JSON = JSON.stringify({
  posts: [
    {
      uri: "at://did:plc:dc1/app.bsky.feed.post/3urgentdc",
      author: { handle: "dcresident.bsky.social" },
      record: { createdAt: "2026-11-12T11:45:00.000Z", text: "Active shooter reported near Farragut Square in DC. Avoid the area." },
    },
    {
      uri: "at://did:plc:mke1/app.bsky.feed.post/3urgentmke",
      author: { handle: "mkenews.bsky.social" },
      record: { createdAt: "2026-11-12T11:30:00.000Z", text: "Active shooter drill scheduled at a Milwaukee high school today." },
    },
  ],
});

export const BING_URGENT_RSS = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>urgent - BingNews</title>
<item><title>Active shooter drill held at Milwaukee high school</title><link>https://mke.example/drill</link><description>Students practised lockdown procedures.</description><pubDate>Thu, 12 Nov 2026 10:00:00 GMT</pubDate><News:Source>MKE Example</News:Source></item>
</channel></rss>`;

const BRAND_QUERY = /Skydance|David Ellison|Warner Bros/;

// Answers each source the way the live service would for that query.
export function sourceResponse(url: URL, overrides: { bingLocal?: string } = {}): Response | null {
  const query = url.searchParams.get("q") ?? "";
  switch (url.hostname) {
    case "www.bing.com":
      if (BRAND_QUERY.test(query)) return new Response(BING_NEWS_RSS);
      if (query.includes("Washington DC")) return new Response(overrides.bingLocal ?? BING_LOCAL_RSS);
      return new Response(query === '"active shooter"' ? BING_URGENT_RSS : EMPTY_RSS);
    case "api.bsky.app":
      if (query === '"active shooter"') return new Response(BLUESKY_URGENT_JSON);
      return new Response(BRAND_QUERY.test(query) ? BLUESKY_JSON : '{"posts":[]}');
    case "news.google.com":
      return new Response(GOOGLE_NEWS_RSS);
    case "lemmy.world":
      return new Response(LEMMY_JSON);
    case "hn.algolia.com":
      return new Response(HN_JSON);
    default:
      return null;
  }
}
