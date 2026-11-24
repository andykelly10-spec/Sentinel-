import { correlate, distanceMiles, feedsForSites, nearestCameras } from "/cameras.js";
import { analyseRoute, assessmentInput, avoidZones, compareRoutes, directionsLink, formatChange, indexCrimes, LEVELS, localTime, readCrime, readOsrm, readValhalla, reasons, summarise } from "/precog.js";

const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_COLORS = { critical: "#ff5252", high: "#ff8d5c", medium: "#fab219", low: "#8a93a0" };
const THREAT_NAMES = { critical: "Critical", high: "High", medium: "Elevated", low: "Guarded" };
const CATEGORIES = [
  ["", "All"],
  ["physical", "Physical"],
  ["cyber", "Cyber"],
  ["brand", "Brand"],
  ["executive", "Executive"],
  ["hazard", "Hazard"],
  ["unclassified", "Review"],
];
const SOURCE_NAMES = {
  bing_news: "Bing News",
  bing_local: "Bing News (near sites)",
  google_news: "Google News",
  bluesky: "Bluesky",
  bluesky_urgent: "Bluesky (urgent terms)",
  lemmy: "Lemmy",
  hackernews: "Hacker News",
  rss: "News outlets (24 feeds)",
  nws: "Weather warnings (National Weather Service)",
  usgs: "Earthquakes (USGS)",
  wildfire: "US wildfires (National Interagency Fire Center)",
  gdacs: "Global disasters (GDACS)",
  aircraft: "Aircraft emergencies (adsb.lol)",
  faa_tfr: "Flight restrictions (FAA)",
  travel_advisory: "Travel advisories (State Department)",
  domains: "Lookalike domains (certificate logs)",
  dispatch: "City 911 dispatch (Seattle Fire, San Francisco Police)",
  nixle: "Nixle police and agency alerts (your ZIP code)",
  air_raids: "Air raids: Ukraine alert status, Ukrainian Air Force, Russian Defence Ministry",
  outages: "Service status pages (14 providers) and IODA internet outages",
  brand_threats: "Brand threats: ransomware claims, phishing sites, data breaches",
  threat_levels: "UK terrorism threat level (MI5)",
  nhc: "Tropical storms (National Hurricane Center)",
};
const BRIEF_COLORS = { critical: "var(--critical)", high: "var(--high)", medium: "var(--medium)", low: "var(--low)" };
const WEATHER_CODES = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
  51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Showers", 81: "Showers", 82: "Heavy showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

const state = { category: "", severity: "", status: "new", alerts: [], groups: [], info: null, quakes: [], cameras: [], cameraFeeds: [] };

// A camera counts as covering a site when it is within this many miles of it.
const CAMERA_RANGE_MILES = 2;

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function svgIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    // The session has ended; reloading shows the sign-in page.
    location.reload();
    throw new Error("Signed out");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body;
}

function ago(value) {
  if (!value) return "";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

function safeUrl(value, hosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (hosts && !hosts.includes(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const saved = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`sentinel.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sentinel.${key}`, JSON.stringify(value));
    } catch {
      // Private windows may refuse storage; the page works without it.
    }
  },
};

const rank = (severity) => SEVERITIES.length - SEVERITIES.indexOf(severity);
const proximity = (item) =>
  item.site && item.distanceMi !== null
    ? `${item.distanceMi < 0.1 ? 0.1 : item.distanceMi} mi from ${item.site === "Your location" ? "you" : item.site}`
    : item.site === "Your location"
      ? "In your area"
      : "";

// ---------- map ----------

const map = L.map("map", { zoomControl: false, preferCanvas: true, worldCopyJump: true, minZoom: 2, maxZoom: 18 }).setView([30, -40], 3);
map.attributionControl.setPrefix(false);

const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const bases = {
  // Satellite imagery with place names and borders drawn over it.
  sat: L.layerGroup([
    L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, attribution: "Imagery © Esri and its data providers" }),
    L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18 }),
  ]),
  streets: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM_CREDIT }),
  dark: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, className: "dark-tiles", attribution: OSM_CREDIT }),
};

function setBase(name) {
  for (const [key, layer] of Object.entries(bases)) {
    if (key === name) {
      layer.addTo(map);
      layer.eachLayer ? layer.eachLayer((tiles) => tiles.setZIndex(0)) : layer.setZIndex(0);
    } else {
      layer.remove();
    }
  }
  for (const button of document.querySelectorAll("[data-base]")) {
    button.setAttribute("aria-pressed", String(button.dataset.base === name));
  }
  saved.set("base", name);
}

function popup(label, title, ...rest) {
  return el("div", { class: "popup" }, el("div", { class: "label" }, label), el("h3", {}, title), ...rest);
}

// Where it is night right now, as a polygon.
function nightPolygon(date) {
  const rad = Math.PI / 180;
  const days = date.getTime() / 86400000 + 2440587.5 - 2451545;
  const meanLongitude = (280.46 + 0.9856474 * days) % 360;
  const anomaly = ((357.528 + 0.9856003 * days) % 360) * rad;
  const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const tilt = (23.439 - 0.0000004 * days) * rad;
  const declination = Math.asin(Math.sin(tilt) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.cos(tilt) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) / rad;
  const siderealHours = (18.697374558 + 24.06570982441908 * days) % 24;
  const sunLongitude = rightAscension - siderealHours * 15;
  const points = [];
  for (let longitude = -360; longitude <= 360; longitude += 2) {
    const hourAngle = (longitude - sunLongitude) * rad;
    points.push([Math.atan(-Math.cos(hourAngle) / Math.tan(declination)) / rad, longitude]);
  }
  const darkPole = declination > 0 ? -90 : 90;
  return [[darkPole, -360], ...points, [darkPole, 360]];
}

