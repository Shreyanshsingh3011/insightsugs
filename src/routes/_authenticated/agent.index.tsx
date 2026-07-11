import { createFileRoute } from "@tanstack/react-router";
import AgentDashboard from "@/components/AgentDashboard";
import AutonomousAgentsPanel from "@/components/AutonomousAgentsPanel";

function AgentIndex() {
  return (
    <>
      <AutonomousAgentsPanel />
      <AgentDashboard />
    </>
  );
}

export const Route = createFileRoute("/_authenticated/agent/")({
  head: () => ({ meta: [{ title: "Agent Dashboard — DelayLens" }] }),
  component: AgentIndex,
});
