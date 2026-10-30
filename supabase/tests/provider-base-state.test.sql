-- Базовий стан провайдера — передумова round-trip і паперового тесту
-- (спека П2 §9, §10.4): без auth.users і ролей провайдера тінь не розгорне
-- FK на auth.users і політики на об'єктах провайдера.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

select ok(current_setting('server_version_num')::int / 10000 = 17,
  'Postgres major version is 17');
select has_schema('auth');
select has_schema('storage');
select has_schema('realtime');
select has_schema('extensions');
select has_table('auth', 'users', 'auth.users exists');
select has_role('anon');
select has_role('authenticated');
select has_role('service_role');
-- Роль команд платформи (`supabase/roles.sql`): безпечна форма — без входу,
-- успадкування й атрибутів, що обходять права.
select has_role('simetra_command');
-- Відсутня роль дає NULL, і перевірка падає, а не проходить.
select is((SELECT rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls
    OR rolcreaterole OR rolcreatedb OR rolreplication
  FROM pg_roles WHERE rolname = 'simetra_command'), false,
  'simetra_command has no LOGIN, INHERIT or privileged attributes');
-- Роль не входить у жодну роль, а її член має лише ADMIN і сам керує ролями:
-- членство нічого не дає. Єдиний виняток — пара ролі входу рантайму (спека
-- П4 §6.2): права ролі команд вона бере лише через SET ROLE.
select is((SELECT count(*) FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.member
  WHERE m.member = to_regrole('simetra_command')
    OR (m.roleid = to_regrole('simetra_command')
      AND NOT (m.member = to_regrole('simetra_runtime')
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
      AND (m.inherit_option OR m.set_option
        OR NOT (g.rolsuper OR g.rolcreaterole))))::int, 0,
  'simetra_command is a member of nothing and its members hold only ADMIN, except the runtime pair');
-- Роль входу рантайму (`supabase/roles.sql`): вхід без жодного іншого атрибута.
select has_role('simetra_runtime');
select is((SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper
    AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb
    AND NOT rolreplication
  FROM pg_roles WHERE rolname = 'simetra_runtime'), true,
  'simetra_runtime has LOGIN and no INHERIT or privileged attribute');
-- Рівно дві пари: роль команд і роль запиту, кожна лише через SET ROLE.
-- `name::text` несе колацію "C", літерали VALUES — типову: без явного
-- COLLATE results_eq не може порівняти рядки.
select results_eq(
  $$SELECT g.rolname::text COLLATE "default", m.admin_option, m.inherit_option, m.set_option
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
    WHERE m.member = to_regrole('simetra_runtime')
    ORDER BY 1$$,
  $$VALUES ('authenticated', false, false, true),
    ('simetra_command', false, false, true)$$,
  'simetra_runtime belongs only to simetra_command and authenticated, with INHERIT FALSE, SET TRUE');
-- Роль команд і роль запиту не входять одна в одну: інакше SET ROLE
-- однієї давав би права другої.
select is((SELECT count(*) FROM pg_auth_members m
  WHERE (m.roleid = to_regrole('simetra_command')
      AND m.member = to_regrole('authenticated'))
    OR (m.roleid = to_regrole('authenticated')
      AND m.member = to_regrole('simetra_command')))::int, 0,
  'simetra_command and authenticated have no membership between them');

select * from finish();
rollback;
