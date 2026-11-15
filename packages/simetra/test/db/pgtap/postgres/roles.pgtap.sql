-- pgtap: role=user claims={"sub":"6f1d2c3b-4a5e-4f60-8b7a-9c0d1e2f3a4b"}
-- Роль запиту в новій базі стека: раннер (test/db/pgtap.ts) копіює
-- `simetra_template` у теговану базу, ставить claims заголовка й `SET LOCAL
-- ROLE` ролі призначення `user`. Тут — лише видиме в копії шаблону;
-- кластерні факти — у stack-base-state.pgtap.sql. `sub` читається у формі
-- продового SQL (`claimSubject` фікстур e1), тож claims раннера перевірено
-- наскрізно, а не лише порядком операторів.
select plan(4);

select has_extension(
  'plpgsql_check',
  'the template copy has plpgsql_check'
);
select hasnt_schema(
  'better_auth',
  'the template copy has no better_auth: identity lives in database simetra'
);
select is(
  current_user::text,
  'simetra_user',
  'the suite runs as the user request role'
);
select is(
  (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
  '6f1d2c3b-4a5e-4f60-8b7a-9c0d1e2f3a4b'::uuid,
  'sub of the session claims is the one of the header'
);
