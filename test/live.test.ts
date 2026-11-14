import { describe, expect, it } from "vitest";
import { liveFromHead } from "../src/live";

describe("live TV lookup", () => {
  it("finds the video a channel is streaming from the start of its /live page", () => {
    const head = `<html><head><title>BREAKING | White House update &amp; more - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=Jrgk_ng35Uw">`;
    expect(liveFromHead(head)).toEqual({ videoId: "Jrgk_ng35Uw", title: "BREAKING | White House update & more" });
  });

  it("returns nothing when the channel is not live", () => {
    expect(liveFromHead(`<title>Sky News - YouTube</title><link rel="canonical" href="https://www.youtube.com/channel/UCoMdktPbSTixAyNGwb-UYkQ">`)).toBeNull();
  });
});

describe("live TV cache", () => {
  it("keeps the last video that worked when YouTube blocks a lookup", async () => {
    const { vi } = await import("vitest");
    const { liveVideos } = await import("../src/live");
    const { createTestDb, NOW } = await import("./helpers");
    const db = createTestDb();
    // As in YouTube's real pages, the title follows the canonical link.
    const page = (id: string) => `<html><head><script>/* ${"x".repeat(5000)} */</script><link rel="canonical" href="https://www.youtube.com/watch?v=${id}"><title>Sky News live - YouTube</title></head>`;
    const blocked = `<html><head><title> - YouTube</title><link rel="canonical" href="undefined"></head>`;
    let reply = page("Jrgk_ng35Uw");
    vi.stubGlobal("fetch", async () => new Response(reply));

    expect(await liveVideos(db, ["sky", "nope"], NOW)).toEqual({ sky: { videoId: "Jrgk_ng35Uw", title: "Sky News live" } });

    // Blocked 20 minutes later: the old video is kept.
    reply = blocked;
    const later = new Date(NOW.getTime() + 20 * 60_000);
    expect((await liveVideos(db, ["sky"], later)).sky?.videoId).toBe("Jrgk_ng35Uw");

    // A new stream is picked up on the next lookup after the 2-minute retry wait.
    reply = page("NEWSKY00001");
    expect((await liveVideos(db, ["sky"], new Date(later.getTime() + 60_000))).sky?.videoId).toBe("Jrgk_ng35Uw");
    expect((await liveVideos(db, ["sky"], new Date(later.getTime() + 3 * 60_000))).sky?.videoId).toBe("NEWSKY00001");
    vi.unstubAllGlobals();
  });
});
