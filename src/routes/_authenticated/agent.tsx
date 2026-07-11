import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import AgentDashboard from "@/components/AgentDashboard";
import AutonomousAgentsPanel from "@/components/AutonomousAgentsPanel";

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
