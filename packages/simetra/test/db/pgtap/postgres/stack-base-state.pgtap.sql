-- Базовий стан стека postgres: версія, доступні розширення, налаштування
-- стека, відсутність схем Supabase і кластерні факти Simetra, які ставить
-- `db:pg:start` через `simetra roles`: ролі, база `simetra`, шаблон. Транзакцію відкриває й відкочує
-- раннер (test/db/pgtap.ts), тож керування транзакцією тут заборонене.
create extension if not exists pgtap;

select plan(13);

select is(
  current_setting('server_version_num')::int / 10000,
  17,
  'the stack runs Postgres 17'
);
select ok(
  exists (select from pg_available_extensions where name = 'pgtap'),
  'extension pgtap is available'
);
select ok(
  exists (select from pg_available_extensions where name = 'plpgsql_check'),
  'extension plpgsql_check is available'
);
select is(
  current_setting('simetra.environment', true),
  'development',
  'simetra.environment is development'
);
select hasnt_schema('auth');
select hasnt_schema('storage');
select hasnt_schema('realtime');
select is(
  (select rolsuper from pg_roles where rolname = 'postgres'),
  true,
  'role postgres is a superuser'
);

-- Ролі Simetra (спека профілю §3.1): атрибути й членства
select is(
  (select jsonb_object_agg(rolname, array[rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication])
     from pg_roles
    where rolname in ('simetra_owner', 'simetra_auth', 'simetra_command', 'simetra_user', 'simetra_anon', 'simetra_runtime')),
  jsonb_build_object(
    'simetra_owner', array[true, false, false, true, false, true, false],
    'simetra_auth', array[true, false, false, false, false, false, false],
    'simetra_command', array[false, false, false, false, false, false, false],
    'simetra_user', array[false, false, false, false, false, false, false],
    'simetra_anon', array[false, false, false, false, false, false, false],
    'simetra_runtime', array[true, false, false, false, false, false, false]
  ),
  'Simetra roles have the attributes of the profile'
);
select is(
  (select jsonb_agg(m.member || '>' || m.role order by m.member, m.role)
     from (select u.rolname as member, r.rolname as role
             from pg_auth_members a
             join pg_roles u on u.oid = a.member
             join pg_roles r on r.oid = a.roleid
            where u.rolname in ('simetra_owner', 'simetra_runtime', 'simetra_auth', 'simetra_user', 'simetra_anon', 'simetra_command')
               or r.rolname in ('simetra_owner', 'simetra_runtime', 'simetra_auth', 'simetra_user', 'simetra_anon', 'simetra_command')) m),
  '["simetra_runtime>simetra_anon", "simetra_runtime>simetra_command", "simetra_runtime>simetra_user"]'::jsonb,
  'the only memberships of Simetra roles are those of the runtime login role'
);
select is(
  (select r.rolname::text from pg_database d join pg_roles r on r.oid = d.datdba where d.datname = 'simetra'),
  'simetra_owner',
  'database simetra is owned by simetra_owner'
);
select is(
  (select array[datistemplate, datallowconn] from pg_database where datname = 'simetra_template'),
  array[true, false],
  'simetra_template is a template that does not allow connections'
);
select is(
  (select s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
    where r.rolname = 'simetra_auth' and s.setdatabase = (select oid from pg_database where datname = 'simetra')),
  array['search_path=better_auth'],
  'simetra_auth has search_path better_auth in simetra'
);

select * from finish();
