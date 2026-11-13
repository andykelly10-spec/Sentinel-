import { correlate, feedsForSites, nearestCameras } from "/cameras.js";

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
const proximity = (item) => (item.site && item.distanceMi !== null ? `${item.distanceMi < 0.1 ? 0.1 : item.distanceMi} mi from ${item.site}` : "");

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

function cameraView(each) {
  const note = [each.owner, each.nearSite ? `${each.siteMiles.toFixed(1)} mi from ${each.nearSite}` : null].filter(Boolean).join(" · ");
  return popup(
    "Traffic camera",
    each.name,
    el("p", { class: "muted" }, note),
    each.image
      ? el("img", { src: `${each.image}${each.image.includes("?") ? "&" : "?"}t=${Date.now()}`, alt: `Live view from ${each.name}`, referrerpolicy: "no-referrer" })
      : el("p", {}, el("a", { href: each.link, target: "_blank", rel: "noopener noreferrer" }, "Open the live video")),
  );
}

// A short list of the open cameras closest to a point; choosing one shows it.
function nearbyCameras(lat, lon, holder) {
  const cameraLayer = LAYERS.find((layer) => layer.id === "cameras");
  if (!cameraLayer.active) {
    holder.replaceChildren(el("p", { class: "muted" }, "Switch on the camera layer to see nearby cameras."));
    return;
  }
  const near = nearestCameras(state.cameras, lat, lon, 4, CAMERA_RANGE_MILES);
  if (!near.length) {
    holder.replaceChildren(el("p", { class: "muted" }, `No open cameras within ${CAMERA_RANGE_MILES} miles.`));
    return;
  }
  const viewer = el("div", {});
  holder.replaceChildren(
    el("div", { class: "label" }, "Nearest cameras"),
    el(
      "div",
      { class: "camera-list" },
      ...near.map((each) => el("button", { onclick: () => viewer.replaceChildren(cameraView(each)) }, `${each.name} · ${each.miles.toFixed(1)} mi`)),
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
        const marker = L.marker([site.lat, site.lon], { icon, title: site.name, zIndexOffset: 500 }).bindPopup(
          popup(
            site.priority ? "Priority site" : "Site",
            site.name,
            el("p", { class: "muted" }, [site.address, site.city, site.country].filter(Boolean).join(", ")),
            site.approximate ? el("p", { class: "muted" }, "Position is approximate.") : null,
            conditions,
            cameras,
          ),
        );
        marker.on("popupopen", () => {
          siteConditions(site, conditions);
          nearbyCameras(site.lat, site.lon, cameras);
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
        const icon = L.divIcon({ html: el("div", { class: `incident-marker sev-${item.severity}${live ? " live" : ""}` }), className: "", iconSize: [20, 20], iconAnchor: [10, 10] });
        const marker = L.marker([item.lat, item.lon], { icon, title: item.name, zIndexOffset: 1000 + rank(item.severity) }).bindPopup(
          popup(
            `${item.severity} · ${item.category}`,
            item.name,
            el("p", {}, item.summary),
            proximity(item) ? el("p", {}, el("strong", {}, proximity(item))) : null,
            el("p", { class: "muted" }, `${item.reports.length} report${item.reports.length === 1 ? "" : "s"} · ${ago(item.latest)}`),
            cameras,
          ),
        );
        marker.on("popupopen", () => nearbyCameras(item.lat, item.lon, cameras));
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
    label: "Traffic cameras around your sites",
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
        const style = each.nearSite
          ? { radius: 5, color: "#04130b", weight: 1, fillColor: "#1fd67a", fillOpacity: 0.95 }
          : { radius: 3, stroke: false, fillColor: "#1fd67a", fillOpacity: 0.35 };
        // The image is only requested when someone opens the camera.
        group.addLayer(L.circleMarker([each.lat, each.lon], style).bindPopup(() => cameraView(each)));
      }
      return nearSites;
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
  const failing = (run?.sources ?? []).filter((source) => source.error).length;
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
];
const HEADLINE_FILTERS = ["All", "World", "US", "UK", "Los Angeles", "New York", "Washington DC", "London"];
const newsroom = { tab: "tv", filter: "All", timer: null };

function closeNewsroom() {
  const panel = document.getElementById("newsroom");
  if (panel.hidden) return;
  panel.hidden = true;
  // Removing the players stops the streams.
  document.getElementById("newsroom-body").replaceChildren();
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
  else {
    renderHeadlines();
    newsroom.timer = setInterval(renderHeadlines, 5 * 60_000);
  }
}

function tvTile(slot, chosen) {
  const channel = CHANNELS.find((each) => each.id === chosen) ?? CHANNELS[slot];
  const select = el(
    "select",
    { "aria-label": `Channel for screen ${slot + 1}` },
    ...CHANNELS.map((each) => el("option", { value: each.id, selected: each.id === channel.id }, each.name)),
  );
  select.addEventListener("change", () => {
    const wall = saved.get("tvWall", CHANNELS.slice(0, 4).map((each) => each.id));
    wall[slot] = select.value;
    saved.set("tvWall", wall);
    renderTvWall();
  });
  return el(
    "div",
    { class: "tv-tile" },
    el(
      "div",
      { class: "tv-head" },
      select,
      el("a", { href: `https://www.youtube.com/channel/${channel.channel}/live`, target: "_blank", rel: "noopener noreferrer" }, "YouTube ↗"),
    ),
    el("iframe", {
      src: `https://www.youtube.com/embed/live_stream?channel=${channel.channel}&autoplay=1&mute=1&playsinline=1`,
      title: `${channel.name} live`,
      allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
      allowfullscreen: true,
      // YouTube refuses to play embeds that arrive without a referrer.
      referrerpolicy: "strict-origin-when-cross-origin",
    }),
  );
}

function renderTvWall() {
  const wall = saved.get("tvWall", CHANNELS.slice(0, 4).map((each) => each.id));
  document.getElementById("newsroom-body").replaceChildren(
    el("div", { class: "tv-grid" }, ...[0, 1, 2, 3].map((slot) => tvTile(slot, wall[slot]))),
    el("p", { class: "note" }, "Streams start muted; click a player for sound. If a channel is not broadcasting, its screen says so. Choose channels with the menus above each screen."),
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

document.getElementById("run-now").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    // Separate requests, so each stays inside Cloudflare's per-request limits.
    const results = await Promise.allSettled([api("/api/run", { method: "POST" }), api("/api/hazards/run", { method: "POST" })]);
    await refresh();
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        document.getElementById("feed").prepend(el("div", { class: "empty error" }, `${index === 0 ? "News" : "Hazard"} check failed. ${result.reason.message}`));
      }
    }
  } catch (error) {
    document.getElementById("feed").prepend(el("div", { class: "empty error" }, `Check failed. ${error.message}`));
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
refresh();
setInterval(refresh, 60000);
setInterval(renderReadouts, 1000);