function planeIcon(track, emergency) {
  const holder = el("div", { class: emergency ? "plane emergency" : "plane" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.style.transform = `rotate(${Number(track) || 0}deg)`;
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", "M12 2l2 7 7 4v2l-7-2v5l2 2v1l-4-1-4 1v-1l2-2v-5l-7 2v-2l7-4 2-7z");
  shape.setAttribute("fill", "currentColor");
  svg.append(shape);
  holder.append(svg);
  return L.divIcon({ html: holder, className: "", iconSize: [18, 18], iconAnchor: [9, 9] });
}

// Windy's free tier asks for its credit beside each image; its image links
// are signed, so they are used exactly as given.
function webcamView(cam) {
  const link = safeUrl(cam.link, ["windy.com", "www.windy.com"]);
  return popup(
    "Webcam",
    cam.name,
    el("p", { class: "muted" }, [cam.place, cam.updated ? `updated ${ago(cam.updated)}` : null].filter(Boolean).join(" · ")),
    cam.image ? el("img", { src: cam.image, alt: `View from ${cam.name}`, referrerpolicy: "no-referrer" }) : null,
    el("p", { class: "credit" }, "Webcams provided by ", el("a", { href: link ?? "https://www.windy.com/webcams", target: "_blank", rel: "noopener noreferrer" }, "windy.com")),
  );
}

function cameraView(each) {
  if (each.owner === "Windy") return webcamView(each);
  const note = [each.owner, each.nearSite ? `${each.siteMiles.toFixed(1)} mi from ${each.nearSite}` : null].filter(Boolean).join(" · ");
  return popup(
    each.kind === "wildfire" ? "Wildfire camera" : "Traffic camera",
    each.name,
    el("p", { class: "muted" }, note),
    each.image
      ? el("img", { src: `${each.image}${each.image.includes("?") ? "&" : "?"}t=${Date.now()}`, alt: `Live view from ${each.name}`, referrerpolicy: "no-referrer" })
      : el("p", {}, el("a", { href: each.link, target: "_blank", rel: "noopener noreferrer" }, "Open the live video")),
    each.kind === "wildfire" && each.link
      ? el("p", { class: "credit" }, "From ", el("a", { href: each.link, target: "_blank", rel: "noopener noreferrer" }, "ALERTCalifornia"), " (UC San Diego). Updated about every minute.")
      : null,
  );
}

// Windy webcams within `miles` of a point, nearest first, as camera entries.
async function nearbyWebcams(lat, lon, miles) {
  try {
    const { cameras } = await api(`/api/webcams?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${Math.ceil(miles * 1.609)}`);
    return cameras
      .map((cam) => ({ ...cam, owner: "Windy", miles: distanceMiles(lat, lon, cam.lat, cam.lon) }))
      .filter((cam) => cam.miles <= miles)
      .sort((a, b) => a.miles - b.miles);
  } catch {
    return [];
  }
}

// Links to live police, fire and EMS radio for the place (Broadcastify, OpenMHz).
async function scannerInfo(lat, lon, holder) {
  if (holder.dataset.loaded) return;
  holder.dataset.loaded = "1";
  let info;
  try {
    info = await api(`/api/scanner?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
  } catch {
    holder.dataset.loaded = "";
    return;
  }
  const link = (entry) => {
    const href = safeUrl(entry?.url, ["www.broadcastify.com", "openmhz.com"]);
    return href ? el("li", {}, el("a", { href, target: "_blank", rel: "noopener noreferrer" }, `${entry.label} ↗`)) : null;
  };
  holder.replaceChildren(
    el("div", { class: "label" }, "Police scanner"),
    info.available ? el("ul", { class: "scanner-links" }, link(info.broadcastify), link(info.openmhz)) : null,
    el("p", { class: "muted small" }, info.note),
  );
}

// A short list of the open cameras closest to a point; choosing one shows it.
async function nearbyCameras(lat, lon, holder) {
  const cameraLayer = LAYERS.find((layer) => layer.id === "cameras");
  holder.replaceChildren(el("p", { class: "muted" }, "Looking for cameras nearby…"));
  const traffic = cameraLayer.active ? nearestCameras(state.cameras, lat, lon, 4, CAMERA_RANGE_MILES) : [];
  const webcams = (await nearbyWebcams(lat, lon, CAMERA_RANGE_MILES)).slice(0, 4);
  const near = [...traffic, ...webcams].sort((a, b) => a.miles - b.miles).slice(0, 6);
  if (!near.length) {
    holder.replaceChildren(
      el("p", { class: "muted" }, cameraLayer.active ? `No open cameras within ${CAMERA_RANGE_MILES} miles.` : "No webcams nearby. Switch on the traffic camera layer to include traffic cameras."),
    );
    return;
  }
  const viewer = el("div", {});
  holder.replaceChildren(
    el("div", { class: "label" }, "Nearest cameras"),
    el(
      "div",
      { class: "camera-list" },
      ...near.map((each) => el("button", { onclick: () => viewer.replaceChildren(cameraView(each)) }, `${each.owner === "Windy" ? "Webcam: " : ""}${each.name} · ${each.miles.toFixed(1)} mi`)),
    ),
    viewer,
  );
}

async function siteConditions(site, holder) {
  const query = `lat=${site.lat}&lon=${site.lon}`;
  const [weather, alerts] = await Promise.allSettled([api(`/api/feeds/weather?${query}`), api(`/api/feeds/weather-alerts?${query}`)]);
  holder.replaceChildren();
  if (weather.status === "fulfilled" && weather.value?.current) {
    const now = weather.value.current;
    holder.append(
      el("p", {}, `${Math.round(now.temperature_2m)}°F, ${WEATHER_CODES[now.weather_code] ?? "conditions unknown"}. Wind ${Math.round(now.wind_speed_10m)} mph, gusts ${Math.round(now.wind_gusts_10m)} mph.`),
    );
  }
  if (alerts.status === "fulfilled") {
    for (const feature of (alerts.value?.features ?? []).slice(0, 3)) {
      holder.append(el("p", {}, el("strong", {}, "Weather alert: "), feature.properties?.headline ?? feature.properties?.event ?? ""));
    }
  }
  if (!holder.childNodes.length) holder.append(el("p", { class: "muted" }, "Conditions unavailable."));
}

// Each layer fills its own group and reports how many things it drew.
const LAYERS = [
  {
    id: "sites",
    label: "Company sites",
    icon: "M4 21V7l8-4 8 4v14M9 21v-5h6v5M9 10h.01M15 10h.01M9 13h.01M15 13h.01",
    on: true,
    load(group) {
      for (const site of state.info?.sites ?? []) {
        const icon = L.divIcon({ html: el("div", { class: site.priority ? "site-marker" : "site-marker minor" }), className: "", iconSize: [14, 14], iconAnchor: [7, 7] });
        const conditions = el("div", {}, el("p", { class: "muted" }, "Loading conditions…"));
        const cameras = el("div", {});
        const scanner = el("div", { class: "scanner" });
        const marker = L.marker([site.lat, site.lon], { icon, title: site.name, zIndexOffset: 500 }).bindPopup(
          popup(
            site.priority ? "Priority site" : "Site",
            site.name,
            el("p", { class: "muted" }, [site.address, site.city, site.country].filter(Boolean).join(", ")),
            site.approximate ? el("p", { class: "muted" }, "Position is approximate.") : null,
            conditions,
            cameras,
            scanner,
          ),
        );
        marker.on("popupopen", () => {
          siteConditions(site, conditions);
          nearbyCameras(site.lat, site.lon, cameras);
          scannerInfo(site.lat, site.lon, scanner);
        });
        group.addLayer(marker);
      }
      return (state.info?.sites ?? []).length;
    },
  },
  {
    id: "incidents",
    label: "Incidents",
    icon: "M12 3l10 18H2L12 3zM12 10v5M12 18h.01",
    on: true,
    load(group) {
      let count = 0;
      for (const item of state.groups) {
        if (item.lat === null || item.lon === null) continue;
        count++;
        const live = item.status === "new" && rank(item.severity) >= rank("high");
        const cameras = el("div", {});
        const scanner = el("div", { class: "scanner" });
        const icon = L.divIcon({ html: el("div", { class: `incident-marker sev-${item.severity}${live ? " live" : ""}` }), className: "", iconSize: [20, 20], iconAnchor: [10, 10] });
        const marker = L.marker([item.lat, item.lon], { icon, title: item.name, zIndexOffset: 1000 + rank(item.severity) }).bindPopup(
          popup(
            `${item.severity} · ${item.category}`,
            item.name,
            el("p", {}, item.summary),
            proximity(item) ? el("p", {}, el("strong", {}, proximity(item))) : null,
            el("p", { class: "muted" }, `${item.reports.length} report${item.reports.length === 1 ? "" : "s"} · ${ago(item.latest)}`),
            cameras,
            scanner,
          ),
        );
        marker.on("popupopen", () => {
          nearbyCameras(item.lat, item.lon, cameras);
          scannerInfo(item.lat, item.lon, scanner);
        });
        item.marker = marker;
        group.addLayer(marker);
      }
      return count;
    },
  },
  {
    id: "quakes",
    label: "Earthquakes, past day (USGS)",
    icon: "M2 12h4l3-8 4 16 3-8h6",
    on: true,
    every: 300,
    async load(group) {
      const data = await api("/api/feeds/quakes");
      state.quakes = [];
      for (const feature of data.features ?? []) {
        const [lon, lat] = feature.geometry?.coordinates ?? [];
        const { mag, place, time, url } = feature.properties ?? {};
        if (typeof lat !== "number" || typeof lon !== "number" || typeof mag !== "number") continue;
        state.quakes.push({ mag, place, time });
        const link = safeUrl(url, ["earthquake.usgs.gov"]);
        group.addLayer(
          L.circleMarker([lat, lon], { radius: 2 + mag * 1.6, color: "#ff5252", weight: 1, fillColor: "#ff5252", fillOpacity: 0.3 }).bindPopup(
            popup("Earthquake", `M${mag.toFixed(1)} · ${place ?? "Unknown location"}`, el("p", { class: "muted" }, ago(time)), link ? el("p", {}, el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "USGS event page")) : null),
          ),
        );
      }
      renderTicker();
      return state.quakes.length;
    },
  },
  {
    id: "weather",
    label: "Severe weather warnings, US (National Weather Service)",
    icon: "M13 2L4 14h7l-1 8 9-12h-7z",
    on: true,
    every: 300,
    async load(group) {
      const data = await api("/api/feeds/weather-warnings");
      let count = 0;
      group.addLayer(
        L.geoJSON(data, {
          filter: (feature) => Boolean(feature.geometry),
          style: (feature) => {
            const color = feature.properties?.severity === "Extreme" ? "#ff5252" : "#ff8d5c";
            return { color, weight: 1, fillColor: color, fillOpacity: 0.18 };
          },
          onEachFeature: (feature, layer) => {
            count++;
            const props = feature.properties ?? {};
            layer.bindPopup(() =>
              popup(
                `${props.severity ?? ""} weather`,
                props.event ?? "Weather warning",
                el("p", {}, props.areaDesc ?? ""),
                el("p", { class: "muted" }, props.ends || props.expires ? `Until ${new Date(props.ends ?? props.expires).toUTCString()}` : ""),
              ),
            );
          },
        }),
      );
      return count;
    },
  },
  {
    id: "wildfires",
    label: "Active wildfires, US (National Interagency Fire Center)",
    icon: "M12 2c1 4 5 6 5 11a5 5 0 01-10 0c0-3 2-4 2-7 2 1 3 3 3 5 1-1 1-3 0-9z",
    on: true,
    every: 900,
    async load(group) {
      const data = await api("/api/feeds/wildfires");
      let count = 0;
      for (const { attributes: fire = {}, geometry } of data.features ?? []) {
        if (typeof geometry?.y !== "number" || typeof geometry?.x !== "number") continue;
        count++;
        const acres = Math.round(fire.IncidentSize ?? 0);
        const contained = typeof fire.PercentContained === "number" ? `${fire.PercentContained}% contained` : "containment not reported";
        group.addLayer(
          L.circleMarker([geometry.y, geometry.x], {
            radius: 3 + Math.min(10, Math.log10(Math.max(1, acres)) * 2),
            color: "#3a0b00",
            weight: 1,
            fillColor: "#ff6a00",
            fillOpacity: 0.85,
          }).bindPopup(() =>
            popup(
              "Wildfire",
              fire.IncidentName ?? "Unnamed fire",
              el("p", {}, `${acres.toLocaleString()} acres, ${contained}`),
              el("p", { class: "muted" }, [fire.POOCounty && `${fire.POOCounty} County`, (fire.POOState ?? "").replace(/^US-/, "")].filter(Boolean).join(", ")),
            ),
          ),
        );
      }
      return count;
    },
  },
  {
    id: "disasters",
    label: "Global disasters: cyclones, floods, volcanoes (GDACS)",
    icon: "M12 4a8 8 0 108 8M12 8a4 4 0 104 4M12 12l8-8",
    on: true,
    every: 900,
    async load(group) {
      const data = await api("/api/feeds/disasters");
      const colors = { Red: "#ff5252", Orange: "#ff8d5c" };
      let count = 0;
      for (const feature of data.features ?? []) {
        const props = feature.properties ?? {};
        // Earthquakes already come from USGS.
        if (feature.geometry?.type !== "Point" || props.eventtype === "EQ") continue;
        const [lon, lat] = feature.geometry.coordinates ?? [];
        if (typeof lat !== "number" || typeof lon !== "number") continue;
        count++;
        const level = props.alertlevel ?? "Green";
        const link = safeUrl(props.url?.report, ["www.gdacs.org"]);
        group.addLayer(
          L.circleMarker([lat, lon], {
            radius: level === "Red" ? 9 : level === "Orange" ? 7 : 5,
            color: "#000",
            weight: 1,
            fillColor: colors[level] ?? "#7fb3ff",
            fillOpacity: 0.85,
          }).bindPopup(() =>
            popup(
              `${level} alert`,
              props.name ?? "Disaster",
              el("p", {}, props.htmldescription ?? ""),
              link ? el("p", {}, el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "GDACS report")) : null,
            ),
          ),
        );
      }
      return count;
    },
  },
  {
    id: "daynight",
    label: "Day and night",
    icon: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 3v18M12 7l5 2M12 12h8M12 17l5-2",
    on: true,
    every: 300,
    load(group) {
      group.addLayer(L.polygon(nightPolygon(new Date()), { stroke: false, fillColor: "#000", fillOpacity: 0.38, interactive: false }));
      return null;
    },
  },
  {
    id: "radar",
    label: "Rain radar (RainViewer)",
    icon: "M7 16a4 4 0 01.5-8 5.5 5.5 0 0110.6 1.5A3.5 3.5 0 0117.5 16M8 19v2M12 19v2M16 19v2",
    on: false,
    every: 300,
    async load(group) {
      const data = await api("/api/feeds/radar");
      const frame = (data.radar?.past ?? []).at(-1);
      if (data.host !== "https://tilecache.rainviewer.com" || !/^\/v2\/radar\/[\w-]+$/.test(frame?.path ?? "")) {
        throw new Error("Unexpected radar response");
      }
      group.addLayer(
        L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0.65, maxNativeZoom: 7, attribution: "Radar © RainViewer" }),
      );
      return null;
    },
  },
  {
    id: "imagery",
    label: "Yesterday's satellite pass (NASA)",
    icon: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
    on: false,
    load(group) {
      const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      group.addLayer(
        L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
          opacity: 0.8,
          maxNativeZoom: 9,
          attribution: "Imagery NASA GIBS",
        }),
      );
      return null;
    },
  },
  {
    id: "aircraft",
    label: "Aircraft around the map centre (zoom in to load)",
    icon: "M12 2l2 7 7 4v2l-7-2v5l2 2v1l-4-1-4 1v-1l2-2v-5l-7 2v-2l7-4 2-7z",
    on: false,
    every: 20,
    followsMap: true,
    async load(group) {
      if (map.getZoom() < 7) return null;
      const centre = map.getCenter().wrap();
      const data = await api(`/api/feeds/aircraft?lat=${centre.lat.toFixed(4)}&lon=${centre.lng.toFixed(4)}`);
      let count = 0;
      for (const craft of data.ac ?? []) {
        if (typeof craft.lat !== "number" || typeof craft.lon !== "number") continue;
        count++;
        const emergency = ["7500", "7600", "7700"].includes(craft.squawk);
        const altitude = typeof craft.alt_baro === "number" ? `${craft.alt_baro.toLocaleString()} ft` : "on the ground";
        group.addLayer(
          L.marker([craft.lat, craft.lon], { icon: planeIcon(craft.track, emergency), zIndexOffset: emergency ? 900 : 0 }).bindPopup(
            popup(
              emergency ? "Aircraft · emergency code" : "Aircraft",
              String(craft.flight ?? craft.r ?? craft.hex ?? "Unknown").trim(),
              el("p", {}, [craft.t, craft.r].filter(Boolean).join(" · ")),
              el("p", { class: "muted" }, `${altitude} · ${Math.round(craft.gs ?? 0)} kt · squawk ${craft.squawk ?? "none"}`),
            ),
          ),
        );
      }
      return count;
    },
  },
  {
    id: "cameras",
    label: "Traffic and wildfire cameras around your sites",
    icon: "M3 8h3l2-3h8l2 3h3v11H3zM12 17a4 4 0 100-8 4 4 0 000 8z",
    on: true,
    every: 1800,
    needsSites: true,
    async load(group) {
      const sites = state.info?.sites ?? [];
      const feeds = feedsForSites(sites);
      const results = await Promise.allSettled(
        feeds.map(async (feed) => {
          const response = await fetch(feed.url);
          if (!response.ok) throw new Error(`Request failed (${response.status})`);
          return feed.parse(await response.text());
        }),
      );
      state.cameraFeeds = feeds.map((feed, index) => ({
        place: feed.place,
        ok: results[index].status === "fulfilled",
        count: results[index].status === "fulfilled" ? results[index].value.length : 0,
      }));
      if (feeds.length && results.every((result) => result.status === "rejected")) throw results[0].reason;

      state.cameras = correlate(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])), sites, CAMERA_RANGE_MILES);
      let nearSites = 0;
      for (const each of state.cameras) {
        if (each.nearSite) nearSites++;
        // Cameras that cover a site stand out; the rest stay in the background.
        const colour = each.kind === "wildfire" ? "#ff8d5c" : "#1fd67a";
        const style = each.nearSite
          ? { radius: 5, color: "#04130b", weight: 1, fillColor: colour, fillOpacity: 0.95 }
          : { radius: each.kind === "wildfire" ? 4 : 3, stroke: false, fillColor: colour, fillOpacity: each.kind === "wildfire" ? 0.7 : 0.35 };
        // The image is only requested when someone opens the camera.
        group.addLayer(L.circleMarker([each.lat, each.lon], style).bindPopup(() => cameraView(each)));
      }
      return nearSites;
    },
  },
  {
    id: "webcams",
    label: "Webcams worldwide from Windy.com (zoom in to load)",
    icon: "M4 6h12v10H4zM16 9l4-2v8l-4-2M9 19h2",
    on: true,
    every: 600,
    followsMap: true,
    async load(group) {
      if (map.getZoom() < 9) return null;
      const bounds = map.getBounds();
      const north = Math.min(85, bounds.getNorth());
      const south = Math.max(-85, bounds.getSouth());
      const west = Math.max(-180, bounds.getWest());
      const east = Math.min(180, bounds.getEast());
      const { cameras } = await api(`/api/webcams?north=${north.toFixed(4)}&east=${east.toFixed(4)}&south=${south.toFixed(4)}&west=${west.toFixed(4)}`);
      for (const cam of cameras) {
        const entry = { ...cam, owner: "Windy" };
        group.addLayer(
          L.circleMarker([cam.lat, cam.lon], { radius: 5, color: "#04121a", weight: 1, fillColor: "#2fd3e6", fillOpacity: 0.9 }).bindPopup(() => webcamView(entry), { maxWidth: 420 }),
        );
      }
      return cameras.length;
    },
  },
  {
    id: "cables",
    label: "Submarine cables",
    icon: "M3 17c4 0 4-10 9-10s5 10 9 10M3 7h.01M21 7h.01",
    on: false,
    async load(group) {
      const data = await api("/api/feeds/cables");
      group.addLayer(L.geoJSON(data, { style: { color: "#2fd3e6", weight: 1, opacity: 0.45 }, interactive: false }));
      return (data.features ?? []).length;
    },
  },
  {
    id: "airraids",
    label: "Air raids: Ukraine alerts, missiles and drones; Russian interceptions",
    icon: "M12 2l3 7h-6zM10 9h4v8l-2 3-2-3zM8 13l2 2M16 13l-2 2",
    on: true,
    every: 60,
    async load(group) {
      const data = await api("/api/airraids");
      const styles = {
        active: { color: "#ff5252", fillColor: "#ff5252", fillOpacity: 0.32, weight: 1.5, radius: 55000 },
        partial: { color: "#ff8d5c", fillColor: "#ff8d5c", fillOpacity: 0.2, weight: 1, radius: 40000 },
        standing: { color: "#ff5252", fillColor: "#ff5252", fillOpacity: 0.08, weight: 1, dashArray: "4 4", radius: 45000 },
      };
      const states = {
        active: (oblast) => `Air raid alert since ${new Date(oblast.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${ago(oblast.since)})`,
        partial: (oblast) => `Alert in ${oblast.districts} district${oblast.districts === 1 ? "" : "s"} of the oblast`,
        standing: () => "Under a standing alert since 2022 (occupied territory)",
      };
      let count = 0;
      for (const oblast of data.oblasts) {
        const style = styles[oblast.state];
        if (!style) continue;
        if (oblast.state !== "standing") count++;
        group.addLayer(
          L.circle([oblast.lat, oblast.lon], { ...style, className: oblast.state === "active" ? "raid-active" : "" })
            .bindTooltip(oblast.name, { direction: "center", className: "raid-tip" })
            .bindPopup(popup("Air raid alert", oblast.name, el("p", {}, states[oblast.state](oblast)), el("p", { class: "muted" }, "Source: Ukraine air raid alert system"))),
        );
      }
      // Several posts about one region are fanned out so each can be opened.
      const placed = new Map();
      const colors = { kinzhal: "#ff2d55", ballistic: "#ff2d55", cruise: "#ff5252", missile: "#ff5252", bombers: "#ff8d5c", kab: "#b48cff", jet_drone: "#fab219", drone: "#fab219", other: "#8a93a0" };
      for (const threat of data.threats) {
        const region = threat.regions.at(-1);
        if (!region) continue;
        const n = placed.get(region.name) ?? 0;
        placed.set(region.name, n + 1);
        const angle = n * 2.4;
        const spread = n === 0 ? 0 : 0.12 + n * 0.03;
        const point = [region.lat + Math.sin(angle) * spread, region.lon + Math.cos(angle) * spread * 1.5];
        count++;
        group.addLayer(
          L.circleMarker(point, { radius: threat.missile ? 8 : 5, color: "#000", weight: 1, fillColor: colors[threat.kind], fillOpacity: 0.95 }).bindPopup(() => threatPopup(threat)),
        );
      }
      for (const report of data.interceptions) {
        for (const region of report.regions) {
          count++;
          group.addLayer(
            L.circleMarker([region.lat, region.lon], { radius: 7, color: "#000", weight: 1, fillColor: "#b48cff", fillOpacity: 0.85 })
              .bindTooltip(report.count ? String(report.count) : "", { permanent: Boolean(report.count) && report.regions.length === 1, direction: "right", className: "raid-tip" })
              .bindPopup(() => interceptionPopup(report)),
          );
        }
      }
      return count;
    },
  },
  {
    id: "iss",
    label: "International Space Station",
    icon: "M4 14l6-6 4 4-6 6zM12 10l2-2M15 5l4 4M17 3l4 4M3 21a6 6 0 004-2",
    on: false,
    every: 10,
    async load(group) {
      const data = await api("/api/feeds/iss");
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") throw new Error("No position");
      const icon = L.divIcon({ html: el("div", { class: "iss-marker" }), className: "", iconSize: [14, 14], iconAnchor: [7, 7] });
      group.addLayer(
        L.marker([data.latitude, data.longitude], { icon }).bindPopup(popup("Satellite", "International Space Station", el("p", { class: "muted" }, `${Math.round(data.altitude)} km up · ${Math.round(data.velocity).toLocaleString()} km/h`))),
      );
      return 1;
    },
  },
];

const savedLayers = saved.get("layers2", {});
for (const layer of LAYERS) {
  layer.group = L.layerGroup();
  layer.active = savedLayers[layer.id] ?? layer.on;
  layer.count = null;
  layer.failed = false;
}

async function loadLayer(layer) {
  if (!layer.active) return;
  // Built off-map and swapped in, so a refresh never blanks what is showing.
  const fresh = L.layerGroup();
  try {
    layer.count = await layer.load(fresh);
    layer.failed = false;
  } catch {
    layer.failed = true;
    renderRail();
    return;
  }
  if (!layer.active) return;
  layer.group.remove();
  layer.group = fresh.addTo(map);
  renderRail();
  renderReadouts();
}

function toggleLayer(layer) {
  layer.active = !layer.active;
  saved.set("layers2", Object.fromEntries(LAYERS.map((each) => [each.id, each.active])));
  clearInterval(layer.timer);
  if (layer.active) {
    loadLayer(layer);
    if (layer.every) layer.timer = setInterval(() => loadLayer(layer), layer.every * 1000);
  } else {
    layer.group.remove();
    layer.count = null;
    layer.failed = false;
  }
  renderRail();
  renderReadouts();
}

// ---------- rail ----------

const railTip = el("div", { class: "rail-tip", hidden: true });
document.body.append(railTip);

function railButton(label, icon, props, badge) {
  const button = el("button", { "aria-label": label, ...props }, svgIcon(icon), badge ? el("span", { class: "badge" }, badge) : null);
  const show = () => {
    railTip.textContent = label;
    railTip.style.top = `${button.getBoundingClientRect().top + 8}px`;
    railTip.hidden = false;
  };
  const hide = () => (railTip.hidden = true);
  button.addEventListener("mouseenter", show);
  button.addEventListener("focus", show);
  button.addEventListener("mouseleave", hide);
  button.addEventListener("blur", hide);
  return button;
}

function renderRail() {
  const focused = document.activeElement?.dataset?.layer;
  document.getElementById("rail").replaceChildren(
    ...LAYERS.map((layer) =>
      railButton(
        layer.failed ? `${layer.label}: unavailable right now` : layer.label,
        layer.icon,
        { "aria-pressed": String(layer.active), "data-layer": layer.id, class: layer.failed ? "failed" : false, onclick: () => toggleLayer(layer) },
        layer.active && layer.count ? String(layer.count > 999 ? `${Math.round(layer.count / 1000)}k` : layer.count) : null,
      ),
    ),
    el("div", { class: "spacer" }),
    railButton("Sentinel Pre-Cog: predict the safest route", "M4 19c3-1 4-5 8-5s5 3 8 1M12 3a5 5 0 015 5c0 2.8-5 6-5 6s-5-3.2-5-6a5 5 0 015-5zM12 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z", { id: "open-precog", onclick: openPrecog }),
    railButton("News: live TV and headlines", "M3 7h18v12H3zM8 3l4 4 4-4M7 11h6M7 15h4", { id: "open-news", onclick: () => openNewsroom() }),
    railButton("Morning brief", "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6", { id: "open-brief", onclick: openBrief }),
    railButton("Sites: view and import your site list", "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", { id: "open-sites", onclick: openSites }),
    railButton("Feeds: what is connected and what else can be", "M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4", { id: "open-feeds", onclick: openFeeds }),
    railButton("Sign out", "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10", { id: "sign-out", onclick: signOut }),
  );
  railTip.hidden = true;
  if (focused) document.querySelector(`[data-layer="${focused}"]`)?.focus();
}

// ---------- alerts ----------

function groupAlerts(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const key = alert.incident || alert.id;
    let group = groups.get(key);
    if (!group) {
      group = { key, incident: alert.incident, name: alert.incident || alert.title, reports: [], lat: null, lon: null, site: "", distanceMi: null, latest: alert.firstSeenAt, lead: alert };
      groups.set(key, group);
    }
    group.reports.push(alert);
    if (rank(alert.severity) > rank(group.lead.severity)) group.lead = alert;
    if (alert.firstSeenAt > group.latest) group.latest = alert.firstSeenAt;
  }
  for (const group of groups.values()) {
    // Position and distance come from the leading report, so the card, the
    // summary and the map agree; other reports only fill in what it lacks.
    const located = group.lead.lat !== null ? group.lead : group.reports.find((report) => report.lat !== null);
    const measured = group.lead.distanceMi !== null ? group.lead : group.reports.find((report) => report.distanceMi !== null);
    if (located) Object.assign(group, { lat: located.lat, lon: located.lon });
    if (measured) Object.assign(group, { site: measured.site, distanceMi: measured.distanceMi });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      severity: group.lead.severity,
      category: group.lead.category,
      summary: group.lead.summary,
      status: group.reports.some((report) => report.status === "new") ? "new" : group.lead.status,
    }))
    .sort((a, b) => rank(b.severity) - rank(a.severity) || b.latest.localeCompare(a.latest));
}

async function setStatus(group, status) {
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (group.incident) await post("/api/incidents/status", { incident: group.incident, status });
  else await post(`/api/alerts/${group.lead.id}/status`, { status });
  refresh();
}

let connector = null;

function locate(group) {
  if (group.lat === null) return;
  connector?.remove();
  const site = (state.info?.sites ?? []).find((each) => each.name === group.site);
  if (site) {
    connector = L.polyline([[group.lat, group.lon], [site.lat, site.lon]], { color: "#e3ab35", weight: 2, dashArray: "6 6" })
      .bindTooltip(`${group.distanceMi} mi`, { permanent: true, direction: "center", className: "distance-tip" })
      .addTo(map);
    map.flyToBounds(L.latLngBounds([[group.lat, group.lon], [site.lat, site.lon]]).pad(0.6), { maxZoom: 15, duration: 0.8 });
  } else {
    map.flyTo([group.lat, group.lon], 13, { duration: 0.8 });
  }
  group.marker?.openPopup();
}

// Alerts with no expiry of their own close 72 hours after the incident's last
// report (see closeStaleIncidents on the server); a card says so once it has
// been quiet for a day.
const STALE_CLOSE_HOURS = 72;
function quietNote(group) {
  if (group.status !== "new" || group.reports.some((report) => report.expiresAt)) return null;
  const quietHours = (Date.now() - Date.parse(group.latest)) / 3_600_000;
  if (quietHours < 24) return null;
  const left = Math.max(1, Math.round(STALE_CLOSE_HOURS - quietHours));
  return el("p", { class: "quiet-note" }, `No new reports for ${Math.floor(quietHours / 24)} day${quietHours >= 48 ? "s" : ""}. Closes automatically in about ${left} h unless there is news.`);
}

function renderCard(group) {
  const link = safeUrl(group.lead.url);
  const title = !group.incident && link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, group.name) : group.name;
  const category = group.category === "unclassified" ? "needs review" : group.category;
  const near = proximity(group);
  const reports = group.reports.length;
  const origin = [group.lead.author, SOURCE_NAMES[group.lead.source] ?? group.lead.source].filter(Boolean).join(" · ");
  const actions =
    group.status === "new"
      ? [el("button", { onclick: () => setStatus(group, "acknowledged") }, "Acknowledge"), el("button", { onclick: () => setStatus(group, "dismissed") }, "Dismiss")]
      : [el("button", { onclick: () => setStatus(group, "new") }, "Reopen")];
  if (group.lat !== null) actions.unshift(el("button", { onclick: () => locate(group) }, "Show on map"));

  return el(
    "article",
    { class: `card sev-${group.severity}${group.status === "new" ? "" : " closed"}` },
    el("div", { class: "tags" }, el("span", { class: "dot" }), el("span", { class: "sev" }, group.severity), el("span", {}, `· ${category}${group.status === "new" ? "" : ` · ${group.status}`}`)),
    el("h3", {}, title),
    el("p", {}, group.summary),
    near ? el("span", { class: "chip" }, near) : null,
    quietNote(group),
    el("div", { class: "meta" }, group.incident ? `${reports} report${reports === 1 ? "" : "s"} · latest ${ago(group.latest)}` : `${origin} · ${ago(group.lead.publishedAt ?? group.lead.firstSeenAt)}`),
    group.incident
      ? el(
          "details",
          {},
          el("summary", {}, `Sources (${reports})`),
          el(
            "ul",
            {},
            ...group.reports.slice(0, 40).map((report) => {
              const href = safeUrl(report.url);
              const label = `${report.title} — ${[report.author, SOURCE_NAMES[report.source] ?? report.source].filter(Boolean).join(" · ")}`;
              return el("li", {}, href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label) : label);
            }),
          ),
        )
      : null,
    el("div", { class: "actions" }, ...actions),
  );
}

function renderFeed() {
  const visible = state.groups.filter((group) => !state.severity || group.severity === state.severity);
  document.getElementById("feed").replaceChildren(...(visible.length ? visible.map(renderCard) : [el("div", { class: "empty" }, "No alerts match these filters.")]));
}

function renderCategories() {
  document.getElementById("categories").replaceChildren(
    ...CATEGORIES.map(([value, label]) =>
      el("button", { "aria-pressed": String(state.category === value), onclick: () => { state.category = value; refresh(); } }, label),
    ),
  );
}

// ---------- status ----------

function renderReadouts() {
  const info = state.info;
  const run = info?.lastRun;
  const stale = !run || Date.now() - new Date(run.finishedAt).getTime() > 40 * 60000;
  // Google News refuses Cloudflare most of the time; Bing carries the same stories,
  // so it alone does not mark the status as degraded.
  const failing = (run?.sources ?? []).filter((source) => source.error && source.source !== "google_news").length;
  const active = LAYERS.filter((layer) => layer.active);
  const entities = active.reduce((sum, layer) => sum + (layer.count ?? 0), 0);
  // `drop` names the readouts the stylesheet hides first on narrower screens.
  const item = (label, value, tone, drop) =>
    el("span", { class: [tone, drop && `drop-${drop}`].filter(Boolean).join(" ") || false }, `${label} `, el("b", {}, value));
  document.getElementById("readouts").replaceChildren(
    item("Zulu", `${new Date().toISOString().slice(11, 19)}Z`),
    item("Status", stale ? "Stale" : failing ? "Degraded" : "Live", stale || failing ? "warn" : "ok"),
    item("Layers", String(active.length), null, 1),
    item("Entities", entities.toLocaleString(), null, 2),
    item("Sites", String(info?.sites?.length ?? 0), null, 3),
    item("Checked", run ? ago(run.finishedAt) : "never", null, 4),
  );
  const online = document.getElementById("online");
  online.textContent = stale ? "Stale" : "Online";
  online.className = stale ? "online warn" : "online";
}

function renderStatus() {
  const info = state.info;
  const top = SEVERITIES.find((severity) => (info.open[severity] ?? 0) > 0);
  const threat = document.getElementById("threat");
  threat.replaceChildren(el("span", { class: "threat-label" }, "Threat level: "), top ? THREAT_NAMES[top] : "Clear");
  threat.className = top ? `threat sev-${top}` : "threat";

  document.getElementById("counts").replaceChildren(
    ...SEVERITIES.map((severity) =>
      el(
        "button",
        { class: `count sev-${severity}`, "aria-pressed": String(state.severity === severity), onclick: () => { state.severity = state.severity === severity ? "" : severity; renderStatus(); renderFeed(); } },
        el("span", { class: "n" }, String(state.groups.filter((group) => group.severity === severity).length)),
        el("span", { class: "name" }, severity),
      ),
    ),
  );

  // One bar per hour for the last 24 hours, oldest first.
  const byHour = new Map(info.activity.map((row) => [row.hour, row]));
  const hours = Array.from({ length: 24 }, (_, index) => new Date(Date.now() - (23 - index) * 3600000).toISOString().slice(0, 13));
  const peak = Math.max(1, ...hours.map((hour) => byHour.get(hour)?.alerts ?? 0));
  const tip = document.getElementById("activity-tip");
  const total = hours.reduce((sum, hour) => sum + (byHour.get(hour)?.alerts ?? 0), 0);
  const scanned = hours.reduce((sum, hour) => sum + (byHour.get(hour)?.scanned ?? 0), 0);
  document.getElementById("activity-total").textContent = `${total} reports · ${scanned.toLocaleString()} scanned`;
  document.getElementById("activity").replaceChildren(
    ...hours.map((hour) => {
      const row = byHour.get(hour) ?? { alerts: 0, scanned: 0 };
      const text = `${hour.slice(11)}:00Z · ${row.alerts} alert${row.alerts === 1 ? "" : "s"} · ${row.scanned} scanned`;
      const bar = el("button", { class: "bar", "aria-label": text }, el("i", { style: `height:${Math.round((row.alerts / peak) * 100)}%` }));
      const show = () => {
        tip.textContent = text;
        tip.style.left = `${Math.min(Math.max(bar.offsetLeft + bar.offsetWidth / 2, 80), bar.parentElement.offsetWidth - 60)}px`;
        tip.style.top = `${bar.parentElement.offsetTop - 4}px`;
        tip.hidden = false;
      };
      const hide = () => (tip.hidden = true);
      bar.addEventListener("mouseenter", show);
      bar.addEventListener("focus", show);
      bar.addEventListener("mouseleave", hide);
      bar.addEventListener("blur", hide);
      return bar;
    }),
  );
  renderReadouts();
}

function renderTicker() {
  const entries = [
    ...state.groups
      .filter((group) => group.status === "new")
      .slice(0, 12)
      .map((group) => el("span", { class: `sev-${group.severity}` }, el("i", {}), el("b", {}, group.severity), [group.name, proximity(group)].filter(Boolean).join(" · "))),
    ...state.quakes
      .filter((quake) => quake.mag >= 4.5)
      .slice(0, 10)
      .map((quake) => el("span", { class: "sev-critical" }, el("i", {}), el("b", {}, `M${quake.mag.toFixed(1)}`), quake.place ?? "")),
  ];
  const track = document.getElementById("ticker");
  if (!entries.length) {
    track.replaceChildren(el("span", {}, "No open alerts."));
    track.style.animation = "none";
    return;
  }
  // Two copies side by side make the scroll loop without a jump.
  track.replaceChildren(...entries, ...entries.map((entry) => entry.cloneNode(true)));
  track.style.animation = "";
  track.style.animationDuration = `${Math.max(40, entries.length * 9)}s`;
}

// ---------- drawers ----------

function openDrawer(title, ...content) {
  closeNewsroom();
  document.getElementById("drawer-title").textContent = title;
  document.getElementById("drawer-body").replaceChildren(...content);
  document.getElementById("drawer").hidden = false;
  document.getElementById("drawer-close").focus();
}

async function signOut() {
  await fetch("/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

// ---------- news: live TV and headlines ----------

const CHANNELS = [
  { id: "sky", name: "Sky News", channel: "UCoMdktPbSTixAyNGwb-UYkQ" },
  { id: "cbs", name: "CBS News 24/7", channel: "UC8p1vwvWtl6T73JiExfWs1g" },
  { id: "aje", name: "Al Jazeera English", channel: "UCNye-wNBqNL5ZzHSJj3l8Bg" },
  { id: "abc", name: "ABC News Live", channel: "UCBi2mrWuNuyYy4gbM6fU18Q" },
  { id: "nbc", name: "NBC News NOW", channel: "UCeY0bbntWzzVIaj2z3QigXg" },
  { id: "dw", name: "DW News", channel: "UCknLrEdhRCp1aegoMqRaCZg" },
  { id: "france24", name: "France 24 English", channel: "UCQfwfsi5VrQ8yKZ-UWmAEFg" },
  { id: "euronews", name: "Euronews", channel: "UCSrZ3UV4jOidv8ppoVuvW9Q" },
  { id: "bloomberg", name: "Bloomberg TV", channel: "UCIALMKvObZNtJ6AmdCLP7Lg" },
  // Live city cameras: fixed 24/7 streams, so they are embedded directly.
  { id: "cam-timessquare", group: "cams", name: "Times Square, New York (EarthCam)", channel: "UC6qrG3W8SMK0jior2olka3g", video: "KHy_n-EMWY8" },
  { id: "cam-nyc", group: "cams", name: "New York City 24/7 (FOX 5)", channel: "UCIjSUWHWp6KohfnR5OQTXnQ", video: "VGnFLdQW39A" },
  { id: "cam-hollywood", group: "cams", name: "Hollywood, Los Angeles (LA Times)", channel: "UC4Rrzu44rIpYtuVit90Kl5w", video: "YHWJd_DNgKY" },
  { id: "cam-whitehouse", group: "cams", name: "White House, Washington (earthTV)", channel: "UCRuyAVeVd7oUwh0LWmxxBBQ", video: "5p_KGD4fJZs" },
  { id: "cam-monument", group: "cams", name: "Washington Monument (EarthCam)", channel: "UC6qrG3W8SMK0jior2olka3g", video: "mG2gAWY_Guw" },
  { id: "cam-abbeyroad", group: "cams", name: "Abbey Road, London (EarthCam)", channel: "UC6qrG3W8SMK0jior2olka3g", video: "zMCea32gpmg" },
  { id: "cam-jerusalem", group: "cams", name: "Western Wall, Jerusalem (EarthCam)", channel: "UC6qrG3W8SMK0jior2olka3g", video: "77akujLn4k8" },
  { id: "cam-ukraine", group: "cams", name: "Ukraine city cameras: Kyiv, Kharkiv, Odesa… (Intel Cams)", channel: "UCper-NWj8xdXacSpFtF4Mgg", video: "IcZ-7sFi1HM" },
  { id: "cam-mideast", group: "cams", name: "Middle East city cameras (Intel Cams)", channel: "UCper-NWj8xdXacSpFtF4Mgg", video: "q1NR5q9tZd0" },
];
const HEADLINE_FILTERS = ["All", "World", "US", "UK", "Los Angeles", "New York", "Washington DC", "London"];
const newsroom = { tab: "tv", filter: "All", timer: null };

// ---------- air raids ----------

function translated(item) {
  const link = safeUrl(item.translate, ["translate.google.com"]);
  const source = safeUrl(item.url, ["t.me"]);
  return el(
    "p",
    { class: "links" },
    source ? el("a", { href: source, target: "_blank", rel: "noopener noreferrer" }, "Original post") : null,
    source && link ? " · " : null,
    link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "Translate") : null,
  );
}

function threatPopup(threat) {
  const where = threat.regions.map((region) => region.name).join(" → ");
  return popup(
    `Ukrainian Air Force · ${ago(threat.time)}`,
    threat.label,
    where ? el("p", {}, where) : null,
    el("p", { class: "muted original", lang: "uk" }, threat.text),
    translated(threat),
  );
}

function interceptionPopup(report) {
  return popup(`Russian Defence Ministry · ${ago(report.time)}`, "Interceptions over Russia", el("p", {}, report.summary), el("p", { class: "muted original", lang: "ru" }, report.text), translated(report));
}

async function renderAirRaids() {
  const body = document.getElementById("newsroom-body");
  if (!body.querySelector(".raids")) body.replaceChildren(el("p", { class: "note" }, "Loading air raid alerts…"));
  let data;
  try {
    data = await api("/api/airraids");
  } catch (error) {
    body.replaceChildren(el("div", { class: "result error" }, `Could not load air raid alerts. ${error.message}`));
    return;
  }
  if (newsroom.tab !== "airraids" || document.getElementById("newsroom").hidden) return;
  const active = data.oblasts.filter((oblast) => oblast.state === "active");
  const partial = data.oblasts.filter((oblast) => oblast.state === "partial");
  const failed = Object.keys(data.errors ?? {});
  const list = (items, render) => (items.length ? el("ol", { class: "headlines" }, ...items.map(render)) : el("p", { class: "note" }, "Nothing reported."));
  body.replaceChildren(
    el(
      "div",
      { class: "raids" },
      el(
        "div",
        { class: `raid-summary ${active.length >= 12 ? "sev-high" : active.length ? "sev-medium" : ""}` },
        el("span", { class: "big" }, String(active.length)),
        el("span", {}, ` of 24 Ukrainian regions under air raid alert${partial.length ? `, ${partial.length} more in part` : ""}.`),
      ),
      active.length || partial.length
        ? el(
            "p",
            { class: "chips" },
            ...active.map((oblast) => el("span", { class: "chip sev-critical" }, `${oblast.name} · ${ago(oblast.since)}`)),
            ...partial.map((oblast) => el("span", { class: "chip" }, `${oblast.name} (part)`)),
          )
        : null,
      el("p", { class: "note" }, `Updated ${ago(data.updatedAt)}. Crimea, Sevastopol and Luhansk are under standing alerts and are not counted.${failed.length ? ` Not answering just now: ${failed.join(", ")}.` : ""}`),
      el("h3", {}, "Ukrainian Air Force · last 3 hours"),
      list(data.threats, (threat) =>
        el(
          "li",
          { class: threat.missile ? "missile" : "" },
          el("div", { class: "meta" }, `${new Date(threat.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${ago(threat.time)}${threat.regions.length ? ` · ${threat.regions.map((region) => region.name).join(" → ")}` : ""}`),
          el("strong", {}, threat.label),
          el("p", { class: "original", lang: "uk" }, threat.text),
          translated(threat),
        ),
      ),
      el("h3", {}, "Russian Defence Ministry · interceptions, last 24 hours"),
      list(data.interceptions, (report) =>
        el("li", {}, el("div", { class: "meta" }, ago(report.time)), el("strong", {}, report.summary), el("p", { class: "original", lang: "ru" }, report.text), translated(report)),
      ),
    ),
  );
}

// ---------- outages ----------

const OUTAGE_LEVEL = { high: "down", medium: "partial", low: "minor" };

async function renderOutages() {
  const body = document.getElementById("newsroom-body");
  if (!body.querySelector(".outages")) body.replaceChildren(el("p", { class: "note" }, "Checking service status…"));
  let data;
  try {
    data = await api("/api/outages");
  } catch (error) {
    body.replaceChildren(el("div", { class: "result error" }, `Could not load service status. ${error.message}`));
    return;
  }
  if (newsroom.tab !== "outages" || document.getElementById("newsroom").hidden) return;
  const worst = (provider) => provider.outages.reduce((top, outage) => (rank(outage.severity) > rank(top) ? outage.severity : top), "low");
  const providers = [...data.providers].sort((a, b) => (b.outages.length ? rank(worst(b)) + 1 : 0) - (a.outages.length ? rank(worst(a)) + 1 : 0));
  const serious = data.providers.filter((provider) => provider.outages.some((outage) => outage.severity !== "low")).length;
  body.replaceChildren(
    el(
      "div",
      { class: "outages" },
      el(
        "div",
        { class: `raid-summary ${serious ? "sev-high" : ""}` },
        el("span", { class: "big" }, String(serious)),
        el("span", {}, ` of ${data.providers.length} services with a significant outage now.`),
      ),
      el("p", { class: "note" }, `From each provider's official status page, updated ${ago(data.updatedAt)}. Minor and long-running problems are listed here but do not raise alerts.`),
      el(
        "ul",
        { class: "services" },
        ...providers.map((provider) => {
          const level = provider.error ? "unknown" : provider.outages.length ? OUTAGE_LEVEL[worst(provider)] : "ok";
          const page = safeUrl(provider.page);
          return el(
            "li",
            { class: `service ${level}` },
            el(
              "div",
              { class: "service-head" },
              el("span", { class: "light", "aria-hidden": "true" }),
              page ? el("a", { href: page, target: "_blank", rel: "noopener noreferrer" }, provider.name) : provider.name,
              el("span", { class: "what" }, provider.what),
              el("span", { class: "state" }, provider.error ? "No answer" : provider.outages.length ? `${provider.outages.length} open` : "Operational"),
            ),
            ...provider.outages.map((outage) => {
              const link = safeUrl(outage.url);
              return el(
                "div",
                { class: `service-issue sev-${outage.severity}` },
                el("div", { class: "meta" }, `${outage.severity}${outage.status ? ` · ${outage.status}` : ""}${outage.started ? ` · started ${ago(outage.started)}` : ""}`),
                link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, outage.title) : outage.title,
                outage.detail ? el("p", {}, outage.detail) : null,
              );
            }),
          );
        }),
      ),
      el("h3", {}, "US airports · FAA"),
      data.airportError
        ? el("p", { class: "note" }, `Not answering just now: ${data.airportError}.`)
        : (data.airports ?? []).length
          ? el(
              "ul",
              { class: "services" },
              ...data.airports.map((issue) =>
                el(
                  "li",
                  { class: `service ${issue.kind === "ground stop" || issue.kind === "closure" || /NATION/i.test(issue.reason) ? "down" : (issue.delayMinutes ?? 0) >= 60 ? "partial" : "minor"}` },
                  el(
                    "div",
                    { class: "service-head" },
                    el("span", { class: "light", "aria-hidden": "true" }),
                    el("strong", {}, issue.code),
                    el("span", { class: "what" }, `${issue.name} · ${issue.kind}${issue.delayMinutes ? ` · avg ${issue.delayMinutes} min` : ""}${issue.reason ? ` · ${issue.reason}` : ""}`),
                  ),
                ),
              ),
            )
          : el("p", { class: "note" }, "No ground stops, closures or major delays reported."),
      el("h3", {}, "Country-wide internet outages · IODA"),
      data.internetError
        ? el("p", { class: "note" }, `Not answering just now: ${data.internetError}.`)
        : data.internet.length
          ? el(
              "ul",
              { class: "services" },
              ...data.internet.map((outage) =>
                el(
                  "li",
                  { class: `service ${outage.signals.some((signal) => signal === "bgp" || signal === "ping-slash24") ? "partial" : "minor"}` },
                  el(
                    "div",
                    { class: "service-head" },
                    el("span", { class: "light", "aria-hidden": "true" }),
                    el("a", { href: `https://ioda.inetintel.cc.gatech.edu/country/${encodeURIComponent(outage.code)}`, target: "_blank", rel: "noopener noreferrer" }, outage.country),
                    el("span", { class: "what" }, `since ${ago(outage.since)} · seen in ${outage.signals.join(", ")}`),
                  ),
                ),
              ),
            )
          : el("p", { class: "note" }, "No country-wide internet outages detected."),
      el("p", { class: "note" }, "Signals: bgp = internet routes withdrawn; ping-slash24 = networks stopped answering; gtr = drop in Google traffic (least reliable on its own)."),
    ),
  );
}

function closeNewsroom() {
  const panel = document.getElementById("newsroom");
  if (panel.hidden) return;
  panel.hidden = true;
  // Removing the players stops the streams.
  document.getElementById("newsroom-body").replaceChildren();
  for (const screen of tvScreens.values()) clearInterval(screen.handshake);
  tvScreens.clear();
  clearInterval(newsroom.timer);
}

function openNewsroom(tab = newsroom.tab) {
  document.getElementById("drawer").hidden = true;
  newsroom.tab = tab;
  document.getElementById("newsroom").hidden = false;
  for (const button of document.querySelectorAll("[data-news-tab]")) {
    button.setAttribute("aria-pressed", String(button.dataset.newsTab === tab));
  }
  clearInterval(newsroom.timer);
  if (tab === "tv") renderTvWall();
  else if (tab === "outages") {
    renderOutages();
    newsroom.timer = setInterval(renderOutages, 2 * 60_000);
  } else if (tab === "airraids") {
    renderAirRaids();
    newsroom.timer = setInterval(renderAirRaids, 60_000);
  } else {
    renderHeadlines();
    newsroom.timer = setInterval(renderHeadlines, 5 * 60_000);
  }
}

// The exact live video for each channel, looked up by the server.
const liveVideos = {};
const LIVE_REFRESH_MS = 15 * 60_000;
const YOUTUBE = "https://www.youtube.com";
// The screens on show, by player id, so YouTube's messages reach the right one.
const tvScreens = new Map();
const PLAYER_ERRORS = {
  2: "the video link is not valid",
  5: "this browser could not play it",
  100: "the stream has ended or been taken down",
  101: "the channel does not allow its stream to play on other websites",
  150: "the channel does not allow its stream to play on other websites",
  152: "the channel does not allow its stream to play on other websites",
  153: "it could not confirm which website is showing it",
};

function embedUrl(channel, video) {
  // enablejsapi lets the player tell this page when something goes wrong.
  const params = `autoplay=1&mute=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  return video ? `${YOUTUBE}/embed/${video.videoId}?${params}` : `${YOUTUBE}/embed/live_stream?channel=${channel.channel}&${params}`;
}

const watchUrl = (screen) => (screen.video ? `${YOUTUBE}/watch?v=${screen.video.videoId}` : `${YOUTUBE}/channel/${screen.channel.channel}/live`);

// YouTube's player reports events once the page says it is listening; it may
// not be ready for the first few messages, so they are repeated briefly.
function listenTo(screen) {
  clearInterval(screen.handshake);
  let tries = 0;
  const send = (message) => screen.frame.contentWindow?.postMessage(JSON.stringify({ ...message, id: screen.id, channel: "widget" }), YOUTUBE);
  screen.heard = false;
  screen.handshake = setInterval(() => {
    if (screen.heard || ++tries > 20 || !screen.frame.isConnected) return clearInterval(screen.handshake);
    send({ event: "listening" });
    send({ event: "command", func: "addEventListener", args: ["onError"] });
  }, 500);
}

window.addEventListener("message", (event) => {
  if (event.origin !== YOUTUBE || typeof event.data !== "string") return;
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  const screen = tvScreens.get(data.id);
  if (!screen || !screen.frame.isConnected) return;
  screen.heard = true;
  if (data.event === "onError") screenFailed(screen, Number(data.info));
});

function showVideo(screen, video) {
  screen.video = video;
  screen.stage.querySelector(".tv-error")?.remove();
  screen.frame.src = embedUrl(screen.channel, video);
  screen.title.textContent = video?.title ?? "";
  screen.title.title = video?.title ?? "";
  screen.link.href = watchUrl(screen);
}

// The stream may simply have ended (breaking-news streams often do), so ask
// for whatever the channel has live now before giving up.
async function screenFailed(screen, code) {
  if (screen.failing) return;
  screen.failing = true;
  // Fixed city-camera streams have no lookup to retry.
  if (!screen.retried && !screen.channel.video) {
    screen.retried = true;
    try {
      const { videos } = await api(`/api/live?channels=${screen.channel.id}&fresh=1`);
      const video = videos[screen.channel.id] ?? null;
      liveVideos[screen.channel.id] = { video, at: Date.now() };
      if (video && video.videoId !== screen.video?.videoId) {
        screen.failing = false;
        return showVideo(screen, video);
      }
    } catch {
      // Fall through to the message.
    }
  }
  screen.stage.querySelector(".tv-error")?.remove();
  screen.stage.append(
    el(
      "div",
      { class: "tv-error", role: "status" },
      el("strong", {}, `${screen.channel.name} won't play here right now`),
      el("p", {}, `YouTube says ${PLAYER_ERRORS[code] ?? `there was a problem (error ${code})`}.`),
      el(
        "div",
        { class: "actions" },
        el("a", { class: "pill gold", href: watchUrl(screen), target: "_blank", rel: "noopener noreferrer" }, "Watch on YouTube ↗"),
        el(
          "button",
          {
            class: "pill",
            onclick: () => {
              screen.retried = false;
              screen.failing = false;
              showVideo(screen, screen.video);
            },
          },
          "Try again",
        ),
      ),
    ),
  );
  screen.failing = false;
}

function tvTile(slot, chosen) {
  const channel = CHANNELS.find((each) => each.id === chosen) ?? CHANNELS[slot];
  // City cameras are fixed streams; news channels use the server's lookup.
  const video = channel.video ? { videoId: channel.video, title: channel.name } : (liveVideos[channel.id]?.video ?? null);
  const option = (each) => el("option", { value: each.id, selected: each.id === channel.id }, each.name);
  const select = el(
    "select",
    { "aria-label": `Channel for screen ${slot + 1}` },
    el("optgroup", { label: "News channels" }, ...CHANNELS.filter((each) => !each.group).map(option)),
    el("optgroup", { label: "Live city cameras" }, ...CHANNELS.filter((each) => each.group === "cams").map(option)),
  );
  select.addEventListener("change", () => {
    const wall = saved.get("tvWall", CHANNELS.slice(0, 4).map((each) => each.id));
    wall[slot] = select.value;
    saved.set("tvWall", wall);
    renderTvWall();
  });
  const id = `tv-${slot}-${Math.random().toString(36).slice(2, 8)}`;
  const frame = el("iframe", {
    id,
    src: embedUrl(channel, video),
    title: `${channel.name} live`,
    allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
    allowfullscreen: true,
    // YouTube refuses to play embeds that arrive without a referrer.
    referrerpolicy: "strict-origin-when-cross-origin",
  });
  const screen = {
    id,
    slot,
    channel,
    video,
    frame,
    stage: el("div", { class: "tv-stage" }, frame),
    title: el("div", { class: "tv-title", title: video?.title ?? "" }, video?.title ?? ""),
    link: el("a", { href: "#", target: "_blank", rel: "noopener noreferrer" }, "YouTube ↗"),
    retried: false,
    failing: false,
  };
  screen.link.href = watchUrl(screen);
  tvScreens.set(id, screen);
  frame.addEventListener("load", () => listenTo(screen));
  return el("div", { class: "tv-tile", "data-channel": channel.id }, el("div", { class: "tv-head" }, select, screen.link), screen.stage, screen.title);
}

async function renderTvWall() {
  const wall = saved.get("tvWall", CHANNELS.slice(0, 4).map((each) => each.id));
  const stale = wall.filter((id) => !CHANNELS.find((each) => each.id === id)?.video && (!liveVideos[id] || Date.now() - liveVideos[id].at > LIVE_REFRESH_MS));
  if (stale.length) {
    try {
      const { videos } = await api(`/api/live?channels=${stale.join(",")}`);
      for (const [id, video] of Object.entries(videos)) liveVideos[id] = { video, at: Date.now() };
    } catch {
      // The screens fall back to the channel's own live link.
    }
    if (newsroom.tab !== "tv" || document.getElementById("newsroom").hidden) return;
  }
  for (const screen of tvScreens.values()) clearInterval(screen.handshake);
  tvScreens.clear();
  document.getElementById("newsroom-body").replaceChildren(
    el("div", { class: "tv-grid" }, ...[0, 1, 2, 3].map((slot) => tvTile(slot, wall[slot]))),
    el("p", { class: "note" }, "Streams start muted; click a player for sound. If a stream ends, its screen switches to whatever the channel is broadcasting now. Choose channels with the menus above each screen."),
  );
}

async function renderHeadlines() {
  const body = document.getElementById("newsroom-body");
  if (!body.querySelector(".headlines")) body.replaceChildren(el("p", { class: "note" }, "Loading headlines…"));
  let data;
  try {
    data = await api("/api/headlines");
  } catch (error) {
    body.replaceChildren(el("div", { class: "result error" }, `Could not load headlines. ${error.message}`));
    return;
  }
  if (newsroom.tab !== "headlines" || document.getElementById("newsroom").hidden) return;
  const shown = data.headlines.filter((story) => newsroom.filter === "All" || story.region === newsroom.filter);
  body.replaceChildren(
    el(
      "div",
      { class: "tabs headline-filters", role: "group", "aria-label": "Region" },
      ...HEADLINE_FILTERS.map((name) =>
        el("button", { "aria-pressed": String(newsroom.filter === name), onclick: () => { newsroom.filter = name; renderHeadlines(); } }, name),
      ),
    ),
    el(
      "p",
      { class: "note" },
      `${data.headlines.length} stories from 24 outlets, updated ${ago(data.fetchedAt)}.`,
      data.failed.length ? ` Not answering just now: ${data.failed.join(", ")}.` : "",
    ),
    el(
      "ol",
      { class: "headlines" },
      ...shown.map((story) => {
        const href = safeUrl(story.url);
        return el(
          "li",
          {},
          el("div", { class: "meta" }, `${story.outlet} · ${story.region} · ${ago(story.publishedAt)}`),
          href ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, story.title) : story.title,
          story.summary ? el("p", {}, story.summary) : null,
        );
      }),
    ),
  );
}

function openSites() {
  const sites = state.info?.sites ?? [];
  const file = el("input", { type: "file", accept: ".csv,text/csv", "aria-label": "Site list file" });
  const replace = el("input", { type: "checkbox", id: "replace-sites", checked: true });
  const result = el("div", {});
  const button = el("button", { class: "pill gold" }, "Import");
  button.addEventListener("click", async () => {
    if (!file.files[0]) {
      result.replaceChildren(el("div", { class: "result error" }, "Choose a .csv file first."));
      return;
    }
    button.disabled = true;
    button.textContent = "Importing…";
    try {
      const outcome = await api("/api/sites/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv: await file.files[0].text(), replace: replace.checked }) });
      await refresh();
      openSites();
      document.getElementById("drawer-body").prepend(
        el(
          "div",
          { class: "result" },
          `Imported ${outcome.imported} site${outcome.imported === 1 ? "" : "s"}. ${outcome.estimated} had no coordinates and were placed by estimate.`,
          outcome.skipped.length ? el("ul", {}, ...outcome.skipped.slice(0, 30).map((line) => el("li", {}, line))) : null,
        ),
      );
    } catch (error) {
      result.replaceChildren(el("div", { class: "result error" }, error.message));
      button.disabled = false;
      button.textContent = "Import";
    }
  });

  openDrawer(
    "Sites",
    el("h3", {}, `${sites.length} site${sites.length === 1 ? "" : "s"} watched`),
    el("p", {}, "Sentinel flags incidents by their distance from these buildings. Upload your own list to replace the starter set."),
    el("h3", {}, "Import a site list"),
    el("p", { class: "note" }, "Save your spreadsheet as CSV. The first row names the columns: ", el("code", {}, "name"), " is required, plus either ", el("code", {}, "lat"), " and ", el("code", {}, "lon"), " or an ", el("code", {}, "address"), " and ", el("code", {}, "city"), ". Optional: ", el("code", {}, "country"), ", ", el("code", {}, "keywords"), " (extra place words), ", el("code", {}, "priority"), " (yes for sites that get their own local news search) and ", el("code", {}, "area"), " (the place name to search)."),
    el("div", { class: "form-row" }, file),
    el("div", { class: "form-row" }, replace, el("label", { for: "replace-sites" }, "Replace the current list"), button),
    result,
    el("h3", {}, "Current list"),
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, el("th", {}, "Site"), el("th", {}, "City"), el("th", {}, "Position"))),
      el(
        "tbody",
        {},
        ...sites.map((site) =>
          el(
            "tr",
            {},
            el("td", {}, site.name, site.priority ? el("div", { class: "note" }, "Priority") : null),
            el("td", {}, [site.city, site.country].filter(Boolean).join(", ")),
            el("td", { class: "num" }, `${site.lat.toFixed(3)}, ${site.lon.toFixed(3)}${site.approximate ? " (est.)" : ""}`),
          ),
        ),
      ),
    ),
  );
}

