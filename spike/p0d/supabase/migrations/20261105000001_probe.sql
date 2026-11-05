-- Синтетична схема спайку П0 (г). Фізичні імена навмисно ≠ логічним (Р5):
-- адаптер знає логічні імена лише зі своєї згенерованої карти.

create schema demo;
grant usage on schema demo to anon, authenticated, service_role;

-- Роль команд: T3 робить SET LOCAL ROLE на транзакцію команди (Р21).
create role simetra_command nologin noinherit;
grant simetra_command to postgres;
grant usage on schema demo to simetra_command;
grant usage on schema realtime to simetra_command;

create table demo.org (
  id uuid primary key,
  title text not null
);

create table demo.member (
  user_id uuid not null,
  org_id uuid not null references demo.org (id),
  primary key (user_id, org_id)
);

-- Функція множини скоупу (§6.8): STABLE, SETOF uuid, без аргументів рядка.
create function demo.user_scopes() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.org_id from demo.member m where m.user_id = (select auth.uid())
$$;
revoke all on function demo.user_scopes() from public;
grant execute on function demo.user_scopes() to authenticated, simetra_command;

create table demo.company (
  id uuid primary key,
  org_id uuid not null references demo.org (id),
  title_txt text not null
);

-- Два FK на ту саму ціль: embed без підказки `!fk_name` неоднозначний.
create table demo.contact (
  id uuid primary key,
  org_id uuid not null references demo.org (id),
  email_addr text,
  full_nm text not null,
  company_id uuid constraint contact_company_fk references demo.company (id),
  referrer_id uuid constraint contact_referrer_fk references demo.company (id),
  score integer,
  row_ver bigint not null default 1,
  deletion_mark boolean not null default false
);

-- Прийнята таблиця, ще не переведена на команди: пишеться напряму через API.
create table demo.legacy_note (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references demo.org (id),
  body text not null,
  prio smallint
);

-- Гранти: читання — ролям API; запис довідника — лише ролі команд,
-- поколонково (як commandColumns у генераторі гранту).
grant select on demo.org, demo.company, demo.contact, demo.legacy_note to authenticated;
grant select on demo.org, demo.member, demo.company, demo.contact to simetra_command;
grant insert (id, org_id, email_addr, full_nm, company_id, referrer_id, score) on demo.contact to simetra_command;
grant update (email_addr, full_nm, company_id, referrer_id, score, row_ver) on demo.contact to simetra_command;
grant insert (org_id, body, prio), update (body, prio) on demo.legacy_note to authenticated;

-- RLS у некорельованій формі (§6.8): скоуп — RESTRICTIVE, «права» — PERMISSIVE.
alter table demo.org enable row level security;
create policy org_scope_read on demo.org as permissive for select to authenticated
  using (id = any (array(select demo.user_scopes())));

alter table demo.company enable row level security;
create policy company_scope_read on demo.company as restrictive for select to authenticated, simetra_command
  using (org_id = any (array(select demo.user_scopes())));
create policy company_read_any on demo.company as permissive for select to authenticated, simetra_command
  using (true);

alter table demo.contact enable row level security;
create policy contact_scope_read on demo.contact as restrictive for select to authenticated, simetra_command
  using (org_id = any (array(select demo.user_scopes())));
create policy contact_read_any on demo.contact as permissive for select to authenticated, simetra_command
  using (true);
create policy contact_scope_insert on demo.contact as restrictive for insert to simetra_command
  with check (org_id = any (array(select demo.user_scopes())));
create policy contact_insert_any on demo.contact as permissive for insert to simetra_command
  with check (true);
create policy contact_scope_update on demo.contact as restrictive for update to simetra_command
  using (org_id = any (array(select demo.user_scopes())))
  with check (org_id = any (array(select demo.user_scopes())));
create policy contact_update_any on demo.contact as permissive for update to simetra_command
  using (true) with check (true);

alter table demo.legacy_note enable row level security;
create policy legacy_note_scope on demo.legacy_note as permissive for all to authenticated
  using (org_id = any (array(select demo.user_scopes())))
  with check (org_id = any (array(select demo.user_scopes())));

-- Канал сигналів: приватний топік `scope:<id>`; читати (підписка) й писати
-- (realtime.send) — лише в скоупи користувача.
create policy scope_channel_receive on realtime.messages as permissive for select to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) = any (array(select 'scope:' || s::text from demo.user_scopes() s))
  );
create policy scope_channel_send on realtime.messages as permissive for insert to simetra_command
  with check (
    extension = 'broadcast'
    and topic = any (array(select 'scope:' || s::text from demo.user_scopes() s))
  );
grant insert on realtime.messages to simetra_command;
