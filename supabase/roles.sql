-- CLI виконує цей файл лише на новому томі; на наявному локальному стеку зміну застосовує `pnpm db:roles`. Файл адитивний та ідемпотентний: лише CREATE відсутнього, налаштування ролі в блоці її створення і членства, які додає сам файл (поза блоком створення ролі — під власною перевіркою `pg_auth_members`).
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
-- Роль сховища файлів (спека профілю postgres §8.1): єдина, що кличе
-- `file_attach`, `storage_rows_exist` і `storage_row_page`; без входу й
-- успадкування. Рантайм входить у неї лише через SET ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simetra_files') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE simetra_files NOLOGIN NOINHERIT;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members
      WHERE roleid = 'simetra_files'::pg_catalog.regrole
        AND member = 'simetra_runtime'::pg_catalog.regrole) THEN
    GRANT simetra_files TO simetra_runtime WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
-- Анонімна сесія читає роллю гостя `anon`, а не роллю користувача: стенд, де
-- роль входу вже створено без цього членства, отримує його тут, окремо від
-- блоку створення.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members
      WHERE roleid = 'anon'::pg_catalog.regrole
        AND member = 'simetra_runtime'::pg_catalog.regrole) THEN
    GRANT anon TO simetra_runtime WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
-- Група споживача сигналів (спека профілю postgres §3.1): права лише на
-- outbox, без входу й успадкування; нічий член і нічий батько, крім ролі входу
-- споживача.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simetra_signal_consumer') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE simetra_signal_consumer NOLOGIN NOINHERIT;
  END IF;
END
$$;
-- Роль входу споживача сигналів (Centrifugo): `SET ROLE` він не вміє, тож
-- групу ставить налаштування ролі — воно діє з першого оператора сесії. Лише
-- в блоці створення: наявну роль файл не змінює. Без пароля, як і рантайм.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'simetra_signals') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE simetra_signals LOGIN NOINHERIT;
    ALTER ROLE simetra_signals SET role = 'simetra_signal_consumer';
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members
      WHERE roleid = 'simetra_signal_consumer'::pg_catalog.regrole
        AND member = 'simetra_signals'::pg_catalog.regrole) THEN
    GRANT simetra_signal_consumer TO simetra_signals WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
