// Live public feeds shown as map layers. The dashboard reads them through the
// worker so it only ever talks to its own address, and so feeds that do not
// allow browser access still work. Only the upstreams listed here can be reached.

interface Feed {
  url: (params: URLSearchParams) => string | null;
  // Seconds a browser may reuse the response.
  maxAge: number;
}

function coordinates(params: URLSearchParams): { lat: string; lon: string } | null {
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!params.get("lat") || !params.get("lon")) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: lat.toFixed(4), lon: lon.toFixed(4) };
}

const FEEDS: Record<string, Feed> = {
  quakes: {
    url: () => "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    maxAge: 300,
  },
  radar: {
    url: () => "https://api.rainviewer.com/public/weather-maps.json",
    maxAge: 300,
  },
  aircraft: {
    url: (params) => {
      const point = coordinates(params);
      return point && `https://api.adsb.lol/v2/point/${point.lat}/${point.lon}/40`;
    },
    maxAge: 15,
  },
  "cameras-la": {
    url: () => "https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json",
    maxAge: 900,
  },
  "cameras-nyc": {
    url: () => "https://webcams.nyctmc.org/api/cameras",
    maxAge: 900,
  },
  weather: {
    url: (params) => {
      const point = coordinates(params);
      return (
        point &&
        `https://api.open-meteo.com/v1/forecast?latitude=${point.lat}&longitude=${point.lon}` +
          "&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code" +
          "&temperature_unit=fahrenheit&wind_speed_unit=mph"
      );
    },
    maxAge: 600,
  },
  "weather-alerts": {
    url: (params) => {
      const point = coordinates(params);
      return point && `https://api.weather.gov/alerts/active?point=${point.lat},${point.lon}`;
    },
    maxAge: 300,
  },
  cables: {
    url: () => "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
    maxAge: 86_400,
  },
  iss: {
    url: () => "https://api.wheretheiss.at/v1/satellites/25544",
    maxAge: 5,
  },
};

export const FEED_NAMES = Object.keys(FEEDS);

export async function proxyFeed(name: string, params: URLSearchParams): Promise<Response> {
  const feed = FEEDS[name];
  if (!feed) return Response.json({ error: "Unknown feed" }, { status: 404 });
  const url = feed.url(params);
  if (!url) return Response.json({ error: "lat and lon are required" }, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "User-Agent": "sentinel-monitor/0.1 (brand security monitoring)", Accept: "application/json, */*" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return Response.json({ error: "Feed did not respond" }, { status: 502 });
  }
  if (!upstream.ok) {
    return Response.json({ error: `Feed answered ${upstream.status}` }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `private, max-age=${feed.maxAge}`,
    },
  });
}
