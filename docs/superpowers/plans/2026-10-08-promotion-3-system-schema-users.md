# Промоція-3 — системна схема `simetra` і користувачі: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** проєкт із системним довідником «Користувачі» отримує платформний
шар у схемі `simetra` (ідентичності, поточний користувач, провізія
Supabase, довідник міток виду), а метамодель — роль «користувачі»,
авторство `trackAuthor`, членство `membership` і знеособлення
`personalData`; ім'я схеми `simetra` зарезервоване за платформою.

**Архітектура:** T0 отримує поля `role`, `trackAuthor`, `membership`,
`personalData`, форму `setFunction: "membership"`, стандартну ціль `ref:
"users"` і правило зарезервованої схеми. T1 резолвить «Користувачі»,
виводить колонки авторства й унікальність членства, генерує SQL-одиниці
членства (як обгортки рухів) і будує контракти `users`, `membership`,
`personalData`. T2 отримує чисту функцію `renderPlatformState(model)`:
«голова» (схема, таблиця, функції, тригери, в'юха, гранти) і «хвіст» (FK
ідентичностей), які `renderDesiredState` ставить до й після об'єктів
застосунку; `engineScope` керує схемою `simetra`, коли шар не порожній.
Вимикач шару — наявність довідника з роллю «користувачі».

**Технології:** TypeScript 7, Zod 4, Vitest, libpg-query 17.7.4, локальний
стек Supabase (Postgres 17), `@supabase/pg-delta` (без зміни версії).

