import { describe, expect, it } from "vitest";
import { cleanFollowUp, revisionLabel } from "./text";

describe("cleanFollowUp", () => {
  it("trims stray wrapping quotes and whitespace", () => {
    expect(cleanFollowUp("'Marcus confirms he changed the pool.'")).toBe("Marcus confirms he changed the pool.");
    expect(cleanFollowUp('  "Reverted at 14:35"  ')).toBe("Reverted at 14:35");
    expect(cleanFollowUp("“Stable for 30 minutes”")).toBe("Stable for 30 minutes");
    expect(cleanFollowUp(`"'double wrapped'"`)).toBe("double wrapped");
  });

  it("drops a lone quote left at either end", () => {
    expect(cleanFollowUp("Marcus confirms he changed DB_POOL_MAX from 20 to 80 at 13:52.”")).toBe("Marcus confirms he changed DB_POOL_MAX from 20 to 80 at 13:52.");
    expect(cleanFollowUp("“Reverted at 14:35")).toBe("Reverted at 14:35");
    expect(cleanFollowUp("'Reverted at 14:35")).toBe("Reverted at 14:35");
  });

  it("leaves inner quotes and apostrophes alone", () => {
    expect(cleanFollowUp('Support says "charged but no order" is resolved')).toBe('Support says "charged but no order" is resolved');
    expect(cleanFollowUp("Marcus's change")).toBe("Marcus's change");
    expect(cleanFollowUp('Support quoted "charged but no order"')).toBe('Support quoted "charged but no order"');
    expect(cleanFollowUp("the engineers’")).toBe("the engineers’");
  });
});

describe("revisionLabel", () => {
  it("drops the wrapping quotes older saved labels had", () => {
    expect(revisionLabel('follow-up USER-001: "Marcus confirms he changed DB_POOL_MAX."')).toBe("follow-up USER-001: Marcus confirms he changed DB_POOL_MAX.");
    expect(revisionLabel("follow-up USER-002: Reverted at 14:35")).toBe("follow-up USER-002: Reverted at 14:35");
  });
});
