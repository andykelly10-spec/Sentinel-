import { expireAlerts, extendExpiry, findExistingIds, insertItems, listSites, recordRun, saveSiteZones, type RunRecord } from "../db";
import { notify } from "../notify";
import type { Env, HazardItem, Site, SourceName, SourceResult } from "../types";
import { advisoryHazards } from "./advisories";
import { aircraftHazards } from "./aircraft";
import { disasterHazards } from "./disasters";
import { domainHazards } from "./domains";
import { restrictionHazards } from "./flightRestrictions";
import { quakeHazards } from "./quakes";
import { resolveZones, weatherHazards } from "./weather";
import { wildfireHazards } from "./wildfires";

// New sites are looked up a few at a time to stay inside the per-run request limit.
export const ZONE_LOOKUPS_PER_RUN = 12;

export interface HazardCheck {
  items: HazardItem[];
  // Saves what the check needs to remember, once its alerts are stored.
  commit?: () => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Hazards are judged by fixed rules rather than the classifier, so this run
// costs nothing in model usage. Checks that are slow or change rarely run
// only when `hourly` is set.
export async function runHazards(env: Env, now: Date = new Date(), hourly = false): Promise<RunRecord> {
  const errors: string[] = [];
  let sites: Site[] = await listSites(env.DB);

  try {
    const lookups = await resolveZones(sites, ZONE_LOOKUPS_PER_RUN);
    await saveSiteZones(env.DB, lookups);
    const byId = new Map(lookups.map((lookup) => [lookup.id, lookup]));
    sites = sites.map((site) => {
      const lookup = byId.get(site.id);
      return lookup ? { ...site, nws_zones: lookup.nwsZones, region: lookup.region } : site;
    });
  } catch (error) {
    errors.push(`Weather zone lookup: ${message(error)}`);
  }

  const wrap = (items: Promise<HazardItem[]>): Promise<HazardCheck> => items.then((list) => ({ items: list }));
  const checks: Array<{ source: SourceName; run: () => Promise<HazardCheck> }> = [
    { source: "nws", run: () => wrap(weatherHazards(sites)) },
    { source: "usgs", run: () => wrap(quakeHazards(sites)) },
    { source: "wildfire", run: () => wrap(wildfireHazards(sites, now)) },
    { source: "gdacs", run: () => wrap(disasterHazards(sites, now)) },
    { source: "aircraft", run: () => wrap(aircraftHazards(sites, now)) },
    { source: "faa_tfr", run: () => wrap(restrictionHazards(sites, now)) },
    ...(hourly
      ? [
          { source: "travel_advisory" as const, run: () => advisoryHazards(env.DB, sites, now) },
          { source: "domains" as const, run: () => domainHazards(env.DB) },
        ]
      : []),
  ];
  const settled = await Promise.allSettled(checks.map((check) => check.run()));

  const sources: SourceResult[] = [];
  const byId = new Map<string, HazardItem>();
  const commits: Array<() => Promise<void>> = [];
  for (const [index, result] of settled.entries()) {
    const source = checks[index]!.source;
    if (result.status === "rejected") {
      sources.push({ source, count: 0, error: message(result.reason) });
      continue;
    }
    sources.push({ source, count: result.value.items.length, error: null });
    for (const item of result.value.items) byId.set(item.id, item);
    if (result.value.commit) commits.push(result.value.commit);
  }

  const items = [...byId.values()];
  const existing = await findExistingIds(env.DB, items.map((item) => item.id));
  const fresh = items.filter((item) => !existing.has(item.id));
  await insertItems(env.DB, fresh, now.toISOString());
  await extendExpiry(env.DB, items.filter((item) => existing.has(item.id)));
  for (const commit of commits) {
    try {
      await commit();
    } catch (error) {
      errors.push(`Saving state: ${message(error)}`);
    }
  }
  await expireAlerts(env.DB, now.toISOString());
  errors.push(...(await notify(env, now)));

  const run: RunRecord = {
    kind: "hazards",
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    fetched: items.length,
    newItems: fresh.length,
    alerts: fresh.length,
    sources,
    errors,
  };
  await recordRun(env.DB, run);
  return run;
}
