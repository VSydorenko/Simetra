# Промоція-2a — мітка виду, «призначене раз», непорожній рядок, ратчет споживачів: план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** метамодель П2 кодує вид об'єкта в даних стабільною міткою виду
(`kindLabel`), яка стає дискримінатором поліморфних пар у `COLLATE "C"`;
компілятор примушує правило «призначено раз» для всіх фізичних міток проти
базового стану; `required` рядка означає «непорожній»; ратчет «поле без
споживача» бачить читачів T2; `GRANT/REVOKE … ON ALL … IN SCHEMA` не
приймається як одиниця.

**Архітектура:** T0 (`packages/simetra/src/model`) отримує поле `kindLabel` у
схемах Catalog, Document, CustomTable, факт реєстру видів `kindLabel: true`,
предикат `expectsKindLabel` і перелік полів «призначено раз» як дані. T1
(`packages/simetra/src/compiler`) перевіряє мітку на стадії 2, бере її
дискримінатором на стадії 3 і в обгортках рухів, ставить `COLLATE "C"` на
колонки `_type`, приймає опційний базовий стан у `compile` і звіряє з ним
поля «призначено раз». `fix`/`create` призначають мітку тим самим
`NameAssigner`. `@simetra/designer` подає базовим станом `HEAD` git у
`compile`. Друга половина рамки (властивості §9.3, `EventSubscription`,
закритий модуль, ратчет боргу) — план 2b.

**Технології:** TypeScript 7, Zod 4, Vitest, libpg-query 17.7.4 (wasm, без
зміни), citty (designer CLI), git (лише в designer).

