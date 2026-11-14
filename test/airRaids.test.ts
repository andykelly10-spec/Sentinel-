import { describe, expect, it } from "vitest";
import {
  airRaidItems,
  attackNight,
  parseAlertStatus,
  parseTelegram,
  readInterception,
  readThreat,
  type AirRaidPicture,
  type OblastStatus,
} from "../src/hazards/airRaids";
import type { Site } from "../src/types";
import { NOW } from "./helpers";

// Samples in each source's real format. The content is invented.
const telegramPost = (id: string, time: string, html: string) => `
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${id}" data-view="x">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${html}</div>
    <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/${id}"><time datetime="${time}" class="time">00:39</time></a></div>
  </div>
</div></div>`;

const AIR_FORCE_PAGE = `<html><body>
${telegramPost("kpszsu/1", "2026-11-12T10:30:00+00:00", "<i class=\"emoji\">🏍</i> Реактивний БпЛА на Оболоні")}
${telegramPost("kpszsu/2", "2026-11-12T10:40:00+00:00", "Загроза застосування балістики з півночі.<br/>Київ - в укриття!")}
${telegramPost("kpszsu/3", "2026-11-12T10:45:00+00:00", "Зліт МіГ-31К! Тривога по всій країні.")}
${telegramPost("kpszsu/4", "2026-11-12T10:50:00+00:00", "💣Пуски керованих авіаційних бомб на Харківську область")}
${telegramPost("kpszsu/5", "2026-11-12T11:00:00+00:00", "Крилаті ракети курсом на Львівщину, далі на Волинь")}
${telegramPost("kpszsu/6", "2026-11-12T11:05:00+00:00", "Ударні БпЛА східніше Харкова курсом на південь.")}
</body></html>`;

const RUSSIA_POST = {
  id: "mod_russia/1",
  url: "https://t.me/mod_russia/1",
  time: "2026-11-12T08:00:00.000Z",
  text: "⚡️ В течение ночи дежурными силами ПВО уничтожены семь украинских беспилотных летательных аппаратов самолетного типа над территориями Белгородской, Курской областей и Московского региона.",
};

const status = (states: Record<string, unknown>) => JSON.stringify({ version: 10, states });
const on = (since: string) => ({ enabled: true, districts: {}, enabled_at: since });

describe("oblast alert status", () => {
  it("tells live, partial and standing alerts apart", () => {
    const oblasts = parseAlertStatus(
      status({
        "АР Крим": on("2022-12-10T22:22:00+00:00"),
        "Львівська область": on("2026-11-12T11:20:00+00:00"),
        "Донецька область": { enabled: false, districts: { "Покровський район": { enabled: true }, "Бахмутський район": { enabled: true }, "Інший район": { enabled: false } } },
        "Одеська область": { enabled: false, districts: {} },
      }),
      NOW,
    );
    const byName = Object.fromEntries(oblasts.map((oblast) => [oblast.name, oblast]));
    expect(byName.Crimea).toMatchObject({ state: "standing" });
    expect(byName.Lviv).toMatchObject({ state: "active", since: "2026-11-12T11:20:00+00:00", west: true });
    expect(byName.Donetsk).toMatchObject({ state: "partial", districts: 2, since: null });
    expect(byName.Odesa!.state).toBe("clear");
    expect(oblasts).toHaveLength(27);
  });
});

describe("Ukrainian Air Force posts", () => {
  const threats = parseTelegram(AIR_FORCE_PAGE).map(readThreat);

  it("reads every post with its time and link", () => {
    expect(threats.map((threat) => threat.id)).toEqual(["kpszsu/1", "kpszsu/2", "kpszsu/3", "kpszsu/4", "kpszsu/5", "kpszsu/6"]);
    expect(threats[1]).toMatchObject({ url: "https://t.me/kpszsu/2", time: "2026-11-12T10:40:00.000Z", text: "Загроза застосування балістики з півночі. Київ - в укриття!" });
    expect(threats[1]!.translate).toMatch(/^https:\/\/translate\.google\.com\/\?sl=auto&tl=en/);
  });

  it("labels each threat in English and finds the regions it names", () => {
    expect(threats.map((threat) => [threat.kind, threat.missile, threat.regions.map((region) => region.name)])).toEqual([
      ["jet_drone", false, ["Kyiv"]],
      ["ballistic", true, ["Kyiv"]],
      ["kinzhal", true, []],
      ["kab", false, ["Kharkiv"]],
      ["cruise", true, ["Lviv", "Volyn"]],
      ["drone", false, ["Kharkiv"]],
    ]);
    expect(threats[2]!.label).toBe("MiG-31K airborne: Kinzhal hypersonic missile threat");
  });
});

