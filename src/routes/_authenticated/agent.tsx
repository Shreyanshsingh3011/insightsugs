import { createFileRoute } from "@tanstack/react-router";
import AgentDashboard from "@/components/AgentDashboard";

export const Route = createFileRoute("/_authenticated/agent")({
  head: () => ({ meta: [{ title: "Agent Dashboard — DelayLens" }] }),
  component: () => (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      <AgentDashboard />
    </main>
  ),
});
