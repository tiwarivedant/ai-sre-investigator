// Shapes of the raw source records in data/. Loose where the data is loose.

export interface AlertRecord {
  id: string;
  timestamp: string;
  source: string;
  service: string;
  severity: "info" | "warning" | "critical";
  title: string;
  value?: string;
  status: "open" | "resolved";
  resolved_at?: string;
  note?: string;
}

export interface LogRecord {
  id: string;
  timestamp: string;
  service: string;
  level: string;
  message: string;
  pod?: string;
  latency_ms?: number;
  duration_ms?: number;
  trace_id?: string;
  source?: string;
  db?: string;
}

export interface DeployRecord {
  id: string;
  timestamp: string;
  service: string;
  type: "code_deploy" | "rollback" | string;
  version: string;
  author: string;
  summary: string;
  status: string;
  rollout?: string;
  canary_result?: string;
}

export interface ConfigChangeRecord {
  id: string;
  timestamp: string;
  service: string;
  source: string;
  author: string;
  change: string;
  comment?: string;
  applies_to?: string;
  ticket: string | null;
}

export interface MetricsFile {
  description: string;
  timestamps: string[]; // "HH:MM"
  series: Record<string, number[]>;
  notes: string[];
}

export interface MetricPoint {
  ts: string; // ISO
  value: number;
}

export interface MetricSeries {
  id: string; // MET-<name>
  name: string;
  service: string;
  points: MetricPoint[];
}

export interface ServiceEntry {
  tier?: number;
  owner_team?: string;
  oncall?: string;
  description?: string;
  depends_on?: string[];
  slo?: string;
  replicas?: number;
  db_pool_default?: number;
}

export interface ResourceEntry {
  type: string;
  owner_team?: string;
  version?: string;
  max_connections?: number;
  reserved_superuser_connections?: number;
  shared_by?: string[];
  notes?: string;
  status_page?: string;
}

export interface ServiceCatalog {
  services: Record<string, ServiceEntry>;
  resources: Record<string, ResourceEntry>;
}

export interface KnowledgeDoc {
  id: string; // RB-<file> or INC-<id>
  kind: "runbook" | "incident";
  title: string;
  text: string;
}