describe("Russian Defence Ministry reports", () => {
  it("reads how many were shot down and where", () => {
    expect(readInterception(RUSSIA_POST)).toMatchObject({
      count: 7,
      regions: [{ name: "Belgorod" }, { name: "Kursk" }, { name: "Moscow" }],
      summary: "Russian air defence reports 7 Ukrainian drones destroyed over Belgorod, Kursk, Moscow.",
    });
    expect(readInterception({ ...RUSSIA_POST, text: "ПВО сбиты 112 БПЛА над Брянской областью" })?.count).toBe(112);
    expect(readInterception({ ...RUSSIA_POST, text: "Танкисты уничтожили опорный пункт" })).toBeNull();
  });
});

describe("air raid alerts", () => {
  const krakow: Site = {
    id: 1, name: "WBD Krakow", address: "", city: "Krakow", country: "PL", lat: 50.0647, lon: 19.945,
    area: "", keywords: "", priority: true, approximate: false, nws_zones: "", region: "",
  };
  const kyivTraveller: Site = { ...krakow, id: -1, name: "Your location", city: "Kyiv", country: "UA", lat: 50.45, lon: 30.52 };

  function picture(active: string[], threats = parseTelegram(AIR_FORCE_PAGE).map(readThreat)): AirRaidPicture {
    const oblasts = parseAlertStatus(status(Object.fromEntries(active.map((name) => [name, on("2026-11-12T09:30:00+00:00")]))), NOW);
    return { updatedAt: NOW.toISOString(), oblasts, activeCount: oblasts.filter((oblast: OblastStatus) => oblast.state === "active").length, threats, interceptions: [readInterception(RUSSIA_POST)!], errors: {} };
  }
  const EAST = ["Харківська область", "Сумська область", "Полтавська область", "Дніпропетровська область", "Запорізька область", "Донецька область", "Чернігівська область", "Київська область", "м. Київ", "Черкаська область", "Кіровоградська область", "Миколаївська область"];

  it("names a night of attacks once, so its reports group together", () => {
    expect(attackNight("2026-11-12T19:00:00Z")).toBe("12 Nov");
    expect(attackNight("2026-11-13T04:00:00Z")).toBe("12 Nov");
    expect(attackNight("2026-11-13T13:00:00Z")).toBe("13 Nov");
  });

  it("raises a mass raid, higher when the regions on the Polish border are under alert", async () => {
    const eastOnly = await airRaidItems(picture(EAST, []), [krakow], NOW);
    expect(eastOnly.map((item) => [item.title, item.severity])).toEqual([["Air raid alert across 12 of 24 Ukrainian regions", "medium"]]);

    const withWest = await airRaidItems(picture([...EAST, "Львівська область"], []), [krakow], NOW);
    expect(withWest[0]).toMatchObject({ severity: "high", site: "WBD Krakow", incident: "Russian air attack on Ukraine, night of 11 Nov" });
    expect(withWest[0]!.summary).toContain("Regions on the Polish border are under alert (Lviv)");
    expect(withWest[0]!.distanceMi).toBeGreaterThan(150);

    expect(await airRaidItems(picture(EAST.slice(0, 11), []), [krakow], NOW)).toEqual([]);
  });

  it("raises each missile threat, but leaves drone and bomb posts to the map", async () => {
    const items = await airRaidItems(picture([]), [krakow], NOW);
    expect(items.map((item) => [item.title, item.severity, item.site])).toEqual([
      ["Ballistic missile threat: Kyiv", "high", ""],
      ["MiG-31K airborne: Kinzhal hypersonic missile threat", "high", ""],
      ["Cruise missiles: Lviv, Volyn", "high", "WBD Krakow"],
    ]);
    expect(new Set(items.map((item) => item.incident))).toEqual(new Set(["Russian air attack on Ukraine, night of 12 Nov"]));
  });

  it("puts anyone inside an alerted region on alert, and reports drones shot down near a site", async () => {
    const items = await airRaidItems(picture(["м. Київ"], []), [krakow, kyivTraveller], NOW);
    expect(items.map((item) => [item.title, item.severity, item.site])).toEqual([["Air raid alert in Kyiv: Your location", "critical", "Your location"]]);

    const moscow: Site = { ...krakow, name: "Moscow hotel", country: "RU", lat: 55.76, lon: 37.62 };
    const russia = await airRaidItems(picture([], []), [moscow], NOW);
    expect(russia.map((item) => [item.title, item.site])).toEqual([["Drone attack reported over Belgorod, Kursk, Moscow", "Moscow hotel"]]);
  });
});