const CAN_JOIN = [
  ["key", "Reddit", "Blocks Cloudflare without sign-in. Works with a free Reddit API app (client ID and secret)."],
  ["key", "Ships and ports (AIS)", "Live vessel positions through a free aisstream.io key."],
  ["key", "Wildfires outside the US", "NASA FIRMS satellite fire detections with a free map key."],
  ["paid", "Protests and unrest", "ACLED tracks planned demonstrations by city; commercial use needs a licence."],
  ["input", "Exploited software (CISA)", "CISA's free list of actively exploited vulnerabilities, matched against the software the company runs once you list it."],
  ["key", "Cameras: Atlanta, Miami, Philadelphia, Pittsburgh, Salt Lake City", "The Georgia, Florida, Pennsylvania and Utah 511 systems each give a free developer key on request."],
  ["down", "Cameras: Washington DC, Chicago, Boston, Denver, Minneapolis, Dallas", "No open camera feed was found for these cities; Maryland's cameras cover the Washington suburbs only."],
  ["key", "Email and text delivery", "SendGrid and Twilio are built in and only need their keys added."],
  ["paid", "X / Twitter", "The search API is paid. It is the largest source of breaking incident chatter."],
  ["paid", "Animated global wind", "Needs a weather-model data service such as Windy or Meteomatics."],
  ["paid", "Commercial alerting", "Services such as Dataminr or Factal can be fed in as another source."],
  ["paid", "Breach and dark-web monitoring", "Credential-leak services for company domains."],
  ["down", "GDELT world news events", "Refuses requests from Cloudflare. Needs a small relay hosted elsewhere."],
  ["down", "Full satellite catalogue", "CelesTrak refuses requests from Cloudflare; only the space station is shown for now."],
  ["down", "Natural-hazard events (NASA EONET)", "Rate-limits Cloudflare's shared addresses. Needs a relay or a cached copy."],
  ["down", "Citizen, PulsePoint, police scanners", "No public feed is offered; licensing would have to be arranged with each."],
];
const STATE_NAMES = { live: "Live", partial: "Intermittent", down: "Blocked", key: "Free key", paid: "Paid", input: "Needs your input" };

