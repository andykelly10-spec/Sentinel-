// Which video each news channel is streaming live right now. YouTube's
// "whatever this channel has live" embed fails when a channel runs more than
// one live stream at once (Sky News often does), so the TV wall embeds the
// exact video instead. The channel's /live page names it in its first few
// kilobytes; only that much is read.

import { getSetting, setSetting } from "./db";
import { decodeEntities } from "./text";

export const TV_CHANNELS: Record<string, string> = {
  sky: "UCoMdktPbSTixAyNGwb-UYkQ",
  cbs: "UC8p1vwvWtl6T73JiExfWs1g",
  aje: "UCNye-wNBqNL5ZzHSJj3l8Bg",
  abc: "UCBi2mrWuNuyYy4gbM6fU18Q",
  nbc: "UCeY0bbntWzzVIaj2z3QigXg",
  dw: "UCknLrEdhRCp1aegoMqRaCZg",
  france24: "UCQfwfsi5VrQ8yKZ-UWmAEFg",
  euronews: "UCSrZ3UV4jOidv8ppoVuvW9Q",
  bloomberg: "UCIALMKvObZNtJ6AmdCLP7Lg",
};

export interface LiveVideo {
  videoId: string;
  title: string;
}

// The marker sits about 800 KB into the page; read no further than this.
const MAX_CHARS = 1_300_000;
const CACHE_MS = 15 * 60_000;
// A failed lookup is retried sooner.
const MISS_CACHE_MS = 2 * 60_000;
// When a screen reports its video unavailable it asks again at once, but no
// more than once a minute per channel.
const FRESH_MIN_MS = 60_000;
const MARKER = '<link rel="canonical"';

// Reads the canonical link (/watch?v=<id> while live) and the title after it.
export function liveFromHead(head: string): LiveVideo | null {
  const videoId = head.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1];
  if (!videoId) return null;
  const title = decodeEntities(head.match(/<title>([^<]*)<\/title>/)?.[1] ?? "").replace(/ - YouTube$/, "").trim();
  return { videoId, title };
}

// YouTube sometimes answers with a "confirm you're not a bot" page instead
// (its canonical link then reads "undefined"), and which address it does
// that for varies, so the mobile address is tried as well.
const ADDRESSES = (channelId: string) => [
  `https://www.youtube.com/channel/${channelId}/live`,
  `https://m.youtube.com/channel/${channelId}/live`,
];

// Scans the page as it arrives, keeping only the text from the marker on.
async function readLivePage(url: string): Promise<LiveVideo | null> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "CONSENT=YES+1",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let carry = "";
  let found = "";
  try {
    while (read < MAX_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      read += chunk.length;
      if (!found) {
        const text = carry + chunk;
        const at = text.indexOf(MARKER);
        if (at < 0) {
          carry = text.slice(-MARKER.length);
          continue;
        }
        found = text.slice(at);
      } else {
        found += chunk;
      }
      if (found.includes("</title>")) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return found ? liveFromHead(found) : null;
}

async function resolve(channelId: string): Promise<LiveVideo | null> {
  for (const url of ADDRESSES(channelId)) {
    const video = await readLivePage(url).catch(() => null);
    if (video) return video;
  }
  return null;
}

interface Cached {
  fetchedAt: string;
  video: LiveVideo | null;
  // False when the last lookup failed and `video` is the last one that worked.
  ok: boolean;
}

// The live video for each requested channel (at most four: the TV wall's screens).
export async function liveVideos(
  db: D1Database,
  keys: string[],
  now: Date = new Date(),
  fresh = false,
): Promise<Record<string, LiveVideo | null>> {
  const wanted = [...new Set(keys)].filter((key) => key in TV_CHANNELS).slice(0, 4);
  const entries = await Promise.all(
    wanted.map(async (key) => {
      const cached = JSON.parse((await getSetting(db, `live:${key}`)) ?? "null") as Cached | null;
      const age = cached ? now.getTime() - Date.parse(cached.fetchedAt) : Infinity;
      const keep = fresh ? FRESH_MIN_MS : cached?.ok ? CACHE_MS : MISS_CACHE_MS;
      if (cached && age < keep) return [key, cached.video] as const;
      const found = await resolve(TV_CHANNELS[key]!).catch(() => null);
      // A failed lookup (YouTube sometimes blocks them) keeps the last video that worked.
      const entry: Cached = { fetchedAt: now.toISOString(), video: found ?? cached?.video ?? null, ok: found !== null };
      await setSetting(db, `live:${key}`, JSON.stringify(entry));
      return [key, entry.video] as const;
    }),
  );
  return Object.fromEntries(entries);
}
