export interface Finding {
  kind: "scope_gap" | "n_plus_one" | "broken_relation" | "parse_error" | "incomplete";
  file: string;
  symbol: string;
  detail: string;
}

export interface Entity {
  name: string;
  tenantOwned: boolean;
}

export interface Relation {
  from: string;
  to: string;
  kind: string;
  broken: boolean;
  reason?: string;
}

export interface Endpoint {
  method: string;
  path: string;
  entity: string | null;
  scopeGap: boolean;
}

export interface Counts {
  scopeGaps: number;
  nPlusOne: number;
  brokenRelations: number;
  score: number;
  risk: "High" | "Medium" | "Low" | "Unscored";
}

export interface Diagrams {
  architecture: string;
  erd: string;
  connections: string;
}

export interface OverviewModule {
  id: string;
  label: string;
  files: number;
  classes?: string[];
}

export interface OverviewDep {
  name: string;
  usedFor: string;
}

export interface OverviewEntry {
  name: string;
  detail: string;
}

export interface OverviewStep {
  title: string;
  detail: string;
}

export interface Overview {
  identity: {
    why: string;
    language: string;
    stack: string[];
    license: string;
    commit: string;
  };
  modules: OverviewModule[];
  moduleDiagram: string;
  dependencies: {
    internal: { from: string; to: string }[];
    external: OverviewDep[];
  };
  entryPoints: OverviewEntry[];
  checklist: OverviewStep[];
  health: {
    testFiles: number;
    coverage: string;
    workflows: string[];
    churn: string;
  };
}

export interface RepoMeta {
  stars: number | null;
  contributors: number | null;
  openIssues: number | null;
  description: string;
  license: string;
  language: string;
  pushedAt: string;
}

export interface ScanResult {
  service: string;
  commit: string;
  source?: string;
  summary: string;
  entities: Entity[];
  relations: Relation[];
  endpoints: Endpoint[];
  findings: Finding[];
  counts: Counts;
  diagrams: Diagrams;
  overview?: Overview;
}
