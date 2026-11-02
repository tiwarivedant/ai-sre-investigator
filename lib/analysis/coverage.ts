import type { EvidenceStore } from "@/lib/evidence/loader";

/**
 * Coverage check, run before the agent: does the available data say anything
 * about what the responder reported? Terms are pulled from the incident text
 * (services from the catalog, infrastructure components, symptoms) and
 * searched for in the service catalog, alerts, logs, metrics and changes.
 * An investigation must not answer a question its data can't see.
 */

export type CoverageSource = "catalog" | "alerts" | "logs" | "metrics" | "changes" | "follow-ups";
export const SEARCHED: CoverageSource[] = ["catalog", "alerts", "logs", "metrics", "changes"];

export interface TermCoverage {
  term: string;
  kind: "component" | "symptom";
  /** Evidence IDs per source (catalog hits are service names). */
  hits: Partial<Record<CoverageSource, string[]>>;
  covered: boolean;
}

export interface Coverage {
  verdict: "covered" | "partial" | "none";
  terms: TermCoverage[];
  /** Components named in the report with no evidence anywhere. */
  uncovered: string[];
  searched: CoverageSource[];
}

// Infrastructure nouns that name a component even when it isn't in our catalog.
const TECH = new Set(
  (
    "kafka consumer producer broker topic partition zookeeper rabbitmq queue sqs sns pubsub redis memcached cache " +
    "postgres postgresql mysql mongodb mongo cassandra dynamodb elasticsearch opensearch database db s3 bucket cdn dns " +
    "nginx haproxy envoy gateway loadbalancer lb kubernetes k8s pod node cluster lambda vpn ldap sso auth login oauth " +
    "certificate cert tls ssl api endpoint webhook cron scheduler job worker pool connection connections " +
    "replica disk memory cpu network firewall payment payments checkout cart search inventory order orders reporting frontend"
  ).split(" "),
);

const SYMPTOMS = new Set(
  "error errors failing failed failure failures slow slowness latency timeout timeouts lag lagging lags down outage 500 500s 503 503s 5xx crash crashing spike spiking stuck backlog unavailable degraded throttled".split(
    " ",
  ),
);

// Words that name a kind of evidence rather than a component: covered when that kind exists.
const EVIDENCE_KINDS: Record<string, CoverageSource> = {
  deploy: "changes",
  deployment: "changes",
  release: "changes",
  rollback: "changes",
  rollout: "changes",
  config: "changes",
  flag: "changes",
  alert: "alerts",
  alerts: "alerts",
};

const STOP = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have how i if in into is it its just " +
    "like may maybe me might min mins minute minutes more most my no not now of on or our out over right same seeing seems " +
    "see so some started starting still than that the their them then there these they this those to too up us very was " +
    "we were what when where which while who why will with would you your ago hour hours today customers customer users " +
    "user people site feels feel getting got lot lots really something anything issue issues problem problems help please " +
    "looks look going went just shipped before after since around about"
  ).split(" "),
);

/** Simple stem for matching: consumers -> consumer, lagging -> lag, timeouts -> timeout. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ging")) w = w.slice(0, -4); // lagging -> lag
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

/** Catalog aliases: "orders-db" -> orders-db, orders db, orders_db; "checkout-service" -> checkout. */
function catalogAliases(store: EvidenceStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of [...Object.keys(store.catalog.services), ...Object.keys(store.catalog.resources)]) {
    const base = name.replace(/-service$/, "");
    for (const a of [name, base, name.replace(/-/g, " "), name.replace(/-/g, "_"), base.replace(/-/g, " ")]) out.set(a.toLowerCase(), name);
  }
  return out;
}

export function extractTerms(text: string, store: EvidenceStore): { term: string; kind: TermCoverage["kind"] }[] {
  const lower = text.toLowerCase();
  const aliases = catalogAliases(store);
  const found = new Map<string, TermCoverage["kind"]>();

  // Multi-word / hyphenated catalog names first ("orders-db", "orders db").
  for (const [alias, name] of aliases) {
    if (alias.length >= 4 && new RegExp(`\\b${alias.replace(/[-_ ]/g, "[-_ ]")}\\b`).test(lower)) found.set(name, "component");
  }
  for (const raw of lower.match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    const w = raw.replace(/\.$/, "");
    if (w.length < 3 || STOP.has(w) || /^v?\d+(\.\d+)+$/.test(w) || /^\d+$/.test(w)) continue;
    if (aliases.has(w)) {
      found.set(aliases.get(w)!, "component");
      continue;
    }
    if ([...found.keys()].some((k) => k.startsWith(w) || w.startsWith(k.replace(/-service$/, "")))) continue; // already covered by a catalog name
    if (EVIDENCE_KINDS[w] || EVIDENCE_KINDS[stem(w)]) continue; // handled below as context, not a component
    // Known names stay as written ("redis", not "redi"); otherwise match on the stem.
    const s = TECH.has(w) ? w : stem(w);
    if (TECH.has(s)) found.set(s, "component");
    else if (SYMPTOMS.has(w) || SYMPTOMS.has(s)) found.set(s, "symptom");
  }
  return [...found].map(([term, kind]) => ({ term, kind }));
}

