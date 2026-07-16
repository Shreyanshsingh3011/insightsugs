import { createFileRoute } from "@tanstack/react-router";
import InsightDashboard from "@/components/InsightDashboard";
import ReconciliationWidget from "@/components/ReconciliationWidget";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({ meta: [{ title: "Insights — DelayLens" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-6">
      <ReconciliationWidget />
      <InsightDashboard />
    </main>
  );
}
