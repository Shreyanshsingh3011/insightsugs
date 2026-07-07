CREATE OR REPLACE FUNCTION public.find_cross_task_links(_user_id uuid, _activity_id uuid, _limit int DEFAULT 20)
RETURNS TABLE(
  id uuid,
  project_id uuid,
  project_name text,
  title text,
  status activity_status,
  assignee_id uuid,
  assignee_name text,
  relation text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH focus AS (
    SELECT a.* FROM activities a
    WHERE a.id = _activity_id
      AND (a.assignee_id = _user_id OR can_see_project(_user_id, a.project_id))
  ),
  preds AS (
    SELECT DISTINCT a2.id, 'predecessor'::text AS relation
    FROM focus f JOIN activities a2 ON a2.id = f.depends_on
    UNION
    SELECT DISTINCT a3.id, 'predecessor'::text
    FROM focus f
    JOIN activities a2 ON a2.id = f.depends_on
    JOIN activities a3 ON a3.id = a2.depends_on
  ),
  succs AS (
    SELECT DISTINCT a2.id, 'successor'::text AS relation
    FROM activities a2 WHERE a2.depends_on = _activity_id
  ),
  siblings AS (
    SELECT DISTINCT a2.id, 'sibling'::text AS relation
    FROM focus f
    JOIN activities a2 ON a2.depends_on = f.depends_on AND a2.id <> f.id
    WHERE f.depends_on IS NOT NULL
  ),
  all_related AS (
    SELECT * FROM preds UNION SELECT * FROM succs UNION SELECT * FROM siblings
  )
  SELECT a.id, a.project_id, p.name, a.title, a.status, a.assignee_id, pr.full_name, r.relation
  FROM all_related r
  JOIN activities a ON a.id = r.id
  JOIN projects p ON p.id = a.project_id
  LEFT JOIN profiles pr ON pr.id = a.assignee_id
  WHERE (a.assignee_id = _user_id OR can_see_project(_user_id, a.project_id))
    AND a.id <> _activity_id
  ORDER BY r.relation, a.updated_at DESC
  LIMIT GREATEST(_limit, 1);
$$;
GRANT EXECUTE ON FUNCTION public.find_cross_task_links(uuid, uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.find_cross_sheet_rows(_user_id uuid, _needle text, _limit int DEFAULT 30)
RETURNS TABLE(
  sheet_registry_id uuid,
  sheet_name text,
  row_index int,
  activity text,
  owner text,
  status text,
  matched_on text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH needle AS (SELECT lower(btrim(_needle)) AS n)
  SELECT
    sr.sheet_registry_id,
    r.display_name,
    sr.row_index,
    NULLIF(sr.canonical->>'activity',''),
    NULLIF(sr.canonical->>'owner',''),
    NULLIF(sr.canonical->>'status',''),
    CASE
      WHEN lower(btrim(coalesce(sr.canonical->>'activity',''))) = (SELECT n FROM needle) THEN 'activity'
      WHEN lower(btrim(coalesce(sr.canonical->>'owner',''))) = (SELECT n FROM needle) THEN 'owner'
      ELSE 'other'
    END
  FROM sheet_rows sr
  JOIN sheet_registry r ON r.id = sr.sheet_registry_id
  WHERE can_read_sheet(_user_id, r.id, r.user_id, r.visibility)
    AND (SELECT n FROM needle) <> ''
    AND (
      lower(btrim(coalesce(sr.canonical->>'activity',''))) = (SELECT n FROM needle)
      OR lower(btrim(coalesce(sr.canonical->>'owner',''))) = (SELECT n FROM needle)
    )
  ORDER BY r.display_name, sr.row_index
  LIMIT GREATEST(_limit, 1);
$$;
GRANT EXECUTE ON FUNCTION public.find_cross_sheet_rows(uuid, text, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.find_person_footprint(_user_id uuid, _person_id uuid, _limit int DEFAULT 40)
RETURNS TABLE(
  project_id uuid,
  project_name text,
  activity_count int,
  overdue_count int,
  blocked_count int,
  latest_activity timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    p.id, p.name,
    count(a.id)::int,
    count(a.id) FILTER (WHERE a.status = 'overdue')::int,
    count(a.id) FILTER (WHERE a.status = 'blocked')::int,
    max(a.updated_at)
  FROM activities a
  JOIN projects p ON p.id = a.project_id
  WHERE a.assignee_id = _person_id
    AND (a.assignee_id = _user_id OR can_see_project(_user_id, a.project_id))
  GROUP BY p.id, p.name
  ORDER BY max(a.updated_at) DESC NULLS LAST
  LIMIT GREATEST(_limit, 1);
$$;
GRANT EXECUTE ON FUNCTION public.find_person_footprint(uuid, uuid, int) TO authenticated;