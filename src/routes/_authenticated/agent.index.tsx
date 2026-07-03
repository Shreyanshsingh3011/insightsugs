import { createFileRoute } from "@tanstack/react-router";
import AgentDashboard from "@/components/AgentDashboard";

export const Route = createFileRoute("/_authenticated/agent/")({
  head: () => ({ meta: [{ title: "Agent Dashboard — DelayLens" }] }),
  component: AgentDashboard,
});
