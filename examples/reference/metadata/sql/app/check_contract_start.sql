-- Обробник підписки CheckContractStart: договір не починається раніше 2000 року.
CREATE FUNCTION app.check_contract_start() RETURNS trigger
LANGUAGE plpgsql VOLATILE
SET search_path = ''
AS $$
BEGIN
  IF NEW.start_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'contract start date % is before 2000', NEW.start_date;
  END IF;
  RETURN NEW;
END
$$;
