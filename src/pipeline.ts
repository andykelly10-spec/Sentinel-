import Anthropic from "@anthropic-ai/sdk";
import { BATCH_SIZE, classifyBatch, createClient } from "./classify";
import { findExistingIds, insertItems, recordRun, type RunRecord } from "./db";
import { notify } from "./notify";
import { collect } from "./sources";
import type { Candidate, ClassifiedItem, Env } from "./types";
import { WATCHLIST } from "./watchlist";

// Bounds the cost and duration of a single run. Anything beyond this is still
// in the source feeds and is picked up by the next run.
export const MAX_NEW_PER_RUN = 40;

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
  const { candidates, sources } = await collect(WATCHLIST.searchTerms, now);

  const existing = await findExistingIds(env.DB, candidates.map((candidate) => candidate.id));
  const unseen = candidates.filter((candidate) => !existing.has(candidate.id)).sort(newestFirst);
  const selected = unseen.slice(0, MAX_NEW_PER_RUN);
  if (unseen.length > selected.length) {
    errors.push(`${unseen.length - selected.length} new items deferred to the next run`);
  }

  const classified: ClassifiedItem[] = [];
  if (selected.length > 0) {
    const client = createClient(env.ANTHROPIC_API_KEY);
    const batches: Candidate[][] = [];
    for (let i = 0; i < selected.length; i += BATCH_SIZE) batches.push(selected.slice(i, i + BATCH_SIZE));

    const outcomes = await Promise.allSettled(
      batches.map((batch) => classifyBatch(client, env.CLASSIFIER_MODEL, batch)),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        // Left unstored so the next run sees these items as new and retries.
        const text = describeError(outcome.reason);
        if (!errors.includes(text)) errors.push(text);
        continue;
      }
      for (const item of batches[index]!) {
        classified.push({ ...item, ...outcome.value.get(item.id)! });
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
