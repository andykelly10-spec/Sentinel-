import { describe, expect, it } from "vitest";
import { emailHtml } from "../src/notify/email";
import { needsEmail, needsSms, recipients } from "../src/notify/rules";
import { smsBodies } from "../src/notify/sms";
import type { Alert } from "../src/types";

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
    ...fields,
  };
}

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

describe("smsBodies", () => {
  it("collapses a burst into a single text", () => {
    const burst = Array.from({ length: 5 }, (_, i) => alert({ severity: i < 2 ? "critical" : "high" }));
    expect(smsBodies(burst, "")).toEqual(["Sentinel: 5 urgent alerts (2 critical). Check the dashboard now."]);
    expect(smsBodies(burst.slice(0, 3), "")).toHaveLength(3);
  });
});

describe("emailHtml", () => {
  it("escapes untrusted text and refuses non-http links", () => {
    const html = emailHtml(
      [alert({ title: '<img src=x onerror="alert(1)">', summary: "<script>x</script>", url: "javascript:alert(1)" })],
      "",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x");
  });
});
