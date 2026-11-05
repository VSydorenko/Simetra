-- Ядро команди в формі П4 §6.6 (спрощено): ключі p_item — фізичні імена;
-- один сигнал на команду після DML (Р31). Payload — лише вид, ключі, версія.
-- Ключі вкладені в `keys`: realtime.send дописує верхній `id` (id повідомлення),
-- і ключ рядка `id` на верхньому рівні з ним би зіткнувся.
create function demo.contact_save(p_item jsonb, p_expected_version bigint)
returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  v_in demo.contact;
  v_row demo.contact;
  v_op text;
  v_key text;
begin
  for v_key in select jsonb_object_keys(p_item) loop
    if v_key not in ('id', 'org_id', 'email_addr', 'full_nm', 'company_id', 'referrer_id', 'score') then
      raise exception using errcode = '22023', message = 'command.invalid', detail = v_key;
    end if;
  end loop;
  v_in := jsonb_populate_record(null::demo.contact, p_item);

  if p_expected_version is null then
    insert into demo.contact (id, org_id, email_addr, full_nm, company_id, referrer_id, score)
    values (v_in.id, v_in.org_id, v_in.email_addr, v_in.full_nm, v_in.company_id, v_in.referrer_id, v_in.score)
    returning * into v_row;
    v_op := 'create';
  else
    select * into v_row from demo.contact c where c.id = v_in.id for no key update;
    if not found then
      raise exception using errcode = '42501', message = 'command.forbidden', detail = 'no-right';
    end if;
    if v_row.row_ver <> p_expected_version then
      raise exception using errcode = '40001', message = 'command.conflict', detail = 'version';
    end if;
    update demo.contact c set
      email_addr = case when p_item ? 'email_addr' then v_in.email_addr else c.email_addr end,
      full_nm = case when p_item ? 'full_nm' then v_in.full_nm else c.full_nm end,
      company_id = case when p_item ? 'company_id' then v_in.company_id else c.company_id end,
      referrer_id = case when p_item ? 'referrer_id' then v_in.referrer_id else c.referrer_id end,
      score = case when p_item ? 'score' then v_in.score else c.score end,
      row_ver = c.row_ver + 1
    where c.id = v_in.id
    returning * into v_row;
    v_op := 'update';
  end if;

  perform realtime.send(
    jsonb_build_object(
      'kind', 'contact',
      'op', v_op,
      'keys', jsonb_build_object('id', v_row.id, 'org_id', v_row.org_id),
      'row_ver', v_row.row_ver
    ),
    'change',
    'scope:' || v_row.org_id::text,
    true
  );
  return v_row.row_ver::text;
end
$$;
revoke all on function demo.contact_save(jsonb, bigint) from public;
grant execute on function demo.contact_save(jsonb, bigint) to simetra_command;

-- Прийнята таблиця: broadcast-тригер з обрізаним payload (лише ключі).
-- broadcast_changes бере `new`/`old` з параметрів, тож обрізаний запис доходить як є.
create type demo.legacy_note_key as (id uuid, org_id uuid);

create function demo.legacy_note_broadcast() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'scope:' || coalesce(new.org_id, old.org_id)::text,
    'legacy_change',
    tg_op,
    tg_table_name,
    tg_table_schema,
    case when new is null then null else row(new.id, new.org_id)::demo.legacy_note_key end,
    case when old is null then null else row(old.id, old.org_id)::demo.legacy_note_key end
  );
  return null;
end
$$;
create trigger legacy_note_zz_broadcast
  after insert or update or delete on demo.legacy_note
  for each row execute function demo.legacy_note_broadcast();
