import { WILDFIRE_QUERY } from "./hazards/wildfires";

// Live public feeds shown as map layers. The dashboard reads them through the
// worker so it only ever talks to its own address, and so feeds that do not
// allow browser access still work. Only the upstreams listed here can be reached.

interface Feed {
  url: (params: URLSearchParams) => string | null;
  // Seconds a browser may reuse the response.
  maxAge: number;
  // Feeds are JSON unless they say otherwise.
  type?: string;
}

// Caltrans publishes one camera list per district: 3 is Sacramento, 4 the
// Bay Area and 7 Los Angeles.
const CALTRANS_DISTRICTS = ["3", "4", "7"];

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
  "cameras-caltrans": {
    url: (params) => {
      const district = params.get("district") ?? "";
      if (!CALTRANS_DISTRICTS.includes(district)) return null;
      return `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${district.padStart(2, "0")}.json`;
    },
    maxAge: 900,
  },
  "cameras-nyc": {
    url: () => "https://webcams.nyctmc.org/api/cameras",
    maxAge: 900,
  },
  "cameras-seattle": {
    url: () =>
      "https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoCamerasWeather/FeatureServer/0/query" +
      "?where=1%3D1&outFields=CameraTitle,ImageURL&outSR=4326&f=json&geometry=-122.6,47.3,-121.9,47.9" +
      "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects",
    maxAge: 900,
  },
  "cameras-maryland": {
    url: () => "https://chart.maryland.gov/DataFeeds/GetCamerasJson",
    maxAge: 900,
  },
  "cameras-sydney": {
    url: () => "https://www.livetraffic.com/datajson/all-feeds-web.json",
    maxAge: 900,
  },
  "cameras-singapore": {
    url: () => "https://api.data.gov.sg/v1/transport/traffic-images",
    maxAge: 120,
  },
  "cameras-hongkong": {
    url: () => "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml",
    maxAge: 3600,
    type: "text/plain",
  },
  "cameras-madrid": {
    url: () => "https://informo.madrid.es/informo/tmadrid/CCTV.kml",
    maxAge: 900,
    type: "text/plain",
  },
  "weather-warnings": {
    url: () => "https://api.weather.gov/alerts/active?status=actual&severity=Extreme,Severe",
    maxAge: 300,
    type: "application/geo+json",
  },
  wildfires: {
    url: () => WILDFIRE_QUERY,
    maxAge: 900,
  },
  disasters: {
    url: () => "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP",
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
  if (!url) return Response.json({ error: "A required parameter is missing or invalid" }, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "User-Agent": "sentinel-monitor/0.1 (brand security monitoring)", Accept: "*/*" },
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
      "Content-Type": `${feed.type ?? "application/json"}; charset=utf-8`,
      "Cache-Control": `private, max-age=${feed.maxAge}`,
    },
  });
}
