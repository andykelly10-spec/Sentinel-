import { mentionsPlace } from "../geo";
import { truncate } from "../text";
import type { RawItem } from "../types";
import { getText, quoted, toIso } from "./http";

interface BlueskyResponse {
  posts?: Array<{
    uri?: string;
    author?: { handle?: string; displayName?: string };
    record?: { text?: string; createdAt?: string };
  }>;
}

export function parseBluesky(body: string, source: "bluesky" | "bluesky_urgent" = "bluesky"): RawItem[] {
  const response = JSON.parse(body) as BlueskyResponse;
  return (response.posts ?? []).map((post) => {
    const handle = post.author?.handle ?? "";
    const postId = post.uri?.split("/").pop() ?? "";
    const text = (post.record?.text ?? "").replace(/\s+/g, " ").trim();
    return {
      source,
      url: handle && postId ? `https://bsky.app/profile/${handle}/post/${postId}` : "",
      title: truncate(text, 140),
      snippet: truncate(text, 600),
      author: handle ? `@${handle}` : "",
      publishedAt: toIso(post.record?.createdAt),
    };
  });
}

async function search(phrases: string[], now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  return Promise.all(
    phrases.map((phrase) =>
      getText(
        `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(phrase)}` +
          `&sort=latest&limit=25&since=${encodeURIComponent(since)}`,
      ),
    ),
  );
}

export async function fetchBluesky(terms: string[], now: Date): Promise<RawItem[]> {
  return (await search(quoted(terms), now)).flatMap((page) => parseBluesky(page));
}

// Posts using an urgent term anywhere, kept only when they mention a place
// belonging to a site.
export async function fetchBlueskyUrgent(urgentTerms: string[], places: string[], now: Date): Promise<RawItem[]> {
  const posts = (await search(quoted(urgentTerms), now)).flatMap((page) => parseBluesky(page, "bluesky_urgent"));
  return posts.filter((post) => mentionsPlace(post.snippet, places));
}
