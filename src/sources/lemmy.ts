import { truncate } from "../text";
import type { RawItem } from "../types";
import { getText, toIso } from "./http";

interface LemmyActor {
  name?: string;
}

interface LemmyResponse {
  posts?: Array<{
    post?: { name?: string; body?: string | null; ap_id?: string; published?: string };
    creator?: LemmyActor;
    community?: LemmyActor;
  }>;
  comments?: Array<{
    comment?: { content?: string; ap_id?: string; published?: string };
    post?: { name?: string };
    creator?: LemmyActor;
    community?: LemmyActor;
  }>;
}

function byline(community: LemmyActor | undefined, creator: LemmyActor | undefined): string {
  return [community?.name && `c/${community.name}`, creator?.name].filter(Boolean).join(" · ");
}

function clean(text: string | null | undefined): string {
  return truncate((text ?? "").replace(/\s+/g, " ").trim(), 600);
}

export function parseLemmy(body: string): RawItem[] {
  const response = JSON.parse(body) as LemmyResponse;
  const posts: RawItem[] = (response.posts ?? []).map(({ post, creator, community }) => ({
    source: "lemmy",
    url: post?.ap_id ?? "",
    title: (post?.name ?? "").trim(),
    snippet: clean(post?.body),
    author: byline(community, creator),
    publishedAt: toIso(post?.published),
  }));
  const comments: RawItem[] = (response.comments ?? []).map(({ comment, post, creator, community }) => ({
    source: "lemmy",
    url: comment?.ap_id ?? "",
    title: `Comment on: ${truncate((post?.name ?? "Lemmy thread").trim(), 160)}`,
    snippet: clean(comment?.content),
    author: byline(community, creator),
    publishedAt: toIso(comment?.published),
  }));
  return [...posts, ...comments];
}

export async function fetchLemmy(terms: string[]): Promise<RawItem[]> {
  const pages = await Promise.all(
    terms.map((term) =>
      getText(`https://lemmy.world/api/v3/search?q=${encodeURIComponent(term)}&type_=All&sort=New&limit=10`),
    ),
  );
  return pages.flatMap(parseLemmy);
}
