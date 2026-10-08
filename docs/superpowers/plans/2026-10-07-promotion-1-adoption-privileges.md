# Промоція-1 — виправлення привілеїв прийому (Р-1…Р-5): план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** санітарний round-trip `introspect → diff` прийнятої бази не губить
і не розширює привілеїв: відкликаний `PUBLIC` на функціях і типах, ACL схеми
`public`, колонкові гранти поруч із табличним відкликанням повертаються
дослівно; попередження про зарезервовані слова й шум тіні не з'являються на
нормальних схемах.

**Архітектура:** п'ять незалежних дефектів, два шари. У T0/T1 флагмана
`simetra` — категорія зарезервованого слова (Р-4) і порядок «відкликання
раніше за грант» на одному об'єкті (Р-3). У T2 — пресет провайдера Supabase
отримує базовий стан `public` і розширень та чисту функцію рендера засіву
тіні (Р-2, Р-5). В адаптері `@simetra/designer` — очікуваний `PUBLIC`
(вбудоване ∪ ADP схеми, Р-1), порівняння ACL `public` з пресетом (Р-2) і
засів тіні перед бажаним SQL (Р-2, Р-5).

**Технології:** TypeScript 7, Vitest 5, `@supabase/pg-delta`
**1.0.0-alpha.56** (без зміни версії), `pg` **8.23.1**, локальний стек
Supabase (Postgres 17).

