import { createFileRoute } from "@tanstack/react-router";
import InsightDashboard from "@/components/InsightDashboard";

const API_BASE = "https://delaybridgesugs-shreyanshsingh3011s-projects.vercel.app";
const TOKEN = "9GliQ2Xi1efsanO7t9LuTyvi21_QR83H";

export const Route = createFileRoute("/_authenticated/insights")({
  component: InsightsPage,
});

function InsightsPage() {
  return (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      <InsightDashboard apiBase={API_BASE} token={TOKEN} />
    </main>
  );
}