**Спека:** [спека системної схеми й користувачів](../specs/2026-10-07-system-schema-users-design.md)
С1–С10, §3–§8, §10, §11.2; [спека промоції](../specs/2026-10-06-promotion-design.md)
§9.10, §9.11, Пр19, §16 п.7; [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3, §5, §6, §8.3, §10.1, §13; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.1, §6.7, §6.8, §6.9.

**Передумова:** плани 2a і 2b виконано (мітка виду, `ASSIGNED_ONCE`, вид
`EventSubscription`, закриті форми, перелік боргу); `orient --plan` цього
файлу; локальний стек (`pnpm db:start`). На checkout працює одна сесія, що
комітить.

**Архітектор задачі:** сесія `consumer-reconciliation`. Розвилки й тексти
правок спек — до неї (`SendMessage`); якщо сесії немає — до власника.

**Поза планом (свідомо):** таблиця лічильників нумерації й функція номера —
план генерації нумерації П3 (ключ «мітка виду» вже в контракті
нумерації); захист платформних колонок «Користувачів» (колонкові гранти +
тригер) і `userKind` анонімних входів — П3; команда знеособлення й
заповнення авторства в `runCommand` — П4; згенеровані політики (RLS, Storage,
Realtime) — П3; адаптери інших провайдерів ідентичності й JIT-провізія;
окрема вісь провайдера ідентичності в `project.meta.json` (з'явиться з
другим провайдером); marker, ledger, outbox, журнал DDL.

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Поведінка коду чи спеки поза
  рішеннями нижче — стоп і звіт архітекторові.
- 🔴 **Правки спек — один docs-коміт, текст до коміту переглядає
  архітектор** (задача 1).
- 🔴 **Ратчет полів:** кожне нове поле — у
  `packages/simetra/src/compiler/__tests__/fixtures/kitchen-sink.ts` і з
  читачем; `packages/simetra/test/field-ratchet.test.ts` зелений без нових
  винятків.
- Схема дозволяє лише те, що приймає компілятор: поле, яке правило завжди
  відхиляє, у схемі цього виду не існує.
- Кожне розгалуження за видом читає реєстр видів (нові факти — поля
  `KindDefinition`).
- Кожна функція платформного шару — `SECURITY DEFINER`, `SET search_path =
  ''`, повністю кваліфіковані імена; `REVOKE EXECUTE … FROM PUBLIC` на кожну;
  `EXECUTE` — явно й лише там, де названо (С1, §3).
- Кожен виклик поточного користувача в згенерованому SQL — лише
  `(select simetra.current_user_id())` (С9).
- Провізія ніколи не падає на даних облікового запису: помилка в тригері
  зриває реєстрацію (С3, С10).
- FK на таблиці провайдера (`auth.users`) немає (С4, С8).
- Нове правило — `SCHEMA_RULES` (`model/schemas/rules.ts`) або
  `COMPILER_RULES` (`compiler/diagnostics.ts`) і тексти en/uk у
  `compiler/messages.ts`; поля схем — з `.meta({ description })`; після
  зміни Zod-форми — `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`.
- Без шимів; коментарі — українською, «чому»; 🔴 без `--` перед шаблоном
  vitest; коміти — Conventional Commits українською, без трейлерів.

## Рішення плану

Рішення ухвалив архітектор задачі (сесія `consumer-reconciliation`)
2026-10-08; рішення 12 — автор плану з технічної причини, названої в ньому.

1. **Платформний шар — окремий рендер T2** `renderPlatformState(model)`,
   чиста функція версії пакета й контрактів моделі; таблиці знімка й T0
   `PhysicalOrigin` не змінюються. `engineScope` додає `simetra` до
   керованих схем, коли шар не порожній, — дрейф шару видно в звичайному
   `diff`.
2. **Вимикач шару** — наявність довідника з `role: "users"`. Без нього шар
   порожній: прийом наявної бази (`introspect → diff`) і round-trip-тести не
   змінюються (Пр19 — перехідний стан §10 спеки користувачів).
3. **Довідник міток** — `VIEW simetra.kind_labels (label, kind, object_id,
   name, schema, table_name)` над `VALUES` з моделі (лише об'єкти з
   `kindLabel`; без них — `SELECT … WHERE false` з типізованими колонками);
   `label` — `text COLLATE "C"`. Грантів ролям застосунку немає.
4. **Лічильники нумерації — не тут** (план генерації нумерації П3).
5. **«Користувачі» — файл довідника з `role: "users"`.** Реєстр додає
   стандартні `userKind` (`user_kind text NOT NULL DEFAULT 'human'`, CHECK
   `IN ('human', 'agent')`) і `invalid` (`invalid boolean NOT NULL DEFAULT
   false`). Правила: щонайбільше один на проєкт; `scope: "none"`;
   `descriptionLength > 0` (найменування — відображуване ім'я). Власний
   реквізит з `required` без `defaultValue` — помилка: провізія вставляє
   рядок без даних застосунку, і `NOT NULL` без значення зірвав би реєстрацію.
6. **`trackAuthor: true`** — на видах із фактом реєстру `authorTracking`
   (Catalog, Document). Стандартні `createdBy` ↔ `created_by_id`, `updatedBy`
   ↔ `updated_by_id` — `ref: "users"` (нова ціль `StandardColumnDef.ref`), FK
   `NO ACTION`, nullable, індекс як у інших стандартних посилань. Без
   довідника «Користувачі» — помилка `users.catalog-missing`.
7. **`membership: { user: "<реквізит>" }`** на скоупленому довіднику;
   реквізит — скалярний `Ref` на «Користувачі», nullable (запрошений, ще не
   зареєстрований учасник). Виводиться: `UNIQUE (носій скоупу, користувач)`
   **NULLS DISTINCT** (кілька запрошень без користувача в тенанті дозволено,
   той самий користувач двічі — помилка БД); згенерована одиниця «мій
   учасник» `<схема>.<таблиця>_my_member(p_scope uuid) RETURNS uuid`, що
   шукає лише за ненульовим користувачем; функція множини виду скоупу з
   `setFunction: "membership"` — `<схема>.<таблиця>_member_scopes() RETURNS
   SETOF uuid`. Обидві — `LANGUAGE sql STABLE SECURITY DEFINER SET
   search_path = ''` з `(select simetra.current_user_id())`. Щонайбільше один
   довідник членства на вид скоупу. Генерація — у П2, як обгортки рухів.
8. **`personalData: true`** — властивість реквізиту будь-якого виду;
   разом із `required` — помилка (знеособлення ставить `NULL`). Контракт
   `contracts.personalData`; команда знеособлення — П4.
9. **Платформний шар Supabase:**
   - `CREATE SCHEMA simetra`; `REVOKE ALL ON SCHEMA simetra FROM PUBLIC`;
     `GRANT USAGE ON SCHEMA simetra TO authenticated, anon` (виклик функції
     в політиці виконується від ролі запиту; схему від PostgREST ховає
     конфіг `db-schemas` провайдера, а не відсутність `USAGE`);
   - `simetra.identities (provider text, subject text, user_id uuid NOT NULL,
     PRIMARY KEY (provider, subject), UNIQUE (user_id, provider))`; FK
     `user_id` → «Користувачі» `DEFERRABLE INITIALLY DEFERRED` («хвіст»);
     персональних даних немає;
   - `simetra.current_user_id() RETURNS uuid` — `LANGUAGE plpgsql STABLE
     SECURITY DEFINER SET search_path = ''`: `sub` з
     `nullif(current_setting('request.jwt.claims', true), '')::jsonb`,
     пошук у `identities` за ключем провайдера, `user_id` лише коли рядок
     «Користувачі» не `invalid`; інакше `NULL` (нечисловий `sub` — `NULL`
     без помилки). `GRANT EXECUTE … TO authenticated, anon`;
   - `simetra.provision_user(p_provider text, p_subject text, p_user_id
     uuid, p_display_name text) RETURNS uuid` — вставка ідентичності `ON
     CONFLICT DO NOTHING`; наявна ідентичність → наявний `user_id`; інакше
     вставка рядка «Користувачі» (`id`, найменування — `left(p_display_name,
     <descriptionLength>)`) `ON CONFLICT (id) DO NOTHING`. Логіки застосунку не
     викликає;
   - тригер `simetra_provision_user AFTER INSERT ON auth.users` → функція
     `simetra.on_auth_user_created()`: `NEW.is_anonymous` → нічого не робить
     (анонімні входи не провізуються); найменування —
     `coalesce(full_name, name, email, 'user ' || left(NEW.id::text, 8))` з
     `raw_user_meta_data` і `email` — ніколи не `NULL`;
   - тригери недійсності `AFTER DELETE ON auth.users` і `AFTER UPDATE OF
     deleted_at ON auth.users` (лише коли `deleted_at` став ненульовим) →
     `simetra.on_auth_user_removed()`: видаляє рядок `identities`, ставить
     `invalid = true`; рядок «Користувачі» не видаляє;
   - ключ провайдера ідентичності — тимчасово з `database.provider`
     (`'supabase'`), з коментарем у коді: окрема вісь з'явиться з другим
     провайдером ідентичності.
10. **`sql.bare-current-user`** (стадія 5): `simetra.current_user_id()` у
    `USING`/`WITH CHECK` дослівного `CREATE POLICY` не всередині підзапиту —
    помилка.
11. **Резервування `simetra`:** схема об'єкта, `project.defaultSchema`,
    `scopeKinds[].setFunction.schema`, `scopeKinds[].root.external.schema`,
    `CustomTable.foreignKeys[].references.external.schema`,
    `EventSubscription.handler.schema` і тека `sql/simetra/` —
    `schema.reserved`; `introspect` відмовляє на `simetra`, як на схемі
    провайдера. Приклад переходить на нову модель (закриває §11.2 спеки
    користувачів).
12. **Голова й хвіст шару.** `renderPlatformState` повертає `{ head; tail }`:
    голова — схема, `identities` без FK, функції (plpgsql — тіла не
    перевіряються на існування таблиць при створенні), тригери на
    `auth.users`, в'юха, гранти; хвіст — FK `identities` → «Користувачі».
    `renderDesiredState` ставить голову одразу після `CREATE SCHEMA`, хвіст —
    після FK застосунку. *Чому не окремий файл `platform.sql` у тіні:* FK на
    таблицю «Користувачі», яку створює `desired.sql`, у файлі перед ним
    неможливий, а згенеровані функції членства й функції множини застосунку
    викликають `simetra.current_user_id()` і мусять іти після голови. Так
    тінь і ціль отримують шар тим самим SQL без зміни адаптера.

## Review Focus

1. **Довідник «Користувачі» з власним `required`-реквізитом без значення
   заповнення** зірвав би реєстрацію — компілятор відхиляє (задача 4), а
   DB-тест провізії вставляє рядок у довідник із власним реквізитом зі
   значенням заповнення (задача 9).
2. **Відображуване ім'я, довше за `descriptionLength`,** обрізається, а не
   валить вставку — DB-тест (задача 9).
3. **Вхід телефоном без email і метаданих** дає найменування `user xxxxxxxx`
   — DB-тест (задача 9).
4. **Повторна провізія того самого облікового запису** (повторний тригер чи
   ручний виклик) не створює другого користувача — DB-тест (задача 9).
5. **Користувач, що став недійсним, із чинним токеном** не бачить рядків
   через політику з обгорткою — DB-тест під `SET LOCAL ROLE authenticated`
   (задача 9).

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** — (лише читання)

- [ ] **Step 1: Якори**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-08-promotion-3-system-schema-users.md`
Expected: якори існують, крім позначених `Create`. Інакше — стоп і звіт.

- [ ] **Step 2: Базова лінія**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`,
`pnpm metadata:check`, `pnpm db:start && pnpm test:db`
Expected: зелено.

---

### Task 1: Правки спек (один docs-коміт, перегляд архітектора)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` (§5, §6, §8.3, §13)
- Modify: `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` (§3, §12)
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (Пр19)

- [ ] **Step 1: Написати правки**

1. Спека П2 §6 і §13: `membership` — уже в П2 (рішення 7), з переліку «Не в
   П2» і «Пізніше» прибрати; форма `setFunction: "membership"`.
2. Спека П2 §5 «Користувачі й авторство»: `role: "users"` на довіднику;
   стандартна ціль `ref: "users"`; фізичні імена `created_by_id`,
   `updated_by_id`; правило `required` без значення заповнення в
   «Користувачах».
3. Спека П2 §8.3: платформний шар — чиста функція T2 над контрактами
   (голова й хвіст навколо бажаного стану застосунку, рішення 12); вимикач
   — довідник «Користувачі»; `engineScope` керує `simetra`, коли шар не
   порожній.
4. Спека користувачів §3: одне речення — ролі API мають `USAGE ON SCHEMA
   simetra` (виклик функції в політиці виконується від ролі запиту);
   невидимість для PostgREST тримає конфіг `db-schemas` провайдера. Пункт
   «`USAGE` — лише ролям, яким потрібні функції сесії» узгодити з цим.
5. Спека користувачів §12, рядок «Як платформа рендерить вміст `simetra`»:
   відповідь — рішення 1, 2, 12 (з посиланням на спеку П2 §8.3); marker і
   перше застосування — П3. Рядок «Склад `userKind`»: анонімні входи в П2 не
   провізуються, решта — П3.
6. Спека промоції Пр19: порожній план прийому — для проєкту без довідника
   «Користувачі»; з ним план містить платформний шар.

- [ ] **Step 2: Якори**

Run: `python3 scripts/check-doc-anchors.py`
Expected: чисто.

- [ ] **Step 3: Перегляд архітектора**

Надіслати `git diff` сесії `consumer-reconciliation`; правки за відповіддю —
до коміту.

- [ ] **Step 4: Коміт**

```bash
git add docs/superpowers/specs/
git commit -m "docs(spec): системна схема й користувачі в П2 — платформний шар, роль users, membership, USAGE схеми simetra"
```

---

### Task 2: Резервування схеми `simetra`

**Files:**
- Create: `packages/simetra/src/model/schemas/pg-schema.ts` (`RESERVED_SCHEMA = "simetra"`, `appSchemaNameSchema`)
- Modify: `packages/simetra/src/model/schemas/object-header.ts`, `project.ts`, `scope.ts`, `custom-table.ts`, `event-subscription.ts` (поля з рішення 11 — через `appSchemaNameSchema`)
- Modify: `packages/simetra/src/model/schemas/rules.ts` (`schema.reserved`)
- Modify: `packages/simetra/src/compiler/stages/files.ts` (тека `sql/simetra/`)
- Modify: `packages/simetra/src/compiler/messages.ts`
- Modify: `packages/designer/src/tools/database-tools.ts` (`introspect` відмовляє на `simetra`)
- Test: `packages/simetra/src/model/__tests__/kind-schemas.test.ts`, `scope-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/stage-files.test.ts`, `packages/designer/src/__tests__/catalog.test.ts`

**Interfaces:**
- Produces: `appSchemaNameSchema: z.ZodString` (рядок, не `"simetra"`,
  правило `schema.reserved`); `RESERVED_SCHEMA`.

- [ ] **Step 1: Failing tests**

```ts
it.each([
  ["object schema", { kind: "Catalog", schema: "simetra" }],
  ["defaultSchema", { defaultSchema: "simetra" }],
  ["external root", { scopeKinds: [{ root: { external: { schema: "simetra", table: "t", column: "id" } } }] }],
])("%s simetra is reserved", …)                       // правило schema.reserved
it("an sql file under sql/simetra is reserved", …)    // stage-files: schema.reserved на файлі
it("introspect refuses schema simetra", …)            // designer: відмова з тим самим повідомленням, що й для схем провайдера
```

Run: `pnpm --filter simetra test kind-schemas scope-schemas stage-files` і `pnpm --filter @simetra/designer test catalog`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 11; повідомлення en «Schema
simetra belongs to the platform», uk — відповідник.

- [ ] **Step 3: Зелено, JSON Schema**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra packages/designer
git commit -m "feat(model): схема simetra зарезервована за платформою"
```

---

### Task 3: `personalData`

**Files:**
- Modify: `packages/simetra/src/model/schemas/attribute.ts` (`attributeShape`), `rules.ts`
- Modify: `packages/simetra/src/compiler/contracts.ts` (`personalData`)
- Test: `packages/simetra/src/model/__tests__/value-type.test.ts`, `packages/simetra/src/compiler/__tests__/contracts.test.ts`

**Interfaces:**
- Produces: поле `personalData?: true`; правило
  `attribute.personal-data-required`; `Contracts.personalData: { objectId:
  string; table: QualifiedName; columns: string[] }[]` (фізичні колонки,
  обидві для поліморфної пари; ТЧ — окремий запис зі своєю таблицею).

- [ ] **Step 1: Failing tests**

```ts
it("personalData with required is an error", …)                  // attribute.personal-data-required
it("contracts list personal columns per table", async () => {
  // довідник з phone (personalData) і ТЧ contacts з email (personalData)
  expect(contracts.personalData).toEqual([
    { objectId: …, table: { schema: "public", name: "person" }, columns: ["phone"] },
    { objectId: …, table: { schema: "public", name: "person_contacts" }, columns: ["email"] },
  ])
})
```

Run: `pnpm --filter simetra test value-type contracts`
Expected: FAIL.

- [ ] **Step 2: Реалізація; kitchen-sink; JSON Schema.**

Run: `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 3: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): властивість personalData і контракт персональних колонок"
```

---

### Task 4: Роль довідника «користувачі»

**Files:**
- Modify: `packages/simetra/src/model/schemas/catalog.ts` (`role`)
- Modify: `packages/simetra/src/model/kinds/catalog.ts` (`standardColumns` — `userKind`, `invalid` за роллю)
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` (правила ролі), `contracts.ts` (`users`), `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/users.test.ts` (Create), `stage-model.test.ts`

**Interfaces:**
- Produces:
  - `role?: "users"` у схемі довідника.
  - Стандартні колонки за рішенням 5 (логічні `userKind`, `invalid`; власний
    реквізит із цим іменем — наявне `identity.name-reserved`).
  - Правила: `users.catalog-duplicate`, `users.scope-not-none`,
    `users.description-required`, `users.required-without-default`.
  - `Contracts.users?: { objectId: string; table: QualifiedName; keyColumn:
    "id"; descriptionColumn: string; descriptionLength: number;
    invalidColumn: "invalid"; userKindColumn: "user_kind" }`.
  - `usersCatalogOf(objects: readonly ParsedObject[]): ParsedObject | undefined`
    у `compiler/stages/model.ts` (споживають задачі 5–8).

- [ ] **Step 1: Failing tests**

```ts
it("a users catalog gets user_kind and invalid", async () => {
  const users = tableOf(physical, "users")
  expect(users.columns).toContainEqual(expect.objectContaining({ name: "user_kind", type: "text", notNull: true, default: "'human'::text" }))
  expect(users.columns).toContainEqual(expect.objectContaining({ name: "invalid", type: "boolean", notNull: true, default: "false" }))
  expect(users.checks).toContainEqual(expect.objectContaining({ expression: "user_kind IN ('human', 'agent')" }))
})
it.each([
  ["two users catalogs", "users.catalog-duplicate"],
  ["scoped users catalog", "users.scope-not-none"],
  ["descriptionLength 0", "users.description-required"],
  ["own required attribute without defaultValue", "users.required-without-default"],
])("%s is an error", …)
it("contracts.users describes the table", …)
it("no users catalog — no contracts.users", …)
```

(Точне написання `default` — як рендерить наявний механізм стандартних
колонок; звірити з сусідніми тестами `deletion_mark`.)

Run: `pnpm --filter simetra test users stage-model`
Expected: FAIL.

- [ ] **Step 2: Реалізація; kitchen-sink (довідник «Користувачі»); JSON Schema.**

Run: `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 3: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): системний довідник «Користувачі» — роль users, платформні реквізити, контракт"
```

---

### Task 5: Авторство `trackAuthor`

**Files:**
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`StandardColumnDef.ref` + `"users"`, `KindDefinition.authorTracking?: true`, будівельник `authorColumns()`)
- Modify: `packages/simetra/src/model/kinds/catalog.ts`, `document.ts` (факт; колонки за `trackAuthor`)
- Modify: `packages/simetra/src/model/schemas/catalog.ts`, `document.ts` (`trackAuthor`)
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`standardTargetRefs` — третій параметр), `identity.ts` (резолв), `integrity.ts` (`users.catalog-missing`), `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/users.test.ts`

