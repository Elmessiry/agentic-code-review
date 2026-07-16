import { defineConfig, devices } from "@playwright/test";

// The e2e tests drive the PRODUCTION build, not the dev server. Dev mode compiles
// routes on first hit and papers over build-only failures; the thing being tested is
// the thing being deployed or the test is theatre.
//
// Two servers, because the interception has to happen between processes: the Next
// server's model calls are redirected (OPENROUTER_URL) to a local mock that answers
// with the recorded eval fixtures. No test here spends money or depends on a model
// being in a good mood — nondeterminism belongs to the nightly live evals, not to a
// suite that gates merges.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: "node --import tsx e2e/mock-upstream.ts",
      port: 8787,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run build && npm run start",
      port: 3000,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        OPENROUTER_URL: "http://localhost:8787",
        // Read inside the request handler and sent only to the mock. The value is
        // never checked by anything; it exists because the handler refuses to run
        // without one, and that refusal is correct in production.
        OPENROUTER_API_KEY: "e2e-fixture-replay",
        // Pinned empty, not merely omitted: `next start` loads .env.local, so a
        // developer who put real Upstash credentials there (the deploy setup says to)
        // would otherwise run these tests against the PRODUCTION counters — every
        // local run writing fixture costs into the real spend key and marching the
        // real rate limit toward 429. Empty is falsy, so the guards stand aside.
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
      },
    },
  ],
});
