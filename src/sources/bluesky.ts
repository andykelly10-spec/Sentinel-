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

export function parseBluesky(body: string): RawItem[] {
  const response = JSON.parse(body) as BlueskyResponse;
  return (response.posts ?? []).map((post) => {
    const handle = post.author?.handle ?? "";
    const postId = post.uri?.split("/").pop() ?? "";
    const text = (post.record?.text ?? "").replace(/\s+/g, " ").trim();
    return {
      source: "bluesky",
      url: handle && postId ? `https://bsky.app/profile/${handle}/post/${postId}` : "",
      title: truncate(text, 140),
      snippet: truncate(text, 600),
      author: handle ? `@${handle}` : "",
      publishedAt: toIso(post.record?.createdAt),
    };
  });
}

export async function fetchBluesky(terms: string[], now: Date): Promise<RawItem[]> {
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const pages = await Promise.all(
    quoted(terms).map((phrase) =>
      getText(
        `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(phrase)}` +
          `&sort=latest&limit=25&since=${encodeURIComponent(since)}`,
      ),
    ),
  );
  return pages.flatMap(parseBluesky);
}
