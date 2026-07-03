import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/agent")({
  head: () => ({ meta: [{ title: "Agent Dashboard — DelayLens" }] }),
  component: () => (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      <Outlet />
    </main>
  ),
});
