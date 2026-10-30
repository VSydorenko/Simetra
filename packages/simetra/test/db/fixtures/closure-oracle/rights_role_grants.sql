-- Оракул еквівалентності замикання прав (Р2d2-22): тіла, згенеровані кодом
-- до переписування `closurePass` (коміт b2d7c39a), під іменами `*_before`.
-- Тестова фікстура, а не шлях продукту: її читає `closure-oracle.ts`.

CREATE OR REPLACE FUNCTION simetra.rights_role_grants_before(p_level text, p_level_id uuid, p_archetype uuid, p_delta jsonb) RETURNS TABLE (object text, action text, extent text, dimension_id uuid) LANGUAGE sql STABLE SET search_path = '' AS $simetra$
WITH typed AS (
  SELECT r.role_id FROM simetra.rights_roles() r
  WHERE r.role_id = rights_role_grants_before.p_archetype AND r.level = rights_role_grants_before.p_level AND r.level_id IS NOT DISTINCT FROM rights_role_grants_before.p_level_id
), deltas AS (
  SELECT d.object, d.action, d.extent, d.dimension AS dimension_id, d.effect
  FROM jsonb_to_recordset(rights_role_grants_before.p_delta) AS d(object text, action text, extent text, dimension uuid, effect text)
), role_rows AS (
  SELECT NULL::text AS storage, NULL::uuid AS storage_id, NULL::uuid AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, rights_role_grants_before.p_archetype AS archetype, rights_role_grants_before.p_level AS level, rights_role_grants_before.p_level_id AS level_id, p.object, p.action, p.extent, p.dimension_id
  FROM typed r JOIN simetra.rights_projection() p ON p.role_id = r.role_id
  WHERE NOT EXISTS (SELECT 1 FROM deltas d WHERE d.effect = 'deny' AND d.object = p.object AND d.action = p.action AND d.extent = p.extent AND d.dimension_id IS NOT DISTINCT FROM p.dimension_id)
  UNION ALL
  SELECT NULL::text AS storage, NULL::uuid AS storage_id, NULL::uuid AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, rights_role_grants_before.p_archetype AS archetype, rights_role_grants_before.p_level AS level, rights_role_grants_before.p_level_id AS level_id, d.object, d.action, d.extent, d.dimension_id
  FROM typed r CROSS JOIN deltas d JOIN simetra.rights_domain() m
    ON m.level = rights_role_grants_before.p_level AND m.level_id IS NOT DISTINCT FROM rights_role_grants_before.p_level_id
   AND m.object = d.object AND m.action = d.action AND m.extent = d.extent AND m.dimension_id IS NOT DISTINCT FROM d.dimension_id
  WHERE d.effect = 'allow'
), closure_1 AS (
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
), closure_2 AS (
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
SELECT DISTINCT object, action, extent, dimension_id FROM closure_2
$simetra$;
