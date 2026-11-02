import { describe, expect, it } from "vitest";
import { expectedFollowUp, fixtureLabel, matchesRecordedIncident, replayFollowUpMessage, replayMismatchMessage } from "./replayGuard";

const recorded = "Customers are seeing errors at checkout and the site feels slow. Started maybe 15–20 min ago.";

describe("replay guard", () => {
  it("accepts the recorded text modulo case and whitespace", () => {
    expect(matchesRecordedIncident(recorded, recorded)).toBe(true);
    expect(matchesRecordedIncident(`  ${recorded.toUpperCase().replace(/ /g, "\n ")}  `, recorded)).toBe(true);
  });

  it("rejects anything else, including small edits", () => {
    expect(matchesRecordedIncident("The database is down", recorded)).toBe(false);
    expect(matchesRecordedIncident(recorded.replace("15–20", "30"), recorded)).toBe(false);
    expect(matchesRecordedIncident("", recorded)).toBe(false);
  });

  it("names the sample in the notice", () => {
    expect(replayMismatchMessage(fixtureLabel("inc-2213"))).toBe(
      "Replay mode only includes the recorded sample incident (INC-2213). Set an API key and turn off REPLAY to investigate other prompts.",
    );
  });
});

describe("replay follow-up guard", () => {
  const recordedFollowUps = ["Marcus confirms he changed the pool"];

  it("expects the recorded follow-ups in order, then none", () => {
    expect(expectedFollowUp(recordedFollowUps, 0)).toBe("Marcus confirms he changed the pool");
    expect(expectedFollowUp(recordedFollowUps, 1)).toBeNull();
  });

  it("explains what can be sent, or that nothing is left", () => {
    expect(replayFollowUpMessage("INC-2213", "Marcus confirms he changed the pool")).toBe(
      'Replay mode only includes the recorded follow-up for the sample incident (INC-2213): "Marcus confirms he changed the pool". Set an API key and turn off REPLAY to send other follow-ups.',
    );
    expect(replayFollowUpMessage("INC-2213", null)).toMatch(/no more recorded follow-ups/);
  });
});
