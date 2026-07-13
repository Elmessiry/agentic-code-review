import ReviewPanel from "./review/review-panel";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Agentic Code Review</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          A planner decides which specialists a snippet needs, they review it in parallel,
          and a synthesizer resolves their disagreements into one verdict.
        </p>
      </header>

      <ReviewPanel />
    </main>
  );
}
