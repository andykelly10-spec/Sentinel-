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

// State and provincial 511 traffic systems that share one map platform; each
// publishes its camera positions at /map/mapIcons/Cameras.
export const SYSTEMS_511: Record<string, string> = {
  ga: "511ga.org",
  fl: "fl511.com",
  pa: "www.511pa.com",
  ct: "ctroads.org",
  ne: "newengland511.org",
  nv: "www.nvroads.com",
  az: "www.az511.gov",
  ut: "udottraffic.utah.gov",
  la: "www.511la.org",
  wi: "511wi.gov",
  on: "511on.ca",
  ab: "511.alberta.ca",
  id: "511.idaho.gov",
  ak: "511.alaska.gov",
};

// Caltrans publishes one camera list per district: 3 is Sacramento, 4 the
// Bay Area and 7 Los Angeles.
// Districts 8 (Inland Empire), 11 (San Diego) and 12 (Orange County) too.
const CALTRANS_DISTRICTS = ["3", "4", "7", "8", "11", "12"];

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
  "cameras-511": {
    url: (params) => {
      const host = SYSTEMS_511[params.get("system") ?? ""];
      return host ? `https://${host}/map/mapIcons/Cameras` : null;
    },
    maxAge: 3600,
  },
  // ALERTCalifornia (UC San Diego): mountaintop wildfire cameras.
  "cameras-wildfire": {
    url: () => "https://cameras.alertcalifornia.org/public-camera-data/all_cameras-v3.json",
    maxAge: 1800,
  },
  "cameras-nz": {
    url: () => "https://www.journeys.nzta.govt.nz/assets/map-data-cache/cameras.json",
    maxAge: 3600,
  },
  "cameras-spain": {
    url: () => "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v36.xml",
    maxAge: 86_400,
    type: "application/xml",
  },
  "cameras-bc": {
    url: () => "https://www.drivebc.ca/api/webcams/",
    maxAge: 3600,
  },
  "cameras-finland": {
    url: () => "https://tie.digitraffic.fi/api/weathercam/v1/stations",
    maxAge: 3600,
  },
  "cameras-nyc": {
    url: () => "https://webcams.nyctmc.org/api/cameras",
    maxAge: 900,
  },
  "cameras-seattle": {
    url: () =>
      "https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoCamerasWeather/FeatureServer/0/query" +
      "?where=1%3D1&outFields=CameraTitle,ImageURL&outSR=4326&f=json",
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
  // Place search for the map's search box (OpenStreetMap's Nominatim). Its
  // usage policy rules out search-as-you-type, so this runs on Enter only.
  geocode: {
    url: (params) => {
      const query = (params.get("q") ?? "").trim();
      if (query.length < 2 || query.length > 200) return null;
      return `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(query)}`;
    },
    maxAge: 86_400,
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
