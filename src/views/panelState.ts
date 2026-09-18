import type { DocumentResearchData, Suggestion } from "../types";

export type PanelPhase =
  | "unconfigured"
  | "non-document"
  | "loading"
  | "empty"
  | "ready";

export interface PanelStateInput {
  hasEndpoint: boolean;
  activeFileExtension: string | null;
  busy: boolean;
  record: DocumentResearchData | null;
}

export function derivePanelState(input: PanelStateInput): PanelPhase {
  if (!input.hasEndpoint) return "unconfigured";
  if (input.activeFileExtension !== "md") return "non-document";
  if (input.busy) return "loading";
  if (!input.record || input.record.suggestions.length === 0) {
    return "empty";
  }
  return "ready";
}

function bucketRank(s: Suggestion): number {
  if (s.bucket === "high") return 0;
  if (s.bucket === "medium") return 1;
  return 2;
}

export function carrySummaries(
  previous: Suggestion[],
  incoming: Suggestion[]
): void {
  const byUrl = new Map(previous.map((s) => [s.url, s] as const));
  for (const s of incoming) {
    const prior = byUrl.get(s.url);
    if (prior?.summary) s.summary = prior.summary;
  }
}

export function pickSummarizeTargets(
  candidates: Suggestion[],
  topN: number
): Suggestion[] {
  return [...candidates]
    .sort((a, b) => bucketRank(a) - bucketRank(b))
    .filter((s) => !s.summary)
    .slice(0, Math.max(0, topN));
}
