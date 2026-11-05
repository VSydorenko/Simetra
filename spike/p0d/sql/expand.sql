-- Фаза розширення зміни типу (платформна спека §7): нова колонка поруч,
-- тригер синхронізації в обидва боки, ядро приймає обидва фізичні ключі.
-- Стара збірка пише `score`/`prio`, нова — `score_num`/`prio_num`.

alter table demo.contact add column score_num numeric(12, 2);
alter table demo.legacy_note add column prio_num numeric(6, 2);

grant insert (score_num), update (score_num) on demo.contact to simetra_command;
grant insert (prio_num), update (prio_num) on demo.legacy_note to authenticated;

-- Трасування порядку: NOTICE лише коли транзакція ввімкнула p0d.trace.
create function demo.p0d_trace(p_label text, p_score text, p_score_num text) returns void
language plpgsql set search_path = '' as $$
begin
  if current_setting('p0d.trace', true) = 'on' then
    raise notice 'trace % depth=% old=% new=%', p_label, pg_trigger_depth(), p_score, p_score_num;
  end if;
end $$;

-- Синхронізація змінює NEW того самого рядка (BEFORE ROW), без додаткового UPDATE.
-- Правило: на зміні виграє та колонка, що змінилась; якщо змінились обидві — нова.
create function demo.contact_sync_score() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.score_num is not null then
      new.score := round(new.score_num)::integer;
    elsif new.score is not null then
      new.score_num := new.score;
    end if;
  else
    if new.score_num is distinct from old.score_num then
      new.score := round(new.score_num)::integer;
    elsif new.score is distinct from old.score then
      new.score_num := new.score;
    end if;
  end if;
  perform demo.p0d_trace('contact_m_sync_score', new.score::text, new.score_num::text);
  return new;
end $$;
create trigger contact_m_sync_score before insert or update on demo.contact
  for each row execute function demo.contact_sync_score();

-- Сусідні BEFORE-тригери лише трасують: показують, що бачать тригери
-- до й після синхронізації за алфавітним порядком імен.
create function demo.contact_trace() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform demo.p0d_trace(tg_name, new.score::text, new.score_num::text);
  return new;
end $$;
create trigger contact_a_trace before insert or update on demo.contact
  for each row execute function demo.contact_trace();
create trigger contact_z_trace before insert or update on demo.contact
  for each row execute function demo.contact_trace();
create trigger contact_after_trace after insert or update on demo.contact
  for each row execute function demo.contact_trace();

create function demo.legacy_note_sync_prio() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.prio_num is not null then
      new.prio := round(new.prio_num)::smallint;
    elsif new.prio is not null then
      new.prio_num := new.prio;
    end if;
  else
    if new.prio_num is distinct from old.prio_num then
      new.prio := round(new.prio_num)::smallint;
    elsif new.prio is distinct from old.prio then
      new.prio_num := new.prio;
    end if;
  end if;
  perform demo.p0d_trace('legacy_note_m_sync_prio', new.prio::text, new.prio_num::text);
  return new;
end $$;
create trigger legacy_note_m_sync_prio before insert or update on demo.legacy_note
  for each row execute function demo.legacy_note_sync_prio();

-- Broadcast-тригер прийнятої таблиці мовчить під час дозаповнення:
-- дозаповнення не змінює даних для клієнта, а сигнал на кожен рядок залив би канал.
drop trigger legacy_note_zz_broadcast on demo.legacy_note;
create trigger legacy_note_zz_broadcast
  after insert or update or delete on demo.legacy_note
  for each row
  when (current_setting('simetra.backfill', true) is distinct from 'on')
  execute function demo.legacy_note_broadcast();

-- Ядро фази розширення: приймає обидва фізичні ключі.
create or replace function demo.contact_save(p_item jsonb, p_expected_version bigint)
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
    if v_key not in ('id', 'org_id', 'email_addr', 'full_nm', 'company_id', 'referrer_id', 'score', 'score_num') then
      raise exception using errcode = '22023', message = 'command.invalid', detail = v_key;
    end if;
  end loop;
  v_in := jsonb_populate_record(null::demo.contact, p_item);

  if p_expected_version is null then
    insert into demo.contact (id, org_id, email_addr, full_nm, company_id, referrer_id, score, score_num)
    values (v_in.id, v_in.org_id, v_in.email_addr, v_in.full_nm, v_in.company_id, v_in.referrer_id, v_in.score, v_in.score_num)
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
      score_num = case when p_item ? 'score_num' then v_in.score_num else c.score_num end,
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
