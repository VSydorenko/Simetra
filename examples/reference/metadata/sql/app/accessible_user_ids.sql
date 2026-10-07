-- Функція множини виду скоупу `user`: користувач бачить лише власні рядки.
-- SECURITY DEFINER і порожній search_path — як у кожної функції множини.
-- Анонімна сесія (auth.uid() IS NULL) не отримує жодного значення.
CREATE FUNCTION app.accessible_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT auth.uid() WHERE auth.uid() IS NOT NULL
  $$;
