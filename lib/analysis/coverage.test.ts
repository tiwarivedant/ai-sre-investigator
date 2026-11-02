import { describe, expect, it } from "vitest";
import { loadEvidenceStore } from "@/lib/evidence/loader";
import { checkCoverage, formatCoverage, whatToProvide } from "./coverage";

const store = loadEvidenceStore();
const cov = (t: string) => checkCoverage(t, store);
const terms = (t: string) => cov(t).terms.map((x) => [x.term, x.kind, x.covered]);

describe("coverage check", () => {
  it("finds no evidence for a component the data never mentions (Kafka)", () => {
    const c = cov("Kafka consumers are lagging.");
    expect(c.verdict).toBe("none");
    expect(c.uncovered).toEqual(["kafka", "consumer"]);
    expect(terms("Kafka consumers are lagging.")).toEqual([
      ["kafka", "component", false],
      ["consumer", "component", false],
      ["lag", "symptom", false],
    ]);
    expect(formatCoverage(c)).toMatch(/Verdict: NONE[\s\S]*"kafka" \(component\): NO EVIDENCE[\s\S]*Say so first; do not answer with a different incident/);
  });

  it("covers the main checkout report", () => {
    const c = cov("Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.");
    expect(c.verdict).toBe("covered");
    const checkout = c.terms.find((t) => t.term === "checkout-service")!;
    expect(checkout.hits.alerts).toEqual(expect.arrayContaining(["ALR-007", "ALR-008"]));
    expect(checkout.hits.metrics).toEqual(expect.arrayContaining(["MET-checkout.error_rate_pct"]));
  });

  it("matches catalog names, symptoms by stem, and evidence-kind words", () => {
    expect(cov("orders-service is throwing 503s and the orders-db connection alert just went critical.").verdict).toBe("covered");
    expect(terms("Payments shipped v2.14.0 right before checkout started failing. Is it the deploy?")).toEqual([
      ["checkout-service", "component", true],
      ["payments-service", "component", true],
      ["fail", "symptom", true],
      ["deploy", "symptom", true],
    ]);
  });

  it("is partial when only some named components have evidence", () => {
    const c = cov("Redis latency is high and checkout is timing out");
    expect(c.verdict).toBe("partial");
    expect(c.uncovered).toEqual(["redis"]);
  });

  it("counts follow-up evidence a human pasted", () => {
    const s = loadEvidenceStore();
    s.addUserEvidence("Kafka consumer group orders-events lag is 2M messages, broker-3 logs show ISR shrink");
    const c = checkCoverage("Kafka consumers are lagging.", s);
    expect(c.terms.find((t) => t.term === "kafka")!.hits["follow-ups"]).toEqual(["USER-001"]);
    expect(c.verdict).toBe("covered");
  });

  it("suggests what to provide", () => {
    expect(whatToProvide("kafka")).toMatch(/consumer lag metrics.*consumer group names.*broker logs/);
    expect(whatToProvide("vault")).toBe("metrics, logs and alerts for vault, and which services depend on it");
  });
});
