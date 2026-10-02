-- «Прийнята» форма документа ServiceAccrual (спека П2 §10.2): так його таблиці,
-- ТЧ і рухи регістрів написав би застосунок без платформи. Паперовий тест
-- розгортає цей файл у схему `accepted` поруч зі скомпільованим доменом і
-- вимагає, щоб різниця була рівно відсутніми стандартними елементами виду.
-- Імена обмежень та індексів — типові імена Postgres, як і в компілятора.

CREATE SCHEMA accepted;

-- Таблиці-цілі посилань — не предмет тесту: тут вони в тій самій формі, що
-- рендер компілятора, щоб посилання документа мали куди вказувати.

CREATE TABLE accepted.contract (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  code character varying(9),
  description character varying(150),
  deletion_mark boolean DEFAULT false NOT NULL,
  owner_id uuid,
  predefined_name text,
  version bigint DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  currency_id uuid NOT NULL,
  start_date date,
  CONSTRAINT contract_pkey PRIMARY KEY (id),
  CONSTRAINT contract_org_id_code_key UNIQUE (org_id, code),
  CONSTRAINT contract_org_id_id_key UNIQUE (org_id, id)
);

CREATE INDEX contract_currency_id_idx ON accepted.contract USING btree (currency_id);

CREATE INDEX contract_org_id_owner_id_idx ON accepted.contract USING btree (org_id, owner_id);

CREATE UNIQUE INDEX contract_org_id_predefined_name_idx ON accepted.contract USING btree (org_id, predefined_name) WHERE predefined_name IS NOT NULL;

ALTER TABLE accepted.contract ENABLE ROW LEVEL SECURITY;

CREATE TABLE accepted.counterparty (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  code character varying(9),
  description character varying(150),
  deletion_mark boolean DEFAULT false NOT NULL,
  parent_id uuid,
  is_folder boolean DEFAULT false NOT NULL,
  predefined_name text,
  version bigint DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  tax_id character varying(12),
  CONSTRAINT counterparty_pkey PRIMARY KEY (id),
  CONSTRAINT counterparty_org_id_code_key UNIQUE (org_id, code),
  CONSTRAINT counterparty_org_id_id_key UNIQUE (org_id, id),
  CONSTRAINT counterparty_org_id_tax_id_key UNIQUE (org_id, tax_id)
);

CREATE INDEX counterparty_org_id_parent_id_idx ON accepted.counterparty USING btree (org_id, parent_id);

CREATE UNIQUE INDEX counterparty_org_id_predefined_name_idx ON accepted.counterparty USING btree (org_id, predefined_name) WHERE predefined_name IS NOT NULL;

ALTER TABLE accepted.counterparty ENABLE ROW LEVEL SECURITY;

CREATE TABLE accepted.currency (
  id uuid NOT NULL,
  code character varying(3),
  description character varying(150),
  deletion_mark boolean DEFAULT false NOT NULL,
  predefined_name text,
  version bigint DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  symbol character varying(5),
  CONSTRAINT currency_pkey PRIMARY KEY (id),
  CONSTRAINT currency_code_key UNIQUE (code)
);

CREATE UNIQUE INDEX currency_predefined_name_idx ON accepted.currency USING btree (predefined_name) WHERE predefined_name IS NOT NULL;

ALTER TABLE accepted.currency ENABLE ROW LEVEL SECURITY;

CREATE TABLE accepted.organization (
  id uuid NOT NULL,
  code character varying(9),
  description character varying(150),
  deletion_mark boolean DEFAULT false NOT NULL,
  predefined_name text,
  version bigint DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  tax_id character varying(12),
  CONSTRAINT organization_pkey PRIMARY KEY (id),
  CONSTRAINT organization_code_key UNIQUE (code)
);

CREATE UNIQUE INDEX organization_predefined_name_idx ON accepted.organization USING btree (predefined_name) WHERE predefined_name IS NOT NULL;

ALTER TABLE accepted.organization ENABLE ROW LEVEL SECURITY;

