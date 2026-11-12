import { truncate } from "../text";
import type { RawItem } from "../types";
import { getText, quoted } from "./http";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
}

// GDELT dates look like 20261112T101500Z.
function parseSeenDate(value: string | undefined): string | null {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

export function parseGdelt(body: string): RawItem[] {
  let parsed: { articles?: GdeltArticle[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    // GDELT reports rate limits and query errors as plain text with a 200.
    throw new Error(truncate(body.trim() || "empty response", 160));
  }
  return (parsed.articles ?? []).map((article) => ({
    source: "gdelt",
    url: article.url ?? "",
    title: (article.title ?? "").replace(/\s+/g, " ").trim(),
    snippet: "",
    author: article.domain ?? "",
    publishedAt: parseSeenDate(article.seendate),
  }));
}

export async function fetchGdelt(terms: string[]): Promise<RawItem[]> {
  const phrases = quoted(terms);
  const query = phrases.length > 1 ? `(${phrases.join(" OR ")})` : (phrases[0] ?? "");
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
    `&mode=ArtList&format=json&maxrecords=100&timespan=2d&sort=DateDesc`;
  return parseGdelt(await getText(url));
}
