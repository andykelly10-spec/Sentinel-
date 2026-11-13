import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { getSetting } from "../src/db";
import { latestHeadlines } from "../src/headlines";
import { runPipeline } from "../src/pipeline";
import { OUTLETS, parseOutlet, relevantStory, type Headline } from "../src/sources/outlets";
import { createEnv, NOW, OUTLET_RSS, sourceResponse } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const WORLD = OUTLETS.find((outlet) => outlet.scope === "world")!;
const LOCAL = OUTLETS.find((outlet) => outlet.scope === "local")!;

const filter = {
  brandTerms: ["Skydance", "Paramount", "Warner Bros"],
  incidentTerms: ["explosion", "shooting"],
  places: ["washington", "new york"],
};

describe("news outlets", () => {
  it("reads titles, links, summaries and dates, removing markup", () => {
    const [first] = parseOutlet(OUTLET_RSS, WORLD);
    expect(first).toEqual({
      outlet: WORLD.name,
      region: WORLD.region,
      scope: "world",
      title: "Paramount staff told to work from home after a threatening letter",
      url: "https://outlet.example/paramount-letter",
      summary: "Security was increased at the studio lot.",
      publishedAt: "2026-11-12T10:30:00.000Z",
    });
  });

  it("passes on brand stories anywhere, and incidents only near a site", () => {
    const keep = (outlet: typeof WORLD) => parseOutlet(OUTLET_RSS, outlet).filter((story) => relevantStory(story, filter)).map((story) => story.title);
    expect(keep(WORLD)).toEqual([
      "Paramount staff told to work from home after a threatening letter",
      "Explosion reported at a warehouse in Washington",
    ]);
    // A local outlet covers a site's area, so its incident stories count wherever they are.
    expect(keep(LOCAL)).toEqual([
      "Paramount staff told to work from home after a threatening letter",
      "Explosion reported at a warehouse in Washington",
      "Explosion at a factory in Lyon",
    ]);
  });

  it("matches whole words, so a brand inside another word does not count", () => {
    const story = (title: string): Headline => ({ outlet: "", region: "", scope: "world", title, url: "", summary: "", publishedAt: null });
    expect(relevantStory(story("Paramountcy of the rule of law"), filter)).toBe(false);
    expect(relevantStory(story("Warner Bros. announces a sequel"), filter)).toBe(true);
  });

  it("reads a few outlets each run, rotating through the list", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      requested.push(url.href);
      return sourceResponse(url) ?? Response.json({ type: "error", error: { type: "authentication_error", message: "no" } }, { status: 401 });
    });
    const env = createEnv();
    await runPipeline(env, NOW);
    const outletUrls = new Set(OUTLETS.map((outlet) => outlet.url));
    expect(requested.filter((url) => outletUrls.has(url))).toEqual(OUTLETS.slice(0, 6).map((outlet) => outlet.url));
    expect(await getSetting(env.DB, "outlet_rotation")).toBe("6");

    requested.length = 0;
    await runPipeline(env, new Date(NOW.getTime() + 15 * 60_000));
    expect(requested.filter((url) => outletUrls.has(url))).toEqual(OUTLETS.slice(6, 12).map((outlet) => outlet.url));
  });
});

describe("headlines", () => {
  it("merges every outlet newest first, notes failures, and reuses the result for a few minutes", async () => {
    const env = createEnv();
    let calls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls++;
      const url = new URL(String(input instanceof Request ? input.url : input));
      return url.href === OUTLETS[1]!.url ? new Response("down", { status: 503 }) : new Response(OUTLET_RSS);
    });
    const list = await latestHeadlines(env.DB, NOW);
    expect(calls).toBe(OUTLETS.length);
    expect(list.failed).toEqual([OUTLETS[1]!.name]);
    // Four stories from each of the outlets that answered.
    expect(list.headlines).toHaveLength((OUTLETS.length - 1) * 4);
    expect(list.headlines[0]!.publishedAt).toBe("2026-11-12T10:30:00.000Z");

    await latestHeadlines(env.DB, new Date(NOW.getTime() + 60_000));
    expect(calls).toBe(OUTLETS.length);
    await latestHeadlines(env.DB, new Date(NOW.getTime() + 6 * 60_000));
    expect(calls).toBe(OUTLETS.length * 2);
  });

  it("is served to the signed-in dashboard", async () => {
    vi.stubGlobal("fetch", async () => new Response(OUTLET_RSS));
    const env = createEnv();
    const response = await worker.fetch(new Request("https://sentinel.example/api/headlines", { headers: { Authorization: `Basic ${btoa(":hunter2")}` } }), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { headlines: Headline[] };
    expect(body.headlines[0]).toMatchObject({ title: "Paramount staff told to work from home after a threatening letter" });
  });
});
