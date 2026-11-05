-- Питання автора П4-B (Г1, Г2): складений FK (скоуп, id) як у скоупленого
-- об'єкта, і другий FK на ту саму ціль, щоб перевірити потребу підказки.
alter table demo.company add constraint company_scope_id_key unique (org_id, id);

create table demo.deal (
  id uuid primary key,
  org_id uuid not null references demo.org (id),
  company_id uuid not null,
  title text not null,
  amount numeric(12, 2),
  constraint deal_company_fk foreign key (org_id, company_id) references demo.company (org_id, id)
);
grant select on demo.deal to authenticated;
alter table demo.deal enable row level security;
create policy deal_scope_read on demo.deal as permissive for select to authenticated
  using (org_id = any (array(select demo.user_scopes())));

-- Заглушка права читання: рядок цілі в тому самому скоупі, невидимий за правами.
-- Складений FK (скоуп, id) робить посилання між скоупами неможливим, тож
-- невидимість цілі виникає лише від прав, а не від скоупу.
create policy company_rights_stub on demo.company as restrictive for select to authenticated
  using (title_txt <> 'hidden by rights');
