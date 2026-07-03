// Shared breadcrumb trail + "Back to dashboard" action for entity detail
// pages. Uses <Link> back to /agent so the dashboard's own sessionStorage-
// persisted filters (search, focus person/team/project, pagination) restore
// automatically — no state is dropped on the way back.

import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DetailBreadcrumbsProps = {
  kind: "person" | "stage" | "project" | "kpi" | "row";
  title: string;
  /** Optional middle crumb (e.g. project name for a row). */
  parent?: { label: string; to: string; params?: Record<string, string> };
};

const KIND_LABEL: Record<DetailBreadcrumbsProps["kind"], string> = {
  person: "People",
  stage: "Stages",
  project: "Projects",
  kpi: "KPIs",
  row: "Activities",
};

export function DetailBreadcrumbs({ kind, title, parent }: DetailBreadcrumbsProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm"
    >
      <Button asChild size="sm" variant="ghost" className="h-8 -ml-2 px-2 gap-1">
        <Link to="/agent" aria-label="Back to dashboard">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Back to dashboard</span>
          <span className="sm:hidden">Back</span>
        </Link>
      </Button>

      <ol className="flex flex-wrap items-center gap-x-1 text-muted-foreground" role="list">
        <li className="flex items-center gap-1">
          <Link to="/agent" className="inline-flex items-center gap-1 hover:text-foreground">
            <Home className="h-3.5 w-3.5" aria-hidden />
            <span>Dashboard</span>
          </Link>
        </li>
        <li aria-hidden><ChevronRight className="h-3.5 w-3.5" /></li>
        <li className="capitalize">{KIND_LABEL[kind]}</li>
        {parent && (
          <>
            <li aria-hidden><ChevronRight className="h-3.5 w-3.5" /></li>
            <li className="max-w-[220px] truncate">
              {/* eslint-disable @typescript-eslint/no-explicit-any */}
              <Link to={parent.to as any} params={parent.params as any} className="hover:text-foreground">
                {parent.label}
              </Link>
              {/* eslint-enable */}
            </li>
          </>
        )}
        <li aria-hidden><ChevronRight className="h-3.5 w-3.5" /></li>
        <li aria-current="page" className="max-w-[280px] truncate font-medium text-foreground">
          {title}
        </li>
      </ol>
    </nav>
  );
}
