-- Базовий стан провайдера — передумова round-trip і паперового тесту
-- (спека П2 §9, §10.4): без auth.users і ролей провайдера тінь не розгорне
-- FK на auth.users і політики на об'єктах провайдера.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

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

select * from finish();
rollback;
