ALTER TABLE public.pending_actions REPLICA IDENTITY FULL;
ALTER TABLE public.signup_requests REPLICA IDENTITY FULL;
ALTER TABLE public.audit_log REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_actions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.signup_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_log;