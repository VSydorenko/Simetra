-- CLI виконує цей файл лише на новому томі; на наявному локальному стеку зміну застосовує `docker exec -i supabase_db_simetra psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f - < supabase/roles.sql`.
-- Роль команд платформи (спека прав §5.1, спека П4 §6.2): кластерна, тож її немає в
-- бажаному стані бази; на базі споживача її створює `simetra roles`.
-- CLI засіває файл під `postgres`, а він не суперкористувач: без скидання
-- `createrole_self_grant` творець отримав би членство з INHERIT/SET.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simetra_command') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE simetra_command NOLOGIN NOINHERIT;
  END IF;
END
$$;
-- Роль входу рантайму (спека П4 §6.2): права бере лише через SET ROLE, тож
-- членства — INHERIT FALSE, SET TRUE (з PG16 типове значення бере атрибут
-- ролі, тому явно). Без пароля: його ставить оператор стенду, а DB-тест
-- входить під неї через SET SESSION AUTHORIZATION від суперкористувача.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simetra_runtime') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE simetra_runtime LOGIN NOINHERIT;
    GRANT simetra_command TO simetra_runtime WITH INHERIT FALSE, SET TRUE;
    GRANT authenticated TO simetra_runtime WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
