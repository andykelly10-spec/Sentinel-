import type { Alert } from "../types";
import { severityRank } from "../types";

export interface AlertGroup {
  alert: Alert;
  reports: number;
}

// Collapses reports of one incident into a single entry, and drops incidents
// that were already announced at this severity or higher. `pending` must be
// ordered most severe first so each group is led by its most severe report.
export function groupForNotification(pending: Alert[], announced: Map<string, number>): AlertGroup[] {
  const groups: AlertGroup[] = [];
  const byIncident = new Map<string, AlertGroup>();
  for (const alert of pending) {
    if (!alert.incident) {
      groups.push({ alert, reports: 1 });
      continue;
    }
    const existing = byIncident.get(alert.incident);
    if (existing) {
      existing.reports++;
    } else if (severityRank(alert.severity) > (announced.get(alert.incident) ?? -1)) {
      const group = { alert, reports: 1 };
      byIncident.set(alert.incident, group);
      groups.push(group);
    }
  }
  return groups;
}