**Interfaces:**
- Consumes: `usersCatalogOf` (задача 4).
- Produces: `trackAuthor: boolean` (default `false`);
  `standardTargetRefs(column: StandardColumnDef, data: unknown, users: MetadataRef | undefined): MetadataRef[]`
  — для `ref: "users"` повертає `[users]` або `[]`; правило
  `users.catalog-missing` (pointer — `/trackAuthor`, `/membership` чи
  `scopeKinds[].root`).

- [ ] **Step 1: Failing tests**

```ts
it("trackAuthor adds created_by_id and updated_by_id referencing users", async () => {
  const sale = tableOf(physical, "sale")
  expect(sale.columns.filter((c) => c.name.endsWith("_by_id")).map((c) => [c.name, c.notNull]))
    .toEqual([["created_by_id", false], ["updated_by_id", false]])
  expect(sale.foreignKeys).toContainEqual(expect.objectContaining({
    columns: ["created_by_id"], references: { schema: "public", table: "users", columns: ["id"] }, onDelete: "noAction",
  }))
})
it("trackAuthor without a users catalog is an error", …)   // users.catalog-missing
```

(Значення `onDelete` — у тому написанні, яке має наявний `FkAction`.)

Run: `pnpm --filter simetra test users`
Expected: FAIL.

