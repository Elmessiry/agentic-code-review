# Agentic Code Review Pipeline

**Paste code, get a review from a team of AI specialists instead of one generalist.** A planner routes the work, specialists run in parallel, and a synthesizer resolves their disagreements into one verdict — with an eval harness that proves it behaves.

> **Status: scaffolding.** Nothing is built yet. This README is a placeholder; it gets replaced with the real one (architecture diagram, ADRs, live link, model matrix) when the pipeline lands.

**Stack:** Next.js · TypeScript · OpenRouter (multi-vendor) · Vercel

## Planned architecture

```
POST /api/review  (one SSE stream, server orchestrates)

  guard      input cap → per-IP rate limit → daily spend cap (real $)
  tripwire   regex pre-pass → forces specialists on, never off
  plan       which specialists are relevant, and why
  specialists  Security · Performance · Readability · Test Coverage — in parallel
  synthesize   resolve conflicts, dedupe, rank, stream the verdict
```

## Why it exists

Projects [1](https://github.com/Elmessiry/AI-Doc-Assistant) and [2](https://github.com/Elmessiry/github-dev-dashboard) prove I can build. This one is about designing an AI *system*: routing work between agents, handling the case where one of them fails, and — the part most AI demos skip — having a way to know when the model is wrong.
