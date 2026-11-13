const USER_AGENT = "sentinel-monitor/0.1 (brand security monitoring)";

export async function getText(url: string, timeoutMs = 15_000): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

export function quoted(terms: string[]): string[] {
  return terms.map((term) => `"${term.replace(/"/g, "")}"`);
}

export function toIso(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