function openFeeds() {
  const row = (kind, name, note) => el("tr", {}, el("td", {}, name, el("div", { class: "note" }, note)), el("td", {}, el("span", { class: `state ${kind}` }, STATE_NAMES[kind])));
  const sourceRows = (run, noun) =>
    (run?.sources ?? []).map((source) =>
      row(
        source.error ? (source.source === "google_news" ? "partial" : "down") : "live",
        SOURCE_NAMES[source.source] ?? source.source,
        source.error ? `Failed: ${source.error}` : `${source.count} ${noun}${source.count === 1 ? "" : "s"}`,
      ),
    );
  const hazardRun = state.info?.lastHazardRun;
  openDrawer(
    "Feeds",
    el("h3", {}, `News and social, checked ${state.info?.lastRun ? ago(state.info.lastRun.finishedAt) : "never"}`),
    el("table", {}, el("tbody", {}, ...sourceRows(state.info?.lastRun, "item"))),
    el("h3", {}, `Hazards, checked ${hazardRun ? ago(hazardRun.finishedAt) : "never"}`),
    el("p", { class: "note" }, "Counts are hazards near your sites. Travel advisories and lookalike domains are checked once an hour."),
    el("table", {}, el("tbody", {}, ...sourceRows(hazardRun, "hazard"))),
    el("h3", {}, `Outages, checked ${state.info?.lastOutageRun ? ago(state.info.lastOutageRun.finishedAt) : "never"}`),
    el("table", {}, el("tbody", {}, ...sourceRows(state.info?.lastOutageRun, "outage"))),
    el("h3", {}, "Map layers"),
    el(
      "table",
      {},
      el("tbody", {}, ...LAYERS.map((layer) => row(layer.failed ? "down" : "live", layer.label, layer.active ? (layer.failed ? "Did not respond just now" : "Showing") : "Available, switched off"))),
    ),
    el("h3", {}, "Camera coverage for your sites"),
    state.cameraFeeds.length
      ? el(
          "table",
          {},
          el("tbody", {}, ...state.cameraFeeds.map((feed) => row(feed.ok ? "live" : "down", feed.place, feed.ok ? `${feed.count.toLocaleString()} cameras` : "Did not respond just now"))),
        )
      : el("p", { class: "note" }, "Switch on the camera layer to load the feeds that cover your sites."),
    el("h3", {}, "What else can be connected"),
    el("table", {}, el("tbody", {}, ...CAN_JOIN.map(([kind, name, note]) => row(kind, name, note)))),
  );
}

