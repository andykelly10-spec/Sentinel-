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
const MARKER = '<link rel="canonical"';

// Reads the canonical link (/watch?v=<id> while live) and the title after it.
export function liveFromHead(head: string): LiveVideo | null {
  const videoId = head.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1];
  if (!videoId) return null;
  const title = decodeEntities(head.match(/<title>([^<]*)<\/title>/)?.[1] ?? "").replace(/ - YouTube$/, "").trim();
  return { videoId, title };
}

// Scans the page as it arrives, keeping only the text from the marker on.
async function resolve(channelId: string): Promise<LiveVideo | null> {
  const response = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
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

interface Cached {
  fetchedAt: string;
  video: LiveVideo | null;
}

// The live video for each requested channel (at most four: the TV wall's screens).
export async function liveVideos(db: D1Database, keys: string[], now: Date = new Date()): Promise<Record<string, LiveVideo | null>> {
  const wanted = [...new Set(keys)].filter((key) => key in TV_CHANNELS).slice(0, 4);
  const entries = await Promise.all(
    wanted.map(async (key) => {
      const cached = JSON.parse((await getSetting(db, `live:${key}`)) ?? "null") as Cached | null;
      if (cached && now.getTime() - Date.parse(cached.fetchedAt) < CACHE_MS) return [key, cached.video] as const;
      const video = await resolve(TV_CHANNELS[key]!).catch(() => null);
      await setSetting(db, `live:${key}`, JSON.stringify({ fetchedAt: now.toISOString(), video } satisfies Cached));
      return [key, video] as const;
    }),
  );
  return Object.fromEntries(entries);
}
