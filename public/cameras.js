// Open traffic-camera feeds and the logic that ties cameras to company sites.
// Every parser turns its feed into { lat, lon, name, image, link, owner },
// where image is a still picture and link is a page showing the camera.

const MILES_PER_DEGREE = 69.05;
const EARTH_RADIUS_MILES = 3958.8;

export function distanceMiles(lat1, lon1, lat2, lon2) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

function httpsUrl(value, hosts) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "https:" && hosts.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function camera(owner, lat, lon, name, image, link) {
  lat = Number(lat);
  lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!image && !link) return null;
  return { owner, lat, lon, name: String(name ?? "").trim() || "Camera", image: image ?? null, link: link ?? null };
}

const xmlText = (block, tag) => (block.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`))?.[1] ?? "").trim();

function parseCaltrans(text) {
  return (JSON.parse(text).data ?? []).flatMap(({ cctv }) => {
    if (cctv?.inService !== "true") return [];
    const image = httpsUrl(cctv.imageData?.static?.currentImageURL, ["cwwp2.dot.ca.gov"]);
    return camera("Caltrans", cctv.location?.latitude, cctv.location?.longitude, cctv.location?.locationName, image) ?? [];
  });
}

function parseNewYork(text) {
  return JSON.parse(text).flatMap((entry) => {
    if (entry.isOnline !== "true") return [];
    return camera("NYC DOT", entry.latitude, entry.longitude, entry.name, httpsUrl(entry.imageUrl, ["webcams.nyctmc.org"])) ?? [];
  });
}

function parseSeattle(text) {
  return (JSON.parse(text).features ?? []).flatMap(({ attributes, geometry }) => {
    const image = httpsUrl(attributes?.ImageURL, ["images.wsdot.wa.gov"]);
    return camera("WSDOT", geometry?.y, geometry?.x, attributes?.CameraTitle, image) ?? [];
  });
}

// Maryland publishes live video pages rather than still images.
function parseMaryland(text) {
  return JSON.parse(text).flatMap((entry) => {
    if (entry.opStatus !== "OK") return [];
    return camera("Maryland CHART", entry.lat, entry.lon, entry.name ?? entry.description, null, httpsUrl(entry.publicVideoURL, ["chart.maryland.gov"])) ?? [];
  });
}

function parseSydney(text) {
  return JSON.parse(text).flatMap((feature) => {
    if (feature.eventCategory !== "liveCams") return [];
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    const image = httpsUrl(feature.properties?.href, ["webcams.transport.nsw.gov.au"]);
    return camera("Transport for NSW", lat, lon, feature.properties?.title, image) ?? [];
  });
}

function parseSingapore(text) {
  return (JSON.parse(text).items?.[0]?.cameras ?? []).flatMap((entry) => {
    const image = httpsUrl(entry.image, ["images.data.gov.sg"]);
    return camera("LTA Singapore", entry.location?.latitude, entry.location?.longitude, `Camera ${entry.camera_id ?? ""}`, image) ?? [];
  });
}

function parseHongKong(text) {
  return Array.from(text.matchAll(/<image>([\s\S]*?)<\/image>/g), ([, block]) =>
    camera("Hong Kong Transport Department", xmlText(block, "latitude"), xmlText(block, "longitude"), xmlText(block, "description"), httpsUrl(xmlText(block, "url"), ["tdcctv.data.one.gov.hk"])),
  ).filter(Boolean);
}

function parseMadrid(text) {
  return Array.from(text.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g), ([, block]) => {
    const [lon, lat] = xmlText(block, "coordinates").split(",");
    const image = httpsUrl(block.match(/img src=(https:\/\/informo\.madrid\.es\/cameras\/Camara\d+\.jpg)/)?.[1], ["informo.madrid.es"]);
    const name = block.match(/<Data name="Nombre">\s*<Value>([^<]*)<\/Value>/)?.[1];
    return camera("Ayuntamiento de Madrid", lat, lon, name, image);
  }).filter(Boolean);
}

function parseLondon(text) {
  return JSON.parse(text).flatMap((place) => {
    const property = (key) => (place.additionalProperties ?? []).find((each) => each.key === key)?.value;
    if (property("available") === "false") return [];
    const image = httpsUrl(property("imageUrl"), ["s3-eu-west-1.amazonaws.com"]);
    return camera("Transport for London", place.lat, place.lon, place.commonName, image) ?? [];
  });
}

// region is [south, west, north, east]. A feed is only downloaded when a site
// falls inside its region, because several of these files are megabytes.
export const CAMERA_FEEDS = [
  { id: "los-angeles", place: "Los Angeles", region: [33.3, -119.6, 34.9, -117.6], url: "/api/feeds/cameras-caltrans?district=7", parse: parseCaltrans },
  { id: "bay-area", place: "San Francisco Bay Area", region: [36.9, -123.2, 38.5, -121.6], url: "/api/feeds/cameras-caltrans?district=4", parse: parseCaltrans },
  { id: "sacramento", place: "Sacramento", region: [38.2, -122.0, 39.4, -120.0], url: "/api/feeds/cameras-caltrans?district=3", parse: parseCaltrans },
  { id: "new-york", place: "New York", region: [40.45, -74.3, 40.95, -73.65], url: "/api/feeds/cameras-nyc", parse: parseNewYork },
  { id: "seattle", place: "Seattle area", region: [47.3, -122.6, 47.9, -121.9], url: "/api/feeds/cameras-seattle", parse: parseSeattle },
  { id: "maryland", place: "Maryland and the Washington suburbs", region: [37.9, -79.5, 39.75, -75.0], url: "/api/feeds/cameras-maryland", parse: parseMaryland },
  { id: "sydney", place: "Sydney", region: [-34.3, 150.5, -33.4, 151.5], url: "/api/feeds/cameras-sydney", parse: parseSydney },
  { id: "singapore", place: "Singapore", region: [1.15, 103.6, 1.48, 104.1], url: "/api/feeds/cameras-singapore", parse: parseSingapore },
  { id: "hong-kong", place: "Hong Kong", region: [22.15, 113.8, 22.6, 114.45], url: "/api/feeds/cameras-hongkong", parse: parseHongKong },
  { id: "madrid", place: "Madrid", region: [40.3, -3.9, 40.6, -3.5], url: "/api/feeds/cameras-madrid", parse: parseMadrid },
  // Transport for London rate-limits Cloudflare's shared addresses, so the
  // browser asks it directly.
  { id: "london", place: "London", region: [51.28, -0.52, 51.7, 0.34], url: "https://api.tfl.gov.uk/Place/Type/JamCam", parse: parseLondon },
];

export function feedsForSites(sites) {
  return CAMERA_FEEDS.filter(({ region: [south, west, north, east] }) =>
    sites.some((site) => site.lat >= south && site.lat <= north && site.lon >= west && site.lon <= east),
  );
}

// Cameras within `maxMiles` of a point, nearest first.
export function nearestCameras(cameras, lat, lon, limit, maxMiles) {
  const latSpan = maxMiles / MILES_PER_DEGREE;
  const lonSpan = latSpan / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  return cameras
    .filter((each) => Math.abs(each.lat - lat) <= latSpan && Math.abs(each.lon - lon) <= lonSpan)
    .map((each) => ({ ...each, miles: distanceMiles(lat, lon, each.lat, each.lon) }))
    .filter((each) => each.miles <= maxMiles)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, limit);
}

// Marks each camera with the nearest site inside `maxMiles`, if there is one.
export function correlate(cameras, sites, maxMiles) {
  const latSpan = maxMiles / MILES_PER_DEGREE;
  return cameras.map((each) => {
    let best = null;
    for (const site of sites) {
      if (Math.abs(site.lat - each.lat) > latSpan) continue;
      const miles = distanceMiles(each.lat, each.lon, site.lat, site.lon);
      if (miles <= maxMiles && (!best || miles < best.miles)) best = { site: site.name, miles };
    }
    return { ...each, nearSite: best?.site ?? null, siteMiles: best?.miles ?? null };
  });
}
