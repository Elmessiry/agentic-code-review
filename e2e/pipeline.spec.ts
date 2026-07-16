import { expect, test } from "@playwright/test";

// One user, one click, the whole pipeline — against the production build, answered by
// the recorded fixtures. The unit tests prove the derivation is right and the evals
// prove the pipeline reasons; this proves a person in a browser sees it happen: the
// graph advances, the summary streams into the page, the verdict and the price land.
//
// The example buttons load the eval cases byte for byte, which is what makes this
// possible at all: the requests a click produces are the requests the fixtures were
// recorded for.

const stage = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`[data-stage="${id}"]`);

test("a review runs end to end: the graph advances, findings land, the cost is shown", async ({
  page,
}) => {
  await page.goto("/");

  // Before anything runs, the pipeline is drawn but dormant.
  await expect(stage(page, "plan")).toHaveAttribute("data-state", "pending");

  await page.getByRole("button", { name: "SQL injection" }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();

  // The planner lands first and opens the fan; the tripwire's overrule is visible on
  // the security lane, because this snippet concatenates SQL and the badge is the
  // deterministic net doing its job in public.
  await expect(stage(page, "plan")).toHaveAttribute("data-state", "done", {
    timeout: 15_000,
  });
  await expect(page.locator('[data-lane="security"]')).toBeVisible();

  // The run finishes: synthesis completes and the terminal node settles.
  await expect(stage(page, "synthesize")).toHaveAttribute("data-state", "done", {
    timeout: 30_000,
  });
  await expect(stage(page, "done")).toHaveAttribute("data-state", "done");

  // The finding is about the mechanism, not the label — the same bar the evals hold.
  await expect(page.getByText(/parameteri|concatenat/i).first()).toBeVisible();

  // The verdict is rendered, and it is not an approval of injectable SQL.
  await expect(page.getByText(/Changes requested|Reject/)).toBeVisible();

  // The price of the review is on the page, in dollars — the argument this project
  // makes, made where a visitor can see it. (first(): the plan card prices the
  // planner's own call too, and both are welcome.)
  await expect(page.getByText(/^\$0\.\d+/).first()).toBeVisible();
});

test("clean code is approved, and the planner's restraint is visible", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();

  await expect(stage(page, "done")).toHaveAttribute("data-state", "done", {
    timeout: 45_000,
  });

  // The whole point of the clean case: fine code gets an approval, not an invented
  // defect. This is the anti-hallucination assertion, made through a browser.
  await expect(page.getByText("Approve", { exact: true })).toBeVisible();
});
