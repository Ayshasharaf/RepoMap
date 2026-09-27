import type { Finding, ScanResult, ScanSnapshot } from "./types";

export function snapshotOf(scan: ScanResult): ScanSnapshot {
  return {
    commit: scan.commit || "",
    summary: scan.summary || "",
    counts: scan.counts,
    entities: (scan.entities ?? []).map((entity) => entity.name),
    findings: scan.findings ?? [],
  };
}

export function findingKey(finding: Finding) {
  return [finding.kind, finding.file, finding.symbol, finding.detail].join("\0");
}

export interface ScanComparison {
  added: Finding[];
  removed: Finding[];
  entitiesBefore: number;
  entitiesAfter: number;
  entitiesAdded: string[];
  entitiesRemoved: string[];
  scoreBefore: number;
  scoreAfter: number;
  riskBefore: ScanSnapshot["counts"]["risk"];
  riskAfter: ScanSnapshot["counts"]["risk"];
  unchanged: boolean;
}

export function compareScans(current: ScanResult, previous: ScanSnapshot): ScanComparison {
  const previousKeys = new Set(previous.findings.map(findingKey));
  const currentKeys = new Set(current.findings.map(findingKey));
  const added = current.findings.filter((finding) => !previousKeys.has(findingKey(finding)));
  const removed = previous.findings.filter((finding) => !currentKeys.has(findingKey(finding)));
  const previousEntities = new Set(previous.entities);
  const currentEntities = new Set(current.entities.map((entity) => entity.name));
  const entitiesAdded = [...currentEntities].filter((name) => !previousEntities.has(name)).sort();
  const entitiesRemoved = [...previousEntities].filter((name) => !currentEntities.has(name)).sort();
  const scoreBefore = previous.counts.score;
  const scoreAfter = current.counts.score;
  const riskBefore = previous.counts.risk;
  const riskAfter = current.counts.risk;
  return {
    added,
    removed,
    entitiesBefore: previous.entities.length,
    entitiesAfter: current.entities.length,
    entitiesAdded,
    entitiesRemoved,
    scoreBefore,
    scoreAfter,
    riskBefore,
    riskAfter,
    unchanged: added.length === 0
      && removed.length === 0
      && entitiesAdded.length === 0
      && entitiesRemoved.length === 0
      && scoreBefore === scoreAfter
      && riskBefore === riskAfter,
  };
}
