-- Add signup notification tracker + resend audit and 'notified' log table.
ALTER TABLE public.signup_requests
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS notify_count int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.signup_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.signup_requests(id) ON DELETE CASCADE,
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('in_app','email')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.signup_notifications TO authenticated;
GRANT ALL ON public.signup_notifications TO service_role;
ALTER TABLE public.signup_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signup_notifications_super_read" ON public.signup_notifications
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'super_admin'));
CREATE POLICY "signup_notifications_super_insert" ON public.signup_notifications
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'super_admin') AND sent_by = auth.uid());

-- Promote shreyanshsingh3011@gmail.com to super_admin (idempotent).
DO $$
DECLARE
  uid uuid;
BEGIN
  SELECT id INTO uid FROM public.profiles WHERE lower(email) = 'shreyanshsingh3011@gmail.com' LIMIT 1;
  IF uid IS NULL THEN
    SELECT id INTO uid FROM auth.users WHERE lower(email) = 'shreyanshsingh3011@gmail.com' LIMIT 1;
    IF uid IS NOT NULL THEN
      INSERT INTO public.profiles(id, full_name, email)
      VALUES (uid, '', 'shreyanshsingh3011@gmail.com')
      ON CONFLICT (id) DO NOTHING;
    END IF;
  END IF;
  IF uid IS NOT NULL THEN
    DELETE FROM public.user_roles WHERE user_id = uid;
    INSERT INTO public.user_roles(user_id, role) VALUES (uid, 'super_admin')
    ON CONFLICT DO NOTHING;
    UPDATE public.signup_requests
       SET status = 'approved', granted_role = 'super_admin',
           verified_via = 'admin', reviewed_at = now()
     WHERE user_id = uid AND status = 'pending';
  END IF;
END $$;

-- Resend verification RPC: super_admin only; sends in-app notification to user
-- and stamps the request as re-notified.
CREATE OR REPLACE FUNCTION public.resend_signup_verification(_request_id uuid, _note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req record;
BEGIN
  IF NOT public.has_role(auth.uid(), 'super_admin') THEN
    RAISE EXCEPTION 'Only super admins can resend verification';
  END IF;
  SELECT * INTO req FROM public.signup_requests WHERE id = _request_id;
  IF req IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF req.status <> 'pending' THEN RAISE EXCEPTION 'Request is not pending'; END IF;

  INSERT INTO public.notifications (user_id, kind, title, body)
  VALUES (
    req.user_id,
    'signup_verification',
    'Verify your account',
    coalesce(_note, 'A super admin has re-triggered your verification. Please complete verification from the signed-in home page, or reply to this notification.')
  );

  INSERT INTO public.signup_notifications (request_id, sent_by, channel, note)
  VALUES (_request_id, auth.uid(), 'in_app', _note);

  UPDATE public.signup_requests
     SET last_notified_at = now(),
         notify_count = coalesce(notify_count, 0) + 1
   WHERE id = _request_id;
END;
$$;