- [ ] **Step 2: Реалізація; kitchen-sink; JSON Schema.**

Run: `pnpm --filter simetra test`, `pnpm test:db`
Expected: PASS.

- [ ] **Step 3: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): авторство trackAuthor — createdBy і updatedBy на «Користувачі»"
```

---

### Task 6: Членство `membership` і функція множини з членства

**Files:**
- Modify: `packages/simetra/src/model/schemas/catalog.ts` (`membership`), `scope.ts` (`setFunction: … | "membership"`)
- Create: `packages/simetra/src/compiler/membership-functions.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts` (злиття згенерованих одиниць, як `buildMovementFunctions`; `CompiledScopeKind.setFunction` для `"membership"` — ім'я згенерованої функції)
- Modify: `packages/simetra/src/compiler/stages/model.ts` (унікальність), `integrity.ts`, `links.ts` (`checkSetFunctions` не перевіряє згенеровану), `contracts.ts` (`membership`), `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/membership.test.ts` (Create); DB-поведінку членства перевіряє задача 8 (крок 4): функції викликають `simetra.current_user_id()`, якої до неї немає

**Interfaces:**
- Consumes: `usersCatalogOf`, `standardTargetRefs` (задачі 4–5).
- Produces:
  - `membership?: { user: string }` у схемі довідника; `setFunction:
    { schema?: string; name: string } | "membership"`.
  - `buildMembershipFunctions(objects: readonly ParsedObject[], physical: PhysicalSnapshot, project: Project): SqlUnit[]`
    — одиниці класу `function` без `file`, з `ownerObjectId` довідника
    членства; тексти за рішенням 7.
  - `Contracts.membership: { objectId; scopeKindId; table: QualifiedName; scopeColumn; userColumn; myMemberFunction: QualifiedName; setFunction?: QualifiedName }[]`.
  - Правила: `membership.not-scoped`, `membership.user-not-users-ref`
    (реквізит відсутній, масив, поліморфний чи не на «Користувачі»),
    `membership.duplicate` (два на один вид скоупу),
    `scope.membership-missing` (`setFunction: "membership"` без довідника
    членства).

- [ ] **Step 1: Failing tests**

`membership.test.ts`:

```ts
it("membership derives a NULLS DISTINCT unique key and two generated functions", async () => {
  expect(tableOf(physical, "org_member").uniques).toContainEqual({ name: …, columns: ["org_id", "user_id"], nullsNotDistinct: false })
  const ids = model.sqlUnits.map((u) => u.identity)
  expect(ids).toEqual(expect.arrayContaining(["function:app.org_member_my_member(uuid)", "function:app.org_member_member_scopes()"]))
  const body = model.sqlUnits.find((u) => u.identity.endsWith("my_member(uuid)"))!.sql
  expect(body).toContain("(SELECT simetra.current_user_id())")
  expect(body).toContain("IS NOT NULL")
})
it("scope kind with setFunction membership uses the generated set function", …)   // CompiledScopeKind.setFunction = app.org_member_member_scopes
it.each([["unscoped", "membership.not-scoped"], ["user attribute is an array", "membership.user-not-users-ref"],
         ["two membership catalogs of one scope kind", "membership.duplicate"],
         ["setFunction membership without a catalog", "scope.membership-missing"]])("%s", …)
