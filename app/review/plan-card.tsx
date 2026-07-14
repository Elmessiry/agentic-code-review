"use client";

import { SPECIALIST_LABELS, type Plan, type Specialist } from "@/lib/pipeline/schema";

// The planner's decision, shown before any specialist runs.
//
// The skipped list is not a detail — it is the evidence. A planner that quietly
// drops two of four specialists and shows no working is indistinguishable from a
// planner that does nothing, and the user has no way to tell whether it just saved
// them money or lost them a vulnerability. So it shows what it skipped, why, and —
// when the tripwire overruled it — who won.

export type PlanResult = Plan & {
  overrides: Record<string, string>;
  costUsd: number;
};

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "run" | "skip" | "forced";
}) {
  const tones = {
    run: "border-accent/40 bg-accent/10 text-ink",
    skip: "border-border bg-transparent text-muted line-through",
    forced: "border-high/50 bg-high/10 text-ink",
  };
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export default function PlanCard({ plan }: { plan: PlanResult }) {
  const wasForced = (s: Specialist) => plan.forced.includes(s);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Planner
        </h3>
        <span className="text-xs text-muted">${plan.costUsd.toFixed(6)}</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {plan.agents.map((s) => (
          <Pill key={s} tone={wasForced(s) ? "forced" : "run"}>
            {SPECIALIST_LABELS[s]}
            {wasForced(s) && " — forced"}
          </Pill>
        ))}
        {plan.skipped.map((s) => (
          <Pill key={s} tone="skip">
            {SPECIALIST_LABELS[s]}
          </Pill>
        ))}
      </div>

      <p className="text-sm leading-relaxed text-muted">{plan.reasoning}</p>

      {plan.forced.length > 0 && (
        // The planner is overruled here, so say so plainly. This is the moment the
        // design earns itself: a regex saw something the model talked itself out of.
        <div className="mt-3 rounded-md border border-high/30 bg-high/5 p-3">
          <p className="text-xs font-medium text-high">Planner overruled</p>
          <ul className="mt-1.5 space-y-1">
            {plan.forced.map((s) => (
              <li key={s} className="text-xs text-muted">
                <span className="text-ink">{SPECIALIST_LABELS[s]}</span> runs anyway — the
                code {plan.overrides[s]}.
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
