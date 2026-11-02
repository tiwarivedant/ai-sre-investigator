import type { LogRecord } from "@/lib/evidence/records";

export interface LogPattern {
  service: string;
  level: string;
  pattern: string; // message with numbers masked
  count: number;
  first: string;
  last: string;
  sampleIds: string[];
}

const ROUTINE_LEVELS = new Set(["INFO", "DEBUG"]);

/** Collapse non-routine log lines into patterns so 140 lines become a dozen rows. */
export function digestLogs(logs: LogRecord[], maxSamples = 3): LogPattern[] {
  const byKey = new Map<string, LogPattern>();
  for (const l of logs) {
    if (ROUTINE_LEVELS.has(l.level)) continue;
    const pattern = maskNumbers(l.message);
    const key = `${l.service}|${l.level}|${pattern}`;
    let p = byKey.get(key);
    if (!p) {
      p = { service: l.service, level: l.level, pattern, count: 0, first: l.timestamp, last: l.timestamp, sampleIds: [] };
      byKey.set(key, p);
    }
    p.count++;
    if (l.timestamp < p.first) p.first = l.timestamp;
    if (l.timestamp > p.last) p.last = l.timestamp;
    if (p.sampleIds.length < maxSamples) p.sampleIds.push(l.id);
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));
}

export function maskNumbers(msg: string): string {
  // Mask standalone numbers and numbers with units ("3000ms", "86%"), but keep identifiers like "3DS2" or "/v1/".
  return msg.replace(/(?<![A-Za-z])\d+(\.\d+)?(?=ms\b|s\b|%|\b)/g, "N");
}