/** "Is it the deploy?" -> the changes we have. Context terms never decide the verdict. */
function contextTerms(text: string, store: EvidenceStore): TermCoverage[] {
  const words = new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).map((w) => (EVIDENCE_KINDS[w] ? w : stem(w))));
  const out: TermCoverage[] = [];
  for (const [word, src] of Object.entries(EVIDENCE_KINDS)) {
    if (!words.has(word) || out.some((t) => t.hits[src])) continue;
    const ids = src === "changes" ? [...store.deploys.map((d) => d.id), ...store.configChanges.map((c) => c.id)] : store.alerts.map((a) => a.id);
    out.push({ term: word, kind: "symptom", hits: ids.length ? { [src]: ids } : {}, covered: ids.length > 0 });
  }
  return out;
}

export function checkCoverage(text: string, store: EvidenceStore, excludeFollowUps: Set<string> = new Set()): Coverage {
  const terms = extractTerms(text, store).map(({ term, kind }) => {
    const re = new RegExp(`\\b${term.replace(/[-_ ]/g, "[-_ ]").replace(/[.]/g, "\\.")}`, "i");
    const hits: TermCoverage["hits"] = {};
    const add = (src: CoverageSource, id: string) => ((hits[src] ??= []).length < 50 ? hits[src]!.push(id) : 0);

    for (const [name, entry] of [...Object.entries(store.catalog.services), ...Object.entries(store.catalog.resources)])
      if (re.test(`${name} ${JSON.stringify(entry)}`)) add("catalog", name);
    for (const a of store.alerts) if (re.test(`${a.service} ${a.title} ${a.note ?? ""}`)) add("alerts", a.id);
    for (const l of store.logs) if (re.test(`${l.service} ${l.message}`)) add("logs", l.id);
    for (const m of store.metrics) if (re.test(m.name.replace(/[._]/g, " ")) || re.test(m.service)) add("metrics", m.id);
    for (const d of store.deploys) if (re.test(`${d.service} ${d.summary}`)) add("changes", d.id);
    for (const c of store.configChanges) if (re.test(`${c.service} ${c.change} ${c.comment ?? ""}`)) add("changes", c.id);
    for (const u of store.list().filter((e) => e.kind === "user" && !excludeFollowUps.has(e.id)))
      if (re.test(String((u.raw as { text?: string })?.text ?? u.title))) add("follow-ups", u.id);

    return { term, kind, hits, covered: Object.keys(hits).length > 0 };
  });
  terms.push(...contextTerms(text, store));

  const components = terms.filter((t) => t.kind === "component");
  const judged = components.length ? components : terms; // no components named: judge on symptoms
  const uncovered = components.filter((t) => !t.covered).map((t) => t.term);
  const verdict: Coverage["verdict"] = judged.length === 0 || judged.every((t) => !t.covered) ? "none" : judged.every((t) => t.covered) ? "covered" : "partial";
  return { verdict, terms, uncovered, searched: SEARCHED };
}

const NEEDS: Record<string, string> = {
  kafka: "consumer lag metrics per consumer group, consumer group names, broker logs, and which services produce to or consume the affected topics",
  consumer: "consumer lag metrics per consumer group, consumer group names, broker logs, and which services produce to or consume the affected topics",
  broker: "broker logs and health metrics (under-replicated partitions, request latency), and the affected topics",
  rabbitmq: "queue depth and consumer counts per queue, broker logs, and the producing/consuming services",
  queue: "queue depth and consumer counts, broker logs, and the producing/consuming services",
  redis: "redis latency, memory and eviction metrics, connection counts, and which services use the instance",
  cache: "cache hit rate, latency and eviction metrics, and which services use the cache",
  dns: "resolution error rates and latency, the affected names, and recent DNS or resolver changes",
  cdn: "CDN error rates and cache hit ratio by region, and recent CDN configuration changes",
  login: "auth service error rates and logs, and the identity provider's status",
  auth: "auth service error rates and logs, and the identity provider's status",
};

/** What a responder could provide to make an uncovered component investigable. */
export function whatToProvide(term: string): string {
  return NEEDS[term] ?? `metrics, logs and alerts for ${term}, and which services depend on it`;
}

/** Plain text for the agent's first message. */
export function formatCoverage(c: Coverage): string {
  const src = (t: TermCoverage) =>
    t.covered
      ? Object.entries(t.hits)
          .map(([k, v]) => `${k}: ${v!.length}${v!.length && k !== "catalog" ? ` (e.g. ${v!.slice(0, 3).join(", ")})` : ""}`)
          .join("; ")
      : "NO EVIDENCE";
  const lines = [
    `## Coverage of the reported symptom (computed by code before you start)`,
    `Verdict: ${c.verdict.toUpperCase()}. Searched: ${c.searched.join(", ")}.`,
    ...c.terms.map((t) => `- "${t.term}" (${t.kind}): ${src(t)}`),
  ];
  if (c.uncovered.length)
    lines.push(
      `The report names ${c.uncovered.map((u) => `"${u}"`).join(", ")}, which appear nowhere in the available data. Say so first; do not answer with a different incident.`,
    );
  return lines.join("\n");
}
