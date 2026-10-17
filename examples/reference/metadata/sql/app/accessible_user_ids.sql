-- Функція множини виду скоупу `user`: користувач бачить лише власні рядки.
-- SECURITY DEFINER і порожній search_path — як у кожної функції множини.
-- Поточний користувач — лише через обгортку `(select …)`: Postgres обчислює
-- її раз на запит, а не на кожен рядок. Сесія без користувача «Користувачів»
-- (анонімна, сервісна, недійсний користувач) не отримує жодного значення.
CREATE FUNCTION app.accessible_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT u.id FROM (SELECT (select simetra.current_user_id()) AS id) u
     WHERE u.id IS NOT NULL
  $$;
