import { createFileRoute } from "@tanstack/react-router";
import InsightDashboard from "@/components/InsightDashboard";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({ meta: [{ title: "Insights — DelayLens" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      <InsightDashboard />
    </main>
  );
}
