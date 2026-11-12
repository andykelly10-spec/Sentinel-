import { truncate } from "../text";
import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        title?: string;
        selftext?: string;
        permalink?: string;
        subreddit_name_prefixed?: string;
        author?: string;
        created_utc?: number;
      };
    }>;
  };
}

export function parseReddit(body: string): RawItem[] {
  const listing = JSON.parse(body) as RedditListing;
  return (listing.data?.children ?? []).map(({ data: post = {} }) => ({
    source: "reddit",
    url: post.permalink ? `https://www.reddit.com${post.permalink}` : "",
    title: (post.title ?? "").trim(),
    snippet: truncate((post.selftext ?? "").replace(/\s+/g, " ").trim(), 600),
    author: [post.subreddit_name_prefixed, post.author && `u/${post.author}`].filter(Boolean).join(" · "),
    publishedAt: post.created_utc ? toIso(post.created_utc * 1000) : null,
  }));
}

export async function fetchReddit(terms: string[]): Promise<RawItem[]> {
  const query = quoted(terms).join(" OR ");
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=50&raw_json=1`;
  return parseReddit(await getText(url));
}
