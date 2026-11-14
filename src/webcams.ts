// Webcams worldwide from Windy.com (city views, landmarks, harbours, ski
// resorts and the like, from tens of thousands of providers). The API key is
// a Worker secret, so the browser asks this worker and never sees it.
// Windy's free tier requires its attribution next to the images, and its
// image links expire after about ten minutes, so responses are short-lived.

import type { Env } from "./types";

export const WINDY_URL = "https://api.windy.com/webcams/api/v3/webcams";
const MAX_RADIUS_KM = 50;

export interface Webcam {
  id: string;
  name: string;
  lat: number;
  lon: number;
  place: string;
  image: string | null;
  link: string | null;
  updated: string | null;
}

const number = (value: string | null, limit: number) => {
  const parsed = Number(value);
  return value !== null && value !== "" && Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
};

// Either a point and radius (cameras near a site) or the visible map area.
export function windyQuery(params: URLSearchParams): string | null {
  const lat = number(params.get("lat"), 90);
  const lon = number(params.get("lon"), 180);
  if (lat !== null && lon !== null) {
    const radius = Math.round(Math.min(MAX_RADIUS_KM, Math.max(1, number(params.get("radius"), 100_000) ?? 10)));
    return `nearby=${lat.toFixed(4)},${lon.toFixed(4)},${radius}`;
  }
  const [north, east, south, west] = ["north", "east", "south", "west"].map((key) => number(params.get(key), key === "north" || key === "south" ? 90 : 180));
  if ([north, east, south, west].some((value) => value === null) || north! <= south!) return null;
  return `bbox=${north!.toFixed(4)},${east!.toFixed(4)},${south!.toFixed(4)},${west!.toFixed(4)}`;
}

const httpsOnly = (value: unknown) => (typeof value === "string" && value.startsWith("https://") ? value : null);

export function parseWindy(body: string): Webcam[] {
  const webcams = ((JSON.parse(body) as { webcams?: Array<Record<string, any>> }).webcams ?? []);
  return webcams.flatMap((cam) => {
    const lat = Number(cam.location?.latitude);
    const lon = Number(cam.location?.longitude);
    if (cam.status && cam.status !== "active") return [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [
      {
        id: String(cam.webcamId ?? cam.id ?? ""),
        name: String(cam.title ?? "Webcam"),
        lat,
        lon,
        place: [cam.location?.city, cam.location?.country].filter(Boolean).join(", "),
        image: httpsOnly(cam.images?.current?.preview) ?? httpsOnly(cam.images?.current?.thumbnail),
        link: httpsOnly(cam.urls?.detail) ?? (cam.webcamId ? `https://www.windy.com/webcams/${cam.webcamId}` : null),
        updated: typeof cam.lastUpdatedOn === "string" ? cam.lastUpdatedOn : null,
      },
    ];
  });
}

export async function windyWebcams(env: Env, params: URLSearchParams): Promise<Response> {
  if (!env.WINDY_API_KEY) return Response.json({ error: "Windy webcams are not set up: add the WINDY_API_KEY secret." }, { status: 503 });
  const query = windyQuery(params);
  if (!query) return Response.json({ error: "Give lat and lon, or north, east, south and west." }, { status: 400 });
  let upstream: Response;
  try {
    upstream = await fetch(`${WINDY_URL}?${query}&limit=50&include=images,location,urls&lang=en`, {
      headers: { "x-windy-api-key": env.WINDY_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json({ error: "Windy did not respond" }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: `Windy answered ${upstream.status}` }, { status: 502 });
  return new Response(JSON.stringify({ cameras: parseWindy(await upstream.text()) }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=300" },
  });
}
