/**
 * Route: "/_authenticated/insights"
 * Access: any authenticated user with at least one role (see _authenticated.tsx).
 * Purpose: rendered inside the "_authenticated" layout (sidebar/header shell).
 * Data dependencies: Data fetched via shared hooks/components used within the page (see imports).
 * Gotchas: this is a client-rendered SPA route (no server loader) — data is fetched on mount
 * via React Query/hooks, not via a TanStack Router `loader`.
 */
import { createFileRoute } from "@tanstack/react-router";
import InsightDashboard from "@/components/InsightDashboard";
import ReconciliationWidget from "@/components/ReconciliationWidget";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({ meta: [{ title: "Insights — DelayLens" }] }),
  component: DashboardPage,
});

/** Page component for "/_authenticated/insights". */
function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-6">
      <ReconciliationWidget />
      <InsightDashboard />
    </main>
  );
}