```

Run: `pnpm --filter simetra test membership`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішенням 7; тексти функцій — через
`quoteIdent`/`sqlLiteral`, як у `movement-functions.ts`.

- [ ] **Step 3: Зелено**

Run: `pnpm --filter simetra test`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra
git commit -m "feat(model): членство membership — унікальність, «мій учасник», функція множини з членства"
```

---

### Task 7: `sql.bare-current-user`

**Files:**
- Modify: `packages/simetra/src/compiler/stages/links.ts`, `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-links.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it("a bare simetra.current_user_id() in a policy is an error", …)   // USING (owner_id = simetra.current_user_id()) → sql.bare-current-user
it("the wrapped call passes", …)                                    // USING (owner_id = (select simetra.current_user_id()))
it("WITH CHECK is checked too", …)
```

(Дослівна політика — у модулі `CustomTable` з переліком боргу через
`acceptDebt`.)

Run: `pnpm --filter simetra test stage-links`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — обхід дерева `CreatePolicyStmt.qual` і
`with_check`: `FuncCall` з іменем `simetra.current_user_id`, предки якого не
містять `SubLink`.

- [ ] **Step 3: Зелено, коміт**

Run: `pnpm --filter simetra test`
Expected: PASS.

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): голий виклик simetra.current_user_id() у політиці — помилка (С9)"
```

---

### Task 8: Платформний шар — `renderPlatformState`

**Files:**
- Create: `packages/simetra/src/schema/render/platform-state.ts`
- Modify: `packages/simetra/src/schema/render/desired-state.ts` (голова після `CREATE SCHEMA`, хвіст після FK)
- Modify: `packages/simetra/src/schema/render/index.ts`, `packages/simetra/src/schema/index.ts` (експорт)
- Modify: `packages/simetra/src/schema/engine/desired.ts` (`engineScope` — `simetra`, коли шар не порожній; `Pick` моделі з `contracts`)
- Test: `packages/simetra/src/schema/__tests__/platform-state.test.ts` (Create), `desired-state.test.ts`, `out-of-scope.test.ts`

**Interfaces:**
- Consumes: `contracts.users` (задача 4), мітки об'єктів (`CompiledModel.objects`), `project.database.provider`.
- Produces:
  - `renderPlatformState(model: Pick<CompiledModel, "project" | "objects" | "contracts">): { head: RenderedStatement[]; tail: RenderedStatement[] }`
    — обидва порожні без `contracts.users`.
  - `PLATFORM_SCHEMA = "simetra"`.

- [ ] **Step 1: Failing tests**

`platform-state.test.ts`:

```ts
it("no users catalog — empty platform layer", () => expect(renderPlatformState(modelWithoutUsers)).toEqual({ head: [], tail: [] }))
it("head creates the schema with USAGE for API roles only", () => {
  const sql = renderPlatformState(model).head.map((s) => s.sql).join("\n")
  expect(sql).toContain("REVOKE ALL ON SCHEMA simetra FROM PUBLIC")
  expect(sql).toContain("GRANT USAGE ON SCHEMA simetra TO authenticated, anon")
})
it("every platform function is SECURITY DEFINER with an empty search_path and no PUBLIC execute", …)
it("current_user_id is executable by authenticated and anon only", …)
it("kind_labels lists every labelled object in C collation", …)
it("the identities FK is in the tail, deferred", () => {
  expect(renderPlatformState(model).tail.map((s) => s.sql)).toEqual([expect.stringContaining("DEFERRABLE INITIALLY DEFERRED")])
})
it("provision truncates the display name to descriptionLength", …)  // текст містить left(…, 150) для descriptionLength 150
```

`desired-state.test.ts`: голова йде після `CREATE SCHEMA` застосунку й до
першої таблиці; хвіст — останній. `out-of-scope.test.ts`: модель із
«Користувачами» дає `simetra` у `scope.schemas`, без них — ні.

Run: `pnpm --filter simetra test platform-state desired-state out-of-scope`
Expected: FAIL.

- [ ] **Step 2: Реалізація** — за рішеннями 3, 9, 12; кожен оператор —
окремий `RenderedStatement`; тіла функцій — plpgsql, імена таблиці й колонок
«Користувачів» — з `contracts.users` через `quoteIdent`.

- [ ] **Step 3: Зелено**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`
Expected: PASS.

