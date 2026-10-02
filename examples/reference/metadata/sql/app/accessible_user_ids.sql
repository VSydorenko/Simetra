-- Функція множини виду скоупу `user`: користувач бачить лише власні рядки.
-- Анонімна сесія (auth.uid() IS NULL) не отримує жодного значення.
CREATE FUNCTION app.accessible_user_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT auth.uid() WHERE auth.uid() IS NOT NULL
  $$;