**Спека:** [спека промоції](../specs/2026-10-06-promotion-design.md) §9.7,
§9.11, Пр10, Пр25, §16 п.2 і п.8; [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3 («Фізичні імена»), §5 («Порожнє значення й обов'язковість», «Посилання
"тип + id"»), §7 (віртуальні таблиці), §8.2, §8.3, §8.6, §10.1;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §6.8
(`'<об'єкт>'` — мітка виду); [спека designer](../specs/2026-10-02-simetra-designer-design.md)
§4.4. Відкладене з [плану 1](2026-10-07-promotion-1-adoption-privileges.md):
пункти (а) і (б) нижче.

**Передумова:** перед стартом — `orient --plan` цього файлу; локальний стек
(`pnpm db:start`) — для задачі 6. На checkout працює одна сесія, що
комітить. План 2b стартує лише після цього плану.

**Архітектор задачі:** сесія `consumer-reconciliation`. Розвилки й тексти
правок спек — до неї (`SendMessage`); якщо сесії немає — до власника.

**Поза планом (свідомо):** довідник «мітка → об'єкт» у базі — план системної
схеми `simetra` / П3 (рішення 3); виняток промоції для «призначено раз»
(канонізація з ledger) — П3; властивості §9.3, `EventSubscription`,
закритий SQL-модуль, граматика правила рядка, ратчет боргу — план 2b;
`required` в оверайдах стандартних реквізитів (спека промоції §17).

## Global Constraints

- 🔴 **Розбіжність спеки з кодом — стоп.** Поведінка коду, не описана тут
  чи у спеці, або спека, що суперечить рішенням нижче, — виконавець
  зупиняється і звітує архітекторові; мовчки не вирішує.
- 🔴 **Правки спек — окремим комітом `docs(spec)`, текст до коміту
  переглядає архітектор** (задача 1).
- Мітка виду призначається раз і не змінюється ніколи (Пр25); унікальна в
  межах **проєкту**; дискримінатор усіх поліморфних пар (`allowedTypes`,
  `owners`, `recorderTypes`).
- Колонки `_type` (зокрема `recorder_type`) — у `COLLATE "C"`.
- `required` рядка: «непорожній після обрізання пробільних символів» —
  рівно `<колонка> !~ '^\s*$'` (POSIX `\s`).
- Без шимів і реекспортів старих імен; видалене правило видаляється разом з
  повідомленням і тестами (`AGENTS.md`, принцип 5).
- Кожне розгалуження за видом читає реєстр видів (`AGENTS.md`).
- Наявні `physicalName` не змінюються (Р5).
- Коментарі в коді — українською, «чому»; повідомлення діагностик — en і uk
  у `compiler/messages.ts`; нове правило — рядок у `COMPILER_RULES`
  (`compiler/diagnostics.ts`).
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter`.
- Коміти — Conventional Commits з українським описом, без трейлерів.

## Рішення плану

Рішення ухвалив архітектор задачі (сесія `consumer-reconciliation`)
2026-10-07.

1. **Поле мітки — `kindLabel`** у файлі об'єкта, у шапці одразу після
   `physicalName` (`HEADER_KEY_ORDER`). Є лише в схемах Catalog, Document і
   CustomTable (не в `objectHeaderShape`: решта видів його не мають, і JSON
   Schema не пропонує зайвого). Формат — `physicalNameSchema`. Опційне в
   схемі, як `physicalName`: відсутнє в об'єкта, який його потребує, —
   `identity.kind-label-missing`; заповнює `fix`.
2. **Хто має мітку — факт реєстру.** `KindDefinition.kindLabel?: true` у
   Catalog, Document, CustomTable. Предикат T0
   `expectsKindLabel(kind, data)`: факт є **і** (вид не `declared` **або**
   таблиця має одноколонковий uuid-ключ). CustomTable без такого ключа з
   міткою — `identity.kind-label-not-allowed`.
3. **Довідник «мітка → об'єкт» у базі — не тут** (план 3 / П3).
4. **Призначення:** `fix`/`create` — `assignPhysicalName(name, { role:
   "label" }, зайняті мітки всього проєкту)`. Для зарезервованого слова мітка
   може відрізнятися від `physicalName` (`order` проти `order_`): мітка —
   літерал даних, а не ідентифікатор.
5. **Унікальність** — у проєкті, `identity.kind-label-duplicate`.
   `physical.discriminator-duplicate` (унікальність `physicalName` у межах
   поліморфної множини) видаляється без шиму: мітка покриває його строго.
6. **`COLLATE "C"`:** колонки `<поле>_type` у знімку мають `collation:
   { name: "C" }`. Параметр `p_recorder_type` лишається `text`: Postgres не
   приймає `COLLATE` в оголошенні аргументу функції. Контракт віртуальної
   таблиці з `p_recorder_type` несе поле-вимогу `momentCollation: "C"`: SQL
   П3 **пише** явне `p_recorder_type COLLATE "C"` у порівнянні моменту.
7. **Контракти несуть мітку:** `PostingContract.kindLabel` — значення, яке
   оболонка пише в `recorder_type`; `NumberingContract.kindLabel` — ключ
   лічильника (спека промоції §9.11). П3 не виводить їх удруге.
8. **«Призначено раз» — одне правило на всі такі поля.** Перелік — дані T0
   (`ASSIGNED_ONCE`): в об'єкта — `physicalName`, `kindLabel` і PG-схема
   (явна `schema` чи успадкована `defaultSchema`, лише для видів, що
   матеріалізуються); у кожного іменованого елемента з `id` (реквізит, ТЧ,
   колонка, значення перерахування, предвизначений, вид скоупу) —
   `physicalName`. Запис переліку сам описує, як обчислити ефективне
   значення (успадкування схеми), і порівнюються ефективні значення — без
   `switch` за полем. API: `compile(files, { baseline })`, де `baseline` —
   мапа файлів попереднього стану; зміна поля в елемента з тим самим `id` —
   `identity.assigned-once-changed` (параметри: поле, було, стало). Значення
   → відсутність — теж зміна; відсутність → значення — ні (це робота `fix`).
   Без `baseline` перевірки немає. Без винятку промоції.
9. **Базовий стан у designer:** `compile` (і `--all`) у git-репо подає
   `HEAD` (з `--staged` — `HEAD` проти індексу); поза git — без базового
   стану з попередженням у stderr. MCP-інструмент `compile` базового стану
   не подає (мутації MCP пишуть лише через `fix`, а ручні правки ловить
   pre-commit).
10. **Непорожній рядок:** String і Text, лише скаляр (не `array`). Довідник,
    регістри, ТЧ довідника — окремий CHECK `<колонка> !~ '^\s*$'` з міткою
    обмеження `nonempty` (`<таблиця>_<колонка>_nonempty`) поруч із `NOT
    NULL`. Шапка документа — той самий CHECK `required`: `NOT posted OR
    (<колонка> IS NOT NULL AND <колонка> !~ '^\s*$')`. Рядки ТЧ документа —
    як зараз, лише контракт `requiredOnPost` (П3 виводить непорожність із
    типу). Мапінг CHECK → реквізит — у тому ж списку, що й `required`
    (перейменований на `elementChecks`, з полем `label`).
11. **Ратчет (б):** ратчет «поле без споживача» переїжджає з
    `src/compiler/__tests__/` у `packages/simetra/test/` (лінт-зона T1
    забороняє тестам компілятора імпорт T2) і записує читання також під
    `engineScope` (T2). Винятки `project.database` і
    `project.database.provider` прибираються.
12. **(а) `GRANT/REVOKE … ON ALL … IN SCHEMA`** — `sql.statement-not-allowed`
    у будь-якому `.sql`. *Чому:* це разова дія над наявними об'єктами, а не
    стан каталогу; каталог тримає гранти на кожен об'єкт, і зворотна
    генерація цієї форми не пише. Мертвий код порядку для неї
    (`compiler/sql/dependencies.ts`) і цілей (`schema/engine/unit-target.ts`)
    видаляється.

## Review Focus

1. **Поліморфна ціль без мітки** (регістр в `allowedTypes`) не валить
   стадію 3: мітки немає — значення не потрапляє в CHECK, а стадія 4 звітує
   `reference.polymorphic-target-kind` — задача 6, тест «polymorphic target
   without a label».
2. **Зміна `defaultSchema` у проєкті** переносить об'єкти без явної `schema`
   — кожен такий об'єкт дає `identity.assigned-once-changed` з полем
   `schema` — задача 7.
3. **`rename` об'єкта** зберігає `kindLabel`, і компіляція з базовим станом
   до перейменування чиста — задача 7.
4. **Однойменні об'єкти в різних PG-схемах** (`app.Contract`,
   `billing.Contract`) отримують від `fix` різні мітки (`contract`,
   `contract_`) — задача 5.
5. **`required` рядка-масиву** не дає `nonempty` (`!~` над `text[]` — не
   SQL) — задача 9.

---

### Task 0: Звірка плану з кодом і базова лінія

**Files:** — (лише читання)

- [ ] **Step 1: Звірити якори плану**

Run: `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-07-promotion-2a-kind-label-assigned-once.md`
Expected: усі шляхи й символи існують, крім позначених `Create` і цілей
`Move` (`packages/simetra/test/field-ratchet.test.ts`). Інший зниклий якір —
стоп і звіт.

- [ ] **Step 2: Базова лінія**

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`,
`pnpm metadata:check`, `pnpm db:start && pnpm test:db`
Expected: зелено. Червоне до початку — стоп і звіт.

---

### Task 1: Правки спек плану 2 — 2a і 2b (один docs-коміт, перегляд архітектора)

Архітектор просив усі правки спек плану 2 одним комітом; пункти 6–12 —
рішення плану 2b (`2026-10-07-promotion-2b-frame-properties-closed-module.md`,
розділ «Рішення плану»), їхній код — там.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` (§3, §5, §7, §8.2, §8.3, §8.6, §11/§13 — де згадано `eventSubscriptions`)
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (§9.2, §9.3, Пр12)
- Modify: `docs/superpowers/specs/2026-10-02-simetra-designer-design.md` (§4.4)
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§9, §12 — згадки `eventSubscriptions`)

- [ ] **Step 1: Написати правки**

1. Спека П2 §8.6, ратчет: «читає щонайменше одна стадія компілятора,
   побудова фізичного знімка, контракт, блок представлення чи кодоген» →
   «читає щонайменше одна стадія компілятора, побудова фізичного знімка,
   контракт, блок представлення, кодоген або читач моделі в T2/T3 (межа
   звірки `engineScope`)»; речення «Явний виняток — декларація
   `eventSubscriptions`…» видалити.
2. Спека П2 §3, після абзацу про унікальність `physicalName`, — новий абзац
   **«Призначене раз — правило компілятора»** за рішенням 8 (перелік полів,
   `compile(files, { baseline })`, `identity.assigned-once-changed`, без
   базового стану — без перевірки, двері designer подають `HEAD`; виняток
   промоції — ledger П3, не цей механізм). У §8.2: унікальність мітки виду
   в проєкті — стадія 2 (ідентичність), а не 4; «незмінність мітки
   наявного об'єкта (§3, §5)» прибирається зі стадії 4 — перевірка «призначено
   раз» є кроком `compile` над базовим станом поза стадіями 1–5 (§3).
   Спека П2 §5 «Типове значення»: поруч зі скаляром — форми `{ fill: now |
   today | newUuid }` і `{ empty: true | "object" | "array" }` за пунктом 6
   нижче; речення «схема відхиляє його для `array` … і `Json`» — лише для
   скалярного значення.
3. Спека П2 §5 «Посилання "тип + id"» і §7 (віртуальні таблиці): параметр
   реєстратора — `text`, порівняння моменту пише `p_recorder_type COLLATE
   "C"` явно; контракт несе `momentCollation: "C"` (рішення 6).
4. Спека промоції §9.3: після таблиці — речення «Форму `access` і
   декларацію видів доступу фіксує план генерації політик (§16 п.5).»
5. Спека designer §4.4: одне речення — `compile` у git-репо звіряє поля,
   призначені раз, із `HEAD` (з `--staged` — `HEAD` проти індексу), поза
   git — без звірки з попередженням.
6. Спека промоції §9.2 (рядок «Порожній `Json` чи масив») і §9.3 (рядок
   `defaultValue: { empty }`): «форму задає тип» → `{ empty: true }` — для
   масиву Postgres (`array: true`), `DEFAULT '{}'`; для скалярного `Json` —
   `{ empty: "object" }` (`'{}'::jsonb`) чи `{ empty: "array" }`
   (`'[]'::jsonb`).
7. Підписки — вид `EventSubscription` (файл на підписку: `sources`,
   `event`, `whenChanged`, `handler`; `physicalName` — база імені тригера
   П3): спека промоції §9.3 (рядок і абзац `eventSubscriptions`, «Де» —
   «вид `EventSubscription`»), Пр12; спека П2 §3 (теки видів —
   `event-subscriptions/`), §5 («Декларативні властивості рамки»), §13
   (згадка в П3); платформна спека §9 і §12 — та сама заміна імені.
8. Спека П2 §3 «Файли» і §8.6 «Ратчет боргу»: перелік боргу —
   `metadata/sql-debt.json` (відсортовані ідентичності дослівних одиниць
   поза закритими формами у модулях `CustomTable`/`PgEnum` і в спільних
   `metadata/sql/`), пише лише `introspect`, `fix` лише прибирає зайві
   записи; одиниця поза закритими формами, якої немає в переліку, —
   `sql.debt-grows`.
9. Спека П2 §8.3: правило рядка модуля виду після перевірки граматики —
   CHECK таблиці у фізичному знімку з походженням «правило рядка», а не
   SQL-одиниця.
10. Спека П2 §8.2, стадія 5: функція множини — ще й `LANGUAGE sql`,
    `SECURITY DEFINER`, `SET search_path = ''` і кваліфіковані відношення в
    тілі.
11. Спека П2 §3 «Дослівний SQL»: закрита оболонка в П2 перевіряє мову,
    явну волатильність, відсутність перевантажень у модулі виду й
    `SECURITY DEFINER` ⇒ `SET search_path = ''`; заборона динамічного SQL —
    з парсером PL/pgSQL (план переписувача) і `plpgsql_check` у тіні П3;
    названа перевірка викликача й `EXECUTE` — з TS-декларацією (П4).
12. Спека промоції §9.3: `publicRead` — на видах із RLS; декларація бакетів
    — `project.storageBuckets: [{ bucket, scopeKind }]`.

- [ ] **Step 2: Перевірити якори**

Run: `python3 scripts/check-doc-anchors.py`
Expected: без мертвих якорів.

- [ ] **Step 3: Перегляд архітектора**

Надіслати `git diff` правок сесії `consumer-reconciliation` і дочекатися
згоди. Правки за відповіддю — до коміту.

- [ ] **Step 4: Коміт**

```bash
git add docs/superpowers/specs/
git commit -m "docs(spec): рамка П2 — призначене раз, ратчети, колляція моменту, вид EventSubscription, закриті форми модуля, форма empty"
```

---

### Task 2: Ратчет (б) — читачі T2 як споживачі

**Files:**
- Move: `packages/simetra/src/compiler/__tests__/field-ratchet.test.ts` → `packages/simetra/test/field-ratchet.test.ts` (`git mv`)

**Interfaces:**
- Consumes: `engineScope(model)` з `simetra/schema` (T2,
  `schema/engine/desired.ts`), `readFiles`, `runStages` з
  `../src/compiler/pipeline`, `kitchenSink` з
  `../src/compiler/__tests__/fixtures/kitchen-sink`.

- [ ] **Step 1: Перенести файл і виправити імпорти**

`git mv`; `vi.mock("../canonical", …)` → `vi.mock("../src/compiler/canonical", …)`;
решта відносних імпортів — від `test/`.

Run: `pnpm --filter simetra test field-ratchet`
Expected: PASS (поведінка не змінилась).

- [ ] **Step 2: Прибрати винятки — тест червоніє**

Видалити з `EXCEPTIONS` рядки `project.database` і `project.database.provider`.

Run: `pnpm --filter simetra test field-ratchet`
Expected: FAIL «every metamodel field is read…» з `project.database` і
`project.database.provider` серед непрочитаних.

- [ ] **Step 3: Записувати читання під `engineScope`**

У `unreadPaths` після `emitEntityTypes(model)` — `await engineScope(model)`
(під записом, не на паузі). Коментар у шапці файлу: споживач — і читач
моделі в T2/T3 (спека П2 §8.6).

- [ ] **Step 4: Зелено**

Run: `pnpm --filter simetra test field-ratchet` і `pnpm --filter simetra lint`
Expected: PASS; лінт чистий (тека `test/` поза ярусними зонами).

- [ ] **Step 5: Коміт**

```bash
git add packages/simetra/test/field-ratchet.test.ts packages/simetra/src/compiler/__tests__/field-ratchet.test.ts
git commit -m "test(simetra): ратчет полів бачить читачів T2 — без винятків project.database"
```

---

### Task 3: (а) Заборона `GRANT/REVOKE … ON ALL … IN SCHEMA`

**Files:**
- Modify: `packages/simetra/src/compiler/sql/units.ts` (`classify`, гілка `GrantStmt`)
- Modify: `packages/simetra/src/compiler/sql/dependencies.ts` (видалити `Category`, `ALL_IN_SCHEMA`, `categories` і гілку `ACL_TARGET_ALL_IN_SCHEMA`)
- Modify: `packages/simetra/src/schema/engine/unit-target.ts` (видалити гілку `ACL_TARGET_ALL_IN_SCHEMA`)
- Modify: `packages/simetra/src/compiler/messages.ts` (підказка `sql.statement-not-allowed` для цієї форми)
- Modify: `packages/designer/src/schema-engine/__tests__/engine-extract.db.test.ts` (мертва гілка `allInSchema.`)
- Test: `packages/simetra/src/compiler/__tests__/sql-units.test.ts`, `packages/simetra/src/compiler/__tests__/creation-order.test.ts`, `packages/simetra/src/schema/__tests__/unit-target.test.ts` (тест «a grant on a schema and ALL IN SCHEMA target the schema» лишає лише грант на схему)

- [ ] **Step 1: Failing test**

У `sql-units.test.ts`:

```ts
it("grant on all objects in a schema is not a unit", async () => {
  const result = await compileSql(
    "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;\n" +
      "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;"
  )
  expect(result.diagnostics.map((d) => [d.code, d.params?.statement, d.params?.line]))
    .toEqual([
      ["sql.statement-not-allowed", "GrantStmt", 1],
      ["sql.statement-not-allowed", "GrantStmt", 2],
    ])
  expect(result.diagnostics[0]!.params).toMatchObject({ detail: "allInSchema" })
})
```

Run: `pnpm --filter simetra test sql-units`
Expected: FAIL (зараз приймається як `grant:grant:allInSchema.function:…`).

- [ ] **Step 2: Гілка в `classify`**

`targtype === "ACL_TARGET_ALL_IN_SCHEMA"` → `{ notAllowed: "GrantStmt",
detail: "allInSchema" }`. Підказка в `messages.ts` для `detail ===
"allInSchema"`: en «Grant on each object: ON ALL … IN SCHEMA is a one-off
action, not a catalog state»; uk — відповідник. Ідентичність гранту більше
не має префікса `allInSchema.`.

- [ ] **Step 3: Видалити мертвий код і старі тести**

`dependencies.ts` — `Category`, `ALL_IN_SCHEMA`, поле `categories` і всі
його `set`, гілка в обробці `GrantStmt`; `unit-target.ts` — гілка
`ACL_TARGET_ALL_IN_SCHEMA`. У `creation-order.test.ts` видалити тести «grants
on all functions and sequences in a schema after them» і той, що чекає
`grant:grant:allInSchema.table:z:anon:select`; у `unit-target.test.ts` —
частину про `ALL IN SCHEMA`; у `engine-extract.db.test.ts` — умову
`type!.startsWith("allInSchema.")`.

- [ ] **Step 4: Зелено**

Run: `pnpm --filter simetra test` і `pnpm --filter simetra typecheck`
Expected: PASS.

- [ ] **Step 5: Коміт**

```bash
git add packages/simetra/src/compiler packages/simetra/src/schema packages/designer/src/schema-engine/__tests__/engine-extract.db.test.ts
git commit -m "fix(compiler): GRANT/REVOKE ON ALL IN SCHEMA — не одиниця, а разова дія"
```

---

### Task 4: Мітка виду в T0

**Files:**
- Modify: `packages/simetra/src/model/schemas/catalog.ts`, `document.ts`, `custom-table.ts` (поле `kindLabel`)
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`KindDefinition.kindLabel?: true`, `HEADER_KEY_ORDER`)
- Modify: `packages/simetra/src/model/kinds/catalog.ts`, `document.ts`, `custom-table.ts` (факт; `singleUuidKeyColumn`, `isUuidColumn` переїжджає сюди)
- Modify: `packages/simetra/src/model/kinds/registry.ts` (`expectsKindLabel`)
- Modify: `packages/simetra/src/model/named-elements.ts` (`ASSIGNED_ONCE`)
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`keyColumnOf` і `isUuidColumn` беруть T0-хелпер)
- Modify: `packages/simetra/schemas/*.schema.json` (регенерація)
- Test: `packages/simetra/src/model/__tests__/kind-schemas.test.ts`, `kind-registry.test.ts`, `format.test.ts`

**Interfaces:**
- Produces (усе через `simetra/model`):
  - `singleUuidKeyColumn(table: CustomTable): CustomTable["columns"][number] | undefined` —
    колонка єдиного PK, якщо вона скалярна uuid (логічний `UUID` чи `Raw`
    з `pgType` uuid); не залежить від `physicalName`.
  - `isUuidColumn(column: CustomTable["columns"][number]): boolean` (переїхав
    з `compiler/stages/model.ts`, без реекспорту там).
  - `expectsKindLabel(kind: MetadataKind, data: unknown): boolean`.
  - `interface AssignedOnceField { on: "object" | "element"; field: "physicalName" | "kindLabel" | "schema"; effective?: (raw: Readonly<Record<string, unknown>>, ctx: { defaultSchema: string; materializes: boolean }) => string | undefined }`
    і `ASSIGNED_ONCE: readonly AssignedOnceField[]` — записи `object/physicalName`,
    `object/kindLabel`, `object/schema` (з `effective`: `ctx.materializes ?
    (raw.schema ?? ctx.defaultSchema) : undefined`) і `element/physicalName`.
    Без `effective` — значення поля як є. Ефективне значення — властивість
    запису даних, а не гілка в коді, що порівнює.

- [ ] **Step 1: Failing tests**

`kind-schemas.test.ts`:

```ts
it("kindLabel is a field of Catalog, Document and CustomTable only", () => {
  // `unwrap` з `model/format.ts`: схема виду може бути обгорнута (`superRefine`)
  for (const kind of ["Catalog", "Document", "CustomTable"] as const)
    expect(Object.keys(unwrap(KIND_REGISTRY[kind].schema).shape)).toContain("kindLabel")
  for (const kind of METADATA_KINDS.filter((k) => KIND_REGISTRY[k].kindLabel !== true))
    expect(Object.keys(unwrap(KIND_REGISTRY[kind].schema).shape)).not.toContain("kindLabel")
})
```

`kind-registry.test.ts`:

```ts
it("expectsKindLabel: catalog and document always, custom table only with a single uuid key", () => {
  expect(expectsKindLabel("Catalog", {})).toBe(true)
  expect(expectsKindLabel("InformationRegister", {})).toBe(false)
  const id = { name: "id", type: "UUID" }
  expect(expectsKindLabel("CustomTable", { columns: [id], primaryKey: { columns: ["id"] } })).toBe(true)
  expect(expectsKindLabel("CustomTable", { columns: [id] })).toBe(false)
  expect(expectsKindLabel("CustomTable", { columns: [{ name: "id", type: "Integer" }], primaryKey: { columns: ["id"] } })).toBe(false)
})
```

`format.test.ts`: у канонічній формі довідника `kindLabel` стоїть одразу
після `physicalName`.

Run: `pnpm --filter simetra test kind-schemas kind-registry format`
Expected: FAIL.

- [ ] **Step 2: Реалізація**

Поле `kindLabel: physicalNameSchema.optional().meta({ description: … })` у
трьох схемах; факт реєстру; `"kindLabel"` після `"physicalName"` у
`HEADER_KEY_ORDER`; хелпери й `ASSIGNED_ONCE` за Interfaces;
`expectsKindLabel` читає `KIND_REGISTRY[kind].kindLabel` і `declared`.

- [ ] **Step 3: Регенерувати JSON Schema**

Run: `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`, далі
`pnpm --filter simetra test`
Expected: PASS; змінились `catalogs`, `documents`, `custom-tables`
`.schema.json`.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra/src/model packages/simetra/src/compiler/stages/model.ts packages/simetra/schemas
git commit -m "feat(model): мітка виду kindLabel — поле, факт реєстру, перелік полів «призначено раз»"
```

---

### Task 5: Правила мітки на стадії 2 і призначення у `fix`/`create`

**Files:**
- Modify: `packages/simetra/src/compiler/stages/identity.ts` (`checkIdentity`)
- Modify: `packages/simetra/src/compiler/operations/fix.ts` (`NameAssigner`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`
- Modify: `packages/simetra/src/compiler/__tests__/helpers.ts` (`object()` ставить `kindLabel: toSnakeCase(name)` для видів із фактом `kindLabel`)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/kitchen-sink.ts` (мітка в довідника, документа й CustomTable з uuid-PK)
- Modify: фікстури тестів `packages/simetra/src/**/__tests__` і `packages/designer/src/**/__tests__`, що компілюють Catalog/Document/CustomTable з uuid-PK без `fix`
- Modify: `packages/simetra/src/schema/reverse/tables.ts` (`customTableData` зберігає наявну `kindLabel`)
- Modify: `examples/reference/metadata/**/*.meta.json` (через `fix`, крок 4)
- Test: `packages/simetra/src/compiler/__tests__/kind-label.test.ts` (Create), `operations-fix.test.ts`, `operations-create.test.ts`, `packages/simetra/src/schema/__tests__/reverse-generate.test.ts`, `packages/designer/src/schema-engine/__tests__/round-trip.db.test.ts`

**Interfaces:**
- Consumes: `expectsKindLabel`, `assignPhysicalName(…, { role: "label" }, taken)`.
- Produces: коди `identity.kind-label-missing`, `identity.kind-label-not-allowed`,
  `identity.kind-label-duplicate` (params `{ label, firstFile }`); pointer —
  `/kindLabel`.

- [ ] **Step 1: Failing tests**

`kind-label.test.ts`:

```ts
it("a catalog without kindLabel is an identity error", async () => {
  const { kindLabel: _, ...bare } = catalog("Contract")
  const result = await compile(metaFiles({ "project.meta.json": project(), "catalogs/Contract/Contract.meta.json": bare }))
  expect(codes(result)).toEqual([["identity.kind-label-missing", "catalogs/Contract/Contract.meta.json", "/kindLabel"]])
})
it("labels are unique across the project, not the schema", async () => {
  const result = await compile(metaFiles({
    "project.meta.json": project(),
    "catalogs/A/A.meta.json": catalog("A", { kindLabel: "same" }),
    "documents/B/B.meta.json": document("B", { schema: "other", kindLabel: "same" }),
  }))
  expect(result.diagnostics).toEqual([expect.objectContaining({ code: "identity.kind-label-duplicate", params: expect.objectContaining({ label: "same" }) })])
})
it("a custom table without a single uuid key takes no label", async () => { /* customTable("T", { kindLabel: "t" }) без primaryKey → identity.kind-label-not-allowed */ })
it("a custom table with a single uuid key needs a label", async () => { /* primaryKey { columns: ["id"] } без kindLabel → identity.kind-label-missing */ })
```

`operations-fix.test.ts`:

```ts
it("fix assigns kindLabel project-wide, never changing an existing one", async () => {
  // app/Contract без мітки і billing/Contract (schema "billing") без мітки;
  // третій об'єкт уже має kindLabel "contract_x" — лишається як є
  // очікування: "contract" і "contract_" за порядком файлів; "contract_x" незмінна
})
it("fix labels a custom table only with a single uuid key", async () => { /* … */ })
```

`operations-create.test.ts`: створений довідник має `kindLabel` =
snake_case імені.

`reverse-generate.test.ts` (зворотна генерація не губить мітку — інакше
повторний `introspect` дав би `identity.assigned-once-changed`):

```ts
it("introspect keeps the existing kindLabel of a custom table", async () => {
  // наявна тека: custom-tables/Note з uuid-PK і kindLabel "memo_note" (≠ snake_case імені)
  // reverseGenerate над тією ж таблицею → файл Note має kindLabel "memo_note"
})
it("introspect labels a new custom table with a single uuid key the way fix does", async () => {
  // нова таблиця app.note з PK id uuid → kindLabel "note"; таблиця без uuid-PK → без kindLabel
})
```

`round-trip.db.test.ts`: повторний `introspect` у ту саму теку не змінює
`kindLabel` (наявний round-trip доповнюється цією перевіркою).

Run: `pnpm --filter simetra test kind-label operations-fix operations-create reverse-generate`
Expected: FAIL.

- [ ] **Step 2: Стадія 2**

У `checkIdentity` для кожного об'єкта: `expectsKindLabel(kind, data)` і
немає `kindLabel` → `missing`; не очікується, але є → `not-allowed`;
повтор значення в проєкті → `duplicate` з `firstFile` першого власника.
Правила й тексти — у `COMPILER_RULES` і `MESSAGES` (en/uk; підказка
`missing` — та сама, що `identity.physical-name-missing`: запустити `fix`).

- [ ] **Step 3: `NameAssigner`**

Новий крок `assignKindLabels()` наприкінці `run()`: множина зайнятих — усі
наявні `kindLabel` проєкту; для файлу, де `expectsKindLabel(def.kind, data)`
і мітки немає, — `assignPhysicalName(name, { role: "label" }, taken)` у поле
`kindLabel`. Поле запису — параметр `assign` (зараз пише лише
`physicalName`), а не копія методу.

- [ ] **Step 4: Зворотна генерація зберігає мітку**

`customTableData` переносить `kindLabel` з наявного файлу (поруч із `id`);
новій таблиці мітку дає наявний виклик `completeFiles` у `reverseGenerate`
(той самий `NameAssigner`, що й у `fix`).

- [ ] **Step 5: Фікстури й приклад**

`helpers.ts` (`object()`), kitchen-sink і фікстури тестів, що червоніють на
`identity.kind-label-missing`. Мітки прикладу — у цьому ж коміті, інакше
pre-commit `metadata:check --staged` його не пропустить:

Run: `node packages/designer/bin/simetra.mjs fix examples/reference/metadata`
Expected: довідники, документ і CustomTable з uuid-PK отримали `kindLabel`;
інших змін немає.

Run: `pnpm --filter simetra test`, `pnpm --filter @simetra/designer test`,
`pnpm metadata:check`, `pnpm test:db`
Expected: PASS.

- [ ] **Step 6: Коміт**

```bash
git add packages/simetra packages/designer examples/reference/metadata
git commit -m "feat(compiler): мітка виду — обов'язковість і унікальність у проєкті, призначення у fix/create/introspect"
```

---

### Task 6: Мітка — дискримінатор пар, `COLLATE "C"`, контракти

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (дискримінатори стандартних пар і `allowedTypes`; `addField` — колляція `_type`)
- Modify: `packages/simetra/src/compiler/movement-functions.ts` (`discriminator`)
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` (видалити перевірку `physical.discriminator-duplicate`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts` (видалити `physical.discriminator-duplicate`)
- Modify: `packages/simetra/src/compiler/contracts.ts` (`VirtualTableContract.momentCollation`, `PostingContract.kindLabel`, `NumberingContract.kindLabel`)
- Modify: `examples/reference/accepted/service-accrual.sql` і `examples/reference/accepted/expected-diff.json` (якщо паперовий тест покаже `COLLATE "C"` на `recorder_type`)
- Test: `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `movement-functions.test.ts`, `contracts.test.ts`, `stage-integrity.test.ts`

**Interfaces:**
- Produces: `kindLabelOf(object: ParsedObject): string | undefined` у
  `stages/model.ts` поруч із `physicalNameOf`; `VirtualTableContract.momentCollation?: "C"`
  (є рівно тоді, коли серед параметрів є `p_recorder_type`);
  `PostingContract.kindLabel: string`; `NumberingContract.kindLabel: string`.

- [ ] **Step 1: Failing tests**

`stage-model.test.ts` — у тестах поліморфних пар («subject_type …»,
«standard polymorphic pairs…») цілі отримують мітки, відмінні від
`physicalName` (`catalog("Contract", { kindLabel: "agreement" })`), і
очікування стають:

```ts
expect(note.columns.find((c) => c.name === "subject_type")).toEqual({
  name: "subject_type", type: "text", collation: { name: "C" }, notNull: true, origin: { elementId: uuid(20) },
})
expect(note.checks).toEqual([{ name: "note_subject_type_check", expression: "subject_type IN ('agreement', 'counterparty')" }])
expect(stock.columns.find((c) => c.name === "recorder_type")!.collation).toEqual({ name: "C" })
```

Плюс тест «polymorphic target without a label»: `allowedTypes` з регістром
→ результат компіляції має `reference.polymorphic-target-kind` і жодного
винятку.

`movement-functions.test.ts` — значення `recorder_type`/пари в обгортці
рухів — мітка документа й цілі, а не `physicalName`.

`contracts.test.ts` — `balance` має `momentCollation: "C"`, `turnovers` — ні;
контракт проведення й нумерації несе `kindLabel` об'єкта.

`stage-integrity.test.ts` — видалити тести `physical.discriminator-duplicate`.

Run: `pnpm --filter simetra test stage-model movement-functions contracts stage-integrity`
Expected: FAIL.

- [ ] **Step 2: Реалізація**

Дискримінатори — `kindLabelOf` замість `physicalNameOf` (обидва місця в
`stages/model.ts` і обидва в `movement-functions.ts`); `undefined`
відфільтровується. Колонка `_type` у гілці пари `addField` — `collation:
{ name: "C" }`. Перевірка й правило `physical.discriminator-duplicate` —
видалити. Контракти — за Interfaces; доккоментар
`VirtualTableContract.parameters` — порівняння моменту пише
`p_recorder_type COLLATE "C"` явно.

- [ ] **Step 3: Паперовий тест і DB**

Run: `pnpm --filter simetra test` і `pnpm test:db`
Expected: PASS. Якщо паперовий тест показує різницю лише в `COLLATE "C"`
колонок `recorder_type`/`_type` — дописати `COLLATE "C"` у
`examples/reference/accepted/*.sql` (та `expected-diff.json`, якщо він
перелічує ці колонки). Будь-яка інша різниця — стоп і звіт.

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra examples/reference/accepted
git commit -m "feat(compiler): мітка виду — дискримінатор пар у COLLATE \"C\", мітка в контрактах проведення й нумерації"
```

---

### Task 7: «Призначено раз» проти базового стану (T1)

**Files:**
- Create: `packages/simetra/src/compiler/object-files.ts` (переїжджають з `operations/fix.ts`: `ObjectFile`, `Located`, `readObjectFiles`, `elementsAt`, `sectionsOf`, `labelGroupsOf`, `namedElementsOf`)
- Create: `packages/simetra/src/compiler/assigned-once.ts`
- Modify: `packages/simetra/src/compiler/operations/fix.ts` (імпорт із `object-files.ts`)
- Modify: `packages/simetra/src/compiler/compile.ts` (опція `baseline`)
- Modify: `packages/simetra/src/compiler/index.ts` (експорт `CompileOptions`)
- Modify: `packages/simetra/src/compiler/diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/assigned-once.test.ts` (Create)

**Interfaces:**
- Consumes: `ASSIGNED_ONCE` (задача 4).
- Produces:
  - `interface CompileOptions { baseline?: ReadonlyMap<string, string> }`;
    `compile(files: ReadonlyMap<string, string>, options?: CompileOptions): Promise<CompileResult>`.
  - `assignedOnceDiagnostics(baseline: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): Diagnostic[]`
    — над сирим JSON обох мап (зламаний файл пропускається: про нього звітує
    стадія 1); елементи зіставляються за `id` у межах усього проєкту
    (об'єкти, `namedElementsOf`, `scopeKinds` проєкту); для кожного запису
    `ASSIGNED_ONCE` порівнюються ефективні значення (`effective` запису з
    контекстом своєї мапи: `defaultSchema ?? "public"` її проєкту й
    `materializes !== "none"` виду; без `effective` — поле як є).
  - Код `identity.assigned-once-changed`, params `{ field, before, after }`
    (`after` — `"(removed)"` для видаленого значення), pointer — на поле в
    поточному файлі (для схеми — `/schema` об'єкта або `/defaultSchema`
    проєкту, коли поле успадковане).

- [ ] **Step 1: Failing tests**

`assigned-once.test.ts` (база — мапа `metaFiles({...})`, поточне — копія з
правкою):

```ts
it.each([
  ["kindLabel", (c: Json) => ({ ...c, kindLabel: "other" })],
  ["physicalName", (c: Json) => ({ ...c, physicalName: "other" })],
  ["schema", (c: Json) => ({ ...c, schema: "billing" })],
])("changing an object's %s is an error", async (field, edit) => { /* code + params.field */ })
it("changing an attribute, enumeration value or predefined label physicalName is an error", …)
it("moving defaultSchema moves objects without explicit schema — an error on each", …)
it("assigning a missing physicalName is not a change", …)
it("removing an assigned value is a change", …)
it("rename keeps assigned fields: compile against the pre-rename baseline is clean", async () => {
  // renameElement(...) з операцій; compile(after, { baseline: before }) → без діагностик
})
it("deleted and re-created object (new id) is not a change", …)
it("without baseline nothing is checked", …)
```

Run: `pnpm --filter simetra test assigned-once`
Expected: FAIL.

- [ ] **Step 2: Перенести хелпери файлів**

Перенести вказані функції з `fix.ts` у `object-files.ts` без зміни
поведінки.

Run: `pnpm --filter simetra test operations`
Expected: PASS.

- [ ] **Step 3: Реалізація**

`assigned-once.ts` за Interfaces; перелік полів — лише з `ASSIGNED_ONCE`
(жодного `switch` за полем). `compile` додає діагностики до результату й
сортує; помилка робить `ok: false` і прибирає `model`.

- [ ] **Step 4: Зелено**

Run: `pnpm --filter simetra test` і `pnpm --filter simetra typecheck`
Expected: PASS.

- [ ] **Step 5: Коміт**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): поля, призначені раз, звіряються з базовим станом (identity.assigned-once-changed)"
```

---

### Task 8: Базовий стан `HEAD` у `compile` designer

**Files:**
- Modify: `packages/designer/src/cli/metadata-dirs.ts` (`readHeadMetadata`)
- Modify: `packages/designer/src/cli/command.ts` (базовий стан на кожну теку інструмента `compile`)
- Modify: `packages/designer/src/tools/types.ts` (`ToolContext.baseline`), `packages/designer/src/tools/read.ts` (`compileTool` передає його)
- Test: `packages/designer/src/__tests__/compile-all.test.ts`, `cli.test.ts`

**Interfaces:**
- Produces: `readHeadMetadata(cwd: string, dir: string): Promise<ReadonlyMap<string, string> | undefined>`
  — `undefined` поза git; порожня мапа, коли коміту `HEAD` ще немає або
  теки в ньому немає; ключі — шляхи відносно теки метаданих (як у
  `readMetadataDir`). Через `git ls-tree -r -z --full-name HEAD -- <dir>` і
  `git cat-file --batch`.
- `ToolContext.baseline?: ReadonlyMap<string, string>`.

- [ ] **Step 1: Failing tests**

У `compile-all.test.ts` (тимчасовий git-репо хелпером `tmp-project`):

```ts
it("compile --all in git checks assigned-once fields against HEAD", async () => {
  // коміт довідника з kindLabel "contract"; правка в робочому дереві → "agreement"
  // очікування: код виходу 1, у виводі identity.assigned-once-changed
})
it("compile --all --staged compares the index with HEAD", async () => { /* правка лише в індексі */ })
it("outside git compile warns that assigned-once fields are not checked", async () => {
  // stderr містить "assigned-once fields are not checked"; код виходу 0 для чистої теки
})
```

Run: `pnpm --filter @simetra/designer test compile-all`
Expected: FAIL.

- [ ] **Step 2: Реалізація**

`readHeadMetadata` за Interfaces. У `command.ts` для інструмента `compile`
базовий стан читається від справжньої (показаної) теки, навіть коли
`--staged` читає вміст з тимчасової; поза git — один рядок у stderr на
прогін: `warning: not a git repository: assigned-once fields are not checked`.

- [ ] **Step 3: Зелено**

Run: `pnpm --filter @simetra/designer test` і `pnpm metadata:check`
Expected: PASS.

- [ ] **Step 4: Коміт**

```bash
git add packages/designer
git commit -m "feat(designer): compile звіряє поля, призначені раз, з HEAD git"
```

---

### Task 9: `required` рядка — непорожній

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`Field.nonEmpty`, `attributeField`, `addField`, `requiredOnPostExpression`, `NONEMPTY_LABEL`; `requiredChecks` → `elementChecks` з `label`)
- Modify: `packages/simetra/src/compiler/contracts.ts` (бере з `elementChecks` лише `label === "required"`)
- Test: `packages/simetra/src/compiler/__tests__/stage-model.test.ts`, `contracts.test.ts`

**Interfaces:**
- Produces: `ModelStageResult.elementChecks: { objectId; attributeId; table; check; label: "required" | "nonempty" }[]`
  (заміна `requiredChecks`, без аліаса).

- [ ] **Step 1: Failing tests**

```ts
it("required string of a catalog is NOT NULL plus a nonempty check", async () => {
  // catalog з attribute("code", { type: "String", length: 20, required: true })
  expect(tableOf(physical, "item").checks).toContainEqual({ name: "item_code_nonempty", expression: "code !~ '^\\s*$'" })
})
it("required text of a register dimension is nonempty too", …)
it("required string of a document header is nonempty only when posted", async () => {
  expect(sale.checks).toContainEqual({ name: "sale_note_required", expression: "NOT posted OR (note IS NOT NULL AND note !~ '^\\s*$')" })
})
it("required string array gets no nonempty check", …)
it("required non-string attribute gets no nonempty check", …)
```

Run: `pnpm --filter simetra test stage-model contracts`
Expected: FAIL.

- [ ] **Step 2: Реалізація**

`nonEmpty = attribute.required && !array && type ∈ {String, Text}` у
`attributeField`. Не-документ: `addField` додає CHECK з `label:
NONEMPTY_LABEL` і `elementId`. Документ: `requiredOnPostExpression` дописує
`<колонка> !~ '^\s*$'` до умови заповненості. Вираз — через `quoteIdent`,
як сусідні.

- [ ] **Step 3: Зелено**

Run: `pnpm --filter simetra test` і `pnpm test:db`
Expected: PASS (тінь приймає вирази).

- [ ] **Step 4: Коміт**

```bash
git add packages/simetra/src/compiler
git commit -m "feat(compiler): required рядка — непорожній після обрізання пробілів (М19, обидва шляхи)"
```

---

### Task 10: Скіл споживача, гейти

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (що `fix` призначає `kindLabel`; не редагувати `id`, `physicalName`, `kindLabel`; `compile` звіряє їх із `HEAD`)

- [ ] **Step 1: Скіл**

Точкові правки в рядках про `fix` і «Do not edit ids or `physicalName`».

- [ ] **Step 2: Повні гейти**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
`pnpm metadata:check`, `pnpm test:db`, `python3 scripts/check-doc-anchors.py`
Expected: усе зелене.

- [ ] **Step 3: Коміт**

```bash
git add packages/designer/skills
git commit -m "docs(designer): мітка виду й призначене раз у скілі метаданих"
```