ALTER TABLE accepted.contract ADD CONSTRAINT contract_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES accepted.currency (id) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE accepted.contract ADD CONSTRAINT contract_org_id_fkey FOREIGN KEY (org_id) REFERENCES accepted.organization (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE accepted.contract ADD CONSTRAINT contract_org_id_owner_id_fkey FOREIGN KEY (org_id, owner_id) REFERENCES accepted.counterparty (org_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE accepted.counterparty ADD CONSTRAINT counterparty_org_id_fkey FOREIGN KEY (org_id) REFERENCES accepted.organization (id) ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE accepted.counterparty ADD CONSTRAINT counterparty_org_id_parent_id_fkey FOREIGN KEY (org_id, parent_id) REFERENCES accepted.counterparty (org_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Документ. Застосунок без платформи не має версії рядка, генерованого
-- періоду номера й унікальності номера в ньому, `UNIQUE (org_id, id)` і
-- перевірок обов'язковості під час проведення: чернетку можна зберегти
-- неповною, а посилання — звичайні FK на `id`, бо складеному FK скоупу
-- нема на що спертися.
CREATE TABLE accepted.service_accrual (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES accepted.organization (id) ON DELETE RESTRICT,
  number varchar(11),
  date timestamptz NOT NULL,
  posted boolean NOT NULL DEFAULT false,
  deletion_mark boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  counterparty_id uuid REFERENCES accepted.counterparty (id),
  contract_id uuid REFERENCES accepted.contract (id),
  accrual_kind text DEFAULT 'regular'
    CHECK (accrual_kind IN ('regular', 'bonus', 'correction')),
  comment varchar(200)
);

-- Списки документа фільтрують за організацією — індекси з неї й починаються.
CREATE INDEX ON accepted.service_accrual (org_id, date);
CREATE INDEX ON accepted.service_accrual (org_id, counterparty_id);
CREATE INDEX ON accepted.service_accrual (org_id, contract_id);

ALTER TABLE accepted.service_accrual ENABLE ROW LEVEL SECURITY;

-- Табличні частини: рядок належить документу через `parent_id`, власної
-- колонки організації в ньому немає — її дає документ.
CREATE TABLE accepted.service_accrual_services (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id uuid NOT NULL
    REFERENCES accepted.service_accrual (id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  service_name varchar(150),
  quantity numeric(15, 3),
  amount numeric(15, 2)
);

CREATE INDEX ON accepted.service_accrual_services (parent_id);

ALTER TABLE accepted.service_accrual_services ENABLE ROW LEVEL SECURITY;

CREATE TABLE accepted.service_accrual_performers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id uuid NOT NULL
    REFERENCES accepted.service_accrual (id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  performer_id uuid REFERENCES accepted.counterparty (id),
  amount numeric(15, 2)
);

CREATE INDEX ON accepted.service_accrual_performers (parent_id);

ALTER TABLE accepted.service_accrual_performers ENABLE ROW LEVEL SECURITY;

-- Рухи регістрів: без ключа за реєстратором, без індексу рухів із
-- реєстратором і без похідних таблиць (місячних оборотів, поточних залишків):
-- застосунок рахує підсумки запитом по рухах.
CREATE TABLE accepted.performer_settlements (
  org_id uuid NOT NULL REFERENCES accepted.organization (id) ON DELETE RESTRICT,
  period timestamptz NOT NULL,
  recorder_type text NOT NULL CHECK (recorder_type IN ('service_accrual')),
  recorder_id uuid NOT NULL,
  line_number integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  movement_type text NOT NULL CHECK (movement_type IN ('Receipt', 'Expense')),
  performer_id uuid REFERENCES accepted.counterparty (id),
  currency_id uuid REFERENCES accepted.currency (id),
  amount numeric(15, 2) NOT NULL
);

CREATE INDEX ON accepted.performer_settlements (org_id, period);
CREATE INDEX ON accepted.performer_settlements (currency_id);

ALTER TABLE accepted.performer_settlements ENABLE ROW LEVEL SECURITY;

CREATE TABLE accepted.income_expenses (
  org_id uuid NOT NULL REFERENCES accepted.organization (id) ON DELETE RESTRICT,
  period timestamptz NOT NULL,
  recorder_type text NOT NULL CHECK (recorder_type IN ('service_accrual')),
  recorder_id uuid NOT NULL,
  line_number integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  counterparty_id uuid REFERENCES accepted.counterparty (id),
  accrual_kind text
    CHECK (accrual_kind IN ('regular', 'bonus', 'correction')),
  income numeric(15, 2) NOT NULL,
  expense numeric(15, 2) NOT NULL
);

CREATE INDEX ON accepted.income_expenses (org_id, period);

ALTER TABLE accepted.income_expenses ENABLE ROW LEVEL SECURITY;
