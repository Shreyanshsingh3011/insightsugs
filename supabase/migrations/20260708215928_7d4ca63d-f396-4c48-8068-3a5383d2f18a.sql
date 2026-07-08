
-- Hot-path indexes based on slow-query analysis and common filter patterns
CREATE INDEX IF NOT EXISTS idx_activities_project_created ON public.activities (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_status_created ON public.activities (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_created ON public.agent_run_events (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created ON public.agent_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_status_created ON public.alerts (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_project_created ON public.notifications (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_actions_run ON public.pending_actions (run_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_run ON public.webhook_events (run_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status_created ON public.webhook_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_created ON public.audit_log (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signup_requests_status_created ON public.signup_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_custom_agents_owner ON public.custom_agents (owner_id);
CREATE INDEX IF NOT EXISTS idx_email_groups_owner ON public.email_groups (owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON public.projects (owner_id);
CREATE INDEX IF NOT EXISTS idx_eval_cases_owner ON public.eval_cases (owner_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON public.project_members (user_id);
