import type { Alert } from "../types";
import { severityRank } from "../types";

export function needsEmail(alert: Alert, minSeverity: string): boolean {
  const threshold = severityRank(minSeverity);
  return severityRank(alert.severity) >= (threshold === -1 ? severityRank("medium") : threshold);
}

// Texts are for situations where someone may need to act now: anything
// critical, and high-severity risks to people.
export function needsSms(alert: Alert): boolean {
  if (alert.severity === "critical") return true;
  return alert.severity === "high" && (alert.category === "physical" || alert.category === "executive");
}

export function recipients(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
