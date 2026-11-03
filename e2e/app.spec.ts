import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

// Drives the real UI in replay mode (recorded model turns, real tools and code).
const fixture = JSON.parse(fs.readFileSync("fixtures/inc-2213.json", "utf8"));
const INCIDENT: string = fixture.incidentInput;
const FOLLOW_UPS: string[] = fixture.runs.filter((r: { kind: string }) => r.kind === "followup").map((r: { message: string }) => r.message);

const stepper = (page: Page) => page.getByRole("list", { name: "Incident status" });
const followUpInput = (page: Page) => page.locator("#followup");
const runPill = (page: Page) => page.getByTestId("run-pill");

async function waitForRunToFinish(page: Page) {
  await expect(runPill(page)).toBeHidden({ timeout: 30_000 });
  await expect(followUpInput(page)).toBeEnabled();
}

test.describe.serial("investigation lifecycle (replay)", () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => page.close());

  test("empty state offers the recorded sample and the read-only samples", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "What are responders seeing?" })).toBeVisible();
    await expect(page.getByText("Recorded sample (replay mode)")).toBeVisible();
    await expect(page.getByRole("button", { name: INCIDENT, exact: true })).toBeVisible();
    await expect(page.locator("main").getByText("Sample", { exact: true })).toHaveCount(5);
  });

  test("a non-matching prompt shows the replay notice instead of running", async () => {
    await page.locator("#incident").fill("The database is down");
    await page.getByRole("button", { name: "Run investigation" }).click();
    await expect(page.getByText(/Replay mode only includes the recorded sample incident \(INC-2213\)/)).toBeVisible();
    await page.getByRole("button", { name: "Load sample incident" }).click();
    await expect(page.locator("#incident")).toHaveValue(INCIDENT);
  });

  test("running state: live pill, plain-language step, skeletons, input disabled; then a brief", async () => {
    await page.getByRole("button", { name: "Run investigation" }).click();
    await expect(runPill(page)).toBeVisible();
    await expect(runPill(page)).toContainText(/Investigating · Turn \d+\/10 · \d+s/);
    await expect(page.getByTestId("run-activity")).not.toHaveText("");
    await expect(page.getByTestId("brief-skeleton")).toBeVisible();
    await expect(followUpInput(page)).toBeDisabled();
    await expect(followUpInput(page)).toHaveAttribute("placeholder", /The agent is working/);

    await waitForRunToFinish(page);
    await expect(page.getByText("Likely cause", { exact: true })).toBeVisible();
    await expect(stepper(page)).toContainText("Investigating");
    await expect(page.getByTestId("brief-skeleton")).toBeHidden();
  });

  test("a non-matching follow-up shows the replay notice", async () => {
    await followUpInput(page).fill("The DB was restarted");
    await page.getByRole("button", { name: "Send follow-up" }).click();
    await expect(page.getByText(/Replay mode only includes the recorded follow-up/)).toBeVisible();
  });

  test("the owner's confirmation moves the incident to Identified", async () => {
    await followUpInput(page).fill(FOLLOW_UPS[0]);
    await page.getByRole("button", { name: "Send follow-up" }).click();
    await expect(runPill(page)).toContainText(/Following up · Turn \d+\/5/);
    await waitForRunToFinish(page);
    await expect(stepper(page).getByText("per")).toHaveCount(1); // Identified · per USER-001
    await expect(page.getByText(/^What changed$/i)).toBeVisible();
  });

  test("Add note records evidence without running the agent", async () => {
    const turns = await page.getByText(/^Turn \d+$/).count();
    await followUpInput(page).fill("Support is refunding the duplicate holds.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.locator("section").filter({ hasText: "Revisions" }).getByText(/note USER-002/)).toBeVisible();
    await expect(page.getByText(/Support is refunding the duplicate holds/).first()).toBeVisible();
    await expect(runPill(page)).toBeHidden();
    expect(await page.getByText(/^Turn \d+$/).count()).toBe(turns); // no new agent turns
  });

  test("Resolve warns when recovery isn't verified and requires a comment", async () => {
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toContainText("Recovery hasn't been verified (status: identified)");
    await dialog.getByRole("button", { name: "Resolve anyway" }).click();
    await expect(dialog.getByText("A resolution comment is required.")).toBeVisible();
    await dialog.getByLabel("Resolution comment (required)").fill("Reverted the pool; closing early.");
    await dialog.getByRole("button", { name: "Resolve anyway" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Cause", { exact: true })).toBeVisible();
    await expect(stepper(page)).toContainText("Resolved");
    await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  });

  test("Reopen returns the incident to its previous status", async () => {
    await page.getByRole("button", { name: "Reopen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Why is it being reopened/).fill("Errors are back.");
    await dialog.getByRole("button", { name: "Reopen" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    await expect(page.locator("section").filter({ hasText: "Revisions" }).getByText(/incident resolved -> identified/)).toBeVisible();
  });

  test("Stop ends a run and keeps the partial brief", async () => {
    await page.getByRole("button", { name: "New investigation" }).click();
    await page.getByRole("button", { name: INCIDENT, exact: true }).click();
    await page.getByRole("button", { name: "Run investigation" }).click();
    await expect(runPill(page)).toBeVisible();
    await runPill(page).getByRole("button", { name: "Stop" }).click();
    await waitForRunToFinish(page);
    await expect(page.getByText("Stopped by the responder; showing the brief so far.").first()).toBeVisible();
    await expect(page.locator("section").filter({ hasText: "Summary" }).first()).toBeVisible();
  });

  test("the Recent list puts open incidents first, with counts and status badges", async () => {
    await page.getByRole("button", { name: /^Investigations/ }).click();
    const menu = page.locator("div.absolute").filter({ hasText: "Recent" }).first();
    await expect(menu.getByTestId("open-count")).toHaveText(/^\d+ open · \d+ resolved$/);
    await expect(menu.getByText(/open \d+[smhd]/).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("samples are read-only", async () => {
    await page.getByRole("button", { name: /^Investigations/ }).click();
    await page.getByRole("button", { name: /Customers are seeing errors at checkout[\s\S]*Sample/ }).first().click();
    await expect(page.getByText("Samples are read-only. Run your own investigation to send follow-ups.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add note" })).toHaveCount(0);
  });
});
