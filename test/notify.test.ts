import { describe, expect, it } from "vitest";
import { distanceMiles, mentionsPlace, nearestSite, placeWords, priorityAreas, proximityLabel } from "../src/geo";
import { emailHtml, emailText } from "../src/notify/email";
import { groupForNotification } from "../src/notify/group";
import { needsEmail, needsSms, recipients } from "../src/notify/rules";
import { smsBodies } from "../src/notify/sms";
import { severityRank, type Alert } from "../src/types";

function alert(fields: Partial<Alert>): Alert {
  return {
    id: "a".repeat(32),
    source: "bing_news",
    url: "https://news.example/story",
    title: "Title",
    snippet: "",
    author: "news.example",
    publishedAt: null,
    firstSeenAt: "2026-11-12T12:00:00.000Z",
    category: "brand",
    severity: "medium",
    summary: "Summary",
    status: "new",
    incident: "",
    place: "",
    lat: null,
    lon: null,
    site: "",
    distanceMi: null,
    expiresAt: null,
    ...fields,
  };
}

const single = (fields: Partial<Alert>) => ({ alert: alert(fields), reports: 1 });

describe("notification rules", () => {
  it("emails at or above the configured severity, defaulting to medium", () => {
    expect(needsEmail(alert({ severity: "low" }), "medium")).toBe(false);
    expect(needsEmail(alert({ severity: "medium" }), "medium")).toBe(true);
    expect(needsEmail(alert({ severity: "low" }), "low")).toBe(true);
    expect(needsEmail(alert({ severity: "low" }), "typo")).toBe(false);
    expect(needsEmail(alert({ severity: "high" }), "typo")).toBe(true);
  });

  it("texts for anything critical and for high-severity risks to people", () => {
    expect(needsSms(alert({ severity: "critical", category: "cyber" }))).toBe(true);
    expect(needsSms(alert({ severity: "high", category: "physical" }))).toBe(true);
    expect(needsSms(alert({ severity: "high", category: "executive" }))).toBe(true);
    expect(needsSms(alert({ severity: "high", category: "cyber" }))).toBe(false);
    expect(needsSms(alert({ severity: "medium", category: "physical" }))).toBe(false);
  });

  it("parses recipient lists", () => {
    expect(recipients(" a@x.example, ,b@x.example ")).toEqual(["a@x.example", "b@x.example"]);
    expect(recipients("")).toEqual([]);
  });
});

describe("groupForNotification", () => {
  const shooting = (severity: Alert["severity"], id: string) => alert({ id, severity, incident: "Farragut Square shooting" });

  it("collapses reports of one incident and keeps unrelated alerts separate", () => {
    const groups = groupForNotification(
      [shooting("critical", "1"), shooting("critical", "2"), alert({ id: "3", severity: "high" }), shooting("high", "4")],
      new Map(),
    );
    expect(groups.map((group) => [group.alert.id, group.reports])).toEqual([
      ["1", 3],
      ["3", 1],
    ]);
  });

  it("stays quiet about an announced incident unless it escalates", () => {
    const announcedHigh = new Map([["Farragut Square shooting", severityRank("high")]]);
    expect(groupForNotification([shooting("high", "1"), shooting("medium", "2")], announcedHigh)).toEqual([]);
    expect(groupForNotification([shooting("critical", "1")], announcedHigh)).toHaveLength(1);
  });
});

describe("proximity", () => {
  const bureau = { name: "CBS News Washington Bureau", lat: 38.9056, lon: -77.0457 };
  const sites = [bureau, { name: "Paramount Skydance New York", lat: 40.7577, lon: -73.986 }];

  it("measures distance in miles", () => {
    // Logan Circle is a little under a mile from 2020 M St NW.
    expect(distanceMiles(38.9096, -77.0296, bureau.lat, bureau.lon)).toBeGreaterThan(0.7);
    expect(distanceMiles(38.9096, -77.0296, bureau.lat, bureau.lon)).toBeLessThan(1.1);
  });

  it("finds the nearest site and ignores events far from all of them", () => {
    expect(nearestSite(38.9096, -77.0296, sites)).toEqual({ site: bureau.name, distanceMi: 0.9 });
    expect(nearestSite(40.7614, -73.9776, sites)!.site).toBe("Paramount Skydance New York");
    expect(nearestSite(41.8781, -87.6298, sites)).toBeNull();
    expect(nearestSite(null, null, sites)).toBeNull();
  });

  it("describes proximity for people", () => {
    expect(proximityLabel(bureau.name, 0.9)).toBe("about 0.9 mi from CBS News Washington Bureau");
    expect(proximityLabel("", null)).toBe("");
  });

  it("matches reports to sites by city and extra place words", () => {
    const words = placeWords([
      { city: "Washington", keywords: "DC, D.C., Logan Circle" },
      { city: "New York", keywords: "" },
      { city: "Washington", keywords: "" },
    ]);
    expect(words).toEqual(["washington", "dc", "d c", "logan circle", "new york"]);
    expect(mentionsPlace("Active shooter reported in D.C. this morning", words)).toBe(true);
    expect(mentionsPlace("Shots fired near Logan Circle", words)).toBe(true);
    expect(mentionsPlace("Bomb threat at a New York school", words)).toBe(true);
    expect(mentionsPlace("Active shooter drill in Milwaukee", words)).toBe(false);
    // A place word must match whole words: "dc" is not found inside "abcdc".
    expect(mentionsPlace("the abcdc concert", words)).toBe(false);
  });

  it("searches the areas of priority sites, busiest first, up to a limit", () => {
    const list = [
      { area: "Burbank", city: "Burbank", priority: true },
      { area: "", city: "Atlanta", priority: true },
      { area: "Manhattan", city: "New York", priority: true },
      { area: "Manhattan", city: "New York", priority: true },
      { area: "London", city: "London", priority: false },
    ];
    expect(priorityAreas(list, 6)).toEqual(["Manhattan", "Burbank", "Atlanta"]);
    expect(priorityAreas(list, 1)).toEqual(["Manhattan"]);
  });
});

describe("smsBodies", () => {
  it("collapses a burst into a single text", () => {
    const burst = Array.from({ length: 5 }, (_, i) => single({ severity: i < 2 ? "critical" : "high" }));
    expect(smsBodies(burst, "")).toEqual(["Sentinel: 5 urgent alerts (2 critical). Check the dashboard now."]);
    expect(smsBodies(burst.slice(0, 3), "")).toHaveLength(3);
  });

  it("says how close the incident is", () => {
    const near = single({ severity: "critical", category: "physical", summary: "Shots fired.", site: "CBS News Washington Bureau", distanceMi: 0.4 });
    expect(smsBodies([near], "")).toEqual([
      "Sentinel CRITICAL physical: Shots fired. (about 0.4 mi from CBS News Washington Bureau)",
    ]);
  });
});

describe("email", () => {
  it("escapes untrusted text and refuses non-http links", () => {
    const html = emailHtml(
      [single({ title: '<img src=x onerror="alert(1)">', summary: "<script>x</script>", url: "javascript:alert(1)" })],
      "",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x");
  });

  it("leads with the incident name and report count", () => {
    const group = { alert: alert({ severity: "critical", category: "physical", incident: "Farragut Square shooting", site: "CBS News Washington Bureau", distanceMi: 0.4 }), reports: 3 };
    expect(emailText([group], "")).toContain("[CRITICAL] physical: Farragut Square shooting (3 reports)");
    expect(emailText([group], "")).toContain("about 0.4 mi from CBS News Washington Bureau");
  });
});
