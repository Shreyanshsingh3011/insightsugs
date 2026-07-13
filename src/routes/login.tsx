import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { useSession } from "@/hooks/useSession";

type RequestedRole = "super_admin" | "admin" | "user";

function consumePostLoginPath(fallback = "/agent") {
  if (typeof window === "undefined") return fallback;
  const saved = window.sessionStorage.getItem("postLoginPath");
  if (saved) window.sessionStorage.removeItem("postLoginPath");
  if (!saved || !saved.startsWith("/") || saved.startsWith("//") || saved.startsWith("/login")) {
    return fallback;
  }
  return saved;
}

function ensurePostLoginPath(fallback = "/agent") {
  if (typeof window === "undefined") return;
  const saved = window.sessionStorage.getItem("postLoginPath");
  if (!saved || !saved.startsWith("/") || saved.startsWith("//") || saved.startsWith("/login")) {
    window.sessionStorage.setItem("postLoginPath", fallback);
  }
}

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — DelayLens" }] }),
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const { session } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [requestedRole, setRequestedRole] = useState<RequestedRole>("user");
  const [busy, setBusy] = useState(false);


  useEffect(() => {
    if (session) router.navigate({ to: consumePostLoginPath() as never, replace: true });
  }, [session, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) router.navigate({ to: consumePostLoginPath() as never, replace: true });
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/insights`,
            data: { full_name: fullName, requested_role: requestedRole },
          },
        });
        if (error) throw error;
        toast.success(`Account created as ${requestedRole.replace("_", " ")}. Check your email to confirm.`);

      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    try {
      const { lovable } = await import("@/integrations/lovable");
      ensurePostLoginPath();
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
        extraParams: {
          prompt: "select_account",
          ...(email ? { login_hint: email } : {}),
        },
      });
      if (result.redirected) return;
      if (result.error) {
        toast.error(result.error instanceof Error ? result.error.message : "Google sign-in failed");
        return;
      }
      const { data } = await supabase.auth.getSession();
      if (data.session) router.navigate({ to: consumePostLoginPath() as never, replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md p-8">
        <h1 className="text-2xl font-semibold tracking-tight">DelayLens</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signin" ? "Sign in to your account" : "Create an account"}
        </p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          {mode === "signup" && (
            <Input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          )}
          {mode === "signup" && (
            <Select value={requestedRole} onValueChange={(v) => setRequestedRole(v as RequestedRole)}>
              <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="super_admin">Super admin</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
          )}

          <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={1} />
          <Button type="submit" className="w-full" disabled={busy}>
            {mode === "signin" ? "Sign in" : "Sign up"}
          </Button>
        </form>
        <Button variant="outline" className="mt-3 w-full" onClick={google}>
          Continue with Google
        </Button>
        <button
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>
      </Card>
    </div>
  );
}
