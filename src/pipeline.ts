import Anthropic from "@anthropic-ai/sdk";
import { BATCH_SIZE, buildSystemPrompt, classifyBatch, createClient } from "./classify";
import { findExistingIds, getSetting, insertItems, listSites, recentIncidents, recordRun, setSetting, type RunRecord } from "./db";
import { nearestSite } from "./geo";
import { notify } from "./notify";
import { collect } from "./sources";
import { OUTLETS } from "./sources/outlets";
import type { Candidate, ClassifiedItem, Env } from "./types";
import { WATCHLIST } from "./watchlist";

// Bounds the cost and duration of a single run. Anything beyond this is still
// in the source feeds and is picked up by the next run.
export const MAX_NEW_PER_RUN = 60;

const INCIDENT_WINDOW_MS = 2 * 86_400_000;

// Outlets read per run, rotating through the list, to stay inside Cloudflare's
// per-run request limit. Each outlet is read about once an hour.
export const OUTLETS_PER_RUN = 6;
const OUTLET_ROTATION = "outlet_rotation";

function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Classifier: ANTHROPIC_API_KEY is missing or invalid";
  }
  if (error instanceof Anthropic.APIError) {
    return `Classifier: Claude API error ${error.status ?? ""} ${error.message}`.trim();
  }
  return `Classifier: ${error instanceof Error ? error.message : String(error)}`;
}

function newestFirst(a: Candidate, b: Candidate): number {
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
}

export async function runPipeline(env: Env, now: Date = new Date()): Promise<RunRecord> {
  const errors: string[] = [];
  const sites = await listSites(env.DB);
  const start = Number((await getSetting(env.DB, OUTLET_ROTATION)) ?? "0") % OUTLETS.length;
  const outlets = Array.from({ length: Math.min(OUTLETS_PER_RUN, OUTLETS.length) }, (_, i) => OUTLETS[(start + i) % OUTLETS.length]!);
  const { candidates, sources } = await collect({ ...WATCHLIST, sites, outlets }, now);
  await setSetting(env.DB, OUTLET_ROTATION, String((start + outlets.length) % OUTLETS.length));

  const existing = await findExistingIds(env.DB, candidates.map((candidate) => candidate.id));
  const unseen = candidates.filter((candidate) => !existing.has(candidate.id)).sort(newestFirst);
  const selected = unseen.slice(0, MAX_NEW_PER_RUN);
  if (unseen.length > selected.length) {
    errors.push(`${unseen.length - selected.length} new items deferred to the next run`);
  }

  const classified: ClassifiedItem[] = [];
  if (selected.length > 0) {
    const client = createClient(env.ANTHROPIC_API_KEY);
    const systemPrompt = buildSystemPrompt(sites);
    const incidents = await recentIncidents(env.DB, new Date(now.getTime() - INCIDENT_WINDOW_MS).toISOString());

    // One batch at a time, so a name coined for an event in one batch is
    // reused by the next rather than each batch inventing its own.
    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      let results: Awaited<ReturnType<typeof classifyBatch>>;
      try {
        results = await classifyBatch(client, env.CLASSIFIER_MODEL, batch, incidents, systemPrompt);
      } catch (error) {
        // Left unstored so the next run sees these items as new and retries.
        const text = describeError(error);
        if (!errors.includes(text)) errors.push(text);
        continue;
      }
      for (const item of batch) {
        const result = results.get(item.id)!;
        if (result.incident && !incidents.includes(result.incident)) incidents.unshift(result.incident);
        const near = nearestSite(result.lat, result.lon, sites);
        classified.push({ ...item, ...result, site: near?.site ?? "", distanceMi: near?.distanceMi ?? null });
      }
    }
    await insertItems(env.DB, classified, now.toISOString());
  }

  errors.push(...(await notify(env, now)));

  const run: RunRecord = {
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    fetched: candidates.length,
    newItems: classified.length,
    alerts: classified.filter((item) => item.category !== "none").length,
    sources,
    errors,
  };
  await recordRun(env.DB, run);
  return run;
}
