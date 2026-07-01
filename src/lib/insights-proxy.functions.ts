import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({
  url: z.string().url().max(3000),
});

function assertSafePublicUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const isLocalPublicApi = url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1") && url.pathname.startsWith("/api/public/");
  if (url.protocol !== "https:" && !isLocalPublicApi) throw new Error("Only https links are supported.");
  if (isLocalPublicApi) return url;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Only public analytics links are supported.");
  }
  return url;
}

export const fetchInsightUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const url = assertSafePublicUrl(data.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Source did not return JSON.");
      }
      const payload = await res.json();
      return { payload, fetchedAt: Date.now(), url: url.toString() };
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        throw new Error("Source timed out while loading analytics data.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });