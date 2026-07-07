import { createFileRoute } from "@tanstack/react-router";
import { useIsAdmin } from "@/hooks/useSession";
import { EmailQueuePanel } from "@/components/EmailQueuePanel";

export const Route = createFileRoute("/_authenticated/admin/email")({
  head: () => ({ meta: [{ title: "Email queue & delivery — DelayLens" }] }),
  component: EmailAdminPage,
});

function EmailAdminPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">
        Admins only.
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email queue &amp; delivery</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monitor outbound email health, retries, and dead-letter items.
        </p>
      </div>
      <EmailQueuePanel />
    </div>
  );
}
