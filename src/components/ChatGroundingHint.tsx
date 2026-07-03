import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Quote } from "lucide-react";

/**
 * Static hint panel for the Copilot / chatbot experience.
 * Lists the dashboard data surfaces the assistant is grounded on and
 * reminds the user that every answer must include citations.
 *
 * Keep in sync with GROUNDING_RULES in src/lib/gemini-client.ts.
 */
export function ChatGroundingHint({ compact = false }: { compact?: boolean }) {
  const grounded: { label: string; ref: string }[] = [
    { label: "Sheet rows", ref: "sheet:<name> row <n>" },
    { label: "Activities", ref: "activities[<id>]" },
    { label: "Flags & TAT breaches", ref: "flags[F-####]" },
    { label: "KPIs & rollups", ref: "kpi:<name>" },
    { label: "People / owners", ref: "person:<name>" },
    { label: "Documents & chunks", ref: "doc:<name> p.<page>" },
  ];

  return (
    <Card className={compact ? "" : ""}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-primary" /> Grounded answers only
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          The assistant answers <span className="font-medium text-foreground">only from your
          dashboard data</span>. If a fact isn't in the provided rows, it will say so instead of
          guessing.
        </p>
        <div>
          <div className="mb-1.5 font-medium">Currently grounded on</div>
          <div className="flex flex-wrap gap-1.5">
            {grounded.map((g) => (
              <Badge key={g.label} variant="outline" title={`Citation format: [${g.ref}]`}>
                {g.label}
              </Badge>
            ))}
          </div>
        </div>
        <div className="rounded-md border bg-muted/30 p-2">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Quote className="h-3 w-3" /> Every answer includes citations
          </div>
          <p className="text-muted-foreground">
            Look for inline references like <code className="rounded bg-background px-1">[flags[F-0003]]</code>{" "}
            or <code className="rounded bg-background px-1">[sheet:Delays row 12]</code>, plus a{" "}
            <span className="font-medium">Sources:</span> list at the bottom. If they're missing,
            reject the answer and re-ask.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
