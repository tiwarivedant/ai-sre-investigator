import type { KnowledgeDoc } from "@/lib/evidence/records";

/**
 * Plain BM25 over runbook / past-incident sections. The corpus is five short
 * markdown files; an embedding model and a vector DB would add latency, cost
 * and a dependency for no measurable gain at this size. Sections (split on
 * "##") are the unit of scoring so the returned snippet is the relevant part;
 * a document's score is its best section's score.
 */

interface Section {
  docId: string;
  docTitle: string;
  heading: string;
  text: string;
  tokens: string[];
}

export interface KnowledgeHit {
  id: string; // RB-... or INC-...
  title: string;
  score: number;
  section: string;
  snippet: string;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with not no do don t s".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class Bm25Index {
  private sections: Section[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(
    docs: KnowledgeDoc[],
    private k1 = 1.2,
    private b = 0.75,
  ) {
    for (const d of docs) {
      for (const [heading, body] of splitSections(d.text)) {
        // Title is prepended so doc-level terms ("connection exhaustion") count in every section.
        const text = `${d.title}\n${heading}\n${body}`;
        this.sections.push({ docId: d.id, docTitle: d.title, heading, text: body.trim(), tokens: tokenize(text) });
      }
    }
    for (const s of this.sections) for (const t of new Set(s.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.sections.reduce((a, s) => a + s.tokens.length, 0) / Math.max(1, this.sections.length);
  }

  search(query: string, k = 3): KnowledgeHit[] {
    const q = [...new Set(tokenize(query))];
    const N = this.sections.length;
    const best = new Map<string, KnowledgeHit>();
    for (const s of this.sections) {
      let score = 0;
      for (const term of q) {
        const tf = s.tokens.filter((t) => t === term).length;
        if (!tf) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * s.tokens.length) / this.avgLen));
      }
      if (score <= 0) continue;
      const prev = best.get(s.docId);
      if (!prev || score > prev.score) {
        best.set(s.docId, { id: s.docId, title: s.docTitle, score: Math.round(score * 100) / 100, section: s.heading, snippet: s.text.slice(0, 900) });
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }
}

function splitSections(md: string): [string, string][] {
  const out: [string, string][] = [];
  let heading = "(intro)";
  let buf: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^##+\s+(.*)$/);
    if (m) {
      if (buf.join("").trim()) out.push([heading, buf.join("\n")]);
      heading = m[1].trim();
      buf = [];
    } else if (!/^#\s/.test(line)) {
      buf.push(line);
    }
  }
  if (buf.join("").trim()) out.push([heading, buf.join("\n")]);
  return out;
}