function renderBrief(stored) {
  if (!stored) {
    return [el("p", {}, "No brief has been written yet. One is written every day at 12:03 UTC (7:03 in New York in winter), or you can write one now.")];
  }
  const brief = stored.body;
  return [
    el("p", { class: "note" }, `Written ${ago(stored.createdAt)}, covering the 24 hours before it.`),
    el("div", { class: "brief-level" }, `Threat level: ${brief.threatLevel}`),
    el("p", { class: "brief-headline" }, brief.headline),
    el("p", {}, brief.overview),
    ...brief.regions.flatMap((region) => [
      el("h3", {}, region.name),
      ...region.items.map((item) =>
        el(
          "div",
          { class: "brief-item", style: `--sev:${BRIEF_COLORS[item.severity] ?? "var(--low)"}` },
          el("div", { class: "tags" }, el("span", { class: "dot" }), el("span", { class: "sev" }, item.severity), el("span", {}, `· ${item.title}`)),
          el("p", {}, item.detail),
        ),
      ),
    ]),
    ...(brief.watch.length ? [el("h3", {}, "Watch"), el("ul", { class: "brief-watch" }, ...brief.watch.map((entry) => el("li", {}, entry)))] : []),
  ];
}

async function openBrief() {
  const body = el("div", {}, el("p", { class: "note" }, "Loading…"));
  const button = el("button", { class: "pill gold" }, "Write a new brief");
  openDrawer("Morning brief", el("div", { class: "form-row" }, button), body);
  const show = (stored) => body.replaceChildren(...renderBrief(stored));
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Writing… (up to a minute)";
    try {
      show((await api("/api/brief", { method: "POST" })).brief);
    } catch (error) {
      body.prepend(el("div", { class: "result error" }, error.message));
    } finally {
      button.disabled = false;
      button.textContent = "Write a new brief";
    }
  });
  try {
    show((await api("/api/brief")).brief);
  } catch (error) {
    body.replaceChildren(el("div", { class: "result error" }, `Could not load the brief. ${error.message}`));
  }
}

// ---------- wiring ----------

let knownSites = -1;

async function refresh() {
  renderCategories();
  const feed = document.getElementById("feed");
  try {
    const query = new URLSearchParams(Object.entries({ category: state.category, status: state.status }).filter(([, value]) => value));
    const [info, { alerts }] = await Promise.all([api("/api/status"), api(`/api/alerts?${query}`)]);
    const firstLoad = !state.info;
    state.info = info;
    state.alerts = alerts;
    state.groups = groupAlerts(alerts);
    renderStatus();
    renderFeed();
    renderTicker();
    await Promise.all(LAYERS.filter((layer) => layer.id === "sites" || layer.id === "incidents").map(loadLayer));
    if (firstLoad) fitSites();
    checkNear();
    // Layers built from the site list load once it is known, and again if it changes.
    const siteCount = info.sites.length;
    if (siteCount !== knownSites) {
      knownSites = siteCount;
      LAYERS.filter((layer) => layer.needsSites).forEach(loadLayer);
    }
  } catch (error) {
    feed.replaceChildren(el("div", { class: "empty error" }, `Could not load alerts. ${error.message}`));
  }
}

// ---------- my location ----------

// Alerts within this many miles of you are counted in the "you are here" popup.
const NEARBY_MILES = 10;
const MY_SITE = "Your location";
const RADIUS_CHOICES = [0.5, 1, 2, 5, 10];
// Your position is sent again after a move this far, or this long without one,
// so the server keeps watching where you are (it stops 12 hours after the last).
const RESEND_MILES = 0.15;
const RESEND_MS = 10 * 60_000;
// Keeps the popup narrow enough for a phone and clear of the left rail and top bar.
const LOCATION_POPUP = { maxWidth: 270, autoPanPaddingTopLeft: [80, 80], autoPanPaddingBottomRight: [20, 60] };

const near = {
  settings: saved.get("nearWatch", { on: false, radiusMi: 1 }),
  here: null,
  watchId: null,
  lastSent: null,
  layer: null,
  dot: null,
  ring: null,
  zone: null,
  seen: new Set(saved.get("nearSeen", [])),
};

const miles = (value) => (value < 0.1 ? "0.1" : value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString());

function watchControls() {
  const { on, radiusMi } = near.settings;
  const status = el(
    "p",
    { class: "muted small", id: "near-status" },
    on
      ? `Watching ${radiusMi} mi around you. Police and fire dispatch, Nixle, local news, weather and civil emergencies are checked every 15 minutes; you are alerted here and by notification.`
      : "Get an alert on this page, and a notification, when an incident is reported near you.",
  );
  return el(
    "div",
    { class: "near-controls" },
    el(
      "label",
      { class: "switch" },
      el("input", { type: "checkbox", role: "switch", checked: on, onchange: (event) => (event.target.checked ? startWatching() : stopWatching()) }),
      el("span", {}, "Alert me to incidents near me"),
    ),
    el(
      "label",
      { class: "radius" },
      "Within ",
      el(
        "select",
        { "aria-label": "Alert radius", onchange: (event) => setRadius(Number(event.target.value)) },
        ...RADIUS_CHOICES.map((value) => el("option", { value: String(value), selected: value === radiusMi }, `${value} mi`)),
      ),
    ),
    status,
  );
}

function locationPopup(lat, lon) {
  const sites = (state.info?.sites ?? []).map((site) => ({ site, miles: distanceMiles(lat, lon, site.lat, site.lon) }));
  const nearest = sites.sort((a, b) => a.miles - b.miles)[0];
  const nearby = state.groups.filter((group) => group.lat !== null && distanceMiles(lat, lon, group.lat, group.lon) <= NEARBY_MILES);
  const worst = nearby.reduce((top, group) => (!top || rank(group.severity) > rank(top) ? group.severity : top), null);
  return popup(
    "Your location",
    "You are here",
    nearest ? el("p", {}, `Nearest site: ${nearest.site.name}, ${miles(nearest.miles)} mi away.`) : null,
    el(
      "p",
      { class: nearby.length ? `sev-text-${worst}` : "muted" },
      nearby.length
        ? `${nearby.length} open alert${nearby.length === 1 ? "" : "s"} within ${NEARBY_MILES} mi (highest: ${worst}).`
        : `No open alerts within ${NEARBY_MILES} mi.`,
    ),
    watchControls(),
  );
}

function locationProblem(message) {
  L.popup({ ...LOCATION_POPUP, className: "locate-problem" }).setLatLng(map.getCenter()).setContent(popup("My location", "Location unavailable", el("p", {}, message))).openOn(map);
}

function locationError(error) {
  return error.code === error.PERMISSION_DENIED
    ? "Location is blocked for this site. Allow it in your browser's site settings (the icon next to the address), then press the button again."
    : "Your location could not be found just now. Check that location services are on, then try again.";
}

// Draws (or moves) the "you are here" dot, its accuracy ring and, while
// watching, the alert radius.
function drawMe(lat, lon, accuracy) {
  near.here = { lat, lon, accuracy };
  if (!near.layer) {
    near.ring = L.circle([lat, lon], { radius: accuracy, color: "#2fd3e6", weight: 1, fillColor: "#2fd3e6", fillOpacity: 0.08, interactive: false });
    near.dot = L.marker([lat, lon], {
      icon: L.divIcon({ className: "me-marker", html: "<span></span>", iconSize: [18, 18] }),
      keyboard: false,
      zIndexOffset: 1000,
    }).bindPopup(() => locationPopup(near.here.lat, near.here.lon), LOCATION_POPUP);
    near.layer = L.layerGroup([near.ring, near.dot]).addTo(map);
  } else {
    near.ring.setLatLng([lat, lon]).setRadius(accuracy);
    near.dot.setLatLng([lat, lon]);
  }
  drawZone();
  document.getElementById("locate-me").setAttribute("aria-pressed", "true");
}

function drawZone() {
  near.zone?.remove();
  near.zone = null;
  if (!near.settings.on || !near.here) return;
  near.zone = L.circle([near.here.lat, near.here.lon], {
    radius: near.settings.radiusMi * 1609.34,
    color: "#e3ab35",
    weight: 1.5,
    dashArray: "6 6",
    fill: false,
    interactive: false,
  }).addTo(map);
}

function locateMe() {
  const button = document.getElementById("locate-me");
  if (!navigator.geolocation) return locationProblem("This browser cannot share its location.");
  button.classList.add("busy");
  button.disabled = true;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      button.classList.remove("busy");
      button.disabled = false;
      const { latitude: lat, longitude: lon, accuracy } = coords;
      drawMe(lat, lon, accuracy);
      // A rough fix (a laptop on Wi-Fi can be off by miles) is shown whole;
      // a precise one zooms to street level.
      if (accuracy > 1500) map.flyToBounds(near.ring.getBounds().pad(0.2), { maxZoom: 15, duration: 0.8 });
      else map.flyTo([lat, lon], near.settings.on && near.settings.radiusMi > 1 ? 13 : 15, { duration: 0.8 });
      map.once("moveend", () => near.dot.openPopup());
      if (near.settings.on) sendPosition(true);
    },
    (error) => {
      button.classList.remove("busy");
      button.disabled = false;
      locationProblem(locationError(error));
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
}

// ----- map search -----

const search = {
  form: document.getElementById("map-search"),
  input: document.getElementById("search-input"),
  list: document.getElementById("search-results"),
  results: [],
  active: -1,
  marker: null,
  query: "",
};

function siteResults(query) {
  const needle = query.toLowerCase();
  return (state.info?.sites ?? [])
    .filter((site) => [site.name, site.city, site.address, site.area, site.country].join(" ").toLowerCase().includes(needle))
    .slice(0, 6)
    .map((site) => ({ kind: "Site", label: site.name, detail: [site.address, site.city, site.country].filter(Boolean).join(", "), lat: site.lat, lon: site.lon, zoom: 16 }));
}

function coordinateResult(query) {
  const match = query.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!match) return [];
  const [lat, lon] = [Number(match[1]), Number(match[2])];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [{ kind: "Point", label: `${lat}, ${lon}`, detail: "Coordinates", lat, lon, zoom: 15 }] : [];
}

function showResults(results, hint) {
  search.results = results;
  search.active = -1;
  search.list.replaceChildren(
    ...results.map((result, index) =>
      el(
        "li",
        { role: "option", id: `search-option-${index}`, "aria-selected": "false" },
        el(
          "button",
          { type: "button", tabindex: "-1", onclick: () => chooseResult(result) },
          el("span", { class: "kind" }, result.kind),
          el("span", { class: "label" }, result.label),
          result.detail ? el("span", { class: "detail" }, result.detail) : null,
        ),
      ),
    ),
    hint ? el("li", { class: "hint", role: "presentation" }, hint) : null,
  );
  const open = results.length > 0 || Boolean(hint);
  search.list.hidden = !open;
  search.input.setAttribute("aria-expanded", String(open));
}

function hideResults() {
  search.list.hidden = true;
  search.input.setAttribute("aria-expanded", "false");
  search.input.removeAttribute("aria-activedescendant");
}

function highlight(index) {
  const options = search.list.querySelectorAll("[role=option]");
  if (!options.length) return;
  search.active = (index + options.length) % options.length;
  options.forEach((option, each) => option.setAttribute("aria-selected", String(each === search.active)));
  options[search.active].scrollIntoView({ block: "nearest" });
  search.input.setAttribute("aria-activedescendant", options[search.active].id);
}

async function searchPlaces(query) {
  const local = [...coordinateResult(query), ...siteResults(query)];
  showResults(local, "Searching places…");
  let places = [];
  try {
    const found = await api(`/api/feeds/geocode?q=${encodeURIComponent(query)}`);
    places = found.map((place) => ({
      kind: place.addresstype ? place.addresstype.replace(/_/g, " ") : "Place",
      label: place.name || place.display_name.split(",")[0],
      detail: place.display_name,
      lat: Number(place.lat),
      lon: Number(place.lon),
      bbox: place.boundingbox?.map(Number),
    }));
  } catch (error) {
    showResults(local, `Place search failed: ${error.message}`);
    return;
  }
  if (search.query !== query) return;
  const results = [...local, ...places];
  showResults(results, results.length ? null : "No places found. Try adding the country, e.g. “Springfield, Illinois”.");
  // Go straight to the best match; the list stays open for the others.
  if (results.length) chooseResult(results[0], { keepOpen: true });
}

function chooseResult(result, { keepOpen = false } = {}) {
  if (!keepOpen) {
    hideResults();
    search.input.value = result.label;
  }
  search.marker?.remove();
  const [south, north, west, east] = result.bbox ?? [];
  if (result.bbox && [south, north, west, east].every(Number.isFinite) && (north - south > 0.002 || east - west > 0.002)) {
    map.flyToBounds([[south, west], [north, east]], { maxZoom: 16, duration: 1, paddingTopLeft: [60, 60], paddingBottomRight: [40, 60] });
  } else {
    map.flyTo([result.lat, result.lon], result.zoom ?? 16, { duration: 1 });
  }
  const nearest = (state.info?.sites ?? [])
    .map((site) => ({ site, miles: distanceMiles(result.lat, result.lon, site.lat, site.lon) }))
    .sort((a, b) => a.miles - b.miles)[0];
  search.marker = L.marker([result.lat, result.lon], {
    icon: L.divIcon({ className: "", html: '<div class="search-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    keyboard: false,
    zIndexOffset: 900,
  })
    .bindPopup(
      popup(
        result.kind,
        result.label,
        result.detail && result.detail !== result.label ? el("p", { class: "muted" }, result.detail) : null,
        nearest && result.kind !== "Site" ? el("p", {}, `Nearest site: ${nearest.site.name}, ${miles(nearest.miles)} mi away.`) : null,
      ),
      LOCATION_POPUP,
    )
    .addTo(map);
  if (!keepOpen) map.once("moveend", () => search.marker?.openPopup());
}

search.input.addEventListener("input", () => {
  const query = search.input.value.trim();
  search.query = query;
  if (!query) return hideResults();
  const local = [...coordinateResult(query), ...siteResults(query)];
  showResults(local, query.length >= 2 ? "Press Enter to search cities, addresses and places worldwide." : null);
});

search.input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlight(search.active + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlight(search.active - 1);
  } else if (event.key === "Escape") {
    hideResults();
    search.input.blur();
  }
});

search.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = search.input.value.trim();
  if (search.active >= 0 && search.results[search.active]) return chooseResult(search.results[search.active]);
  if (query.length < 2) return;
  search.query = query;
  searchPlaces(query);
});

document.addEventListener("click", (event) => {
  if (!search.form.contains(event.target)) hideResults();
});

// "/" jumps to the search box, as on many sites.
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "") || document.activeElement?.isContentEditable;
  if (typing) return;
  event.preventDefault();
  search.input.focus();
  search.input.select();
});

// ----- alerts near you -----

function saveNear() {
  saved.set("nearWatch", near.settings);
}

function renderWatchState() {
  const button = document.getElementById("locate-me");
  button.classList.toggle("watching", near.settings.on);
  button.title = near.settings.on ? `Watching ${near.settings.radiusMi} mi around you` : "My location";
  const popupNode = near.dot?.getPopup();
  if (popupNode?.isOpen()) popupNode.setContent(locationPopup(near.here.lat, near.here.lon));
}

async function sendPosition(force = false) {
  if (!near.settings.on || !near.here) return;
  const { lat, lon, accuracy } = near.here;
  const last = near.lastSent;
  const due = force || !last || distanceMiles(lat, lon, last.lat, last.lon) > RESEND_MILES || Date.now() - last.at > RESEND_MS;
  if (!due) return;
  near.lastSent = { lat, lon, at: Date.now() };
  try {
    await api("/api/me", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, radiusMi: near.settings.radiusMi, accuracyM: accuracy }),
    });
  } catch (error) {
    near.lastSent = null;
    console.warn("Could not send your position:", error.message);
  }
}

function startWatching({ quiet = false } = {}) {
  if (!navigator.geolocation) return locationProblem("This browser cannot share its location.");
  near.settings.on = true;
  saveNear();
  // Asked while the switch is being pressed, as browsers require.
  if (!quiet && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  if (near.watchId === null) {
    near.watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        drawMe(coords.latitude, coords.longitude, coords.accuracy);
        sendPosition();
        checkNear();
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          stopWatching({ keepServer: true });
          if (!quiet) locationProblem(locationError(error));
        }
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 },
    );
  }
  drawZone();
  renderWatchState();
}

async function stopWatching({ keepServer = false } = {}) {
  near.settings.on = false;
  saveNear();
  if (near.watchId !== null) navigator.geolocation.clearWatch(near.watchId);
  near.watchId = null;
  near.lastSent = null;
  drawZone();
  renderWatchState();
  hideNearBanner();
  if (!keepServer) await api("/api/me/off", { method: "POST" }).catch(() => {});
}

function setRadius(value) {
  near.settings.radiusMi = value;
  saveNear();
  drawZone();
  renderWatchState();
  sendPosition(true);
  checkNear();
}

// Open alerts close to you that you have not been told about yet.
async function checkNear() {
  if (!near.settings.on || !near.here) return;
  let alerts;
  try {
    ({ alerts } = await api("/api/alerts?status=new"));
  } catch {
    return;
  }
  const { lat, lon } = near.here;
  const close = groupAlerts(alerts)
    .map((group) => ({
      group,
      miles: group.lat !== null ? distanceMiles(lat, lon, group.lat, group.lon) : null,
    }))
    .filter(({ group, miles: distance }) => (distance !== null ? distance <= near.settings.radiusMi : group.reports.some((report) => report.site === MY_SITE)))
    .sort((a, b) => rank(b.group.severity) - rank(a.group.severity) || (a.miles ?? 0) - (b.miles ?? 0));
  const fresh = close.filter(({ group }) => !near.seen.has(group.key));
  if (fresh.length === 0) return;
  for (const { group } of fresh) near.seen.add(group.key);
  saved.set("nearSeen", [...near.seen].slice(-300));
  showNearBanner(fresh);
  notifyNear(fresh);
}

