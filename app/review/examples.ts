import clean from "@/evals/cases/clean.json";
import sqlInjection from "@/evals/cases/sql-injection.json";
import conflict from "@/evals/cases/conflict.json";

// The starter snippets, taken straight from the eval cases so the code a visitor runs is
// the same code the suite grades the pipeline on. Each lands on a different outcome: a
// clean file that should draw zero high-severity findings, a single unambiguous defect,
// and one line two specialists flag through different lenses — the case the synthesizer
// exists for.
export type Example = { id: string; label: string; code: string };

export const EXAMPLES: Example[] = [
  { id: "clean", label: "Clean", code: clean.code },
  { id: "sql-injection", label: "SQL injection", code: sqlInjection.code },
  { id: "conflict", label: "Conflict", code: conflict.code },
];
