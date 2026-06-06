
CREATE TABLE public.email_groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  applies_to JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_groups TO authenticated;
GRANT ALL ON public.email_groups TO service_role;

ALTER TABLE public.email_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage email groups"
ON public.email_groups FOR ALL TO authenticated
USING (public.is_admin_or_super(auth.uid()))
WITH CHECK (public.is_admin_or_super(auth.uid()));

CREATE TRIGGER trg_email_groups_updated_at
BEFORE UPDATE ON public.email_groups
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


CREATE TABLE public.email_group_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.email_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, email)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_group_members TO authenticated;
GRANT ALL ON public.email_group_members TO service_role;

ALTER TABLE public.email_group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage email group members"
ON public.email_group_members FOR ALL TO authenticated
USING (public.is_admin_or_super(auth.uid()))
WITH CHECK (public.is_admin_or_super(auth.uid()));

CREATE INDEX idx_email_group_members_group ON public.email_group_members(group_id);