const distanceText = (distance) => (distance === null ? "In your area" : `${miles(distance)} mi away`);

function showNearBanner(entries) {
  const [{ group, miles: distance }] = entries;
  const banner = document.getElementById("near-banner");
  banner.className = `near-banner sev-${group.severity}`;
  banner.replaceChildren(
    el("div", { class: "near-label" }, el("span", { class: "dot" }), `Near you · ${distanceText(distance)} · ${group.severity}`),
    el("div", { class: "near-title" }, group.name),
    el("div", { class: "near-summary" }, group.summary),
    el(
      "div",
      { class: "near-actions" },
      group.lat !== null ? el("button", { class: "pill gold", onclick: () => { locate(group); hideNearBanner(); } }, "Show on map") : null,
      group.lead.url ? el("a", { class: "pill", href: group.lead.url, target: "_blank", rel: "noopener noreferrer" }, "Source") : null,
      el("button", { class: "pill", onclick: hideNearBanner }, entries.length > 1 ? `Dismiss (+${entries.length - 1} more in the alerts list)` : "Dismiss"),
    ),
  );
  banner.hidden = false;
  map.closePopup();
  navigator.vibrate?.([200, 100, 200]);
}

function hideNearBanner() {
  document.getElementById("near-banner").hidden = true;
}

function notifyNear(entries) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  for (const { group, miles: distance } of entries.slice(0, 3)) {
    try {
      const note = new Notification(`Near you: ${group.name}`, {
        body: `${distanceText(distance)} · ${group.severity}. ${group.summary}`.slice(0, 240),
        tag: `sentinel-${group.key}`,
        requireInteraction: group.severity === "critical",
      });
      note.onclick = () => {
        window.focus();
        if (group.lat !== null) locate(group);
        note.close();
      };
    } catch {
      // Some phone browsers only allow notifications from an installed app.
    }
  }
}

// Picks up watching again after a reload, without prompting.
if (near.settings.on) {
  startWatching({ quiet: true });
}
setInterval(() => {
  sendPosition();
}, RESEND_MS);

function fitSites() {
  const sites = state.info?.sites ?? [];
  if (!sites.length) return;
  // Leave room for the rail on the left and the alerts panel on the right.
  const panel = document.getElementById("alerts-panel");
  const beside = window.innerWidth > 860 && !panel.classList.contains("hidden") ? panel.offsetWidth + 30 : 30;
  map.fitBounds(L.latLngBounds(sites.map((site) => [site.lat, site.lon])), { paddingTopLeft: [90, 100], paddingBottomRight: [beside, 90], maxZoom: 11 });
}

document.getElementById("status").addEventListener("change", (event) => {
  state.status = event.target.value;
  refresh();
});

// A short-lived report box under the top bar.
function showToast(title, lines, tone = "") {
  const toast = document.getElementById("toast");
  clearTimeout(toast.timer);
  toast.className = `toast ${tone}`;
  toast.replaceChildren(
    el("div", { class: "toast-head" }, el("strong", {}, title), el("button", { class: "icon-btn", "aria-label": "Close", onclick: () => (toast.hidden = true) }, "×")),
    ...lines.map((line) => el("p", {}, line)),
  );
  toast.hidden = false;
  toast.timer = setTimeout(() => (toast.hidden = true), tone === "error" ? 30000 : 15000);
}

// Plain-language summary of one run, for the Check now report.
function runSummary(label, run, noun) {
  const failing = (run.sources ?? []).filter((source) => source.error);
  const parts = [`${label}: ${run.fetched} ${noun} scanned, ${run.newItems} new`];
  if (typeof run.alerts === "number" && label === "News") parts.push(`${run.alerts} new alert${run.alerts === 1 ? "" : "s"}`);
  let text = parts.join(", ") + ".";
  if (failing.length) text += ` Not answering: ${failing.map((source) => SOURCE_NAMES[source.source] ?? source.source).join(", ")}.`;
  const problems = (run.errors ?? []).filter((error) => !/deferred to the next run/.test(error));
  if (problems.length) text += ` Problems: ${problems.join("; ")}.`;
  return text;
}

document.getElementById("run-now").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Checking…";
  const started = Date.now();
  showToast("Checking now…", ["Reading news, social media and hazard feeds, then having Claude review anything new. This can take a minute."]);
  try {
    // Separate requests, so each stays inside Cloudflare's per-request limits.
    const [news, hazards] = await Promise.allSettled([api("/api/run", { method: "POST" }), api("/api/hazards/run", { method: "POST" })]);
    await refresh();
    const seconds = Math.round((Date.now() - started) / 1000);
    const lines = [
      news.status === "fulfilled" ? runSummary("News", news.value.run, "stories") : `News check failed: ${news.reason.message}`,
      hazards.status === "fulfilled" ? runSummary("Hazards", hazards.value.run, "reports") : `Hazard check failed: ${hazards.reason.message}`,
    ];
    const failed = news.status === "rejected" || hazards.status === "rejected";
    const found = [news, hazards].some((result) => result.status === "fulfilled" && result.value.run.newItems > 0);
    if (!failed && !found) lines.push("Nothing new since the last check; the scheduled checks run every 15 minutes.");
    showToast(failed ? `Check finished with problems (${seconds} s)` : `Check complete (${seconds} s)`, lines, failed ? "error" : "ok");
  } catch (error) {
    showToast("Check failed", [error.message], "error");
  } finally {
    button.disabled = false;
    button.textContent = "Check now";
  }
});

for (const button of document.querySelectorAll("[data-base]")) {
  button.addEventListener("click", () => setBase(button.dataset.base));
}
document.getElementById("zoom-in").addEventListener("click", () => map.zoomIn());
document.getElementById("zoom-out").addEventListener("click", () => map.zoomOut());
document.getElementById("zoom-sites").addEventListener("click", fitSites);
document.getElementById("locate-me").addEventListener("click", locateMe);
document.getElementById("drawer-close").addEventListener("click", () => (document.getElementById("drawer").hidden = true));
document.getElementById("newsroom-close").addEventListener("click", closeNewsroom);
for (const button of document.querySelectorAll("[data-news-tab]")) {
  button.addEventListener("click", () => openNewsroom(button.dataset.newsTab));
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.getElementById("drawer").hidden = true;
  closeNewsroom();
});

function showAlerts(visible) {
  document.getElementById("alerts-panel").classList.toggle("hidden", !visible);
  document.getElementById("alerts-open").hidden = visible;
  saved.set("alerts", visible);
}
document.getElementById("alerts-toggle").addEventListener("click", () => showAlerts(false));
document.getElementById("alerts-open").addEventListener("click", () => showAlerts(true));

const cursor = document.getElementById("cursor");
let pointer = null;
function renderCursor() {
  cursor.textContent = `Cursor ${pointer ? `${pointer.lat.toFixed(3)}, ${pointer.lng.toFixed(3)}` : "—"} · Zoom ${map.getZoom().toFixed(1)}`;
}
map.on("mousemove", (event) => {
  pointer = event.latlng.wrap();
  renderCursor();
});
map.on("zoomend", renderCursor);

let moveTimer = null;
map.on("moveend", () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => LAYERS.filter((layer) => layer.followsMap).forEach(loadLayer), 600);
});

setBase(bases[saved.get("base", "sat")] ? saved.get("base", "sat") : "sat");
showAlerts(saved.get("alerts", window.innerWidth > 860));
renderRail();
renderCursor();
for (const layer of LAYERS) {
  if (layer.id !== "sites" && layer.id !== "incidents") {
    if (!layer.needsSites) loadLayer(layer);
    if (layer.active && layer.every) layer.timer = setInterval(() => loadLayer(layer), layer.every * 1000);
  }
}
// ---------- ops board ----------
// Situational tiles at the top of the right-hand column. Each feed loads on its
// own schedule; a tile shows its headline figure and opens details on click.

const ops = { intel: null, raids: null, outages: null, kev: null, breaches: null, quakes: null, seen: {} };
const CLOCKS = [
  ["LA", "America/Los_Angeles"],
  ["NYC", "America/New_York"],
  ["London", "Europe/London"],
  ["Kyiv", "Europe/Kyiv"],
  ["Tokyo", "Asia/Tokyo"],
];
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// A small trend line; the area under it is shaded.
function sparkline(values, width = 64, height = 22) {
  const svg = svgEl("svg", { class: "spark", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) return svg;
  const min = Math.min(...points);
  const span = Math.max(...points) - min || 1;
  const xy = points.map((value, index) => [(index / (points.length - 1)) * width, height - 2 - ((value - min) / span) * (height - 4)]);
  const line = xy.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  svg.append(svgEl("path", { class: "area", d: `${line}L${width},${height}L0,${height}Z` }), svgEl("path", { d: line }));
  return svg;
}

function tile({ id, label, value, unit, sub, tone = "", wide = false, spark, body, details, action }) {
  const node = el(
    "button",
    {
      class: `tile ${tone}${wide ? " wide" : ""}`,
      "data-tile": id,
      onclick: () => (action ? action() : details ? openDrawer(label, ...details()) : null),
    },
    el("span", { class: "tile-label" }, label),
    body ?? el("span", { class: "tile-value" }, value ?? "—", unit ? el("small", {}, unit) : null),
    sub ? el("span", { class: "tile-sub", title: sub }, sub) : null,
    spark ? sparkline(spark) : null,
  );
  // A tile whose figure or colour changed flashes once.
  const fingerprint = `${value}|${tone}`;
  if (ops.seen[id] && ops.seen[id] !== fingerprint) node.classList.add("flash");
  ops.seen[id] = fingerprint;
  return node;
}

const loading = (id, label, wide = false) => tile({ id, label, value: "…", sub: "Loading", tone: "idle", wide });
const credit = (text, href) => el("p", { class: "credit" }, "Source: ", el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text));
const listOf = (items, render, empty) => (items.length ? el("ul", { class: "detail-list" }, ...items.map((item) => el("li", {}, ...render(item)))) : el("p", { class: "muted" }, empty));
const meta = (text) => el("div", { class: "meta" }, text);
const external = (href, text) => {
  const url = safeUrl(href);
  return url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text) : text;
};

function clockTile() {
  const now = new Date();
  return tile({
    id: "clocks",
    label: "Local time at key sites",
    wide: true,
    body: el(
      "div",
      { class: "clocks" },
      ...CLOCKS.map(([name, zone]) => {
        const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(now));
        return el("div", { class: hour < 7 || hour >= 20 ? "night" : "" }, el("b", { "data-zone": zone }, formatClock(now, zone)), el("span", {}, name));
      }),
    ),
  });
}

const formatClock = (date, zone) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(date);

function updateClocks() {
  const now = new Date();
  for (const node of document.querySelectorAll(".clocks b[data-zone]")) node.textContent = formatClock(now, node.dataset.zone);
}

const UK_TONES = { CRITICAL: "crit", SEVERE: "warn", SUBSTANTIAL: "watch", MODERATE: "ok", LOW: "ok" };
const UK_MEANING = {
  LOW: "an attack is highly unlikely",
  MODERATE: "an attack is possible but not likely",
  SUBSTANTIAL: "an attack is likely",
  SEVERE: "an attack is highly likely",
  CRITICAL: "an attack is highly likely in the near future",
};

function ukTile() {
  const uk = ops.intel?.ukThreat;
  if (!ops.intel) return loading("uk", "UK terror threat");
  if (!uk) return tile({ id: "uk", label: "UK terror threat", value: "—", sub: "MI5 not answering", tone: "idle" });
  return tile({
    id: "uk",
    label: "UK terror threat",
    value: uk.level,
    sub: `${UK_MEANING[uk.level] ?? ""} · MI5`,
    tone: UK_TONES[uk.level] ?? "",
    details: () => [
      el("div", { class: "big-figure" }, uk.level),
      el("p", {}, `The UK national terrorism threat level is ${uk.level}: ${UK_MEANING[uk.level]}.`),
      uk.northernIreland ? el("p", {}, `Northern Ireland-related terrorism: ${uk.northernIreland}.`) : null,
      el("p", { class: "muted" }, "Levels, lowest to highest: Low, Moderate, Substantial, Severe, Critical. A change raises an alert in Sentinel."),
      credit("MI5", "https://www.mi5.gov.uk/threats-and-advice/threat-levels"),
    ],
  });
}

function raidTile() {
  const raids = ops.raids;
  if (!raids) return loading("raids", "Ukraine air raids");
  const active = raids.oblasts.filter((oblast) => oblast.state === "active").length;
  const partial = raids.oblasts.filter((oblast) => oblast.state === "partial").length;
  const missiles = raids.threats.filter((threat) => threat.missile).length;
  return tile({
    id: "raids",
    label: "Ukraine air raids",
    value: String(active),
    unit: "/ 24 regions",
    sub: `${partial ? `${partial} in part · ` : ""}${missiles ? `${missiles} missile warning${missiles === 1 ? "" : "s"}` : `${raids.threats.length} Air Force posts`} · 3 h`,
    tone: active >= 12 || missiles ? "crit" : active ? "warn" : partial ? "watch" : "ok",
    action: () => openNewsroom("airraids"),
  });
}

function servicesTile() {
  const data = ops.outages;
  if (!data) return loading("services", "Service outages");
  const serious = data.providers.filter((provider) => provider.outages.some((outage) => outage.severity !== "low"));
  const minor = data.providers.filter((provider) => provider.outages.length && !serious.includes(provider)).length;
  const national = (data.airports ?? []).some((issue) => /NATION/i.test(issue.reason));
  return tile({
    id: "services",
    label: "Service outages",
    value: national ? "FAA STOP" : String(serious.length),
    unit: national ? "" : `/ ${data.providers.length} services`,
    sub: serious.length ? serious.map((provider) => provider.name).join(", ") : `All major services up${minor ? ` · ${minor} minor` : ""}`,
    tone: national || serious.some((provider) => provider.outages.some((outage) => outage.severity === "high")) ? "crit" : serious.length ? "warn" : minor ? "watch" : "ok",
    action: () => openNewsroom("outages"),
  });
}

function ransomwareTile() {
  const data = ops.intel?.ransomware;
  if (!ops.intel) return loading("ransomware", "Ransomware claims");
  if (!data) return tile({ id: "ransomware", label: "Ransomware claims", value: "—", sub: "Feed not answering", tone: "idle" });
  return tile({
    id: "ransomware",
    label: "Ransomware claims · 24 h",
    value: String(data.day),
    unit: "victims",
    sub: data.brand.length ? `${data.brand.length} naming our brands` : `None naming our brands${data.groups[0] ? ` · top: ${data.groups[0].name}` : ""}`,
    tone: data.brand.length ? "crit" : "ok",
    details: () => [
      data.brand.length ? el("p", { class: "sev-text-critical" }, `${data.brand.length} claim${data.brand.length === 1 ? "" : "s"} naming the company's brands. Each also appears as a critical alert.`) : el("p", {}, "No leak-site claims name the company's brands."),
      el("h3", {}, "Most active groups, last 24 hours"),
      listOf(data.groups, (group) => [`${group.name}: ${group.count} victim${group.count === 1 ? "" : "s"}`], "None."),
      el("h3", {}, "Latest claims"),
      listOf(data.latest, (victim) => [meta(`${victim.group} · ${victim.country || "country unknown"} · ${ago(victim.discovered)}`), external(victim.url, victim.victim), victim.sector ? el("div", { class: "muted" }, victim.sector) : null], "None."),
      el("p", { class: "muted" }, "These are claims posted by the criminal groups themselves, not confirmed breaches."),
      credit("ransomware.live", "https://www.ransomware.live/"),
    ],
  });
}

function phishingTile() {
  const data = ops.intel?.phishing;
  if (!ops.intel) return loading("phishing", "Phishing vs brands");
  if (!data) return tile({ id: "phishing", label: "Phishing vs brands", value: "—", sub: "Feed not answering", tone: "idle" });
  return tile({
    id: "phishing",
    label: "Phishing vs brands",
    value: String(data.hits.length),
    unit: "live sites",
    sub: `${data.total.toLocaleString()} phishing sites in the live feed`,
    tone: data.hits.length ? "warn" : "ok",
    details: () => [
      el("p", {}, data.hits.length ? `${data.hits.length} live phishing site${data.hits.length === 1 ? "" : "s"} use a company brand name. Each is also an alert.` : `None of the ${data.total.toLocaleString()} live phishing sites currently use a company brand name.`),
      listOf(data.hits, (hit) => [meta(hit.brand), el("code", {}, hit.url)], ""),
      el("p", { class: "muted" }, "Lookalike domain registrations are watched separately through certificate logs."),
      credit("OpenPhish community feed", "https://openphish.com/"),
    ],
  });
}

