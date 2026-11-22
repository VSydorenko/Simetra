-- Функція множини виду скоупу `user`: користувач бачить лише власні рядки.
-- SECURITY DEFINER і порожній search_path — як у кожної функції множини.
-- Поточний користувач — лише через обгортку `(select …)`: Postgres обчислює
-- її раз на запит, а не на кожен рядок. Сесія без користувача «Користувачів»
-- (анонімна, сервісна, недійсний користувач) не отримує жодного значення.
CREATE FUNCTION app.accessible_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' SET lc_monetary = 'C' SET lc_numeric = 'C' SET lc_time = 'C' SET bytea_output = 'hex' SET xmlbinary = 'base64' SET xmloption = 'content' SET timezone_abbreviations = 'Default' SET default_text_search_config = 'pg_catalog.simple' SET standard_conforming_strings = 'on' SET array_nulls = 'on' SET transform_null_equals = 'off' SET quote_all_identifiers = 'off' SET gin_fuzzy_search_limit = '0'
  AS $$
    SELECT u.id FROM (SELECT (select simetra.current_user_id()) AS id) u
     WHERE u.id IS NOT NULL
  $$;
