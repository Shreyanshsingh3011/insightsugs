
-- Tighten role-scoped RLS: admin = project-scoped for data; super_admin = global.

-- pending_actions: remove `assigned_to IS NULL` leak; admins must own the referenced project.
DROP POLICY IF EXISTS "Users see actions targeting them or that they proposed" ON public.pending_actions;
DROP POLICY IF EXISTS "Users decide on actions they can see" ON public.pending_actions;

CREATE POLICY "pending_actions_select_scoped" ON public.pending_actions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR proposed_by = auth.uid()
    OR assigned_to = auth.uid()
    OR (
      (payload ? 'project_id')
      AND public.can_see_project(auth.uid(), (payload->>'project_id')::uuid)
    )
  );

CREATE POLICY "pending_actions_update_scoped" ON public.pending_actions
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR proposed_by = auth.uid()
    OR assigned_to = auth.uid()
    OR (
      public.is_admin_or_super(auth.uid())
      AND (payload ? 'project_id')
      AND public.can_see_project(auth.uid(), (payload->>'project_id')::uuid)
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'super_admin')
    OR proposed_by = auth.uid()
    OR assigned_to = auth.uid()
    OR (
      public.is_admin_or_super(auth.uid())
      AND (payload ? 'project_id')
      AND public.can_see_project(auth.uid(), (payload->>'project_id')::uuid)
    )
  );

-- alerts: admin now only sees alerts they sent or receive; super_admin sees all.
DROP POLICY IF EXISTS "alerts_select" ON public.alerts;
CREATE POLICY "alerts_select" ON public.alerts
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR sent_by = auth.uid()
    OR public.is_alert_recipient(id, auth.uid())
  );

DROP POLICY IF EXISTS "alerts_update" ON public.alerts;
CREATE POLICY "alerts_update" ON public.alerts
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR sent_by = auth.uid())
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR sent_by = auth.uid());

-- concerns: admin scoped via raised_by / target_dept / sheet visibility.
DROP POLICY IF EXISTS "concerns_select" ON public.concerns;
CREATE POLICY "concerns_select" ON public.concerns
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR raised_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.department = concerns.target_dept
    )
    OR (
      registry_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.sheet_registry r
        WHERE r.id = concerns.registry_id
          AND public.can_read_sheet(auth.uid(), r.id, r.user_id, r.visibility)
      )
    )
  );

DROP POLICY IF EXISTS "concerns_update" ON public.concerns;
CREATE POLICY "concerns_update" ON public.concerns
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.department = concerns.target_dept
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'super_admin')
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.department = concerns.target_dept
    )
  );

-- agent_runs / agent_run_events: only super_admin sees other users' agent activity.
DROP POLICY IF EXISTS "Users see their own runs" ON public.agent_runs;
CREATE POLICY "agent_runs_select_scoped" ON public.agent_runs
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS "own events select" ON public.agent_run_events;
CREATE POLICY "agent_run_events_select_scoped" ON public.agent_run_events
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin'));
