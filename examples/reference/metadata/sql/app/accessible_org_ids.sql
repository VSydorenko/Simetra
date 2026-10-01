-- Функція множини виду скоупу `org`: організації, учасником яких є поточний
-- користувач. SECURITY DEFINER і порожній search_path — бо RLS-політики (П3)
-- самі викликають її над таблицями з RLS, зокрема над org_member: виклик від
-- імені користувача зациклив би політику на самій собі.
CREATE FUNCTION app.accessible_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
  AS $$
    SELECT m.org_id FROM app.org_member m WHERE m.user_id = auth.uid()
  $$;
