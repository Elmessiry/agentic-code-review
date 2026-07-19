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

// The mock upstream this suite talks to instead of OpenRouter (see e2e/mock-upstream.ts)
// also answers a control endpoint that forces one specialist's call to fail, so the
// failure path below is a real dead specialist rather than a fixture forged by hand.
const MOCK_UPSTREAM = "http://localhost:8787";

function poison(specialist: string): Promise<Response> {
  return fetch(`${MOCK_UPSTREAM}/__poison`, {
    method: "POST",
    body: JSON.stringify({ specialist }),
  });
}

function unpoison(): Promise<Response> {
  return fetch(`${MOCK_UPSTREAM}/__poison`, { method: "POST", body: "{}" });
}

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
  // planner's own call too, and both are welcome.) The regex alone would also match
  // $0.00000, so the number itself is parsed and checked for being real money.
  const priceText = await page
    .getByText(/^\$0\.\d+/)
    .first()
    .textContent();
  expect(Number(priceText?.slice(1))).toBeGreaterThan(0);
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

test("a dead specialist does not take the review down: it fails visibly, and the merge fallback ships a verdict", async ({
  page,
}) => {
  // The conflict case is the one with two specialists (security and performance) on
  // the same line — poisoning one leaves the other to actually finish, which is what
  // makes the rest of this test possible: a review where every specialist died never
  // reaches synthesis at all (see runSynthesis's `fan.results.length === 0` guard in
  // lib/pipeline/review.ts).
  await poison("security");

  try {
    await page.goto("/");

    await page.getByRole("button", { name: "Conflict", exact: true }).click();
    await page.getByRole("button", { name: "Review", exact: true }).click();

    // The specialist-failure state, on the page: the security lane settles on
    // "failed" rather than sitting on "running" forever or vanishing.
    await expect(page.locator('[data-lane="security"]')).toHaveAttribute(
      "data-state",
      "failed",
      { timeout: 15_000 },
    );

    // The run still finishes. A dead specialist's brief also changes the synthesizer's
    // own request (it now names a gap that the recording never saw), so that call
    // misses its fixture too — which pushes the review down the SAME fallback the
    // synthesizer's own death would: the deterministic merge in lib/pipeline/merge.ts.
    await expect(stage(page, "done")).toHaveAttribute("data-state", "done", {
      timeout: 30_000,
    });

    // The fallback says out loud that it is a fallback, rather than passing off a
    // mechanical merge as a model's judgement.
    await expect(page.getByText(/merged mechanically/i)).toBeVisible();

    // And a verdict — degraded, but a verdict, not a blank page.
    await expect(page.getByText(/Approve|Changes requested|Reject/)).toBeVisible();
  } finally {
    await unpoison();
  }
});
