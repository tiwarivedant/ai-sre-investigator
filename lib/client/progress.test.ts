import { describe, expect, it } from "vitest";
import { runReadout } from "./progress";

const step = (n: number) => ({ step: n, thought: "", ms: 0 });

describe("runReadout", () => {
  it("counts the in-flight turn while running", () => {
    expect(runReadout([], { startedAt: 0, baseStep: 0, maxTurns: 10 }, true, 3_400)).toEqual({ turn: 1, maxTurns: 10, elapsedS: 3 });
    expect(runReadout([step(1), step(1), step(2)], { startedAt: 0, baseStep: 0, maxTurns: 10 }, true, 12_000).turn).toBe(3);
  });

  it("counts follow-up turns from the run's base step, against the follow-up budget", () => {
    const prior = [step(1), step(2), step(3), step(4)];
    expect(runReadout(prior, { startedAt: 0, baseStep: 4, maxTurns: 5 }, true, 1_000).turn).toBe(1);
    expect(runReadout([...prior, step(5)], { startedAt: 0, baseStep: 4, maxTurns: 5 }, true, 1_000).turn).toBe(2);
  });

  it("never shows more turns than the budget", () => {
    const many = Array.from({ length: 12 }, (_, i) => step(i + 1));
    expect(runReadout(many, { startedAt: 0, baseStep: 0, maxTurns: 10 }, true, 0).turn).toBe(10);
  });
});