function kevTile() {
  const data = ops.kev;
  if (!data) return loading("kev", "Exploited vulns (CISA)");
  const latest = data.week[0];
  return tile({
    id: "kev",
    label: "Exploited vulns · CISA",
    value: `+${data.week.length}`,
    unit: "this week",
    sub: latest ? `${latest.vendorProject} ${latest.product}` : `${data.total.toLocaleString()} in the catalogue`,
    tone: data.week.some((entry) => entry.knownRansomwareCampaignUse === "Known") ? "warn" : data.week.length ? "watch" : "ok",
    details: () => [
      el("p", {}, `${data.week.length} vulnerabilities were added to CISA's catalogue of flaws being exploited by attackers in the last 7 days (${data.total.toLocaleString()} in total). Check whether the company runs any of these products.`),
      listOf(
        data.week,
        (entry) => [
          meta(`${entry.dateAdded} · fix due ${entry.dueDate}${entry.knownRansomwareCampaignUse === "Known" ? " · used by ransomware" : ""}`),
          external(`https://nvd.nist.gov/vuln/detail/${entry.cveID}`, `${entry.cveID}: ${entry.vendorProject} ${entry.product}`),
          el("div", { class: "muted" }, entry.vulnerabilityName),
        ],
        "None added this week.",
      ),
      credit("CISA Known Exploited Vulnerabilities", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog"),
    ],
  });
}

function breachTile() {
  const data = ops.breaches;
  if (!data) return loading("breaches", "Data breaches");
  const latest = data[0];
  return tile({
    id: "breaches",
    label: "New data breaches",
    value: String(data.filter((breach) => Date.now() - Date.parse(breach.AddedDate) < 7 * 86_400_000).length),
    unit: "this week",
    sub: latest ? `Latest: ${latest.Title} (${(latest.PwnCount ?? 0).toLocaleString()} accounts)` : "",
    tone: "ok",
    details: () => [
      el("p", {}, "The most recent breaches added to Have I Been Pwned. A breach of a company domain raises a high alert; staff reusing passwords on breached sites are a common way in."),
      listOf(data.slice(0, 10), (breach) => [meta(`added ${breach.AddedDate.slice(0, 10)} · ${(breach.PwnCount ?? 0).toLocaleString()} accounts`), `${breach.Title}${breach.Domain ? ` (${breach.Domain})` : ""}`], "None."),
      credit("Have I Been Pwned", "https://haveibeenpwned.com/PwnedWebsites"),
    ],
  });
}

const KP_EFFECTS = {
  G0: "quiet",
  G1: "minor storm: weak power-grid fluctuations",
  G2: "moderate storm: high-latitude power and HF radio affected",
  G3: "strong storm: GPS and HF radio problems, grid voltage corrections",
  G4: "severe storm: widespread grid and GPS problems",
  G5: "extreme storm: grid collapse and blackouts possible",
};

function spaceTile() {
  const data = ops.intel?.space;
  if (!ops.intel) return loading("space", "Space weather");
  if (!data) return tile({ id: "space", label: "Space weather", value: "—", sub: "NOAA not answering", tone: "idle" });
  const level = Number(data.scale.slice(1));
  return tile({
    id: "space",
    label: "Space weather · Kp",
    value: data.kp.toFixed(1),
    unit: data.scale,
    sub: KP_EFFECTS[data.scale],
    tone: level >= 3 ? "crit" : level >= 1 ? "watch" : "ok",
    spark: data.series,
    details: () => [
      el("div", { class: "big-figure" }, `Kp ${data.kp.toFixed(1)} · ${data.scale}`),
      el("p", {}, `Geomagnetic conditions: ${KP_EFFECTS[data.scale]}. Strong storms (G3 and above) disrupt GPS, satellite links and radio, and can stress power grids.`),
      el("p", { class: "muted" }, `Last reading ${ago(data.at)}; the trend line shows the last three days.`),
      credit("NOAA Space Weather Prediction Center", "https://www.swpc.noaa.gov/"),
    ],
  });
}

function quakeTile() {
  const data = ops.quakes;
  if (!data) return loading("quakes", "Earthquakes · 24 h");
  const strongest = data[0];
  return tile({
    id: "quakes",
    label: "Earthquakes M4.5+ · 24 h",
    value: String(data.length),
    sub: strongest ? `Largest M${strongest.mag.toFixed(1)} ${strongest.place}` : "None",
    tone: strongest?.mag >= 7 ? "crit" : strongest?.mag >= 6 ? "warn" : "ok",
    details: () => [
      listOf(data.slice(0, 12), (quake) => [meta(`M${quake.mag.toFixed(1)} · ${ago(quake.time)}`), external(quake.url, quake.place)], "No earthquakes of magnitude 4.5 or more in the last day."),
      credit("USGS", "https://earthquake.usgs.gov/earthquakes/map/"),
    ],
  });
}

function stormTile() {
  const storms = ops.intel?.storms;
  if (!ops.intel) return loading("storms", "Tropical storms");
  if (!storms) return tile({ id: "storms", label: "Tropical storms", value: "—", sub: "NHC not answering", tone: "idle" });
  return tile({
    id: "storms",
    label: "Tropical storms · NHC",
    value: String(storms.length),
    unit: "active",
    sub: storms.length ? storms.map((storm) => `${storm.kind} ${storm.name}`).join(", ") : "Atlantic and East Pacific quiet",
    tone: storms.some((storm) => /hurricane/i.test(storm.kind)) ? "warn" : storms.length ? "watch" : "ok",
    details: () => [
      listOf(storms, (storm) => [meta(storm.windKt ? `${storm.windKt} knots` : ""), `${storm.kind} ${storm.name}`], "No active tropical storms in the Atlantic or eastern and central Pacific."),
      el("p", { class: "muted" }, "Storms within 400 miles of a site raise an alert."),
      credit("National Hurricane Center", "https://www.nhc.noaa.gov/"),
    ],
  });
}

const VOLCANO_TONES = { RED: "crit", ORANGE: "warn", YELLOW: "watch" };

function volcanoTile() {
  const list = ops.intel?.volcanoes;
  if (!ops.intel) return loading("volcanoes", "Volcanoes");
  if (!list) return tile({ id: "volcanoes", label: "Volcanoes", value: "—", sub: "USGS not answering", tone: "idle" });
  const worst = ["RED", "ORANGE", "YELLOW"].find((colour) => list.some((volcano) => volcano.colour === colour));
  return tile({
    id: "volcanoes",
    label: "US volcanoes elevated",
    value: String(list.length),
    sub: list.map((volcano) => `${volcano.name} (${volcano.colour.toLowerCase()})`).join(", ") || "All normal",
    tone: VOLCANO_TONES[worst] ?? "ok",
    details: () => [
      listOf(list, (volcano) => [meta(`${volcano.level} · ${volcano.colour} · ${volcano.observatory}`), volcano.name], "No US volcanoes above normal."),
      el("p", { class: "muted" }, "Aviation colour codes: yellow is advisory, orange is a watch, red is a warning (eruption under way or imminent)."),
      credit("USGS Volcano Hazards Program", "https://www.usgs.gov/programs/VHP"),
    ],
  });
}

function marketTile() {
  const quotes = ops.intel?.markets;
  if (!ops.intel) return loading("markets", "Markets", true);
  if (!quotes?.length) return tile({ id: "markets", label: "Markets", value: "—", sub: "Quotes not available just now", tone: "idle", wide: true });
  const body = el(
    "div",
    { class: "quotes" },
    ...quotes.map((quote) => {
      const node = el(
        "div",
        { class: "quote" },
        el("b", {}, `${quote.symbol.replace("^GSPC", "S&P 500")} `, el("span", { class: quote.changePct >= 0 ? "up" : "down" }, `${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(1)}%`)),
        el("span", {}, quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })),
      );
      const line = sparkline(quote.series, 100, 18);
      line.style.setProperty("--tone", quote.changePct >= 0 ? "var(--green)" : "var(--critical)");
      node.append(line);
      return node;
    }),
  );
  return tile({ id: "markets", label: "Markets · today", wide: true, body, tone: "", details: () => [
    listOf(quotes, (quote) => [meta(quote.symbol), `${quote.name}: ${quote.price.toLocaleString()} (${quote.changePct >= 0 ? "+" : ""}${quote.changePct}%)`], ""),
    el("p", { class: "muted" }, "Quotes may be delayed. A sharp fall in the company's share price can draw protests, hostile press and insider risk."),
    credit("Yahoo Finance", "https://finance.yahoo.com/"),
  ] });
}

const AQI_BANDS = [
  [50, "good", "ok"],
  [100, "moderate", "watch"],
  [150, "unhealthy for sensitive groups", "warn"],
  [200, "unhealthy", "crit"],
  [300, "very unhealthy", "crit"],
  [Infinity, "hazardous", "crit"],
];
const aqiBand = (aqi) => AQI_BANDS.find(([limit]) => aqi <= limit);

function airTile() {
  const air = ops.intel?.air;
  if (!ops.intel) return loading("air", "Air quality");
  if (!air?.length) return tile({ id: "air", label: "Air quality", value: "—", sub: "Not available", tone: "idle" });
  const worst = air[0];
  const [, words, tone] = aqiBand(worst.aqi);
  return tile({
    id: "air",
    label: "Worst air quality · sites",
    value: String(Math.round(worst.aqi)),
    unit: "AQI",
    sub: `${worst.site}: ${words}`,
    tone,
    details: () => [
      listOf(air, (entry) => [meta(`AQI ${Math.round(entry.aqi)} · ${aqiBand(entry.aqi)[1]}`), entry.site], ""),
      el("p", { class: "muted" }, "US Air Quality Index at priority sites. Wildfire smoke is the usual cause of sudden spikes in California."),
      credit("Open-Meteo air quality", "https://open-meteo.com/en/docs/air-quality-api"),
    ],
  });
}

function renderOps() {
  const grid = document.getElementById("ops-grid");
  if (!grid) return;
  grid.replaceChildren(
    clockTile(),
    ukTile(),
    raidTile(),
    servicesTile(),
    ransomwareTile(),
    phishingTile(),
    kevTile(),
    spaceTile(),
    quakeTile(),
    stormTile(),
    volcanoTile(),
    breachTile(),
    airTile(),
    marketTile(),
  );
  const stamp = [ops.intel?.updatedAt, ops.raids?.updatedAt, ops.outages?.updatedAt].filter(Boolean).sort().at(-1);
  document.getElementById("ops-updated").textContent = stamp ? `updated ${ago(stamp)}` : "";
}

async function loadOps(name, task) {
  try {
    ops[name] = await task();
  } catch {
    // Keep showing the last good figures; the tile marks feeds that never loaded.
  }
  renderOps();
}

const opsFeeds = [
  ["intel", () => api("/api/intel"), 5 * 60_000],
  ["raids", () => api("/api/airraids"), 2 * 60_000],
  ["outages", () => api("/api/outages"), 3 * 60_000],
  [
    "kev",
    async () => {
      const data = await api("/api/feeds/kev");
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const week = data.vulnerabilities.filter((entry) => entry.dateAdded >= weekAgo).sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
      return { total: data.count ?? data.vulnerabilities.length, week };
    },
    60 * 60_000,
  ],
  ["breaches", async () => (await api("/api/feeds/breaches")).sort((a, b) => b.AddedDate.localeCompare(a.AddedDate)).slice(0, 25), 60 * 60_000],
  [
    "quakes",
    async () => {
      const data = await api("/api/feeds/quakes");
      const dayAgo = Date.now() - 86_400_000;
      return (data.features ?? [])
        .map((feature) => ({ mag: feature.properties?.mag, place: feature.properties?.place ?? "Unknown", time: feature.properties?.time, url: feature.properties?.url }))
        .filter((quake) => quake.mag >= 4.5 && quake.time >= dayAgo)
        .sort((a, b) => b.mag - a.mag);
    },
    5 * 60_000,
  ],
];

for (const [name, task, every] of opsFeeds) {
  loadOps(name, task);
  setInterval(() => loadOps(name, task), every);
}
setInterval(updateClocks, 15_000);
setInterval(renderOps, 60_000);

const opsToggle = document.getElementById("ops-toggle");
function setOpsOpen(open) {
  opsToggle.setAttribute("aria-expanded", String(open));
  document.getElementById("ops-grid").hidden = !open;
  saved.set("opsOpen", open);
}
opsToggle.addEventListener("click", () => setOpsOpen(opsToggle.getAttribute("aria-expanded") !== "true"));
setOpsOpen(saved.get("opsOpen", true));
renderOps();

refresh();
setInterval(refresh, 60000);
setInterval(renderReadouts, 1000);

// ---------- Sentinel Pre-Cog ----------

const PRECOG_TITLE = "Sentinel Pre-Cog";
const ROUTE_LETTERS = "ABCDE";
const precog = {
  from: saved.get("precog.from", null),
  to: saved.get("precog.to", null),
  mode: saved.get("precog.mode", "walk"),
  when: "now",
  dayType: "weekday",
  busy: false,
  status: "",
  error: "",
  data: null,
  routes: [],
  selected: 0,
  assessment: null,
  assessing: false,
  showIncidents: true,
  layer: L.layerGroup(),
  picking: null,
  assessTimer: 0,
};

const precogOpen = () => !document.getElementById("drawer").hidden && document.getElementById("drawer-title").textContent === PRECOG_TITLE;

function openPrecog() {
  openDrawer(PRECOG_TITLE, precogPanel());
}

function renderPrecog() {
  if (precogOpen()) {
    const body = document.getElementById("drawer-body");
    const top = body.scrollTop;
    body.replaceChildren(precogPanel());
    body.scrollTop = top;
  }
}

// The hour and kind of day the prediction is for, in the route's own time zone.
function precogTime() {
  if (precog.when !== "now") return { hour: Number(precog.when), weekend: precog.dayType === "weekend", now: false };
  const tz = precog.data?.sources?.find((source) => source.tz)?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { ...localTime(Date.now(), tz), now: true };
}

const hourText = (hour) => `${String(hour).padStart(2, "0")}:00`;
const levelChip = (level, score) => el("span", { class: "pc-level", style: `--level:${level.color}` }, `${level.label} · ${Math.round(score)}`);

function endpointRow(which) {
  const point = precog[which];
  const input = el("input", { type: "text", id: `precog-${which}`, value: point?.label ?? "", placeholder: which === "from" ? "Start: address, place or site" : "Destination: address, place or site", "aria-label": which === "from" ? "Start" : "Destination", autocomplete: "off" });
  input.addEventListener("input", () => {
    if (input.value.trim() !== (precog[which]?.label ?? "")) precog[which] = input.value.trim() ? { label: input.value.trim() } : null;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      planPrecog();
    }
  });
  return el(
    "div",
    { class: "pc-endpoint" },
    el("span", { class: `pc-pin ${which}` }, which === "from" ? "A" : "B"),
    input,
    el("button", { class: "pill small", type: "button", title: "Use my location", "aria-label": `${which === "from" ? "Start" : "Destination"}: my location`, onclick: () => useMyLocation(which) }, "Me"),
    el("button", { class: "pill small", type: "button", title: "Pick on the map", "aria-pressed": String(precog.picking === which), "aria-label": `${which === "from" ? "Start" : "Destination"}: pick on the map`, onclick: () => pickOnMap(which) }, "Map"),
  );
}

function precogPanel() {
  const time = precogTime();
  const whenSelect = el(
    "select",
    { "aria-label": "Time of travel", onchange: (event) => setPrecogTime(event.target.value, precog.dayType) },
    el("option", { value: "now", selected: precog.when === "now" }, "Leaving now"),
    ...Array.from({ length: 24 }, (_, hour) => el("option", { value: String(hour), selected: precog.when === String(hour) }, `At ${hourText(hour)}`)),
  );
  const daySelect = el(
    "select",
    { "aria-label": "Day", disabled: precog.when === "now", onchange: (event) => setPrecogTime(precog.when, event.target.value) },
    el("option", { value: "weekday", selected: precog.dayType === "weekday" }, "on a weekday"),
    el("option", { value: "weekend", selected: precog.dayType === "weekend" }, "at the weekend"),
  );
  const modeButton = (mode, label) =>
    el("button", { type: "button", "aria-pressed": String(precog.mode === mode), onclick: () => { precog.mode = mode; saved.set("precog.mode", mode); renderPrecog(); } }, label);

  return el(
    "div",
    { class: "precog" },
    el("p", { class: "pc-intro" }, "Predicts how risky each route is at the time you travel, from where and when crime has been recorded along it, and finds a detour around hotspots."),
    el("div", { class: "pc-endpoints" }, endpointRow("from"), endpointRow("to"), el("button", { class: "icon-btn pc-swap", type: "button", "aria-label": "Swap start and destination", title: "Swap", onclick: swapPrecog }, "⇅")),
    el("div", { class: "pc-options" }, el("div", { class: "tabs", role: "group", "aria-label": "Travel mode" }, modeButton("walk", "Walk"), modeButton("drive", "Drive")), whenSelect, daySelect),
    el("button", { class: "pill gold pc-go", type: "button", disabled: precog.busy, onclick: planPrecog }, precog.busy ? "Predicting…" : "Predict the safest route"),
    precog.status ? el("p", { class: "pc-status", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), precog.status) : null,
    precog.error ? el("div", { class: "result error" }, precog.error) : null,
    precog.routes.length ? precogResults(time) : null,
  );
}

function precogResults(time) {
  const route = precog.routes[precog.selected] ?? precog.routes[0];
  const max = Math.max(1, ...precog.routes.flatMap((each) => each.byHour));
  const noCrime = !precog.data?.crimes?.length;
  return el(
    "div",
    { class: "pc-results" },
    el("h3", {}, `${precog.routes.length} route${precog.routes.length === 1 ? "" : "s"} · ${time.now ? "leaving now" : "at"} ${hourText(time.hour)}${time.now ? "" : time.weekend ? " at the weekend" : " on a weekday"}`),
    noCrime ? el("div", { class: "result" }, precog.data?.note ?? "No crime records cover this area, so routes are compared on live Sentinel alerts only.") : null,
    routeSummary(summarise(precog.routes, time.hour)),
    ...precog.routes.map((each, index) => routeCard(each, index, max, time)),
    precogAssessmentBox(),
    route.hotspots.length
      ? el(
          "section",
          {},
          el("h3", {}, `Hotspots on route ${route.letter}`),
          el(
            "ul",
            { class: "pc-hotspots" },
            ...route.hotspots.map((spot) =>
              el(
                "li",
                {},
                el(
                  "button",
                  { type: "button", onclick: () => map.flyTo([spot.lat, spot.lon], 17, { duration: 0.8 }) },
                  el("strong", {}, spot.place || `Near ${spot.lat.toFixed(4)}, ${spot.lon.toFixed(4)}`),
                  el("span", {}, `≈${Math.round(spot.perMonth)} incidents/month${spot.violentPerMonth >= 0.5 ? `, ${Math.round(spot.violentPerMonth)} violent` : ""} · ${spot.types.map(([type]) => type.toLowerCase()).join(", ")}${spot.peak ? ` · peaks ${spot.peak}` : ""}`),
                ),
              ),
            ),
          ),
        )
      : null,
    el(
      "label",
      { class: "pc-toggle" },
      el("input", { type: "checkbox", checked: precog.showIncidents, onchange: (event) => { precog.showIncidents = event.target.checked; drawPrecog(false); } }),
      ` Show recorded incidents along route ${route.letter} (red: violent)`,
    ),
    precogSources(),
  );
}

