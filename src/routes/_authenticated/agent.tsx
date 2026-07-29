/**
 * Route: "/_authenticated/agent"
 * Access: any authenticated user with at least one role (see _authenticated.tsx).
 * Purpose: rendered inside the "_authenticated" layout (sidebar/header shell).
 * Data dependencies: Data fetched via shared hooks/components used within the page (see imports).
 * Gotchas: this is a client-rendered SPA route (no server loader) — data is fetched on mount
 * via React Query/hooks, not via a TanStack Router `loader`.
 */
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import AgentDashboard from "@/components/AgentDashboard";
import AutonomousAgentsPanel from "@/components/AutonomousAgentsPanel";

/** Page component for "/_authenticated/agent". */
function AgentRoute() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isAgentIndex = pathname === "/agent" || pathname === "/agent/";

  return (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      {isAgentIndex ? (
        <>
          <AutonomousAgentsPanel />
          <AgentDashboard />
        </>
      ) : (
        <Outlet />
      )}
    </main>
  );
}

export const Route = createFileRoute("/_authenticated/agent")({
  head: () => ({ meta: [{ title: "Agent Dashboard — DelayLens" }] }),
  component: AgentRoute,
});