- [ ] **Step 4: DB-тест членства (поведінка задачі 6)**

Create `packages/simetra/test/db/membership.db.test.ts` (розгортання
`renderDesiredState(model).sql` у `withRollback`, як
`reference-domain.db.test.ts`): два учасники без користувача в одному
тенанті — вставка проходить; той самий користувач двічі — `unique_violation`;
`<схема>.org_member_my_member(<org>)` під claims користувача повертає його
учасника, а для учасника без користувача — нікого.

Run: `pnpm --filter simetra test:db membership`
Expected: PASS.

- [ ] **Step 5: Коміт**

```bash
git add packages/simetra
git commit -m "feat(schema): платформний шар simetra — ідентичності, поточний користувач, провізія Supabase, довідник міток"
```

---

### Task 9: Поведінка платформного шару на стеку

**Files:**
- Modify: `packages/simetra/test/db/connection.ts` (`asRole(client, role, claims)` — `SET LOCAL ROLE` + `set_config('request.jwt.claims', …, true)`)
- Create: `packages/simetra/test/db/platform-users.db.test.ts`
- Modify: `packages/designer/src/schema-engine/__tests__/engine-desired.db.test.ts` (round-trip шару)

**Interfaces:**
- Produces: `asRole(client: pg.Client, role: "authenticated" | "anon", claims: Record<string, unknown>): Promise<void>`.