// The headline: which route, why, and the numbers behind it.
function routeSummary(summary) {
  if (!summary) return null;
  const tone = (change) => (change < 0 ? "good" : change > 0 ? "bad" : "");
  const stat = (value, label, className = "") => el("div", { class: `pc-stat ${className}` }, el("strong", {}, value), el("span", {}, label));
  const rec = summary.rows[0];
  const t = summary.timing;
  const several = summary.rows.length > 1;
  return el(
    "section",
    { class: "pc-summary", style: `--level:${rec.level.color}` },
    el("h3", {}, "Route summary"),
    el("p", { class: "pc-headline" }, summary.headline),
    el("p", {}, el("strong", {}, "Why this route: "), summary.why),
    el(
      "div",
      { class: "pc-stats" },
      stat(rec.level.label, `risk at ${t?.hour ?? "this time"} (${Math.round(rec.score)}/km)`, "level"),
      several ? stat(formatChange(rec.vsFastest), "exposure vs fastest", tone(rec.vsFastest)) : null,
      stat(`${summary.violentShare}%`, "of incidents violent", summary.violentShare >= 40 ? "bad" : ""),
      t ? stat(formatChange(t.vsAverage), `at ${t.hour} vs daily average`, tone(t.vsAverage)) : null,
      t ? stat(`${t.quieterHours}%`, "of hours are quieter", t.quieterHours >= 60 ? "bad" : t.quieterHours <= 25 ? "good" : "") : null,
      t && t.bestChange < -5 ? stat(formatChange(t.bestChange), `if you go at ${t.bestHour} instead`, "good") : null,
    ),
    t ? null : el("p", { class: "muted small" }, "These records have no times of day, so the risk is the same at every hour."),
    several
      ? el(
          "table",
          { class: "pc-compare" },
          el("thead", {}, el("tr", {}, ...["Route", "Time", "Risk", "vs fastest", "Violent", "Hotspots"].map((h) => el("th", {}, h)))),
          el(
            "tbody",
            {},
            ...summary.rows.map((row, index) =>
              el(
                "tr",
                { class: index === precog.selected ? "selected" : "", onclick: () => selectRoute(index) },
                el("td", {}, row.route.replace("Route ", ""), row.tags.includes("Recommended") ? el("span", { class: "pc-star", title: "Recommended" }, " ★") : null),
                el("td", { class: "num" }, `${row.minutes}m${row.extraMinutes > 0 ? ` +${row.extraMinutes}` : ""}`),
                el("td", {}, el("span", { class: "pc-dot", style: `--level:${row.level.color}` }), `${row.level.label} ${Math.round(row.score)}`),
                el("td", { class: `num ${tone(row.vsFastest)}` }, row.tags.includes("Fastest") ? "—" : formatChange(row.vsFastest)),
                el("td", { class: "num" }, `${row.violentShare}%`),
                el("td", { class: "num" }, String(row.hotspots + row.live)),
              ),
            ),
          ),
        )
      : null,
  );
}

function routeCard(route, index, max, time) {
  const selected = index === precog.selected;
  const bars = el(
    "div",
    { class: "pc-hours", "aria-label": `Predicted risk by hour for route ${route.letter}` },
    ...route.byHour.map((value, hour) =>
      el("span", { class: hour === time.hour ? "now" : "", style: `height:${Math.max(4, (100 * value) / max)}%;--level:${levelColor(value)}`, title: `${hourText(hour)} · ${Math.round(value)} (${levelName(value)})` }),
    ),
  );
  return el(
    "article",
    { class: `pc-route${selected ? " selected" : ""}`, style: `--level:${route.level.color}`, onclick: (event) => { if (!event.target.closest("a")) selectRoute(index); } },
    el(
      "header",
      {},
      el("strong", {}, `Route ${route.letter}`),
      ...route.tags.map((tag) => el("span", { class: `pc-tag${tag === "Recommended" ? " rec" : ""}` }, tag)),
      levelChip(route.level, route.score),
    ),
    el(
      "div",
      { class: "pc-meta" },
      `${Math.max(1, Math.round(route.durationS / 60))} min · ${(route.distanceM / 1000).toFixed(1)} km${route.extraMinutes > 0 ? ` · +${route.extraMinutes} min` : ""} · exposure ${Math.round(route.exposure)}${route.peak ? ` · crime peaks ${route.peak}` : ""}`,
    ),
    bars,
    el("div", { class: "pc-axis", "aria-hidden": "true" }, el("span", {}, "00"), el("span", {}, "06"), el("span", {}, "12"), el("span", {}, "18"), el("span", {}, "24")),
    selected ? el("ul", { class: "pc-reasons" }, ...reasons(route, time.hour).map((line) => el("li", {}, line))) : null,
    selected ? el("a", { class: "pc-link", href: directionsLink(route, precog.mode), target: "_blank", rel: "noopener" }, "Open this route in Google Maps ↗") : null,
  );
}

const levelColor = (score) => LEVELS.find((level) => score < level.below).color;
const levelName = (score) => LEVELS.find((level) => score < level.below).label;

function precogAssessmentBox() {
  const a = precog.assessment;
  if (precog.assessing && !a) return el("section", { class: "pc-brief" }, el("h3", {}, "Pre-Cog assessment"), el("p", { class: "pc-status" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Reasoning over the figures…"));
  if (!a) return null;
  if (a.error) return el("section", { class: "pc-brief" }, el("h3", {}, "Pre-Cog assessment"), el("p", { class: "muted" }, a.error));
  return el(
    "section",
    { class: "pc-brief" },
    el("h3", {}, "Pre-Cog assessment", el("span", { class: `pc-confidence ${a.confidence}` }, `${a.confidence} confidence`)),
    el("p", { class: "pc-verdict" }, a.verdict),
    el("p", {}, el("strong", {}, "Best time: "), a.bestTime),
    a.reasoning.length ? el("ul", {}, ...a.reasoning.map((line) => el("li", {}, line))) : null,
    a.precautions.length ? el("div", {}, el("strong", {}, "Precautions"), el("ul", {}, ...a.precautions.map((line) => el("li", {}, line)))) : null,
    el("p", { class: "muted small" }, a.confidenceNote),
  );
}

function precogSources() {
  const sources = precog.data?.sources ?? [];
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return el(
    "section",
    { class: "pc-sources" },
    el("h3", {}, "Data behind the prediction"),
    ...sources.map((source) =>
      el(
        "p",
        {},
        el("strong", {}, source.name),
        source.error ? ` — unavailable (${source.error})` : ` — ${source.count.toLocaleString()} incidents${source.from ? `, ${day(source.from)} to ${day(source.to)}` : ""}; ${source.lag}.`,
      ),
    ),
    el(
      "p",
      { class: "muted small" },
      "Pre-Cog counts incidents recorded within " +
        `${precog.mode === "walk" ? 80 : 50} m of each route, weights violent crime three times, and predicts the risk for your hour and day from when they happened, as a 30-day rate per km. ` +
        "Open Sentinel alerts within 300 m add to it. Police records lag and only cover reported crime, so treat this as advice, not a guarantee. Fraud, shoplifting and paperwork offences are left out.",
    ),
  );
}

// ----- choosing the ends -----

function useMyLocation(which) {
  const set = (lat, lon) => {
    precog[which] = { lat, lon, label: "My location" };
    saved.set(`precog.${which}`, precog[which]);
    renderPrecog();
  };
  if (near.here) return set(near.here.lat, near.here.lon);
  if (!navigator.geolocation) return showToast("Location unavailable", ["This browser cannot share its location."], "error");
  navigator.geolocation.getCurrentPosition(
    (position) => set(Math.round(position.coords.latitude * 1e5) / 1e5, Math.round(position.coords.longitude * 1e5) / 1e5),
    () => showToast("Location unavailable", ["Allow location access for this site, or pick the point on the map."], "error"),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

function pickOnMap(which) {
  precog.picking = precog.picking === which ? null : which;
  document.getElementById("map").classList.toggle("picking", Boolean(precog.picking));
  if (precog.picking) showToast("Pick a point", [`Click the map to set the ${which === "from" ? "start" : "destination"}. Press Esc to cancel.`]);
  renderPrecog();
}

map.on("click", (event) => {
  if (!precog.picking) return;
  const which = precog.picking;
  const { lat, lng } = event.latlng;
  precog[which] = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lng * 1e5) / 1e5, label: `Map point ${lat.toFixed(4)}, ${lng.toFixed(4)}` };
  saved.set(`precog.${which}`, precog[which]);
  precog.picking = null;
  document.getElementById("map").classList.remove("picking");
  document.getElementById("toast").hidden = true;
  drawEnds();
  renderPrecog();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && precog.picking) {
    precog.picking = null;
    document.getElementById("map").classList.remove("picking");
    renderPrecog();
  }
});

function swapPrecog() {
  [precog.from, precog.to] = [precog.to, precog.from];
  saved.set("precog.from", precog.from);
  saved.set("precog.to", precog.to);
  renderPrecog();
}

// A typed place: a site by name, coordinates, or the first OpenStreetMap match.
async function resolveEnd(which) {
  const point = precog[which];
  if (!point?.label) throw new Error(`Enter a ${which === "from" ? "start" : "destination"}.`);
  if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) return point;
  const [coords] = coordinateResult(point.label);
  const [site] = siteResults(point.label);
  let found = coords ?? site;
  if (!found) {
    const [place] = await api(`/api/feeds/geocode?q=${encodeURIComponent(point.label)}`);
    if (!place) throw new Error(`Could not find "${point.label}".`);
    found = { lat: Number(place.lat), lon: Number(place.lon), label: place.display_name.split(",").slice(0, 2).join(",") };
  }
  precog[which] = { lat: found.lat, lon: found.lon, label: point.label };
  saved.set(`precog.${which}`, precog[which]);
  return precog[which];
}

// ----- predicting -----

const liveAlerts = () => state.groups.filter((group) => group.lat !== null && (group.status === "new" || group.status === "acknowledged")).map((group) => ({ lat: group.lat, lon: group.lon, severity: group.severity, title: group.name }));

function scoreRoutes(raw) {
  const time = precogTime();
  const index = precog.data?.index ?? indexCrimes([]);
  const analysed = raw.map((route) => analyseRoute(route, { index, mode: precog.mode, hour: time.hour, weekend: time.weekend, alerts: liveAlerts() }));
  return compareRoutes(analysed, precog.mode);
}

function precogStatus(text) {
  precog.status = text;
  renderPrecog();
}

async function planPrecog() {
  if (precog.busy) return;
  for (const which of ["from", "to"]) {
    const input = document.getElementById(`precog-${which}`);
    if (input && input.value.trim() !== (precog[which]?.label ?? "")) precog[which] = input.value.trim() ? { label: input.value.trim() } : null;
  }
  Object.assign(precog, { busy: true, error: "", routes: [], assessment: null, data: null, selected: 0 });
  try {
    precogStatus("Finding the places…");
    const [from, to] = [await resolveEnd("from"), await resolveEnd("to")];
    drawEnds();
    precogStatus("Finding routes…");
    const query = new URLSearchParams({ from: `${from.lat},${from.lon}`, to: `${to.lat},${to.lon}`, mode: precog.mode });
    const raw = readOsrm(await api(`/api/precog/routes?${query}`));
    if (!raw.length) throw new Error("No route was found between those places.");
    raw.forEach((route, index) => (route.letter = ROUTE_LETTERS[index]));

    const lats = raw.flatMap((route) => route.coords.map(([lat]) => lat));
    const lons = raw.flatMap((route) => route.coords.map(([, lon]) => lon));
    const pad = 0.004;
    const box = [Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad];
    if (box[2] - box[0] <= 0.35 && box[3] - box[1] <= 0.35) {
      precogStatus("Reading months of police records along the way…");
      const crime = readCrime(await api(`/api/precog/crime?box=${box.map((value) => value.toFixed(4)).join(",")}`));
      precog.data = { ...crime, index: indexCrimes(crime.crimes), note: crime.sources.length ? null : "No police open-data source covers this area yet (Pre-Cog reads Chicago, DC, Los Angeles, New York, Philadelphia, San Francisco, Seattle, and England, Wales and Northern Ireland). Routes are compared on live Sentinel alerts only." };
    } else {
      precog.data = { crimes: [], sources: [], index: indexCrimes([]), note: "This trip is longer than a city, so it is compared on live Sentinel alerts only, not crime records." };
    }

    precogStatus("Predicting risk by hour…");
    let routes = scoreRoutes(raw);
    const zones = avoidZones(routes, from, to);
    if (zones.length && Math.min(...routes.map((route) => route.score)) >= LEVELS[0].below) {
      precogStatus("Looking for a detour around the hotspots…");
      try {
        const [detour] = readValhalla(await api("/api/precog/avoid", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to, mode: precog.mode, zones }) }));
        if (detour && raw.every((route) => Math.abs(route.distanceM - detour.distanceM) > 40)) {
          detour.letter = ROUTE_LETTERS[raw.length];
          raw.push(detour);
          routes = scoreRoutes(raw);
        }
      } catch {
        // The detour is a bonus; the routes found already stand.
      }
    }
    precog.raw = raw;
    precog.routes = routes;
    precog.selected = 0;
    precog.status = "";
    drawPrecog(true);
    requestAssessment(0);
  } catch (error) {
    precog.error = error.message;
    precog.status = "";
  } finally {
    precog.busy = false;
    renderPrecog();
  }
}

function setPrecogTime(when, dayType) {
  precog.when = when;
  precog.dayType = dayType;
  if (precog.raw) {
    const letter = precog.routes[precog.selected]?.letter;
    precog.routes = scoreRoutes(precog.raw);
    precog.selected = Math.max(0, precog.routes.findIndex((route) => route.letter === letter));
    drawPrecog(false);
    requestAssessment(1200);
  }
  renderPrecog();
}

function requestAssessment(delay) {
  clearTimeout(precog.assessTimer);
  precog.assessment = null;
  precog.assessing = true;
  const routes = precog.routes;
  precog.assessTimer = setTimeout(async () => {
    const time = precogTime();
    const input = assessmentInput({ routes: routes.map((route) => ({ ...route, label: `Route ${route.letter}` })), mode: precog.mode, hour: time.hour, weekend: time.weekend, sources: precog.data?.sources ?? [], from: precog.from, to: precog.to });
    try {
      const { assessment } = await api("/api/precog/assess", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (precog.routes === routes) precog.assessment = assessment;
    } catch (error) {
      if (precog.routes === routes) precog.assessment = { error: error.message };
    } finally {
      if (precog.routes === routes) precog.assessing = false;
      renderPrecog();
    }
  }, delay);
}

function selectRoute(index) {
  precog.selected = index;
  drawPrecog(false);
  renderPrecog();
}

// ----- drawing -----

function drawEnds() {
  precog.layer.eachLayer((layer) => layer.options.precogEnd && precog.layer.removeLayer(layer));
  for (const which of ["from", "to"]) {
    const point = precog[which];
    if (!Number.isFinite(point?.lat)) continue;
    L.circleMarker([point.lat, point.lon], { precogEnd: true, radius: 8, color: "#fff", weight: 2, fillColor: which === "from" ? "#1fd67a" : "#ff5252", fillOpacity: 1 })
      .bindTooltip(which === "from" ? "A" : "B", { permanent: true, direction: "center", className: "pc-end-tip" })
      .addTo(precog.layer);
  }
  if (!map.hasLayer(precog.layer)) precog.layer.addTo(map);
}

function drawPrecog(fit) {
  precog.layer.clearLayers();
  const selected = precog.routes[precog.selected];
  // Unselected routes underneath, dimmed; the chosen one on top.
  for (const route of [...precog.routes].sort((a, b) => (a === selected) - (b === selected))) {
    const chosen = route === selected;
    if (chosen) L.polyline(route.coords, { color: "#000", weight: 10, opacity: 0.5, interactive: false }).addTo(precog.layer);
    L.polyline(route.coords, { color: route.level.color, weight: chosen ? 6 : 4, opacity: chosen ? 1 : 0.45, dashArray: chosen ? null : "6 8" })
      .bindTooltip(`Route ${route.letter} · ${route.level.label} · ${Math.round(route.durationS / 60)} min`, { sticky: true })
      .on("click", () => selectRoute(precog.routes.indexOf(route)))
      .addTo(precog.layer);
  }
  if (selected && precog.showIncidents) {
    for (const each of selected.crimes.slice(0, 3000)) {
      L.circleMarker([each.lat, each.lon], { radius: each.violent ? 3 : 2, stroke: false, fillColor: each.violent ? "#ff5252" : "#fab219", fillOpacity: each.violent ? 0.85 : 0.55 })
        .bindTooltip(`${each.type}${each.place ? ` · ${each.place}` : ""} · ${new Date(each.date).toISOString().slice(0, 10)}${each.hour !== null ? ` ${hourText(each.hour)}` : ""}`)
        .addTo(precog.layer);
    }
  }
  for (const spot of selected?.hotspots ?? []) {
    L.circle([spot.lat, spot.lon], { radius: 110, color: "#ff5252", weight: 1.5, fillColor: "#ff5252", fillOpacity: 0.12, dashArray: "3 4" })
      .bindPopup(
        el(
          "div",
          { class: "popup" },
          el("strong", {}, `Hotspot${spot.place ? `: ${spot.place}` : ""}`),
          el("p", {}, `About ${Math.round(spot.perMonth)} recorded incidents a month${spot.violentPerMonth >= 0.5 ? `, ${Math.round(spot.violentPerMonth)} violent` : ""}.`),
          el("p", { class: "muted" }, `${spot.types.map(([type, count]) => `${type} (${count})`).join(", ")}${spot.peak ? ` · peaks ${spot.peak}` : ""}`),
        ),
        LOCATION_POPUP,
      )
      .addTo(precog.layer);
  }
  drawEnds();
  if (fit && precog.routes.length) {
    const bounds = L.latLngBounds(precog.routes.flatMap((route) => route.coords));
    const drawer = document.getElementById("drawer");
    const alerts = document.getElementById("alerts-panel");
    const left = drawer.hidden || window.innerWidth < 700 ? 60 : drawer.getBoundingClientRect().right + 20;
    const right = alerts.hidden || window.innerWidth < 700 ? 40 : window.innerWidth - alerts.getBoundingClientRect().left + 20;
    map.flyToBounds(bounds, { paddingTopLeft: [left, 90], paddingBottomRight: [right, 90], maxZoom: 17, duration: 0.8 });
  }
}
