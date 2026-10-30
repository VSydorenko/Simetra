-- Оракул еквівалентності замикання прав (спека прав §5.4): тіла, згенеровані кодом
-- до переписування `closurePass` (коміт b2d7c39a), під іменами `*_before`.
-- Тестова фікстура, а не шлях продукту: її читає `closure-oracle.ts`.

CREATE OR REPLACE FUNCTION simetra.rights_mine_before()
RETURNS TABLE (level text, level_id uuid, scope uuid, container uuid, object text, action text, extent text, dimension_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $simetra$
WITH my_scopes AS (
  SELECT s.scope_kind_id, s.scope, s.member
  FROM simetra.rights_my_scopes() s
),
assignments AS (
  SELECT 'scope'::text AS storage, '00000000-0000-4000-8000-000000006001'::uuid AS storage_id, a.org_id AS scope, a.container AS container, a.custom_role AS custom_role,
         CASE WHEN a.custom_role IS NULL THEN a.archetype ELSE c.archetype END AS archetype,
         '00000000-0000-4000-8000-000000006001'::uuid AS scope_kind_id, NULL::text AS source_level, NULL::uuid AS source_level_id
  FROM public.org_role_assignments a
  JOIN my_scopes s
    ON s.scope_kind_id = '00000000-0000-4000-8000-000000006001'::uuid
   AND s.scope = a.org_id
   AND s.member = a.subject
  LEFT JOIN public.org_roles c
    ON c.org_id = a.org_id
   AND c.id = a.custom_role
   AND NOT c.deletion_mark
  WHERE NOT a.deletion_mark
    AND (a.custom_role IS NULL) = (c.id IS NULL)
  UNION ALL
  SELECT 'scope'::text AS storage, '00000000-0000-4000-8000-000000006008'::uuid AS storage_id, a.team_id AS scope, a.container AS container, a.custom_role AS custom_role,
         CASE WHEN a.custom_role IS NULL THEN a.archetype ELSE c.archetype END AS archetype,
         '00000000-0000-4000-8000-000000006008'::uuid AS scope_kind_id, NULL::text AS source_level, NULL::uuid AS source_level_id
  FROM public.team_role_assignments a
  JOIN my_scopes s
    ON s.scope_kind_id = '00000000-0000-4000-8000-000000006008'::uuid
   AND s.scope = a.team_id
   AND s.member = a.subject
  LEFT JOIN public.team_roles c
    ON c.team_id = a.team_id
   AND c.id = a.custom_role
   AND NOT c.deletion_mark
  WHERE NOT a.deletion_mark
    AND (a.custom_role IS NULL) = (c.id IS NULL)
  UNION ALL
  SELECT 'source'::text AS storage, '00000000-0000-4000-8000-000000006121'::uuid AS storage_id, s.scope AS scope, src.project_id AS container, NULL::uuid AS custom_role, k.role_id AS archetype,
         '00000000-0000-4000-8000-000000006001'::uuid AS scope_kind_id, 'container'::text AS source_level, '00000000-0000-4000-8000-000000006020'::uuid AS source_level_id
  FROM public.role_grant src
  JOIN simetra.rights_source_keys() k
    ON k.source_id = '00000000-0000-4000-8000-000000006121'::uuid
   AND k.key = src.role_key
  JOIN my_scopes s
    ON s.scope_kind_id = '00000000-0000-4000-8000-000000006001'::uuid
   AND s.member = src.member_id
  WHERE src.is_active IS TRUE
  UNION ALL
  SELECT 'source'::text AS storage, '00000000-0000-4000-8000-000000006123'::uuid AS storage_id, NULL::uuid AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, k.role_id AS archetype,
         NULL::uuid AS scope_kind_id, 'global'::text AS source_level, NULL::uuid AS source_level_id
  FROM public.global_grant src
  JOIN simetra.rights_source_keys() k
    ON k.source_id = '00000000-0000-4000-8000-000000006123'::uuid
   AND k.key = src.role_key
  WHERE src.member_id = (SELECT simetra.current_user_id())
),
typed AS (
  SELECT x.storage, x.storage_id, x.scope, x.container, x.custom_role, x.archetype, x.scope_kind_id, r.level, r.level_id
  FROM assignments x
  JOIN simetra.rights_roles() r
    ON r.role_id = x.archetype
   AND r.storage = x.storage
   AND r.storage_id IS NOT DISTINCT FROM x.storage_id
  UNION ALL
  SELECT x.storage, x.storage_id, x.scope, x.container, x.custom_role, x.archetype, x.scope_kind_id, r.level, r.level_id
  FROM assignments x
  JOIN simetra.rights_roles() r
    ON r.role_id = x.archetype
   AND r.level = x.source_level
   AND r.level_id IS NOT DISTINCT FROM x.source_level_id
  WHERE x.storage = 'source'
),
containers AS (
  SELECT '00000000-0000-4000-8000-000000006020'::uuid AS level_id, k.id AS container, '00000000-0000-4000-8000-000000006001'::uuid AS scope_kind_id, k.org_id AS scope
  FROM public.project k
),
held AS (
  SELECT t.storage, t.storage_id, t.scope, NULL::uuid AS container, t.custom_role, t.archetype, t.level, t.level_id
  FROM typed t
  WHERE t.level <> 'container'
  UNION ALL
  SELECT t.storage, t.storage_id, t.scope, k.container, t.custom_role, t.archetype, t.level, t.level_id
  FROM typed t
  JOIN containers k
    ON k.level_id = t.level_id
   AND k.container = t.container
   AND k.scope_kind_id IS NOT DISTINCT FROM t.scope_kind_id
   AND k.scope IS NOT DISTINCT FROM t.scope
  WHERE t.level = 'container'
),
deltas AS (
  SELECT 'scope'::text AS storage, '00000000-0000-4000-8000-000000006001'::uuid AS storage_id, d.parent_id AS custom_role,
         d.object AS object, d.action AS action, d.extent AS extent, d.dimension AS dimension_id, d.effect AS effect
  FROM public.org_roles_delta d
  UNION ALL
  SELECT 'scope'::text AS storage, '00000000-0000-4000-8000-000000006008'::uuid AS storage_id, d.parent_id AS custom_role,
         d.object AS object, d.action AS action, d.extent AS extent, d.dimension AS dimension_id, d.effect AS effect
  FROM public.team_roles_delta d
),
role_rows AS (
  SELECT h.storage, h.storage_id, h.scope, h.container, h.custom_role, h.archetype, h.level, h.level_id, p.object, p.action, p.extent, p.dimension_id
  FROM held h
  JOIN simetra.rights_projection() p ON p.role_id = h.archetype
  WHERE NOT EXISTS (
    SELECT 1
    FROM deltas d
    WHERE d.storage = h.storage
      AND d.storage_id IS NOT DISTINCT FROM h.storage_id
      AND d.custom_role = h.custom_role
      AND d.effect = 'deny'
      AND d.object = p.object
      AND d.action = p.action
      AND d.extent = p.extent
      AND d.dimension_id IS NOT DISTINCT FROM p.dimension_id
  )
  UNION ALL
  SELECT h.storage, h.storage_id, h.scope, h.container, h.custom_role, h.archetype, h.level, h.level_id, d.object, d.action, d.extent, d.dimension_id
  FROM held h
  JOIN deltas d
    ON d.storage = h.storage
   AND d.storage_id IS NOT DISTINCT FROM h.storage_id
   AND d.custom_role = h.custom_role
  JOIN simetra.rights_domain() m
    ON m.level = h.level
   AND m.level_id IS NOT DISTINCT FROM h.level_id
   AND m.object = d.object
   AND m.action = d.action
   AND m.extent = d.extent
   AND m.dimension_id IS NOT DISTINCT FROM d.dimension_id
  WHERE d.effect = 'allow'
),
closure_1 AS (
  SELECT g.storage, g.storage_id, g.scope, g.container, g.custom_role, g.archetype, g.level, g.level_id, g.object, g.action, g.extent, g.dimension_id
  FROM role_rows g
  WHERE NOT EXISTS (
    SELECT 1
    FROM simetra.rights_requires() q
    WHERE q.object = g.object
      AND q.action = g.action
      AND NOT EXISTS (
        SELECT 1
        FROM role_rows s
        WHERE (s.storage, s.storage_id, s.scope, s.container, s.custom_role, s.archetype)
              IS NOT DISTINCT FROM (g.storage, g.storage_id, g.scope, g.container, g.custom_role, g.archetype)
          AND s.object = q.object
          AND s.action = q.required
          AND (s.extent = 'any' OR (s.extent = g.extent AND s.dimension_id IS NOT DISTINCT FROM g.dimension_id))
      )
  )
),
closure_2 AS (
  SELECT g.storage, g.storage_id, g.scope, g.container, g.custom_role, g.archetype, g.level, g.level_id, g.object, g.action, g.extent, g.dimension_id
  FROM closure_1 g
  WHERE NOT EXISTS (
    SELECT 1
    FROM simetra.rights_requires() q
    WHERE q.object = g.object
      AND q.action = g.action
      AND NOT EXISTS (
        SELECT 1
        FROM closure_1 s
        WHERE (s.storage, s.storage_id, s.scope, s.container, s.custom_role, s.archetype)
              IS NOT DISTINCT FROM (g.storage, g.storage_id, g.scope, g.container, g.custom_role, g.archetype)
          AND s.object = q.object
          AND s.action = q.required
          AND (s.extent = 'any' OR (s.extent = g.extent AND s.dimension_id IS NOT DISTINCT FROM g.dimension_id))
      )
  )
)
SELECT c.level, c.level_id, c.scope, c.container, c.object, c.action, c.extent, c.dimension_id
FROM closure_2 c
UNION
SELECT r.level, r.level_id, NULL::uuid, NULL::uuid, p.object, p.action, p.extent, p.dimension_id
FROM simetra.rights_roles() r
JOIN simetra.rights_projection() p ON p.role_id = r.role_id
WHERE r.level = 'everyUser'
  AND (SELECT simetra.current_user_id()) IS NOT NULL
$simetra$;