- [ ] **Step 1: Failing tests**

`platform-users.db.test.ts` (у `withRollback`: розгорнути
`renderDesiredState(model).sql` моделі з «Користувачами» з власним
реквізитом зі значенням заповнення, далі вставки в `auth.users`):

```ts
it("signup provisions one identity and one user", …)            // INSERT INTO auth.users(id, email, raw_user_meta_data) → рядок identities і рядок users з найменуванням full_name
it("provisioning twice keeps one user", …)                       // повторний SELECT simetra.provision_user(...) → той самий id, рядків не додалось
it("anonymous signup is not provisioned", …)                     // is_anonymous = true → жодного рядка
it("phone signup gets a neutral display name", …)                // без email і метаданих → 'user ' || left(id, 8)
it("a long display name is truncated", …)
it("deleting the account invalidates the user and keeps the row", …)
it("soft-deleting the account invalidates the user", …)          // UPDATE auth.users SET deleted_at = now()
it.each([["valid", "id"], ["invalid", "null"], ["non-uuid sub", "null"], ["anon without sub", "null"]])(
  "current_user_id for %s", …)
it("authenticated sees rows through a wrapped policy and cannot read identities", async () => {
  // таблиця з RLS і політикою USING (owner_id = (select simetra.current_user_id()))
  // asRole(client, "authenticated", { sub: <id>, role: "authenticated" }) → бачить свій рядок
  // SELECT FROM simetra.identities → помилка 42501 permission denied
})
it("an invalid user with a valid token sees nothing", …)
```

