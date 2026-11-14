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
