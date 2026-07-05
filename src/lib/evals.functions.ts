// Server functions for the evaluation harness (Step 6).
// AI SDK deps are lazy-loaded inside the runEvalSuite handler to keep the
// SSR bundle small.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type EvalCase = {
  id: string;
  name: string;
  prompt: string;
  expected_tool: string | null;
  expected_substring: string | null;
  tags: string[] | null;
  active: boolean;
  created_at: string;
};

export type EvalRun = {
  id: string;
  case_id: string;
  passed: boolean;
  tool_called: string | null;
  output: string | null;
  error: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
};

export const listEvalCases = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("eval_cases")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as EvalCase[];
  });

export const listRecentEvalRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("eval_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as EvalRun[];
  });

export const createEvalCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { name: string; prompt: string; expected_tool?: string; expected_substring?: string }) => ({
    name: z.string().min(1).max(120).parse(raw.name),
    prompt: z.string().min(1).max(1000).parse(raw.prompt),
    expected_tool: raw.expected_tool?.slice(0, 60) || null,
    expected_substring: raw.expected_substring?.slice(0, 200) || null,
  }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("eval_cases").insert({
      owner_id: context.userId,
      name: data.name,
      prompt: data.prompt,
      expected_tool: data.expected_tool,
      expected_substring: data.expected_substring,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteEvalCase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string }) => ({ id: z.string().uuid().parse(raw.id) }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("eval_cases").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Runs the golden set against the same model+prompt the chat uses, with
// stubbed no-op tools so we can check tool-selection correctness cheaply.
export const runEvalSuite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");
    const { data: cases, error } = await context.supabase
      .from("eval_cases")
      .select("*")
      .eq("active", true);
    if (error) throw new Error(error.message);
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const stubTools = [
      "getDashboardSummary",
      "getPersonWorkload",
      "topDelays",
      "filterActivities",
      "getOpenAlerts",
      "proposeCreateAlert",
      "proposeNudgeAssignee",
      "rememberFact",
    ];

    const results: Array<{ case_id: string; passed: boolean; tool_called: string | null }> = [];

    for (const c of cases ?? []) {
      const called: string[] = [];
      const tools = Object.fromEntries(
        stubTools.map((name) => [
          name,
          tool({
            description: `stub for ${name}`,
            inputSchema: z.object({}).passthrough(),
            execute: async (input: unknown) => {
              called.push(name);
              return { stub: true, input };
            },
          }),
        ]),
      );

      const t0 = Date.now();
      let passed = false;
      let output = "";
      let errStr: string | null = null;
      let tokensIn: number | null = null;
      let tokensOut: number | null = null;
      try {
        const res = await generateText({
          model,
          system:
            "You are an eval harness runner. Choose the single most appropriate tool to answer the user, then give a short answer. Prefer calling one tool over none.",
          prompt: c.prompt,
          tools,
          stopWhen: stepCountIs(3),
        });
        output = res.text ?? "";
        tokensIn = res.usage?.inputTokens ?? null;
        tokensOut = res.usage?.outputTokens ?? null;
        const toolOK = c.expected_tool ? called.includes(c.expected_tool) : true;
        const substrOK = c.expected_substring
          ? output.toLowerCase().includes(c.expected_substring.toLowerCase())
          : true;
        passed = toolOK && substrOK;
      } catch (e) {
        errStr = e instanceof Error ? e.message : String(e);
      }

      await context.supabase.from("eval_runs").insert({
        case_id: c.id,
        actor_id: context.userId,
        passed,
        tool_called: called[0] ?? null,
        output: output.slice(0, 2000),
        error: errStr,
        latency_ms: Date.now() - t0,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      });
      results.push({ case_id: c.id, passed, tool_called: called[0] ?? null });
    }

    const passedCount = results.filter((r) => r.passed).length;
    return { total: results.length, passed: passedCount, results };
  });
