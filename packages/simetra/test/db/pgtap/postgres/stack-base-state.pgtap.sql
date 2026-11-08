-- Базовий стан стека postgres: версія, доступні розширення, налаштування
-- стека й відсутність схем Supabase. Ролі Simetra тут не перевіряються — їх
-- створює `simetra roles` пізніших блоків. Транзакцію відкриває й відкочує
-- раннер (test/db/pgtap.ts), тож керування транзакцією тут заборонене.
create extension if not exists pgtap;

select plan(8);

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

select * from finish();