**Спека:** [спека промоції](../specs/2026-10-06-promotion-design.md) §9.9,
Пр22, §16 п.1; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.9 (абзац «Очікувані привілеї `PUBLIC`…»); [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3 «Фізичні імена», §9 «Читач каталогу», §10.4 «Тінь». Знахідки —
[звірка першого споживача](../../research/reviews/metahub-reconciliation-2026-10.md) §2.

**Передумова:** перед стартом — `orient --plan` цього файлу; локальний стек
запущено (`pnpm db:start`). На checkout працює одна сесія, що комітить.

**Поза планом:** глобальні типові привілеї ролі (поза межею, §6.9 — їх не
читаємо і не пишемо); ADP провайдера в `public` (лишаються явними
одиницями); реєстр пресетів за ключем провайдера (з'явиться з другим
провайдером, рішення 9); датований план E2b не правиться.

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Якщо код поводиться не так, як
  описано в цьому плані або в спеці (§9.9, §6.9, П2 §9/§10.4), виконавець
  зупиняється і звітує власнику; мовчки не вирішує.
- Очікуване для `PUBLIC` = вбудоване Postgres за видом ∪ гранти ADP схеми;
  глобальний ADP ролі — поза межею (спека промоції §9.9).
- Схема `public` — керована; тінь засівається з фіксованого пресету
  провайдера; відмінність цілі від пресету — явна одиниця метаданих.
- Засів тіні копією ACL цілі заборонено (§9.9).
- Без нових залежностей; `@supabase/pg-topo` не додається.
- Без шимів і реекспортів старих імен (`AGENTS.md`, принцип 5).
- Наявні `physicalName` не змінюються (Р5): нове правило слів діє лише на
  нові елементи.
- Коментарі в коді — українською, «чому», а не «що»; повідомлення
  діагностик — англійською й українською, як у `compiler/messages.ts`.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`.
- Коміти — Conventional Commits з українським описом, без трейлерів.

## Рішення плану

Рішення 1–6 ухвалив архітектор спеки промоції (сесія
`consumer-reconciliation`) 2026-10-07; рішення 7–8 — автор плану, рішення 8
погоджено з тим самим архітектором.

1. **Р-1:** очікуване для пари (об'єкт, отримувач) = вбудоване (`PUBLIC`:
   `EXECUTE` на function/procedure/aggregate, `USAGE` на type/domain) ∪
   привілеї ADP схеми для того ж отримувача. Порожній маркер `PUBLIC`, який
   двигун синтезує для рядка ADP **схеми** (`extract/roles.js`), нічого не
   додає. `language` — поза обсягом. *Чому:* у Postgres ADP схеми лише
   додає до глобальних/вбудованих привілеїв і відкликати їх не може; зараз
   `expectedPrivileges` бере запис ADP **замість** вбудованого.
2. **Р-2, склад пресету `public` — лише ACL самої схеми:** `USAGE` для
   `PUBLIC`, `postgres`, `anon`, `authenticated`, `service_role` (зафіксовано
   на образі локального стеку 2026-10-07). ADP провайдера в `public`
   лишаються явними одиницями: рішення 6 плану E2a стоїть для ADP і
   скасовується лише для грантів самої схеми.
3. **Р-2, механіка:** один пресет — константа в
   `packages/simetra/src/schema/engine/provider/supabase.ts`; з неї (а)
   чиста T2-функція рендерить засів тіні, (б) адаптер порівнює ACL `public`
   цілі. Адаптер `withDesiredShadow` подає засів окремим файлом **перед**
   бажаним SQL лише в тінь. `renderDesiredState` засіву не містить — робоча
   база вже має базовий стан провайдера. Порівняння: рівне пресету — не
   одиниця; зайве — `GRANT`; бракує отримувача пресету (зокрема `PUBLIC`) —
   явний `REVOKE USAGE ON SCHEMA public FROM …`.
4. **Р-5 — у цьому плані:** перелік розширень базового стану — частина
   пресету: `pgcrypto`, `uuid-ossp`, `pg_stat_statements` у схемі
   `extensions` (`supabase_vault` і `plpgsql` не засіваються). Засів —
   `CREATE EXTENSION IF NOT EXISTS … WITH SCHEMA extensions` у тому ж файлі.
5. **Р-4:** «зарезервоване слово» = будь-яке не-UNRESERVED ключове слово
   `kwlist.h`, тобто рівно `PG_QUOTED_KEYWORDS`; рукописний
   `sql-reserved-words.ts` видаляється. `key`, `type` перестають бути
   зарезервованими; нові елементи з такими іменами суфікса `_` не
   отримують; наявні імена не змінюються.
6. **Спека designer §3.2:** рядок «базовий стан провайдера засівається з
   цілі» уточнюється винятком для `public` і розширень. Текст правки до
   коміту переглядає власник (сесії архітектора designer немає).
7. **Р-3 — одна істина порядку.** Порядок «табличне відкликання раніше за
   грант на той самий об'єкт» дає ребро в графі створення
   (`compiler/sql/dependencies.ts`): одиниця `GRANT` на об'єкт залежить від
   кожної одиниці `REVOKE` на той самий об'єкт (колонковий грант таблиці —
   теж на таблицю). Розкладка сайдкара (`reverse/units.ts`) у межах класу
   `grant` ставить `REVOKE` раніше за `GRANT`. *Чому:* рендер іде за
   `creationOrder`, а не за порядком у файлі; правка лише сайдкара шлях
   «компіляція → рендер → тінь» не лікує. Інших порядків гранту й
   відкликання на одному об'єкті, які мали б іти навпаки, немає: одиниці
   описують кінцевий стан, а табличний `REVOKE` знімає й колонкові гранти.
8. **Шум pg-topo:** адаптер передає `planSchemaFiles` опцію
   `reorderOnFailure: false`. *Чому:* без `@supabase/pg-topo` пересортування
   й так недоступне, а бажаний SQL уже впорядковано `creationOrder`; опція
   описує фактичну поведінку замість фільтра за текстом повідомлення.
   Тест доводить, що в каналі `frontend_warning` немає попередження про
   пересортування (задача 5). Запасний шлях — лише описаний тут відкат, а не
   код: якщо з опцією падає будь-який DB-тест, що проходив без неї, —
   відкотити опцію, відфільтрувати рівно повідомлення
   `reorder assist unavailable` на межі адаптера (з тим самим тестом) і
   назвати це у звіті. Рішення прийняв архітектор спеки промоції 2026-10-07.
9. **Провайдер бази — явний вибір у `project.meta.json`** (платформна спека
   §6.9: «пресет у конфігурації проєкту»; аудит Codex назвав вшитий
   `provider: "supabase"` блокером). Проєкт **вибирає** пресет ключем, **вміст**
   пресету — код платформи (факти образу провайдера). Поле вкладене —
   `database: { provider: "supabase" }`, бо спека користувачів вводить
   окрему вісь провайдера ідентичності (Supabase + Better Auth — валідна
   пара), і плоский `provider` був би неоднозначним. Поле **обов'язкове,
   без дефолту Zod**: тихий дефолт сховав би рішення застосунку; усі
   `project.meta.json` репо й фікстури оновлюються в тому самому коміті.
   Дефолт `"supabase"` діє лише на межі інструмента `introspect` для нової
   теки, а записаний файл несе поле явно. Реєстру пресетів за ключем немає
   (один провайдер); він з'явиться з другим. Рішення ухвалив архітектор
   спеки промоції 2026-10-07 за дорученням власника.

## Review Focus

1. **Тінь не відтворює ціль на звичайній схемі Supabase** — функції в
   `public` з вбудованим `EXECUTE` для `PUBLIC` після виправлення Р-1 не
   дають жодного `GRANT … TO PUBLIC` (задача 3, тест «builtin PUBLIC
   execute beside schema ADP»).
2. **Засів конфліктує із засівом припущених схем двигуна** (`extensions`
   уже засіяна з цілі разом із функціями розширень) — тест засіву на
   цілі-стеку й на цілі-тіні (задача 5); конфлікт — стоп і звіт.
3. **Стек, де `public` дорівнює пресету, після засіву дає порожній план без
   жодних одиниць на схему** — задача 6, оновлений тест `engine-scope`.
4. **Наявний `physicalName` з суфіксом `_`** (`key_`) після зміни правила не
   перевиводиться й не дає діагностик — задача 1.
5. **Табличний `REVOKE` і колонковий `GRANT` в одному сайдкарі** в обох
   шляхах (файл і рендер) — задача 2.

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** — (лише читання)

- [ ] **Step 1: Звірити якори плану**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-07-promotion-1-adoption-privileges.md`
Expected: усі шляхи й символи плану існують, крім файлів із позначкою
`Create` (зараз — `provider-preset.db.test.ts`). Інший зниклий якір — стоп і
звіт.

- [ ] **Step 2: Базова лінія тестів**

Run: `pnpm db:start`, далі `pnpm --filter simetra test` і `pnpm test:db`
Expected: зелено. Червоне до початку роботи — стоп і звіт (не лагодити
мовчки).

---

### Task 1: Р-4 — зарезервоване слово = ключове слово Postgres, яке `quote_ident` бере в лапки

**Files:**
- Modify: `packages/simetra/src/model/physical/pg-keywords.ts`
- Delete: `packages/simetra/src/model/schemas/sql-reserved-words.ts`
- Delete: `packages/simetra/src/model/__tests__/sql-reserved-words.test.ts`
- Modify: `packages/simetra/src/model/schemas/index.ts` (прибрати реекспорт)
- Modify: `packages/simetra/src/model/physical/index.ts` (експортувати `isSqlReservedWord`)
- Modify: `packages/simetra/src/model/physical/assign.ts`
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` (імпорт)
- Modify: `packages/simetra/src/compiler/messages.ts` (`physical.reserved-word`)
- Test: `packages/simetra/src/model/__tests__/pg-names.test.ts`,
  `packages/simetra/src/model/__tests__/assign.test.ts`,
  `packages/simetra/src/compiler/__tests__/stage-integrity.test.ts`

**Interfaces:**
- Produces: `isSqlReservedWord(name: string): boolean` у
  `model/physical/pg-keywords.ts` — `PG_QUOTED_KEYWORDS.has(name.toLowerCase())`;
  у `simetra/model` функція лишається через `model/physical/index.ts` (цей
  індекс зараз `pg-keywords` не експортує); константа `SQL_RESERVED_WORDS`
  зникає.

- [ ] **Step 1: Failing tests**

У `pg-names.test.ts`:

```ts
describe("isSqlReservedWord", () => {
  it("is every keyword quote_ident quotes, case-insensitive", () => {
    expect(isSqlReservedWord("check")).toBe(true) // RESERVED
    expect(isSqlReservedWord("Join")).toBe(true) // TYPE_FUNC_NAME
    expect(isSqlReservedWord("INT")).toBe(true) // COL_NAME
  })
  it("unreserved keywords and plain names are not reserved", () => {
    expect(isSqlReservedWord("key")).toBe(false)
    expect(isSqlReservedWord("type")).toBe(false)
    expect(isSqlReservedWord("index")).toBe(false)
    expect(isSqlReservedWord("orders")).toBe(false)
  })
})
```

У `assign.test.ts` поруч із «reserved word»:

```ts
it("an unreserved keyword takes no suffix", () => {
  expect(assignPhysicalName("key", { role: "field" }, none)).toBe("key")
  expect(assignPhysicalName("type", { role: "field" }, none)).toBe("type")
})
```

У `stage-integrity.test.ts` поруч із «reserved word is a warning»:

```ts
it("an existing suffixed name stays as is and is not a warning", async () => {
  // Правило слів змінилося, але physicalName призначено раз (Р5)
  const result = await compileWith({
    "catalogs/Order/Order.meta.json": catalog("Order", {
      attributes: [attribute("key", { physicalName: "key_" })],
    }),
  })
  expect(result.diagnostics).toEqual([])
  // знайти таблицю Order у result.model!.physical.tables і перевірити:
  // колонка атрибута має name === "key_"
})
it("an unreserved keyword as physicalName is not a warning", async () => {
  // attribute("type", { physicalName: "type" }) → diagnostics []
})
```

Плюс тест у `compiler/__tests__/operations-fix.test.ts`: `fix` над каталогом
з атрибутом `physicalName: "key_"` не змінює файл (порожній результат змін).

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter simetra test pg-names assign stage-integrity operations-fix`
Expected: FAIL на `key`/`type`/`index` (рукописний список їх містить) і на
відсутньому експорті з `pg-keywords.ts`.

- [ ] **Step 3: Implement**

`isSqlReservedWord` переїжджає в `pg-keywords.ts` поверх `PG_QUOTED_KEYWORDS`;
коментар файлу — один список для обох ролей (лапки `quote_ident` і
попередження про ім'я). `assign.ts`, `integrity.ts` імпортують звідти.
Повідомлення `physical.reserved-word`: «is a PostgreSQL keyword that must be
quoted» / «ключове слово Postgres, яке треба брати в лапки»; підказку
залишити за змістом.

- [ ] **Step 4: Run — PASS, і весь пакет**

Run: `pnpm --filter simetra test` і `pnpm --filter simetra typecheck`
Expected: PASS. Падіння іншого тесту через очікуване `<слово>_` — оновити
очікування лише там, де слово тепер unreserved, і назвати ці тести у звіті.

- [ ] **Step 5: Commit**

```bash
git add -A packages/simetra/src/model packages/simetra/src/compiler
git commit -m "fix(model): зарезервоване слово — ключове слово Postgres з kwlist.h, а не рукописний список (Р-4)"
```

---

### Task 2: Р-3 — табличне відкликання раніше за грант на тому самому об'єкті

**Files:**
- Modify: `packages/simetra/src/compiler/sql/dependencies.ts` (обробка `GrantStmt`)
- Modify: `packages/simetra/src/schema/reverse/units.ts` (`layoutUnits`, сортування в межах рангу)
- Test: `packages/simetra/src/compiler/__tests__/creation-order.test.ts`,
  `packages/simetra/src/schema/__tests__/reverse-generate.test.ts`,
  `packages/designer/src/schema-engine/__tests__/fixtures/round-trip-classes.ts`

**Interfaces:**
- Produces: правило графа — одиниця `GRANT` (`is_grant`) з
  `ACL_TARGET_OBJECT` має ребро до кожної одиниці `REVOKE` з тією самою
  ціллю (той самий `objtype` і об'єкт; колонковий грант — ціль таблиця).

- [ ] **Step 1: Failing tests**

`creation-order.test.ts`:

```ts
it("a table revoke goes before a grant on the same table", async () => {
  // Табличний REVOKE знімає й колонкові гранти: навпаки грант пропав би
  const list = await order({
    [MISC]:
      "GRANT SELECT (body) ON z.t TO anon;\n" +
      "REVOKE ALL ON z.t FROM anon;\n" +
      "CREATE TABLE z.t (id int, body text);",
  })
  const revoke = list.find((id) => id.startsWith("grant:revoke:"))!
  const grant = list.find((id) => id.startsWith("grant:grant:"))!
  expectBefore(list, [[revoke, grant]])
})
```

(Якщо `CREATE TABLE` в `MISC` не дозволений гейтом одиниць — узяти таблицю
з `codes([...])` як у сусідніх тестах.)

`reverse-generate.test.ts`:

```ts
it("a table revoke precedes a column grant in the sidecar", async () => {
  const result = await reverseGenerate(
    model({
      tables: [table("app", "note")],
      units: units(
        "GRANT SELECT (id) ON TABLE app.note TO anon;\n" +
          "REVOKE ALL ON TABLE app.note FROM anon;"
      ),
    }),
    options()
  )
  const sql = result.files.get("custom-tables/Note/Note.sql")!
  expect(sql.indexOf("REVOKE")).toBeLessThan(sql.indexOf("GRANT"))
})
```

Фікстура round-trip (у `CLASS_FIXTURES`):

```ts
{
  name: "column grant after a table revoke",
  schemas: ["app"],
  sql: `
    CREATE SCHEMA app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO anon;
    CREATE TABLE app.ledger (id uuid PRIMARY KEY, amount numeric);
    REVOKE ALL ON app.ledger FROM anon;
    GRANT SELECT (amount) ON app.ledger TO anon;
  `,
  property: (shape) =>
    shape.acls.find((a) => a.object === "c:app.ledger.amount")?.acl,
  expected: ["anon=r/postgres"],
},
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter simetra test creation-order reverse-generate`, потім
`pnpm --filter @simetra/designer test:db round-trip`
Expected: FAIL — `grant:grant:…` стоїть раніше за `grant:revoke:…`; у
фікстурі тінь без колонкового гранту.

- [ ] **Step 3: Implement**

Ребро в `dependencies.ts` за Interfaces; у `layoutUnits` ключ сортування в
межах рангу `grant`: спершу одиниці `grant:revoke:`, далі `grant:grant:`,
далі ідентичність. Коментар — чому (табличний `REVOKE` знімає колонкові).

- [ ] **Step 4: Run — PASS**

Run: ті самі команди, плюс `pnpm --filter simetra test` повністю.
Expected: PASS; цикл у графі не з'являється.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src packages/designer/src/schema-engine/__tests__
git commit -m "fix(schema): відкликання раніше за грант на тому самому об'єкті — і в графі створення, і в сайдкарі (Р-3)"
```

---

### Task 3: Р-1 — очікуваний `PUBLIC` = вбудоване ∪ ADP схеми

**Files:**
- Modify: `packages/designer/src/schema-engine/pg-delta/map-units.ts` (`expectedPrivileges`)
- Modify: `packages/designer/src/schema-engine/__tests__/fixtures/round-trip-classes.ts` (оракул і фікстури)
- Modify: `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts`

**Interfaces:**
- Consumes: `PUBLIC_DEFAULT`, `defaultsFor` (`map-units.ts`).
- Produces: `expectedPrivileges(fact, defaults)` повертає
  `privileges = union(builtin(grantee, kind), adp?.privileges ?? [])`,
  `grantable = adp?.grantable ?? []`; `builtin` — `PUBLIC_DEFAULT[kind]` лише
  для `PUBLIC` і лише для `type`, `domain`, `function`, `procedure`,
  `aggregate` (`language` не входить). Гілка `_ownerDefault` і колонкова —
  без змін.

- [ ] **Step 1: Розширити оракул**

`OracleShape.acls` отримує рядки `T:<схема>.<тип>` (`COALESCE(typacl,
acldefault('T', typowner))` для енамів, доменів, діапазонів і окремих
складених типів: `typtype IN ('e','d','r')` або `typtype = 'c'` з
`relkind = 'c'` — рядкові типи таблиць і масиви не беруться, належні
розширенням (`pg_depend.deptype = 'e'`) теж)
і `n:<схема>` (`COALESCE(nspacl, acldefault('n', nspowner))` для схем
`$1`). Прогнати `pnpm --filter @simetra/designer test:db round-trip` —
наявні фікстури лишаються зеленими (інакше — стоп і звіт: оракул знайшов
давню втрату).

- [ ] **Step 2: Failing fixtures**

```ts
{
  name: "PUBLIC execute revoked by a global ADP beside a schema ADP",
  schemas: ["app"],
  sql: `
    CREATE SCHEMA app;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon;
    CREATE FUNCTION app.secret() RETURNS int LANGUAGE sql AS $$ select 1 $$;
  `,
  property: (shape) =>
    shape.acls
      .find((a) => a.object === "f:app.secret()")
      ?.acl.filter((item) => item.startsWith("=")),
  expected: [],
},
{
  name: "PUBLIC usage revoked on a type and a domain beside a schema ADP",
  schemas: ["app"],
  sql: `
    CREATE SCHEMA app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE ON TYPES TO anon;
    CREATE TYPE app.mood AS ENUM ('ok', 'bad');
    CREATE DOMAIN app.positive AS int CHECK (VALUE > 0);
    REVOKE USAGE ON TYPE app.mood FROM PUBLIC;
    REVOKE USAGE ON DOMAIN app.positive FROM PUBLIC;
  `,
  property: (shape) =>
    shape.acls
      .filter((a) => a.object === "T:app.mood" || a.object === "T:app.positive")
      .map((a) => a.acl.filter((item) => item.startsWith("="))),
  expected: [[], []],
},
```

У `round-trip.db.test.ts` — окремий `describe` для зворотного напрямку:

```ts
it("builtin PUBLIC execute beside a schema ADP writes no PUBLIC grant", async () => {
  const sql = `
    CREATE SCHEMA app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon;
    CREATE FUNCTION app.open() RETURNS int LANGUAGE sql AS $$ select 1 $$;
  `
  // inTarget + roundTripOf як у циклі фікстур
  // expect(result.model.sqlUnits.filter((u) => /\bPUBLIC\b/i.test(u.sql))).toEqual([])
  // і в цілі, і в тіні ACL f:app.open() містить "=X/postgres"
})
```

Перша фікстура — рівно сценарій Р-1. Друга — типи й домени (§9.9 називає
обидва). Тест зворотного напрямку — відсутність зайвого гранту.

- [ ] **Step 3: Run — FAIL**

Run: `pnpm --filter @simetra/designer test:db round-trip`
Expected: перші дві фікстури — FAIL (у тіні `=X`/`=U` повернулися);
тест зворотного напрямку — FAIL (є `GRANT EXECUTE … TO PUBLIC`).
Якщо двигун поводиться інакше (немає порожнього маркера ADP схеми або
ACL-факту `PUBLIC`) — стоп і звіт: першопричину в плані виведено з
`extract/roles.js` і `extract/scope.js` alpha.56.

- [ ] **Step 4: Implement** `expectedPrivileges` за Interfaces. Коментар —
чому об'єднання (ADP схеми лише додає; маркер двигуна для рядка схеми
відкликання не означає).

- [ ] **Step 5: Run — PASS**

Run: `pnpm --filter @simetra/designer test:db` і
`pnpm --filter @simetra/designer test`
Expected: PASS, зокрема `engine-extract` («fresh/older/extra») без змін.

- [ ] **Step 6: Commit**

```bash
git add packages/designer/src/schema-engine
git commit -m "fix(designer): очікуваний PUBLIC — вбудоване разом з ADP схеми, явне відкликання на функціях, типах і доменах (Р-1)"
```

---

### Task 4: Провайдер бази — явний вибір у `project.meta.json` (рішення 9)

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`, `packages/simetra/src/model/schemas/index.ts`
- Modify: `packages/simetra/src/model/schemas/rules.ts` (код `project.database-required`)
- Modify: `packages/simetra/src/compiler/messages.ts`; за потреби `packages/simetra/src/compiler/stages/files.ts`
- Modify: `packages/simetra/src/schema/engine/port.ts`, `packages/simetra/src/schema/engine/desired.ts`
- Modify: `packages/simetra/src/schema/reverse/generate.ts` (`ReverseOptions.project`, запис нового файлу проєкту)
- Modify: `packages/designer/src/tools/database-tools.ts`, `packages/designer/src/cli/input.ts`
- Modify: `examples/reference/metadata/project.meta.json`, `packages/simetra/schemas/project.schema.json` (генерується)
- Modify: `packages/designer/skills/simetra-adoption/SKILL.md` (вхід `introspect` для нової теки)
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §6.9 — одне речення з іменем поля
- Modify: кожен тестовий опис проєкту — `packages/simetra/src/compiler/__tests__/helpers.ts` (`project()`),
  `packages/simetra/src/compiler/__tests__/fixtures/kitchen-sink.ts`,
  `packages/simetra/src/schema/__tests__/fixtures/e1-fixtures.ts`,
  `packages/designer/src/__tests__/helpers/catalog.ts` (`project()`), `round-trip.db.test.ts`
  (опції `roundTripOf`) і решта, яку знайде `grep -rln "defaultSchema" packages/*/src packages/*/test`
- Test: `packages/simetra/src/compiler/__tests__/stage-files.test.ts`,
  `packages/simetra/src/schema/__tests__/engine-desired.test.ts`,
  `packages/simetra/src/schema/__tests__/reverse-generate.test.ts`,
  `packages/designer/src/__tests__/cli.test.ts`, `packages/designer/src/__tests__/database-tools.db.test.ts`

**Interfaces:**
- Produces (`simetra/model`): `DATABASE_PROVIDERS = ["supabase"] as const`;
  `type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number]`;
  `projectSchema.database: z.strictObject({ provider: z.enum(DATABASE_PROVIDERS) })`
  — обов'язкове, одразу після `defaultSchema` (порядок `PROJECT_KEY_ORDER`
  виводиться зі схеми).
- Produces (`simetra/schema`): `EngineScope.provider: DatabaseProvider`;
  `engineScope(model)` бере `model.project.database.provider`;
  `ReverseOptions.project.databaseProvider: DatabaseProvider` — новий
  `project.meta.json` пише `database: { provider }`.
- Produces (designer): вхід `introspect` — `project.database.provider`
  (необов'язковий, `"supabase"` лише тут, для теки без проєкту); прапор CLI
  `--database-provider` тим самим механізмом, що `--project-name` і
  `--attribute-case`; у наявному проєкті межа береться з його файлу.
- Діагностика: файл проєкту без `database` або без `database.provider` —
  рівно одна помилка `project.database-required` (pointer `/database` або
  `/database/provider`), en/uk/hint у `messages.ts`, без супутньої
  `file.schema` на той самий pointer. Невідомий провайдер — звичайна
  `file.schema` переліку.

- [ ] **Step 1: Failing tests**

`stage-files.test.ts`:

```ts
it("a project without a database provider is an error with its own code", async () => {
  const { database: _omit, ...withoutDatabase } = project()
  const result = await compileWith({ "project.meta.json": withoutDatabase })
  expect(result.diagnostics.map((d) => [d.code, d.severity, d.pointer])).toEqual([
    ["project.database-required", "error", "/database"],
  ])
})
it("an unknown database provider is a schema error", async () => {
  // project({ database: { provider: "mysql" } }) → один file.schema на /database/provider
})
```

`engine-desired.test.ts`: `engineScope` повертає `provider` з
`model.project.database.provider`. `reverse-generate.test.ts`: новий
`project.meta.json` містить `"database": { "provider": "supabase" }`.
`cli.test.ts`: `--database-provider supabase` потрапляє у вхід, невідоме
значення — код 2. `database-tools.db.test.ts`: `introspect` у порожню теку
без явного провайдера пише файл проєкту з `database.provider = "supabase"`.

- [ ] **Step 2: Run — FAIL**

Run: `pnpm --filter simetra test stage-files engine-desired reverse-generate`,
`pnpm --filter @simetra/designer test cli`
Expected: FAIL — поля немає.

- [ ] **Step 3: Implement** за Interfaces. Механізм коду діагностики —
наявний шлях `params.rule` → `SchemaRule`, якщо Zod 4 дає його для
відсутнього поля; інакше — перевірка перед `zodDiagnostics` у
`stages/files.ts`, яка прибирає дубль `file.schema`. Оновити хелпери й
фікстури (`project()` повертає `database: { provider: "supabase" }`),
приклад `examples/reference`, скіл споживача (одне речення про
`--database-provider` / `project.database.provider` і дефолт для нової
теки; приклади скіла перевіряє `skill-examples.test.ts`). Згенерувати схему:
`UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`. У §6.9
платформної спеки після «пресет у конфігурації проєкту» — «(поле
`database.provider` файлу проєкту)»; текст правки до коміту — на перегляд
власнику.

- [ ] **Step 4: Run — PASS**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`,
`pnpm --filter @simetra/designer test:db database-tools`, `pnpm metadata:check`,
`pnpm typecheck`
Expected: PASS; `metadata:check` зелений на `examples/reference`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/simetra packages/designer examples docs/superpowers/specs/2026-09-24-simetra-platform-design.md
git commit -m "feat(model): провайдер бази — явний вибір у project.meta.json (§6.9)"
```

---

### Task 5: Пресет провайдера — базовий стан `public` і розширень, засів тіні (Р-2, Р-5)

**Files:**
- Modify: `packages/simetra/src/schema/engine/provider/supabase.ts`
- Modify: `packages/simetra/src/schema/engine/index.ts`, `packages/simetra/src/schema/index.ts` (експорт, якщо пакетний індекс реекспортує поіменно)
- Modify: `packages/designer/src/schema-engine/pg-delta/adapter.ts` (`planAndRun`)
- Test: `packages/simetra/src/schema/__tests__/engine-provider.test.ts`,
  Create: `packages/simetra/src/schema/__tests__/provider-preset.db.test.ts`,
  Modify: `packages/designer/src/schema-engine/__tests__/engine-scope.db.test.ts`

**Interfaces:**
- Produces (T2, `simetra/schema`):
  - `SUPABASE_PUBLIC_SCHEMA_GRANTS: readonly { grantee: string; privileges: readonly string[] }[]`
    — `PUBLIC`, `postgres`, `anon`, `authenticated`, `service_role`, кожному
    `["USAGE"]` (верхній регістр, як у payload двигуна).
  - `SUPABASE_BASE_EXTENSIONS: readonly { name: string; schema: string }[]`
    — `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, усі в `extensions`.
  - `renderProviderSeed(): string` — чиста: один `GRANT USAGE ON SCHEMA public TO …`
    (`PUBLIC` без лапок, ролі через `quoteIdent`) і
    `CREATE EXTENSION IF NOT EXISTS <quoteIdent(name)> WITH SCHEMA <quoteIdent(schema)>;`
    на кожне розширення; детермінований порядок — як у константах.
- Produces (designer): `planAndRun` передає `planSchemaFiles` файли
  `[{ name: "provider-seed.sql", sql: renderProviderSeed() }, { name: "desired.sql", sql: desiredSql }]`
  і опцію `reorderOnFailure: false` (рішення 8).

- [ ] **Step 1: Failing unit tests** (`engine-provider.test.ts`)

```ts
it("base extensions are excluded from the boundary", () => {
  for (const ext of SUPABASE_BASE_EXTENSIONS)
    expect(SUPABASE_EXTENSIONS).toContain(ext.name)
})
it("provider seed grants the public preset and creates base extensions", () => {
  expect(renderProviderSeed()).toBe(
    'GRANT USAGE ON SCHEMA public TO PUBLIC, postgres, anon, authenticated, service_role;\n' +
      'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;\n' +
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;\n' +
      'CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;\n'
  )
})
```

- [ ] **Step 2: Контрактна передумова** (`provider-preset.db.test.ts`, проти стеку)

Це не red/green-доказ виправлення (його дає крок 3), а фіксація образу
провайдера: тест зелений, щойно з'являються константи.

```ts
it("the stack's public schema ACL equals the preset", async () => {
  // SELECT grantee, privilege_type FROM aclexplode((SELECT nspacl FROM pg_namespace WHERE nspname='public'))
  // без фактичного власника схеми (grantee = nspowner, читати з каталогу,
  // а не вшивати pg_database_owner) — множина {PUBLIC, postgres, anon,
  // authenticated, service_role} × USAGE дорівнює SUPABASE_PUBLIC_SCHEMA_GRANTS
})
it("the stack has every base extension in its schema", async () => {
  // SELECT extname, extnamespace::regnamespace FROM pg_extension
  // ⊇ SUPABASE_BASE_EXTENSIONS
})
```

*Чому:* пресет фіксований, а образ провайдера оновлюється; розходження
пресету з образом має бути червоним тестом, а не тихою різницею в плані.

- [ ] **Step 3: Failing adapter tests** (`engine-scope.db.test.ts`)

```ts
it("the shadow carries the provider base state", async () => {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    `create schema app;
     create function app.token() returns text language sql
       as $$ select encode(extensions.gen_random_bytes(8), 'hex') $$;`,
    scopeOf("app"),
    async (shadow) => /* у тіні: nspacl public містить anon=U, authenticated=U,
      service_role=U, postgres=U, =U; pg_extension містить pgcrypto */ …
  )
  expect(outcome.status).toBe("loaded")
  expect(outcome.diagnostics.filter((d) =>
    d.engineCode === "invalid_routine_body" ||
    (d.engineCode === "frontend_warning" && /reorder|pg-topo/i.test(d.message))
  )).toEqual([])
})
```

Додатково — той самий засів, коли ціль сама є тінню (вкладений
`withDesiredShadow`, як у «scope follows 6.9»): завантаження `loaded`,
без помилок (Review Focus 2).

- [ ] **Step 4: Run — FAIL**

Run: `pnpm --filter simetra test engine-provider`,
`pnpm --filter simetra test:db provider-preset`,
`pnpm --filter @simetra/designer test:db engine-scope`
Expected: FAIL — немає експортів; у тіні `public` лише `=U`; є
`invalid_routine_body` і попередження pg-topo. Контрактна передумова
(крок 2) — PASS одразу після появи констант; якщо FAIL — стоп і звіт (образ
не той, що зафіксовано 2026-10-07).

- [ ] **Step 5: Implement** константи, `renderProviderSeed` і зміну
`planAndRun` за Interfaces. Коментар у `supabase.ts` до
`SUPABASE_EXTENSIONS` («засіяна тінь їх не має») виправити: базові
розширення тінь тепер має з засіву, виключення з межі лишається, бо
розширення ставить провайдер.

- [ ] **Step 6: Run — PASS і всі DB-тести designer**

Run: `pnpm --filter @simetra/designer test:db` і `pnpm --filter simetra test:db`
Expected: PASS. Тест «managed public with declared provider grants plans
nothing against the stack» на цьому кроці може змінити поведінку — його
переписує задача 6; якщо він падає тут, позначити `it.todo` НЕ можна —
виконати задачу 6 до коміту й комітити обидві разом. Запасний шлях
рішення 8 — лише за умовою, названою там.

- [ ] **Step 7: Commit**

```bash
git add packages/simetra/src/schema packages/designer/src/schema-engine
git commit -m "feat(schema): пресет провайдера — базовий стан public і розширень, засів тіні перед бажаним станом (Р-2, Р-5)"
```

---

### Task 6: Р-2 — ACL `public` цілі порівнюється з пресетом

**Files:**
- Modify: `packages/designer/src/schema-engine/pg-delta/map-units.ts`
- Modify: `packages/designer/src/schema-engine/pg-delta/map-model.ts` (гілка `id.kind === "schema"`)
- Modify: `packages/designer/src/schema-engine/pg-delta/policy.ts` (коментар про рішення 6 E2a)
- Test: `packages/designer/src/schema-engine/__tests__/fixtures/round-trip-classes.ts`,
  `packages/designer/src/schema-engine/__tests__/engine-scope.db.test.ts`

**Interfaces:**
- Consumes: `SUPABASE_PUBLIC_SCHEMA_GRANTS` (задача 5); `grantTarget`, `aclStatement`.
- Produces:
  - `aclStatement(fact, defaults, issues): string[]` (було `string`): пара, у
    якої є і зайві, і відсутні відносно очікуваного привілеї, дає два
    оператори — `REVOKE <missing>` і `GRANT <extra>` (ідентичності різні,
    порядок дає задача 2); інші гілки — як зараз, один оператор або
    порожньо. Правила опції гранту (`grantable`) не змінюються. Виклик у
    `unitStatements` розгортає масив. Зараз така пара мовчки дає один
    `GRANT` усіх прав і зберігає відкликане (діє й для ADP таблиць, не лише
    для пресету).
  - `expectedPrivileges` для ACL-факту з ціллю `{ kind: "schema", name: "public" }`
    і отримувачем із пресету повертає привілеї пресету (`grantable: []`).
  - `revokedPresetStatements(view: FactBase, schema: StableId): string[]` —
    для схеми `public`: на кожного отримувача пресету без ACL-факту —
    `REVOKE <privileges> ON SCHEMA public FROM <grantee>`; для інших схем — `[]`.
    Викликається з `mapModel` у гілці `schema` через `unit(fact, …)`.

- [ ] **Step 1: Failing fixture**

```ts
{
  name: "public schema ACL differs from the provider preset",
  schemas: ["public"],
  sql: `
    REVOKE USAGE ON SCHEMA public FROM PUBLIC;
    GRANT CREATE ON SCHEMA public TO authenticated;
    CREATE TABLE public.memo (id uuid PRIMARY KEY);
  `,
  // Грантор залежить від сесії, тож порівнюємо отримувача й привілеї
  property: (shape) =>
    shape.acls
      .find((a) => a.object === "n:public")
      ?.acl.map((item) => item.split("/")[0]),
  expected: [
    "anon=U",
    "authenticated=UC",
    "pg_database_owner=UC",
    "postgres=U",
    "service_role=U",
  ],
},
{
  name: "a preset grantee with one privilege swapped for another",
  schemas: ["public"],
  sql: `
    REVOKE USAGE ON SCHEMA public FROM anon;
    GRANT CREATE ON SCHEMA public TO anon;
    CREATE TABLE public.memo (id uuid PRIMARY KEY);
  `,
  property: (shape) =>
    shape.acls
      .find((a) => a.object === "n:public")
      ?.acl.map((item) => item.split("/")[0])
      .filter((item) => item.startsWith("anon=")),
  expected: ["anon=C"],
},
```

Друга фікстура — змішана пара (бракує `USAGE`, зайвий `CREATE`): один
`GRANT` її не виражає.

Ціль фікстур — тінь, засіяна пресетом (задача 5), тож відкликання
`PUBLIC` — саме відмінність від пресету.

- [ ] **Step 2: Переписати тест `engine-scope`**

«managed public with declared provider grants plans nothing against the
stack» → дві перевірки: (а) бажаний стан без грантів схеми, але з трьома
`alter default privileges … in schema public` → план порожній (гранти схеми
дає засів); (б) бажаний стан без нічого → `destroys` не містить жодного
`acl:(schema:public).…`, але містить ADP-факти `public` (рішення 2: ADP
лишаються явними). Коментар тесту й коментар `policy.ts` — рішення 6 E2a
тепер стосується лише ADP; гранти самої схеми — пресет (§9.9).

- [ ] **Step 3: Run — FAIL**

Run: `pnpm --filter @simetra/designer test:db round-trip engine-scope`
Expected: перша фікстура FAIL — у тіні знову `=U` (одиниці `REVOKE`
немає), а зайвий `GRANT USAGE … TO anon` тощо з'являється в одиницях; друга
— FAIL з `anon=UC` у тіні.

- [ ] **Step 4: Implement** за Interfaces. Коментар — чому окрема функція:
для схем двигун маркера відкликаного `PUBLIC` не дає (у `acldefault('n')`
`PUBLIC` немає), тож відкликання видно лише з боку пресету.

- [ ] **Step 5: Run — PASS**

Run: `pnpm --filter @simetra/designer test:db` і `pnpm --filter @simetra/designer test`
Expected: PASS; одиниці схеми лягають окремими файлами в `sql/public/` без
`introspect.path-collision`; наявні фікстури (зокрема «grant on a table»,
«default privileges») зелені.

- [ ] **Step 6: Commit**

```bash
git add packages/designer/src/schema-engine
git commit -m "fix(designer): ACL схеми public звіряється з пресетом провайдера, відмінність — явна одиниця (Р-2)"
```

---

### Task 7: Документація й гейти

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` (§3.2, абзац «Тінь»)
- Перевірити: `.agents/skills/code-review/references/simetra-domain-criteria.md` (рядок «names and reserved words» — правило не змінилось, лише джерело списку; правити, лише якщо там названо видалений файл)

- [ ] **Step 1: Правка спеки designer** — речення «базовий стан провайдера
засівається з цілі» замінити на: «базовий стан провайдера засівається з
цілі, крім ACL схеми `public` і розширень базового стану — їх тінь отримує
з фіксованого пресету провайдера ([спека промоції](2026-10-06-promotion-design.md) §9.9)».
Текст до коміту — на перегляд власнику (рішення 6).

- [ ] **Step 2: Пошук залишків**

Run: `grep -rn "sql-reserved-words\|SQL_RESERVED_WORDS" packages docs .agents`
Expected: порожньо (крім датованих планів у `docs/superpowers/plans/`).

- [ ] **Step 3: Гейти**

Run: `python3 scripts/check-doc-anchors.py`, потім
`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm metadata:check && pnpm test:db`
Expected: усе зелене.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-simetra-designer-design.md
git commit -m "docs(spec): designer — тінь бере public і розширення з пресету провайдера (§9.9)"
```

## Критерії приймання

1. Фікстури round-trip «PUBLIC execute revoked by a global ADP…», «PUBLIC
   usage revoked on a type and a domain…», «column grant after a table
   revoke», «public schema ACL differs from the provider preset» — зелені:
   оракул бачить властивість і в цілі, і в тіні, звірка порожня.
2. Функція з вбудованим `EXECUTE` у схемі з ADP не дає одиниці з `PUBLIC`.
3. `isSqlReservedWord` = `PG_QUOTED_KEYWORDS`; `key`, `type` — без
   попереджень і суфікса; наявний `key_` не змінюється.
4. Тінь має ACL `public` пресету й базові розширення; немає
   `invalid_routine_body` для функцій на `pgcrypto` і попередження pg-topo.
5. Контрактний тест «пресет = образ стеку» зелений.
6. Усі гейти `AGENTS.md` і `pnpm test:db` зелені; `check-doc-anchors` чистий.
