import type { ServiceCatalog } from "@/lib/evidence/records";

/** Everything `name` calls, directly or transitively (services and resources). */
export function downstream(catalog: ServiceCatalog, name: string): Set<string> {
  const seen = new Set<string>();
  const walk = (n: string) => {
    for (const d of catalog.services[n]?.depends_on ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(name);
  return seen;
}

/** Everything that calls `name`, directly or transitively. */
export function upstream(catalog: ServiceCatalog, name: string): Set<string> {
  const seen = new Set<string>();
  const walk = (n: string) => {
    for (const [svc, entry] of Object.entries(catalog.services)) {
      if (!entry.depends_on?.includes(n) || seen.has(svc)) continue;
      seen.add(svc);
      walk(svc);
    }
  };
  walk(name);
  return seen;
}

/** Services that share a resource (e.g. a database) with `name` or with anything it depends on. */
export function resourceNeighbours(catalog: ServiceCatalog, name: string): Set<string> {
  const out = new Set<string>();
  const touched = new Set([name, ...downstream(catalog, name)]);
  for (const [res, entry] of Object.entries(catalog.resources)) {
    if (!touched.has(res)) continue;
    for (const s of entry.shared_by ?? []) if (s !== name) out.add(s);
  }
  return out;
}

/**
 * Services whose health could plausibly affect, or be affected by, the focus
 * services: their dependencies, their callers, and anything sharing a resource
 * with that dependency tree.
 */
export function blastRadius(catalog: ServiceCatalog, focus: string[]): Set<string> {
  const out = new Set<string>(focus);
  for (const f of focus) {
    for (const s of downstream(catalog, f)) out.add(s);
    for (const s of upstream(catalog, f)) out.add(s);
  }
  for (const s of [...out]) for (const n of resourceNeighbours(catalog, s)) out.add(n);
  return out;
}

export function isKnown(catalog: ServiceCatalog, name: string): boolean {
  return name in catalog.services || name in catalog.resources;
}