`engine-desired.db.test.ts`: розгорнутий бажаний стан моделі з
«Користувачами» → `diff` проти тіні дає порожній план (шар у межі, без
дрейфу); модель без «Користувачів» — `simetra` не в межі.

Run: `pnpm test:db`
Expected: FAIL до реалізації, якої бракує; якщо задача 8 уже робить усе —
тести проходять одразу, і це треба явно записати у звіт (тести писано
проти специфікації, а не проти коду).

- [ ] **Step 2: Виправлення за червоними тестами** — лише в
`platform-state.ts`; зміна рішень 9 чи 12 — стоп і до архітектора.

- [ ] **Step 3: Зелено, коміт**

Run: `pnpm test:db`
Expected: PASS.

```bash
git add packages/simetra/test packages/designer/src/schema-engine/__tests__ packages/simetra/src/schema
git commit -m "test(schema): платформний шар на стеку — провізія, недійсність, поточний користувач під ролями API"
```

---

### Task 10: Приклад, скіли, гейти

**Files:**
- Create: `examples/reference/metadata/catalogs/Users/Users.meta.json` (`role: "users"`, `scope: "none"`, власний реквізит `locale` зі значенням заповнення)
- Modify: `examples/reference/metadata/project.meta.json` (корінь `user` → `{ object: { kind: "Catalog", name: "Users" } }`; `org` — `setFunction: "membership"`)
- Delete: `examples/reference/metadata/custom-tables/OrgMember/` і `examples/reference/metadata/sql/app/accessible_org_ids.sql`
- Create: `examples/reference/metadata/catalogs/OrgMember/OrgMember.meta.json` (скоуп `org`, реквізит `user` — `Ref` на `Users`, `membership: { user: "user" }`)
- Modify: `examples/reference/metadata/custom-tables/UserSettings/UserSettings.meta.json` (FK на `Users`)
- Modify: `examples/reference/metadata/sql/app/accessible_user_ids.sql` (`simetra.current_user_id()` в обгортці)
- Modify: `examples/reference/accepted/*` (лише якщо паперовий тест вимагає)
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` («Користувачі», `trackAuthor`, `membership`, `personalData`, зарезервована `simetra`)
- Modify: `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` §11.2 — лише якщо архітектор просить прибрати закриті прогалини в docs-коміті задачі 1 (інакше не чіпати)

- [ ] **Step 1: Перевести приклад** — `node packages/designer/bin/simetra.mjs fix examples/reference/metadata` після правок файлів.

- [ ] **Step 2: Повні гейти**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
`pnpm metadata:check`, `pnpm test:db`, `python3 scripts/check-doc-anchors.py`
Expected: усе зелене; паперовий тест і reference-domain DB-тест — без
різниці, крім очікуваної (платформний шар і нові об'єкти прикладу);
неочікувана різниця — стоп і звіт.

- [ ] **Step 3: Коміт**

```bash
git add examples/reference packages/designer/skills
git commit -m "docs(designer): приклад на «Користувачах» і членстві; скіл метаданих — користувачі, авторство, членство"
```
