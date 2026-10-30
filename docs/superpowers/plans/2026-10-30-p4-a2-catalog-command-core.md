# П4-A2: SQL-ядро команд довідника — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: план; виконання — після злиття A1 у `main` і «далі» архітекторки.
Архітекторка задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** кожна основна таблиця довідника, що пише командою, отримує
згенеровані функції ядра `<t>_save` і `<t>_mark_deletion` (довідник
призначень — ще `<t>_delete`). Функція бере замок, звіряє контекст і версію,
перевіряє право тими самими предикатами, що й політики запису, пише рядок і
його ТЧ і повертає рядок після запису. Ієрархічний довідник отримує тригер
бази проти циклу `parent_id`.

**Архітектура:**

- **T1** (`packages/simetra/src/compiler`):
  - контракт ядра — `catalog-command/contracts.ts`: функції, дії, ключі
    `p_item` з того самого джерела, що й гранти A1, ТЧ, посилання, зв'язки
    копій носіїв;
  - перевірка права над змінними рядка — `rightsPredicates` +
    `renderCondition` з кваліфікатором (`rights/predicates.ts`); окремої
    `simetra.authorize` немає (Р-A2-2);
  - генератор ядра — `catalog-command/units.ts` (новий `UnitGenerator`
    `catalogCommand`);
  - тригер ієрархії — `hierarchy-units.ts` (`AFTER`-тригери, поза групою
    `BEFORE`);
  - зв'язки копій носіїв — одне джерело `carrierLinks`
    (`rights/carrier-units.ts`) для тригера носіїв і ядра.
- **T2** (`packages/simetra/src/schema`): розпізнавачі зворотної генерації й
  промоції знають тригер ієрархії, як тригер авторства в A1.
- **Документи:** спека П4 §6.6, §6.7, §6.10, §6.16, §7.2, §9, Додаток А;
  платформна спека §4; спека прав §5.1, §6.2; ROADMAP; скіл споживача
  `simetra-metadata`.

**Стек технологій:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query
(дерева SQL і plpgsql), Postgres 17 локального стека Supabase.

**Спека:** [спека П4](../specs/2026-10-26-p4-runtime-design.md) — Рт2, Рт3,
Рт4, Рт12 (§5), §6.6, §6.7, §6.10, §6.12, §6.16 (інваріанти 4, 8, 11), §7,
рядок A2 у §8, рядки A2 у Додатку А, рядок «Цикл ієрархії довідника» в §9.
Суміжні: [спека прав](../specs/2026-10-17-rights-design.md) §5.1–§5.4, §6.2;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §4, Р24.
Плани [Права-2b1](2026-10-24-rights-2b1-write-policies-effects.md) (Р2b1-4…7,
Р2b1-13), [Права-2c2](2026-10-25-rights-2c2-rights-administration-guards.md)
(Р2c2-1, Р2c2-8) і [A1](2026-10-29-p4-a1-roles-grants-authorship.md)
(Р-A1-8…11) — їхні рішення діють.

**Залежність:** A1, прийнятий архітекторкою (злиття в `main` не потрібне). Перед стартом:
`git merge <фінальний SHA feat/p4-a1 від архітекторки>` (злиттям, без rebase; гілки спільні для всіх worktree). Коли A1 зіллється в `main`, `git merge origin/main` дасть ті самі коміти. Потім
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-30-p4-a2-catalog-command-core.md`.
Розбіжність якорів із кодом — архітекторці до старту.

**Паралельна робота:** Права-2d2 (worktree `Simetra-2d2`) змінює `rights/predicates.ts`: множина в `RightsCondition` стає структурованим посиланням (функція + аргументи), `renderCondition` для політик дає той самий SQL. Перед стартом перевірити, чи 2d2 уже в `main` (`git log origin/main --oneline -- packages/simetra/src/compiler/rights/predicates.ts`). Кваліфікатор рядка в `renderCondition` (Задача 2) — окремий мінімальний коміт; хто зливається другим, той механічно об'єднує обидві зміни.

## Global Constraints

- Усі обмеження планів Права-2a1…2c2 і A1 (розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` і `pnpm --filter simetra test:db <pattern>` — **без** `--` перед шаблоном.
- 🔴 Контекст команди в SQL — лише функції `COMMAND_FUNCTIONS` (`rights/command-units.ts`); користувач — лише `(SELECT simetra.current_user_id())`.
- 🔴 Розгалуження за видом і роллю довідника — лише через реєстр видів (`KIND_REGISTRY[kind].commandWrites`, `.rightsSystem`, `.actions`) і контракти (`contracts.users`), не за іменем.
- 🔴 Колонку визначають за `origin` фізичного знімка (`standard`, `scopeKindId`, `copyOf`) і `table.origin.tabularSectionId`, ніколи за логічним чи фізичним ім'ям. `origin.standard` — логічне ім'я в стилі проєкту (`naming.attributeCase`), тож його порівнюють лише зі стилізованим ім'ям реєстру (`standardLogicalName(def, attributeCase)`), не з літералом (`"deletionMark"`). Причина: [борг прав](2026-10-26-rights-residual-debt.md) §1 — генератори з літералами не компілюють snake_case-проєкт.
- 🔴 Ключі `p_item` беруться з `AccessContract.command` (`access-units.ts`, `commandColumns`) — того самого значення, з якого рендеряться гранти. Окремого переліку ключів немає.
- 🔴 Предикати права ядра — лише з `rightsPredicates` (`rights/predicates.ts`); формули права в ядрі не пишуть руками.
- 🔴 Функції ядра — `LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''`, кваліфіковані відношення, без динамічного SQL (`EXECUTE`); `EXECUTE` функції — лише `simetra_command` через `executeGrants(sig, ["command"], provider)`.
- 🔴 Відмова ядра не несе даних рядка: лише `MESSAGE` (код) і `DETAIL` (причина чи ключ). Відсутній і чужий рядок — та сама відмова.
- Тести SQL — на деревах (`compiler/__tests__/fixtures/sql-shape.ts`: `tree`, `bodyShape`, `nodes`) чи цілими операторами, не `toContain` фрагмента.
- DB-тест — лише для того, що вирішує Postgres; кожен новий DB-кейс називає причину. Скіл `.agents/skills/writing-tests/SKILL.md` — перед кожним кроком тестів. Метадані — будівниками `fixtures/rights.ts`, не літералами.
- Об'єкти стека — лише через run-tag (`packages/simetra/test/db/connection.ts`).
- Кожна відмова й кожен інваріант має тест, що червоніє від названої мутації; DB-мутації — лише на закоміченому дереві.
- Між задачами гейти не червоні: зміна, що ламає тест чи фікстуру, і її правка — в одному коміті. Кожен коміт — зелені scoped unit-тести й `pnpm --filter simetra typecheck`.
- Під час роботи — лише scoped тести, typecheck і lint пакета. Повні гейти й повний `pnpm test:db` — на одному SHA, лише після «можна» архітекторки.
- Версій пакетів і `PLATFORM_VERSION` не чіпати. Репо публічне: фікстури синтетичні. `AGENTS.md` і `CLAUDE.md` не правити.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р-A2-1 | **Цикл ієрархії — інваріант бази** (рішення архітекторки 2026-10-30, Ф1). Факт: захисту немає — лише FK `parent_id → id` (`ref: "self"`). Рядкові **`AFTER`**-тригери `<t>_simetra_hierarchy` (`INSERT … WHEN NEW.parent_id IS NOT NULL`) і `<t>_simetra_hierarchy_update` (`UPDATE … WHEN NEW.parent_id IS DISTINCT FROM OLD.parent_id`) на основній таблиці довідника з `hierarchyType ≠ None`; `AFTER`, бо `BEFORE … UPDATE OF` не бачить `parent_id`, присвоєного обробником `beforeWrite` (аудит, раунд 1; рішення архітекторки, Ф5). Функція — `VOLATILE` (типова): у `READ COMMITTED` обхід після очікування на замок бере новий знімок; `STABLE` зламав би це. Функція на таблицю (`SECURITY DEFINER`, `row_security = off`, `search_path = ''`, `EXECUTE` нікому), як функція носіїв. Замок — `pg_advisory_xact_lock(<HIERARCHY_LOCK_SPACE>, <oid таблиці>::int)`, стала простору — одна константа T1. Обхід предків нового батька — рекурсивний CTE з клаузою `CYCLE`: наявний у даних цикл не вішає тригер. Самопосилання чи знайдений серед предків id рядка — `22023`, `MESSAGE 'command.invalid'`, `DETAIL 'parent_id'` | INVOKER-ядро не бачить невидимих предків, тож перевірка в ядрі пропустила б цикл через чужий рядок; тригер діє для будь-якого автора (команда, імпорт, мігратор); замок закриває гонку двох переміщень у `READ COMMITTED`; пакет фаз може дати `40P01` «замок рядка ↔ advisory-замок» — його повторює T3 (§6.5) | П4 §6.6 (пункт про ієрархію), §9 (рядок закрито); платформна спека §4 (інваріант ієрархії) |
| Р-A2-2 | **Перевірка права — частина згенерованого ядра таблиці** (рішення архітекторки, Ф2; область прав). Окремої `simetra.authorize` немає. Ядро рендерить `rightsPredicates(contract, <літерал дії функції>, main)` — той самий будівник, що й політики запису, — над змінними рядка `v_old` (рядок під `FOR UPDATE`) і `v_new` (той самий тип рядка, стан «після»). Розширення — лише кваліфікатор у `renderCondition`. Факт, що виключив спекову форму: умова `own` — `rights_my_members(<вид скоупу власника>)` на кожен носій, контейнер — другий предикат кожного обсягу, а не окремий диз'юнкт (`predicates.ts`), тож форма `{own:[uuid], dims, container}` не повторює RLS | еквівалентність з RLS тримає побудова, а не друга реалізація формули; DB-кейс «перевірка ≡ RLS» — доказ | П4 Рт3, §6.7 (перевірка в ядрі замість функції), §6.1, §6.16, §7.1–§7.2; Додаток А — рядок спеки прав §5.1 замінено |
| Р-A2-3 | **Коди відмов перевірки права.** Створення: «після» не пройшло → `no-right`. Зміна, позначка, видалення: «до» не пройшло → `no-right`; «після» не пройшло → `new-carrier`. `old-carrier` не потрібен: замок `FOR UPDATE` уже застосовує `UPDATE USING` (право дії над станом «до»), тож рядок, що не проходить «до», ядро бачить як відсутній | Рт4: відсутній і чужий — однакова відмова | П4 §6.7, §6.10, §7.2 (`old-carrier` прибрано); спека прав §6.2 (перелік причин) |
| Р-A2-4 | **Копії носіїв у стані «після» — за тими самими зв'язками, що й тригер носіїв** (рішення архітекторки, Ф3, варіант Б). Факт: функцій виведення, які можна викликати окремо, немає — виведення вбудоване в definer-тригер `<t>_simetra_carriers`. Одне TS-джерело `carrierLinks` (`rights/carrier-units.ts`, експортується) дає і тіло тригера, і читання ядра. Ядро читає джерело під командою (INVOKER, RLS) лише після перевірки видимості цілі `Ref`; незмінений зв'язок — копії з `v_old`; зв'язок через колонку авторства — винятком Р-A2-14 | definer-функція виведення з `EXECUTE` для `simetra_command` читала б носії чужого тенанта повз RLS; розбіжність лише в гонці — тригер перечитує під `FOR SHARE`, RLS дає пізній `42501`, не дірку | П4 §6.7 («тими самими функціями виведення» → «за тими самими зв'язками копій, читанням джерела під командою») |
| Р-A2-5 | **Ключі `p_item`** (рішення архітекторки, Ф4): створення — `command.insert` мінус колонки переходів мінус колонка позначки видалення; зміна — `command.update` мінус ті самі. Позначку видалення пише лише `mark_deletion` на всіх довідниках, зокрема системних довідниках прав (там `deletion_mark` не колонка переходу, бо дії `markDeletion` немає). На створенні позначка бере значення за замовчуванням | одне джерело з грантом: розсинхрон ключа й гранту неможливий побудовою | П4 §6.6 (одне речення) |
| Р-A2-6 | **Зміна завжди виконує `UPDATE` шапки** всіма колонками ключів зміни: `SET <c> = CASE WHEN p_item ? '<c>' THEN v_in.<c> ELSE <c> END`. Коли `p_item` змінює лише ТЧ, оператор — самоприсвоєння | один шлях для «зміни шапки» і «підвищення версії на зміні лише ТЧ» замість окремої гілки з першою колонкою гранту; `contentChangeCondition` на порожній зміні істинна (`… OR NOT (<копії змінилися>)`), тож `touch`, авторство, ефекти й підписки спрацьовують, як на будь-якій зміні | П4 §6.6 — механізм «порожнього `UPDATE`» описано через самоприсвоєння всіх колонок ключів зміни |
| Р-A2-7 | **Значення з `p_item`** — один `jsonb_populate_record(NULL::<t>, p_item)` у `v_in`; колонка, якої немає в `p_item`, на створенні бере `default` фізичного знімка (чи `NULL`), на зміні — своє значення. Ядро не перетворює типів руками | Postgres сам перетворює текст і масиви JSON у типи колонок; `numeric` і `bigint` T3 подає рядками (Рт1) | немає |
| Р-A2-8 | **Конфлікт** — `RAISE` з `ERRCODE 'P0001'`, `MESSAGE 'command.conflict'`, `DETAIL` `version` чи `exists`; поточна версія — у `HINT` (текст). `40001` не годиться: T3 повторює його (§6.5) | T3 мапить за `MESSAGE`, як `command.forbidden` | П4 §6.10 (SQLSTATE і `HINT`); Рт1 — порт помилки несе `hint` (блок A3) |
| Р-A2-9 | **Контекст фази** ядро звіряє суворими функціями: `command_action()` = дія функції і `command_root(<мітка>)` = id рядка. Інакше — `42501`, `MESSAGE 'command.context'`, `DETAIL 'phase'` | контекст ставить T3 перед кожною фазою (Рт5); ядро не ставить його саме | П4 §6.6 (`DETAIL 'phase'`) |
| Р-A2-10 | **Корінь виду скоупу** в A2 отримує `save` без гілки створення (як «Користувачі»); створення кореня — блок A6 (§6.13) | §6.6: «корінь скоупу має інший порядок» | немає |
| Р-A2-11 | **Дія контексту функції** — з реєстру дій об'єкта: `create`/`update`/`markDeletion`, коли об'єкт їх має; інакше `administerRights` (системні довідники прав, Р2c2-1). Функція чи гілка без дії не генерується | розгалуження лише через реєстр | немає |
| Р-A2-12 | **ТЧ:** id рядка, що вже належить іншому власнику, — `no-right` в обох формах: видимий (явна перевірка перед DML) і невидимий (`23505` на ключі ТЧ у `INSERT`). Дубль id у масиві — `22023` `tabular.<t>` | невидимий чужий рядок ядро не бачить, тож друга форма — ключ | немає (§6.6) |
| Р-A2-13 | **Ієрархія лише в `READ COMMITTED`** (рішення архітекторки, Ф5): зміна `parent_id` в іншій ізоляції — `0A000`, `MESSAGE 'hierarchy.isolation'`; перевірка `current_setting('transaction_isolation')` — першою в функції тригера, до замка. T3 мапить її як `command.internal` | у `REPEATABLE READ`/`SERIALIZABLE` знімок фіксований, і після замка обхід не бачить закоміченого переміщення; SSI ловить гонку лише коли обидві транзакції `SERIALIZABLE`, змішана пара проходить; `runCommand` — завжди `READ COMMITTED`, тож для команди відмова — дефект платформи | П4 §6.6 (межа), §6.10 (`hierarchy.isolation` → `command.internal`); платформна §4 |
| Р-A2-14 | **Джерела копій від авторства** (рішення архітекторки, Ф6): зв'язок копії носія через колонку авторства читає рядок «Користувачів» поточного користувача не під командою, а функцією `simetra.current_user_carrier_sources()` — генерується лише коли такий зв'язок є; повертає типізований `record` лише з колонками-джерелами цих зв'язків (перелік — з `carrierLinks` на компіляції); `WHERE <ключ> = (SELECT simetra.current_user_id())` (`NULL` → жодного рядка); `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET row_security = off`; `EXECUTE` лише `simetra_command` (`executeGrants`, `REVOKE` від `PUBLIC` і ролей API). Значення йде лише в `v_new` для перевірки права | під командою рядок «Користувачів» невидимий без права `read` на них, і копія `NULL` дала б хибне `no-right`, тоді як тригер (DEFINER) пише справжнє значення; функція розкриває лише власні дані викликача, які тригер і так пише в рядок | П4 §6.7 (виняток для зв'язку авторства); спека системної схеми §3 (нова функція схеми `simetra`) |

## Review Focus

1. **Відкликання права між замком і DML** (`READ COMMITTED`): `UPDATE` повторно застосовує політики й дає нуль рядків → `GET DIAGNOSTICS` → `no-right`, не успіх і не конфлікт. В одному з'єднанні нуль рядків після замка недосяжний (замок і `UPDATE USING` — ті самі політики), тож інваріант тримає лише деревна мутація «без `GET DIAGNOSTICS`» (Задача 5).
2. **`Ref` на невидимий рядок свого тенанта** в шапці й у рядку ТЧ — `command.invalid` з колонкою, однаково з відсутньою ціллю; незмінене значення не перевіряється. Тест — Задача 7.
3. **Ключ поза грантом у `p_item`** (`created_by_id`, `version`, `deletion_mark`, колонка переходу, `predefined_name`) — `command.invalid` раніше за грант. Тест — Задача 7 (таблиця кейсів).
4. **Паралельні правки лише ТЧ з тією самою версією** — друга чекає на замок і дістає `conflict`. Тест — Задача 9.
6. **Носій `NULL`** у стані «після» — відмова ядра `no-right`, не сирий `42501` RLS (`IS NOT TRUE`). Тест — Задача 7.
5. **Наявний цикл ієрархії в даних** (прийнята таблиця, імпорт) — тригер не зависає. Тест — Задача 9.

---

### Задача 1: контракт ядра довідника

**Files:**
- Create: `packages/simetra/src/compiler/catalog-command/contracts.ts`
- Modify: `packages/simetra/src/compiler/contracts.ts` (`derivedFunctionLabels`, `derivedFunctions` — резервування імен; експорт `derived`)
- Modify: `packages/simetra/src/compiler/rights/carrier-units.ts` (експорт `carrierLinks` і `CarrierLink`)
- Modify: `packages/simetra/test/support.ts` (реекспорт `commandCoreLayer` для designer, Задача 9)
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-contracts.test.ts`

**Interfaces:**
- Consumes: `AccessContract` (`access-units.ts`, поле `command`), `RightsContract`, `mainTableOf`, `PhysicalSnapshot`, `KIND_REGISTRY`, `carrierLinks`.
- Produces:

```ts
export interface CatalogCommandContract {
  objectId: string
  kindLabel: string
  table: PhysicalTable                       // основна таблиця
  scopeColumn?: string                       // origin.scopeKindId
  key: string                                // колонка origin.standard === "ref"
  functions: { save: QualifiedName; markDeletion?: QualifiedName; delete?: QualifiedName }
  actions: { create?: string; update: string; markDeletion?: string; delete?: string }
  createKeys: string[]                       // Р-A2-5
  updateKeys: string[]                       // Р-A2-5
  tabularSections: CatalogCommandSection[]
  references: CommandReference[]             // шапка
  carrierLinks: CarrierLink[]                // зв'язки копій основної таблиці
  predefinedColumn?: string
  versionColumn: string
}
export interface CatalogCommandSection {
  table: PhysicalTable
  key: string; parent: string; lineNumber: string  // ключ ТЧ у p_item.tabular — table.name (фізичне ім'я, спека §6.6)
  scopeColumn?: string     // власна колонка скоупу ТЧ (origin.scopeKindId), якщо є
  rowKeys: string[]        // command.insert ТЧ мінус key, parent, lineNumber і scopeColumn
  updateColumns: string[]  // command.update ТЧ мінус lineNumber
  references: CommandReference[]
}
export type CommandReference =
  | { form: "single"; column: string; target: PhysicalTable; targetKey: string; array: boolean }
  | { form: "pair"; typeColumn: string; idColumn: string; array: boolean;
      targets: { label: string; table: PhysicalTable; key: string; scopeColumn?: string }[] }
export function catalogCommandContracts(input: {
  access: readonly AccessContract[]; rights: readonly RightsContract[];
  physical: PhysicalSnapshot; objects: readonly ParsedObject[];
  usersObjectId: string | undefined; scopeRootIds: ReadonlySet<string>
}): CatalogCommandContract[]
export const CATALOG_COMMAND_LABELS = { save: "save", markDeletion: "mark_deletion", delete: "delete" } as const
```

Правила побудови:
- Контракт є лише для основної таблиці об'єкта з `KIND_REGISTRY[kind].commandWrites`, наявним `AccessContract.command` і хоч однією дією з записом (`writesByCommandContract`).
- `actions` — Р-A2-11: дію бере з `RightsContract.actions` за іменем; без `create` і для кореня скоупу (`scopeRootIds`, Р-A2-10) чи «Користувачів» (`usersObjectId`) — `create` немає. `markDeletion` — лише коли є дія `markDeletion` чи `administerRights`, і не для «Користувачів» (§6.6: лише `save`). `delete` — лише для `rightsSystem === "roleAssignments"`.
- `createKeys`/`updateKeys` — Р-A2-5: колонки переходів — `RightsContract.transitions`, колонка позначки — за `origin.standard` реєстру дії `markDeletion` (`markDeletionAction.transition.column` у стилі проєкту, як `standardLogicalName`).
- `references` — з `objects` (реквізити шапки й ТЧ типу `Ref`), не з FK: масив `Ref` FK не має, а дискримінатори пари в знімку — лише текст CHECK. `ref` → `single`; `allowedTypes` → `pair` (колонки `<n>_type`/`<n>_id`); ціль — `kindLabelOf` + `mainTableOf` об'єкта цілі (ціль може не мати контракту прав, наприклад документ); `array` — з `array: true` реквізиту. Колонку реквізиту в таблиці знаходить `origin.elementId`. Виняток — стандартна колонка `parent_id` ієрархії (у `objects` її немає): `single` на свою таблицю за `origin.standard`. Копії носіїв (`origin.copyOf`) і колонка власника ТЧ до `references` не входять. `parent_id` ієрархії — `single` на свою таблицю.
- Імена функцій — `derived(table, label)` (`contracts.ts`, той самий алгоритм, що `save` документа). `derivedFunctionLabels` резервує `save`, `mark_deletion` і (для призначень) `delete` для об'єктів з `commandWrites` — з надлишком, як функції ефектів (Р2b1-11).

- [ ] **Крок 1: тести, що падають** — `catalog-command-contracts.test.ts` на `compileRights(policyDomain(writeRoles()))`, `compileRights(policyDomain(writeRoles(), adminRoles()))` і `compileRights(singleTenantRights(...))`:
  - `it.each` «ключі = грант A1 мінус …» з очікуваною різницею за роллю: вставка звичайного довідника — `[]` (`command.insert` уже без переходів, а `deletion_mark` — колонка переходу `markDeletion`); зміна звичайного довідника — колонки переходів (зокрема `deletion_mark`); вставка й зміна «Ролей»/«Призначень» — `[deletion_mark]` (дії `markDeletion` там немає, тож колонка — не перехід);
  - `it("ключі не містять механіки, авторства, копій, predefined_name, deletion_mark")` — таблицею `it.each` за `origin.standard`;
  - `it.each` ролей: звичайний довідник → `{create, update, markDeletion}`; «Ролі» → `{create:"administerRights", update:"administerRights", markDeletion:"administerRights"}`; «Призначення» → ще `delete`; «Користувачі» → лише `update`; корінь скоупу → без `create`;
  - `it("ТЧ: rowKeys без key, parent, lineNumber і колонки скоупу")` — на ТЧ скоупленого некореневого довідника (у неї власна колонка скоупу `NOT NULL`, `stages/model.ts` `withScope`), `it("поліморфний Ref — pair з мітками цілей")` (новий шар фікстури, Крок 2);
  - `it.each(["camelCase", "snake_case"])("%s: контракт за origin, не за іменем")` — та сама модель з `naming.attributeCase` обох стилів (будівник `withAttributeCase` у `fixtures/rights.ts`, якщо його немає): `createKeys`, `updateKeys`, колонка позначки (`deletion_mark`), колонки ТЧ (`parent_id`, `line_number`) і колонки гранту однакові за фізичними іменами в обох стилях. Поки snake_case-проєкт із довідниками прав не компілюється (виправлення боргу прав §1 — гілка `feat/rights-debt-1` — ще не влито), snake_case-рядок — `it.todo` з посиланням на борг прав §1. Коли архітекторка надішле SHA коміту виправлення — `git merge <SHA>` і увімкнути всі snake_case-рядки окремим комітом. Мовчки не пропускати. Той самий двостильовий кейс — у тестах Задач 2, 5 і 6 (ключі `p_item`, `deletion_mark`, `parent_id` у дереві функції);
  - `it("ім'я save довідника, зайняте дослівною функцією, — physical.function-duplicate")` — дослівна `CREATE FUNCTION public.<t>_save()` у `.sql` дає діагностику (через `functionCollisions`).
- [ ] **Крок 2: будівник фікстури.** `Task` у `policyDomain` — **документ**, а ядро генерується лише для довідника (`commandWrites` — лише в `Catalog`). У `fixtures/rights.ts` — шар `commandCoreLayer()` (наявні будівники `catalog`, `refAttribute`, `role`, `grant`; типові значення наявних шарів не змінюються):
  - довідник `Ticket` (`kindLabel: "ticket"`, `scope: "org"`, `trackAuthor: true`, `hierarchyType: "FoldersAndItems"`): `assignee` → `OrgMember` (`ownership: ["assignee"]`), `region` → `Region` (`access: [{ attribute: "region", dimension: "region" }]`), `project` → `Project` (`containerBinding: "project"`), `subject` — поліморфний `allowedTypes: [Project, Region]`; ТЧ `checklist` з реквізитом `region` → `Region`;
  - ролі (кожна дія запису вимагає `read` — `actionRequires`; без нього `rights.requires-missing`): `TicketWriter` (`read`, `create`, `update`, `markDeletion` @ `any`), `TicketOwnWriter` (те саме @ `own`), `TicketRegionWriter` (те саме @ вимір `region`), `ProjectTicketWriter` (контейнерна роль на `Project`, те саме @ `any` у контейнері), `TicketReader` (лише `read` @ `any`). `read` — на тому самому обсязі, що й запис: `read@any` для всіх змінив би видимість під `FOR UPDATE`;
  - засів `seedCommandCore(client)` у `packages/simetra/test/db/rights-seed.ts` — організації A і B, користувачі з ролями вище, рядки `Ticket` з різними носіями, рядок B для чужого тенанта, ієрархія `K1 → K2 → K3`.
  Носій за шляхом — наявний довідник `TaskComment` (`ownership: [["task", "assignee"]]`, ТЧ `attachments`).
- [ ] **Крок 3:** запустити `pnpm --filter simetra test catalog-command-contracts` — FAIL (модуля немає).
- [ ] **Крок 4:** реалізувати `catalogCommandContracts` і резервування імен; експортувати `carrierLinks`.
- [ ] **Крок 5:** `pnpm --filter simetra test catalog-command-contracts` і `pnpm --filter simetra test carrier-units` — PASS; `pnpm --filter simetra typecheck`.
- [ ] **Крок 6: коміт** — `feat(compiler): контракт ядра команд довідника — ключі з грантів A1`.

### Задача 2: предикати права над змінними рядка

**Files:**
- Modify: `packages/simetra/src/compiler/rights/predicates.ts` (`renderCondition`)
- Create: `packages/simetra/src/compiler/catalog-command/rights-check.ts`
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-rights-check.test.ts`

**Interfaces:**
- Produces:

```ts
// predicates.ts: колонка кваліфікується, коли передано змінну рядка
export function renderCondition(condition: RightsCondition, row?: string): string
// rights-check.ts
export function rightsCheckPredicates(contract: RightsContract, action: string,
  main: PhysicalTable, row: "v_old" | "v_new"): string[]  // один рядок на предикат: AND умов
export function rightsCheck(contract: RightsContract, action: string,
  main: PhysicalTable, row: "v_old" | "v_new"): string    // (<p1>) OR (<p2>) …
```

Ядро вживає перевірку лише як `IF (<rightsCheck>) IS NOT TRUE THEN <відмова>`: носій `NULL` дає `NULL`, і `IF NOT (…)` пропустив би запис до сирого `42501` RLS.

`rightsCheck` = `(<p1>) OR (<p2>) …` з `rightsPredicates(contract, action, main)`, кожна умова — `renderCondition(c, row)`: `v_new."col" = ANY (ARRAY(SELECT …))`, `v_new."col" = (SELECT simetra.current_user_id())`, булева — без змін. Порожній перелік предикатів — `false` (fail-closed).

- [ ] **Крок 1: тести, що падають:**
  - `it("дерево в дерево: предикати ядра = предикати політик запису кореневої родини")` — для `Ticket` (own, вимір, контейнер; `commandCoreLayer`) і `TaskComment` (носій за шляхом). Очікування: політики `UPDATE` кореневої родини таблиці з `sqlUnits` — імена з `accessPolicyNames(table).write("update", "root", <мітка>)` для кожного предиката; з дерева `USING` кожної викинути перший кон'юнкт — префікс родини `"<key>" = (SELECT simetra.command_root('<мітка>'))` — і замінити `(SELECT simetra.command_action())` літералом `'update'`. Фактичне: `rightsCheckPredicates(contract, "update", main, "v_new")`, кожен розібраний `tree("SELECT " + p)`, з `ColumnRef` `v_new.<col>` → `<col>`. Порівнюються **списки кон'юнктів** кожного предиката (аргументи `BoolExpr AND`, або сам вираз, коли кон'юнкт один), відсортовані (`toEqual`) — інакше `BoolExpr` з одним аргументом після викидання префікса не дорівнював би голому виразу;
  - `it("нескоуплений об'єкт — has_right")` на `singleTenantRights`;
  - `it("без предикатів — false")`;
  - `renderCondition` без `row` — дерево як до зміни (наявні тести `rights-policies*.test.ts` лишаються зеленими без правок).
- [ ] **Крок 2:** `pnpm --filter simetra test catalog-command-rights-check` — FAIL.
- [ ] **Крок 3:** реалізувати двома комітами. Перший — лише `renderCondition(condition, row?)` у `predicates.ts` (мінімальний диф, без інших правок файлу: Права-2d2 змінює той самий файл): `refactor(compiler): кваліфікатор рядка в renderCondition`. Другий — `rights-check.ts` з тестами (Крок 6).
- [ ] **Крок 4:** `pnpm --filter simetra test catalog-command-rights-check` і `pnpm --filter simetra test rights-polic` — PASS.
- [ ] **Крок 5: мутації** (на закоміченому дереві після Кроку 6): у `rightsCheckPredicates` передати в `rightsPredicates` літерал іншої дії (`'read'`) → тест «дерево в дерево» червоний; викинути предикати контейнера → червоний. Записати в журнал мутацій.
- [ ] **Крок 6: коміт** — `feat(compiler): предикати права ядра з rightsPredicates над змінними рядка`.

### Задача 3: тригер ієрархії

**Files:**
- Create: `packages/simetra/src/compiler/hierarchy-units.ts`
- Modify: `packages/simetra/src/compiler/contracts.ts` (`derivedFunctions` резервує ім'я функції ієрархії)
- Modify: `packages/simetra/src/compiler/pipeline.ts` (`buildHierarchyUnits`, генератор `mechanics`)
- Modify: `packages/simetra/src/schema/reverse/units.ts` (`platformFunctions` і впізнання платформних тригерів — там само, де `simetra_author` і тригери носіїв)
- Modify: `packages/simetra/src/schema/apply/promotion/replacements.ts` (фільтр `platform` — `touch || touchUpdate || author || carrier || effect || guard` — отримує `hierarchy`; інакше тригер ієрархії потрапить у `subscriptionShapes`) і його тест
- Modify: `packages/simetra/src/schema/__tests__/desired-state.test.ts` (inline-знімок з ієрархічним `app.category` змінюється від нового тригера — у тому самому коміті)
- Test: `packages/simetra/src/compiler/__tests__/hierarchy-units.test.ts`; тест зворотної генерації — новий кейс

**Interfaces:**
- Produces: `buildHierarchyUnits(physical, provider, module, parse): SqlUnit[]`; `hierarchyNames(table: QualifiedName): { insert: string; update: string; fn: QualifiedName }` — імена `makeObjectName(table, undefined, "simetra_hierarchy" | "simetra_hierarchy_update")`, як тригери поширення носіїв (`AFTER`-тригери на `NEW` не впливають і в групу `BEFORE` не входять); функція — у схемі таблиці з іменем тригера вставки; `HIERARCHY_LOCK_SPACE: number` (стала простору advisory-замків платформи, одна в T1).

Форма (Р-A2-1):
- Таблиці — основні таблиці з колонкою `origin.standard` = стилізоване ім'я реєстру для `parent` і FK на саму себе (не ТЧ).
- Тригери — **`AFTER`**, рядкові: `AFTER INSERT … WHEN (NEW.<parent> IS NOT NULL)` і `AFTER UPDATE … WHEN (NEW.<parent> IS DISTINCT FROM OLD.<parent>)`, без списку `OF`. `BEFORE … UPDATE OF` не годиться: Postgres не запускає тригер `OF <col>`, коли колонку змінив інший `BEFORE`-тригер (обробник `beforeWrite`), а не `SET` (так само тригер ефектів — `AFTER`, `effects-units.ts`).
- Функція на таблицю через `definerTrigger` (`SECURITY DEFINER`, `search_path = ''`, `row_security = off`), як функція носіїв: рекурсивний запит статичний, без `EXECUTE`. Тіло:
  1. `IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE … '0A000' MESSAGE 'hierarchy.isolation'` (Р-A2-13); коментар у коді — чому лише `READ COMMITTED` і чому функція `VOLATILE`, а не `STABLE`;
  2. `IF NEW.<parent> = NEW.<key> THEN RAISE … '22023' command.invalid DETAIL '<parent>'`;
  3. `PERFORM pg_advisory_xact_lock(<HIERARCHY_LOCK_SPACE>, '<s>.<t>'::regclass::oid::int)` (oid понад 2³¹ обертається у від'ємне `int` — ключ стабільний);
  4. `IF EXISTS (WITH RECURSIVE up(id) AS (SELECT p.<parent> FROM <s>.<t> p WHERE p.<key> = NEW.<parent> UNION ALL SELECT p.<parent> FROM <s>.<t> p JOIN up ON p.<key> = up.id) CYCLE id SET looped USING trail SELECT 1 FROM up WHERE up.id = NEW.<key>) THEN RAISE … '22023' command.invalid DETAIL '<parent>'` — `AFTER`-тригер бачить таблицю вже з новим зв'язком, тож шлях від нового батька до рядка — це цикл; оператор після замка в `READ COMMITTED` бере новий знімок і бачить переміщення, закомічене тим, хто тримав замок;
  5. `RETURN NULL`.
- `EXECUTE` функції — нікому (`executeGrants(sig, [], provider)`); `requires` — таблиця тіла. Ім'я функції резервує `derivedFunctions` (як функції носіїв).

- [ ] **Крок 1: тести, що падають:** `bodyShape` функції = еталон (`expectedFunction`) для фікстури з однією ієрархічною таблицею; дерева обох `CREATE TRIGGER` (`AFTER`, `WHEN`); `SECURITY DEFINER` + порожній `search_path` + `row_security = off`; таблиця без ієрархії тригера не має; зворотна генерація впізнає функцію й тригери ієрархії як платформні.
- [ ] **Крок 2:** `pnpm --filter simetra test hierarchy-units` — FAIL.
- [ ] **Крок 3:** реалізувати; підключити в `pipeline.ts`.
- [ ] **Крок 4:** `pnpm --filter simetra test hierarchy-units`, `pnpm --filter simetra test desired-state`, `pnpm --filter simetra test reverse` — PASS; далі повні unit-набори обох пакетів `pnpm --filter simetra test` і `pnpm --filter @simetrajs/designer test` — ієрархічні довідники є в `creation-order.test.ts`, `kitchen-sink.ts`, `e1-fixtures.ts`, `operations-promote.test.ts`, `examples/reference` (`Counterparty`); оновити очікування лише на нові одиниці; `pnpm --filter simetra typecheck`.
- [ ] **Крок 5: коміт** — `feat(compiler): тригер бази проти циклу ієрархії довідника`.

### Задача 4: копії носіїв — одне джерело для тригера й ядра

**Files:**
- Modify: `packages/simetra/src/compiler/rights/carrier-units.ts`
- Test: `packages/simetra/src/compiler/__tests__/carrier-units.test.ts`

**Interfaces:**
- Produces: `export function carrierLinks(physical): CarrierLink[]`; `export function carrierCopyRead(link: CarrierLink, row: "NEW" | "v_new", lock: boolean): string` (`v_new` — змінна `record`, Задача 5) — оператор `SELECT s.<col>… INTO <row>.<copy>… FROM <source> s WHERE s.<source pair> = <row>.<local pair> …[FOR SHARE]`. Тригер кличе його з `NEW` (зі `FOR SHARE` на вставці й зміні зв'язку, як зараз), ядро — з `v_new` без `FOR SHARE` (читання під командою, Р-A2-4).

- Produces також (Р-A2-14): `authorCarrierSources(physical, attributeCase): { fn: QualifiedName; columns: { name: string; type: string }[] } | undefined` і одиниці функції `simetra.current_user_carrier_sources()` (`RETURNS TABLE(<колонки>)`, генератор `carriers`); `undefined` і жодної одиниці — коли зв'язку через колонку авторства немає. Колонку авторства визначає `origin.standard` (стилізовані імена `authorColumns()`), не ім'я. Ядро бере з неї джерела для зв'язків, чия локальна колонка — авторство зі значенням поточного користувача (створення — обидві колонки авторства; зміна — `updated_by`, бо `created_by` незмінний і копія береться з `v_old`).

- [ ] **Крок 1: тести.** Наявні тести `carrier-units.test.ts` — без змін очікувань (тіло тригера — те саме дерево). Новий `it("читання ядра й тригера — один будівник")`: для кожного зв'язку `TaskComment` (шлях `task.assignee`) і `Note` (`createdBy.mentor`, `singleTenantRights(authorCarrier())`) дерево `carrierCopyRead(link, "v_new", false)` після заміни `v_new` на `NEW` = дерево оператора `SELECT … INTO NEW…` тіла тригера без `FOR SHARE`.
- [ ] **Крок 2:** `pnpm --filter simetra test carrier` — новий тест FAIL (функції немає).
  Ще: `it("джерела авторства: лише колонки зв'язків через авторство, WHERE ключ = current_user_id(), DEFINER, row_security off, EXECUTE лише command")` на `singleTenantRights(authorCarrier())`; `it("без зв'язку через авторство — функції немає")` на `policyDomain(writeRoles())`.
- [ ] **Крок 3:** винести `carrierCopyRead`; `deriveFunction` будує через нього оператор усього зв'язку (гілка вставки й зміни зв'язку); поодинокі перевиведення гілки `ELSE` лишаються як є; додати `authorCarrierSources` і її одиниці.
- [ ] **Крок 4:** `pnpm --filter simetra test carrier` — PASS; typecheck.
- [ ] **Крок 5: коміт** — `refactor(compiler): зв'язки копій носіїв — один будівник читання для тригера й ядра`.

### Задача 5: `<t>_save` — створення, зміна, ТЧ, посилання

**Files:**
- Create: `packages/simetra/src/compiler/catalog-command/units.ts`
- Modify: `packages/simetra/src/compiler/sql/units.ts` (`UnitGenerator` += `"catalogCommand"`, `FIXED_BODY.catalogCommand = true`)
- Modify: `packages/simetra/src/compiler/pipeline.ts` (`buildCatalogCommandUnits`, `describeGenerated.catalogCommand`)
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-save.test.ts`

**Interfaces:**
- Consumes: `CatalogCommandContract` (Задача 1), `rightsCheck` (Задача 2), `carrierCopyRead` (Задача 4), `COMMAND_FUNCTIONS`, `CURRENT_USER`, `executeGrants`, `dollarTag`.
- Produces: `buildCatalogCommandUnits(contracts: readonly CatalogCommandContract[], rights: readonly RightsContract[], physical, provider, module, parse): SqlUnit[]` (порожньо без `hasRightsFunctions`); `CATALOG_COMMAND_ERRORS` — сталі `MESSAGE`/`DETAIL` для тестів.

Сигнатура: `<s>.<t>_save(p_item jsonb, p_expected_version bigint) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''`. Змінні: `v_in record`, `v_old record`, `v_new record`, `v_row record`, `v_count bigint`. **Тип `record`, не `<s>.<t>`:** парсер plpgsql тестів (`@libpg-query/parser`, `bodyShape`) не розбирає присвоєння полю змінної з типом таблиці (`v_new.col := …`, `SELECT … INTO v_new.col`), а з `record` розбирає (перевірено). `record` отримує форму рядка першим присвоєнням (`v_in := jsonb_populate_record(NULL::<s>.<t>, p_item)`, `v_new := jsonb_populate_record(NULL::<s>.<t>, '{}')`, `SELECT * INTO v_old …`).

**Ребра `requires`** (граф тіл plpgsql не читає): таблиця й кожна ТЧ, таблиці цілей посилань, джерела копій носіїв, `COMMAND_FUNCTIONS.action`/`.root`, `CURRENT_USER_FUNCTION`, функції множин, які кличе `rightsCheck` (`functionIdentity`), — як `effects-units.ts` і `carrier-units.ts`.

Порядок операторів тіла (тест тримає його деревом):

1. **Вхід:** `jsonb_typeof(p_item) IS DISTINCT FROM 'object'` → `22023` `DETAIL 'p_item'`. Невідомий ключ — перший за порядком (`ORDER BY`) з `jsonb_object_keys(p_item)` поза дозволеними → `22023` `command.invalid`, `DETAIL` — ключ. Дозволені: створення — `createKeys ∪ {'tabular'}` (ключ `<key>` уже в `createKeys`); зміна — `updateKeys ∪ {<key>, 'tabular'}` (`updateKeys` ключа не містить). `v_in := jsonb_populate_record(NULL::<s>.<t>, p_item)` (Р-A2-7). Ключ `<key>` обов'язковий у обох гілках.
2. **Гілка створення** (`p_expected_version IS NULL`; лише коли `actions.create`):
   1. контекст (Р-A2-9): `IF (SELECT simetra.command_action()) IS DISTINCT FROM '<create>' OR (SELECT simetra.command_root('<мітка>')) IS DISTINCT FROM v_in.<key> THEN` → `command.context` `phase` (`command_root` дає `NULL` для іншого об'єкта, тож лише `IS DISTINCT FROM`);
   2. `PERFORM 1 FROM <s>.<t> WHERE <key> = v_in.<key>`; знайдено → `command.conflict` `exists` (Р-A2-8);
   3. `v_new := jsonb_populate_record(NULL::<s>.<t>, '{}')` — першим (поле `record` без структури дає `55000`); потім кожна колонка `createKeys`: `v_new.<c> := CASE WHEN p_item ? '<c>' THEN v_in.<c> ELSE <default|NULL> END`; колонки авторства — `(SELECT simetra.current_user_id())`;
   4. посилання (див. «Посилання» нижче) для кожного ключа `p_item`, що є посиланням;
   5. копії носіїв `v_new` — `carrierCopyRead(link, "v_new", false)` на кожен зв'язок, під командою, після кроку 4; зв'язок через колонку авторства — `SELECT … INTO v_new.<copy>… FROM simetra.current_user_carrier_sources() s` (Р-A2-14);
   6. `IF (<rightsCheck(…, create, "v_new")>) IS NOT TRUE THEN` `42501` `command.forbidden` `no-right`;
   7. `INSERT INTO <s>.<t> (<createKeys>) VALUES (<v_new.<c>>…) RETURNING * INTO v_row` у блоці `BEGIN … EXCEPTION WHEN unique_violation` — `CONSTRAINT_NAME` — первинний ключ чи `UNIQUE (<scope>, <key>)` скоупленої таблиці (`table.uniques`, колонки `[scope, key]`; котре з них Postgres перевірить першим, вирішує порядок індексів) → повторити `PERFORM 1 … WHERE <key> = v_in.<key>` (новий оператор у `READ COMMITTED` бачить коміт паралельного створення): видно → `exists`, ні → `no-right`; інше обмеження — перекинути (`RAISE`).
3. **Гілка зміни** (`p_expected_version IS NOT NULL`):
   1. контекст — та сама `IS DISTINCT FROM`-умова з `'<update>'`;
   2. `SELECT * INTO v_old FROM <s>.<t> WHERE <key> = v_in.<key> FOR UPDATE`; `NOT FOUND` → `no-right`;
   3. `v_old.<version> <> p_expected_version` → `command.conflict` `version`, `HINT` — `v_old.<version>::text`;
   4. `IF (<rightsCheck(…, update, "v_old")>) IS NOT TRUE` → `no-right`;
   5. `v_new := v_old`; кожна колонка `updateKeys`: `IF p_item ? '<c>' THEN v_new.<c> := v_in.<c>`; посилання — лише значення, що `IS DISTINCT FROM` `v_old`; копії — перевиведення лише для зв'язків, чиї колонки змінилися;
   6. `IF (<rightsCheck(…, update, "v_new")>) IS NOT TRUE` → `new-carrier`;
   7. `UPDATE <s>.<t> SET <c> = CASE WHEN p_item ? '<c>' THEN v_in.<c> ELSE <c> END, … WHERE <key> = v_in.<key> RETURNING * INTO v_row` (Р-A2-6); `GET DIAGNOSTICS v_count = ROW_COUNT`; `v_count = 0` → `no-right`.
4. **ТЧ** (обидві гілки, після DML шапки; на кожну ТЧ контракту, лише коли `p_item -> 'tabular' ? '<ts>'`; невідома ТЧ у `tabular` → `22023` `tabular.<ts>`):
   1. масив — `jsonb_typeof = 'array'`; кожен елемент — об'єкт лише з `rowKeys` (`22023` `tabular.<ts>.<ключ>`); `id` обов'язковий; дубль `id` → `22023` `tabular.<ts>`;
   2. `IF EXISTS (SELECT 1 FROM <ts> r WHERE r.<key> = ANY(<ids>) AND r.<parent> <> v_row.<key>)` → `no-right` (Р-A2-12);
   3. посилання рядків: нові рядки — кожне значення; наявні рядки цього власника — лише значення, змінені щодо збереженого;
   4. `DELETE FROM <ts> WHERE <parent> = v_row.<key> AND <key> <> ALL(<ids>)`;
   5. `UPDATE <ts> r SET <c> = CASE WHEN x.e ? '<c>' THEN <значення елемента> ELSE r.<c> END` (за `updateColumns`, як шапка — Р-A2-6; значення — `jsonb_populate_record(NULL::<ts>, x.e)`), `<lineNumber> = x.ord FROM jsonb_array_elements(…) WITH ORDINALITY x(e, ord) WHERE r.<key> = (x.e->>'<key>')::uuid AND r.<parent> = v_row.<key>`;
   6. `INSERT INTO <ts> (<key>, <parent>, <lineNumber>[, <scopeColumn>], <rowKeys…>)` для елементів без рядка цього власника; `<scopeColumn>` = `v_row.<scope>` (з входу не береться, як `<parent>`); ключ, якого немає в елементі, — `default` колонки чи `NULL`; `<parent>` = `v_row.<key>` (не з входу); `<lineNumber>` = порядок у масиві; `unique_violation` на первинному ключі ТЧ чи її `UNIQUE (<scope>, <key>)` → `no-right`.
5. **Результат:** `to_jsonb(v_row) || jsonb_build_object(<лише колонки numeric і bigint та їхні масиви — `::text`/`::text[]`>)` (не один `jsonb_build_object` усіх колонок: межа 100 аргументів функції — понад 50 колонок упало б на виконанні), плюс `'tabular'` — для кожної ТЧ, названої в `p_item`, масив рядків `ORDER BY <lineNumber>`; `RETURN …::text`.

**Посилання** (`CommandReference`; побудова в Задачі 1 — з `objects`, не з FK: масив `Ref` FK не має, а дискримінатори пари в знімку лишаються лише текстом CHECK; ціль — `ref`/`allowedTypes` реквізиту → `kindLabelOf` + `mainTableOf`, масив — за `array: true` реквізиту; ціль може не мати контракту прав, наприклад документ): `single` — `IF v IS NOT NULL AND NOT EXISTS (SELECT 1 FROM <target> WHERE <targetKey> = v [AND <target scope> = v_new.<scope>])`; умова скоупу — для масиву (FK на елементи масиву немає) і для цілі того самого виду скоупу; одиничний `Ref` скоуп тримає складений FK; у ТЧ скоуп — з `v_row` → `22023` `command.invalid` `DETAIL '<колонка>'` (у ТЧ — `tabular.<ts>.<колонка>`); масив — кожен елемент. `pair` — мітка ∉ дозволених → та сама відмова; інакше гілка за міткою з тією самою перевіркою видимості й, коли ціль має колонку скоупу того самого виду, — `AND <target scope> = v_new.<scope>`.

- [ ] **Крок 1: тести, що падають** (`catalog-command-save.test.ts`, `loadShapeParsers` у `beforeAll`):
  - `it("порядок зміни: контекст → замок → версія → право «до» → право «після» → UPDATE → GET DIAGNOSTICS")` — індекси операторів у `bodyShape` (обхід углиб з `depth`) гілки зміни строго зростають; `FOR UPDATE` — у дереві запиту замка (`nodes(tree, "lockingClause")`); `GET DIAGNOSTICS` у `bodyShape` виразу не несе — перевіряти, що оператор `getdiag` іде одразу після `UPDATE`, а за ним `IF` з `v_count = 0`;
  - `it("порядок створення: контекст → exists → посилання → копії → право → INSERT")`;
  - `it("перевірка права — дерево rightsCheck")` для `v_old`/`v_new`;
  - `it("ТЧ: DELETE і UPDATE мають parent = v_row.key у WHERE; INSERT бере parent з v_row")` — дерева операторів;
  - `it("UPDATE шапки — CASE за кожною колонкою updateKeys")` — дерево цілим оператором;
  - `it("ключі поза createKeys/updateKeys відхиляє перевірка входу")` — літерали переліку в дереві = ключі контракту;
  - `it("гранти: EXECUTE лише command")` — `executeGrants(sig, ["command"], provider)` цілими операторами;
  - `it("SECURITY INVOKER, search_path = '', без EXECUTE у тілі")` (`bodyShape(fn).filter(s => s.type === "dynexecute")` порожній);
  - `it("кожна перевірка — NULL-безпечна")`: умови контексту — `IS DISTINCT FROM`, перевірки права — `IS NOT TRUE` (дерева `IF`);
  - `it("широка таблиця: результат без межі аргументів")` — довідник з 60 реквізитами компілюється, і `jsonb_build_object` результату має лише колонки `numeric`/`bigint`;
  - `it.each(["camelCase", "snake_case"])` — ключі `p_item` у дереві однакові (snake_case — `it.todo` до злиття боргу прав §1).
- [ ] **Крок 2:** `pnpm --filter simetra test catalog-command-save` — FAIL.
- [ ] **Крок 3:** реалізувати генератор і підключити в `pipeline.ts`.
- [ ] **Крок 4:** `pnpm --filter simetra test catalog-command` — PASS. Повні unit-набори `pnpm --filter simetra test` і `pnpm --filter @simetrajs/designer test` (нові одиниці змінюють знімки `desired-state.test.ts`, `compile.test.ts`, `explain.test.ts` та інші); оновити очікування лише там, де нові одиниці додаються, без нових діагностик. `paper-test.db.test.ts` (`expected-diff.json`) — перевірити на DB-прогоні Задачі 7.
- [ ] **Крок 5:** `pnpm --filter simetra typecheck`, `pnpm --filter simetra lint`.
- [ ] **Крок 6: коміт** — `feat(compiler): ядро save довідника — замок, версія, право, ТЧ, посилання`.
- [ ] **Крок 7: мутації дерева** (на закоміченому дереві; кожна — окремий прогін `pnpm --filter simetra test catalog-command-save`, відкат `git checkout`): прибрати `FOR UPDATE` → червоний «порядок зміни»; поставити перевірку права після `UPDATE` → червоний; прибрати `GET DIAGNOSTICS` → червоний; прибрати `parent = v_row.key` з `WHERE` `DELETE` ТЧ → червоний «ТЧ». Записати в журнал мутацій.

### Задача 6: `mark_deletion`, `delete`, «Користувачі», системні довідники прав

**Files:**
- Modify: `packages/simetra/src/compiler/catalog-command/units.ts`
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-mark.test.ts`

**Interfaces:**
- `<t>_mark_deletion(p_id uuid, p_expected_version bigint, p_mark boolean) RETURNS text`: `p_mark IS NULL` чи `p_expected_version IS NULL` → `22023` `command.invalid` з іменем параметра → контекст (`actions.markDeletion`, корінь `p_id`) → замок → версія → право «до» → `v_new := v_old; v_new.deletion_mark := p_mark` → право «після» (`new-carrier`) → `v_old.<predefined> IS NOT NULL` → `22023` `command.invalid` `predefined` → `UPDATE … SET <deletion_mark> = p_mark WHERE <key> = p_id RETURNING * INTO v_row` → `GET DIAGNOSTICS` → результат. Посилань не шукає (Рт12). Позначка предвизначеного перевіряється після права: інакше відмова без права розкривала б, що рядок предвизначений.
- `<t>_delete(p_id uuid, p_expected_version bigint) RETURNS text` (лише «Призначення»): контекст → замок → версія → право «до» → `DELETE … WHERE <key> = p_id` → `GET DIAGNOSTICS` → `jsonb_build_object('<key>', p_id, '<version>', v_old.<version>::text)::text`.
- Умови контексту й права — NULL-безпечні, як у Задачі 5.
- «Користувачі», корінь скоупу — лише гілка зміни `save`; `p_expected_version IS NULL` → `22023` `command.invalid` `DETAIL 'create'`.

- [ ] **Крок 1: тести, що падають:** порядок операторів обох функцій деревом; предвизначений — після перевірки права; `delete` лише на «Призначеннях» (`it.each` ролей довідника: наявність/відсутність функцій); «Користувачі» без гілки створення; дія контексту «Ролей» — `'administerRights'` у дереві `command_action()` = літерал.
- [ ] **Крок 2:** `pnpm --filter simetra test catalog-command-mark` — FAIL.
- [ ] **Крок 3:** реалізувати.
- [ ] **Крок 4:** `pnpm --filter simetra test catalog-command` — PASS; typecheck.
- [ ] **Крок 5: коміт** — `feat(compiler): позначка видалення, видалення призначення, зміна «Користувачів»`.

### Задача 7: DB — ядро через `commandAs`

**Files:**
- Create: `packages/simetra/test/db/catalog-command.db.test.ts`
- Modify: `packages/simetra/test/db/rights-seed.ts` (`seedCommandCore`, Задача 1)
- Modify: `packages/simetra/test/db/connection.ts` (`Refusal` += `hint?: string`; `commandAs` читає `hint` помилки)
- Modify: `packages/simetra/test/support.ts` (реекспорт `seedCommandCore` не потрібен — designer засіває напряму, як `rights-last-full-access.db.test.ts`)
- Modify: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (`Layer` зливає лише JSON, тож SQL обробника додається до `Map` після `policyDomain(...)`, як `COUNT_COMMENT_SQL_FILE`; будівник підписки `beforeWrite` на `Ticket`: обробник присвоює `NEW.<поле> := current_user` — для кейсу «від імені `simetra_command`»; і обробник, що присвоює `NEW.parent_id` значення з іншого реквізиту — для Задачі 9)

**Interfaces:** модель — `policyDomain(writeRoles(), commandCoreLayer())`; засів — `seedCommandCore`; роль команд — **лише згенеровані гранти** й `EXECUTE` функцій ядра (як `command-grants.db.test.ts`: `GRANT <command> TO CURRENT_USER WITH SET TRUE`, без повного DML-гранту), бо доказ — контракт ролі. Причина DB-рівня: RLS, гранти, `FOR UPDATE` і `23505` вирішує Postgres. Виклик — `commandAs(client, claims, {action, object, root}, "SELECT <s>.<t>_save($1, $2)", {params})`. `withRoles` зливає файли на верхньому рівні: шар, що змінює `attributes` наявного об'єкта, повторює всі його реквізити.

Кейси (таблиця `CASES`, один `it.each`; кожен — один виклик у точці збереження):
- `create` / `update` / `markDeletion` `Ticket` (скоуп) — з ТЧ `checklist` і поліморфним `subject`; результат — рядок з `version` рядком і ТЧ; рядок ТЧ має колонку скоупу з `v_row`, а не з входу;
- конфлікт версії → `command.conflict` `version`, `hint` — поточна версія; повторне створення з видимим id → `exists`; з id рядка тенанта B → `no-right`;
- **чужий і відсутній рядок** — `update` з id рядка тенанта B і з випадковим UUID → обидва `42501` `command.forbidden` `no-right`, однакові `code/message/detail/hint`;
- **конфлікт бачить лише той, хто має право:** `TicketReader` (лише `read`) — правильний id, хибна версія → `no-right`, не `conflict`;
- обсяги: `TicketOwnWriter` (`assignee`), `TicketRegionWriter` (`region`), `ProjectTicketWriter` (`project`): зміна носія на чужий → `new-carrier`; носій `NULL` (порожній `region`) під роллю виміру: створення → `no-right`, зміна → `new-carrier` — від ядра, не сирий `42501` RLS;
- ТЧ: правка ТЧ одного `Ticket` не чіпає рядків ТЧ іншого видимого `Ticket` (кількість і зміст до й після); id рядка ТЧ іншого власника (видимий) → `no-right`; (невидимий, тенант B) → `no-right`; дубль id → `command.invalid` `tabular.<ts>`; `line_number` = порядок масиву; рядки, відсутні в масиві, видалено;
- ключі: `deletion_mark`, `version`, `created_by_id`, `predefined_name`, колонка переходу, вигаданий ключ у `save` → `22023` `command.invalid` з ключем; прямий `UPDATE predefined_name` під згенерованим грантом → `42501` (грант; `deletion_mark` у гранті зміни є, і під дією `update` його не відхиляють ні грант, ні ефекти — тому тримає його лише перевірка ключів ядра);
- `Ref`: шапка й рядок ТЧ на невидимий рядок свого тенанта → `command.invalid` з колонкою, той самий результат, що для випадкового UUID; незмінене невидиме значення при зміні іншої колонки — проходить; поліморфний з міткою поза дозволеними → `command.invalid`;
- позначка предвизначеного → `command.invalid` `predefined`; позначка без права → `no-right`; `p_mark` `NULL` → `command.invalid` `p_mark`;
- контекст: `root` іншого рядка → `command.context` `phase`; контекст з міткою іншого об'єкта (`command_root` → `NULL`) → `command.context` `phase`;
- підписка `beforeWrite` шапки на правці лише ТЧ виконується від `simetra_command`, не від власника таблиці;
- окремий `describe` нескоупленого довідника `Note` (`singleTenantRights(authorCarrier())`: ТЧ `lines`, роль `NoteWriter` — `read`, `create`, `update`): `create`/`update` з ТЧ `lines` — проходять; `markDeletion` — `no-right` (права немає); і в тому самому `describe` з моделлю `singleTenantRights(authorCarrier())` і `authorCarrier("long")` (60-байтна назва): роль `NoteOwnCreator` (`read`, `create` @ `own` на `Note`, будівник у `fixtures/rights.ts`), користувач **без** `read` на «Користувачах» і з `mentor_id` = власний id створює `Note` з рядками ТЧ і носієм `createdBy.mentor` — проходить, копія = значення з його рядка (з `NULL`-копією в `v_new` право `own` не виконалось би, тож кейс червоніє від мутації «читати джерело під командою»); виклик `simetra.current_user_carrier_sources()` від ролі API (`queryAs` `authenticated`) → `42501`.

- [ ] **Крок 1:** написати файл з кейсами. Запуск: `pnpm --filter simetra test:db catalog-command` — FAIL лише якщо ядро ще не підключене; інакше зелений одразу, і доказом стають мутації Кроку 4.
- [ ] **Крок 2:** зелений прогін; час прогону — у звіт.
- [ ] **Крок 3: коміт** — `test(db): ядро довідника — відмови, конфлікти, ТЧ, посилання, ключі`.
- [ ] **Крок 4: DB-мутації** (закомічене дерево, по одній, відкат `git checkout`): прибрати `FOR UPDATE` → червоний кейс `TicketReader` (без замка версія перевіряється раніше за RLS, і вилазить `conflict`); прибрати перевірку видимості `Ref` → червоний кейс `Ref`; прибрати `parent_id = <корінь>` з `WHERE` `DELETE` ТЧ → червоний кейс «ТЧ іншого власника» (твердження: рядки ТЧ іншого видимого `Ticket` лишилися цілими; для `UPDATE` ТЧ мутація DB-рівнем не червоніє — видимий чужий рядок відсікає явна перевірка, невидимий — RLS, тож її тримає деревна мутація Задачі 5); прибрати перевірку ключів `p_item` → червоний кейс ключів; читати джерело авторства під командою замість `current_user_carrier_sources()` → червоний кейс «без `read` на «Користувачах»» (хибне `no-right`). У журнал мутацій.

### Задача 8: DB — перевірка права ядра ≡ RLS

**Files:**
- Create: `packages/simetra/test/db/catalog-command-rights.db.test.ts`

Причина DB-рівня: доводить, що предикати над змінними дають те саме, що політики над рядком. Модель і засів — Задачі 7 (`commandCoreLayer`, `seedCommandCore`); роль команд — повний DML-грант фікстури (Р2b1-13), щоб базова лінія RLS не впиралась у колонкові гранти.

Сітка: користувачі засіву × рядки `Ticket` тенантів A і B і рядки `TaskComment` (носій за шляхом `task.assignee`) × дії `create`, `update`, `markDeletion` × стан «після» (без зміни носія; `assignee`, `region`, `project` замінено на значення, яке користувач має чи не має; `NULL`). Для кожної точки:
- ядро: `commandAs(…, "SELECT <t>_save(…)")` → `ok` | `check` (`42501` з `MESSAGE 'command.forbidden'`) | `rls` (`42501` без нього);
- RLS: той самий стан прямим `INSERT`/`UPDATE … WHERE id = …` під `commandAs` з тим самим контекстом → `ok` | `refused` (0 рядків чи `42501`).
- Твердження: ядро ніколи не дає `rls`; `ok` ядра ⇔ `ok` RLS. На `create` діє ще `RESTRICTIVE`-межа `scope_insert`, яку перевірка ядра не повторює: точка «створення в чужому тенанті» має дати `check` чи `ok`→`rls` — останнє і є розбіжністю, яку ловить тест.

- [ ] **Крок 1:** написати; `pnpm --filter simetra test:db catalog-command-rights` — PASS; час — у звіт.
- [ ] **Крок 2: коміт** — `test(db): перевірка права ядра збігається з RLS на фікстурах політик`.
- [ ] **Крок 3: DB-мутація:** у `rightsCheckPredicates` викинути предикати контейнера → червоний (точки `ProjectTicketWriter`). У журнал мутацій.

### Задача 9: DB — паралельність, ієрархія, системні довідники прав

**Files:**
- Create: `packages/designer/src/__tests__/catalog-command-concurrency.db.test.ts`
- Create: `packages/simetra/test/db/catalog-command-admin.db.test.ts`

**Паралельність і ієрархія** — у пакеті designer за зразком `packages/designer/src/__tests__/rights-last-full-access.db.test.ts`: модель з `simetra/test/support` (`policyDomain`, `commandCoreLayer`), `renderDesiredState`, ціль — `inTarget` (`support/db.ts`, тінь рушія з бажаним SQL поряд зі стеком; окрема база через `CREATE DATABASE` не має стану провайдера), засів напряму під режимом обслуговування й `COMMIT`, дві сесії `pg.Client`; кожна команда сесії — `BEGIN` → `set_config('request.jwt.claims', …, true)` → `set_config(COMMAND_SETTING, …, true)` → `SET LOCAL ROLE simetra_command` → виклик ядра → `COMMIT`/`ROLLBACK` (`commandAs` не годиться: він відкочує точку збереження й знімає замок); членство тестової ролі в `simetra_command` — разовий `GRANT <command> TO CURRENT_USER WITH SET TRUE` у закоміченій транзакції з `REVOKE` у `finally` (сторож стека бачить лише імена ролей, тож слід лишився б непоміченим); очікування на замок — `waitForLock` (`pg_stat_activity.wait_event_type = 'Lock'`) з того самого файлу (винести в `support/db.ts`, щоб не копіювати). Причина DB-рівня: замки й `READ COMMITTED` вирішує Postgres; потрібні закомічені дані й два з'єднання. Кейси:
- дві правки лише ТЧ `Ticket.checklist` з тією самою очікуваною версією: сесія 1 `BEGIN` → `save` → тримає; сесія 2 `save` чекає на замок (`waitForLock`); сесія 1 `COMMIT`; сесія 2 → `command.conflict` `version`;
- ієрархія `Ticket`: самопосилання → `command.invalid` `parent_id`; A→B→A → те саме; один `UPDATE` двох рядків (A під B і B під A одним оператором) → відмова; два паралельні переміщення (A під B у сесії 1, B під A у сесії 2): друга чекає на advisory-замок і після `COMMIT` першої падає `command.invalid`; обробник `beforeWrite`, що присвоює `NEW.parent_id` циклічне значення, → відмова; кейс — прямий `UPDATE <t> SET <інший реквізит>` під `simetra_command` з контекстом, не через `save`: `save` присвоює всі `updateKeys`, зокрема `parent_id`, і `BEFORE … UPDATE OF parent_id` спрацював би й так; наявний цикл у даних (засіяний з поіменно вимкненими `ALTER TABLE … DISABLE TRIGGER <t>_simetra_hierarchy` і `… <t>_simetra_hierarchy_update` у транзакції засіву, не `ALL`: `ALL` вимикає й FK і вимагає суперкористувача) — переміщення під член циклу завершується (`SET statement_timeout = '5s'`): відмова, коли ланцюг доходить до рядка, успіх інакше; зміна `parent_id` у `REPEATABLE READ` і в `SERIALIZABLE` → `0A000` `hierarchy.isolation`.

**Системні довідники прав** (модель `policyDomain(writeRoles(), adminRoles())`, описова транзакція, як `rights-guards.db.test.ts`; причина DB-рівня — запобіжники 2c2 на `COMMIT`; перевірка `COMMIT` — `SET CONSTRAINTS ALL IMMEDIATE` у точці збереження, як там):
- створити кастомну роль `save` з ТЧ `delta` → журнал має рядок `command`;
- правка лише ТЧ ролі з призначенням (порожній `UPDATE` шапки): `role-in-use` не спрацьовує, ⊆ не спрацьовує, версія ролі +1;
- `mark_deletion` ролі з живим призначенням → `role-in-use`;
- призначити (`save` «Призначень») і зняти (`<t>_delete`) — проходять; `<t>_delete` з хибною версією → `conflict`;
- «Користувачі»: `save` зміни реквізиту застосунку — проходить; ключ `invalid` → `command.invalid`; `save` без версії → `command.invalid` `create`.

- [ ] **Крок 1:** написати обидва файли; `pnpm --filter @simetrajs/designer test:db catalog-command-concurrency` і `pnpm --filter simetra test:db catalog-command-admin` — PASS; час — у звіт; сторож стека не бачить сиріт.
- [ ] **Крок 2: коміт** — `test(db): паралельні правки ТЧ, цикл ієрархії, ядро системних довідників прав`.
- [ ] **Крок 3: DB-мутації:** прибрати `pg_advisory_xact_lock` → червоний паралельний кейс ієрархії; повернути `BEFORE … UPDATE OF parent_id` → червоний кейс обробника `beforeWrite`; прибрати перевірку ізоляції → червоний кейс `REPEATABLE READ`; виконувати `UPDATE` шапки лише коли є ключі шапки → червоний кейс паралельних правок ТЧ. У журнал мутацій.

### Задача 10: документи

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-p4-runtime-design.md`
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§5.1, §6.2)
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§4)
- Modify: `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` (§3)
- Modify: `docs/ROADMAP.md`
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (рядок про ієрархію: база відхиляє цикл `parent_id`)

Правки спеки П4 (кожна — з рішення плану):
- Рт3 → «Перевірка права — частина згенерованого ядра таблиці з тих самих `rightsPredicates`, що й політики запису, над змінними рядка; окремої функції немає» (Р-A2-2);
- §6.1 «Входить» — `authorize` → «перевірка права в ядрі»;
- §6.6: ключі (Р-A2-5), самоприсвоєння (Р-A2-6), контекст `phase` (Р-A2-9), корінь скоупу без створення (Р-A2-10), ТЧ (Р-A2-12), новий пункт «Ієрархія» (Р-A2-1);
- §6.7 — переписати під Р-A2-2…4: стан «після», коди, без `simetra.authorize`, без `EXECUTE`;
- §6.10 — `command.conflict`: `P0001`, `HINT` (Р-A2-8); `hierarchy.isolation` → `command.internal` (Р-A2-13); `old-carrier` прибрати;
- §6.6 — форма тригера ієрархії (`AFTER`) і межа `READ COMMITTED` (Р-A2-1, Р-A2-13); §6.7 — виняток для зв'язку через авторство (Р-A2-14);
- рядок 248 (`EXECUTE` функцій ядра й `simetra.authorize`) — без `simetra.authorize`;
- §6.16 п. 4 — без змін змісту; §7.1–§7.2 — «`authorize` ≡ RLS» → «перевірка права ядра ≡ RLS», `old-carrier` прибрати;
- §8 рядок A2 — `simetra.authorize` → перевірка в ядрі; §9 — рядок «Цикл ієрархії» прибрати (вирішено Р-A2-1);
- Додаток А: рядок спеки прав §5.1 → «перевірка права в ядрі (Р-A2-2) замість `simetra.authorize`»; рядки з блоком A2 позначити внесеними.

Спека прав: §5.1 — абзац `authorize` → перевірка в ядрі з `rightsPredicates`; ім'я `simetra.authorize` з переліку форм прибрати; решта згадок `authorize` (Рх11, Рх12 — «та сама умова в `authorize`», §1, §5) — на «перевірку права ядра» (`grep -n authorize` по файлу);
Спека системної схеми §3: `simetra.current_user_carrier_sources()` (Р-A2-14).
 §6.2 — «нуль змінених рядків… повторна перевірка» → замок за Рт4 і перелік причин без `old-carrier`.
Платформна спека §4: інваріант ієрархії — база відхиляє цикл `parent_id` для будь-якого автора.
ROADMAP, рядок «Ранній зріз П4»: «A2 (ядро довідника) виконано; далі A3».

- [ ] **Крок 1:** внести правки; `python3 scripts/check-doc-anchors.py` — без нових помилок.
- [ ] **Крок 2: коміт** — `docs(spec): П4-A2 — перевірка права в ядрі, ключі, ієрархія`.

### Задача 11: перевірка й звіт

- [ ] **Крок 1:** `.claude/commands/виконай-задачу.md` — Workflow перевірки: лінзи `code-review` `correctness` (однакова відмова чужого й відсутнього рядка; `FOR UPDATE` і `READ COMMITTED`; відкликання права між замком і DML; ТЧ іншого власника; ключі поза грантом; видимість цілі `Ref`; перевірка права ≢ RLS) і `test-honesty` (кожна відмова червоніє від мутації); кожну знахідку — `code-review-verifier`.
- [ ] **Крок 2:** контрольна точка архітекторці після DB-тестів: SHA і коміти, журнал мутацій, час scoped DB-прогонів, рішення з полем «вплив на спеку». Чекати «далі».
- [ ] **Крок 3:** повні гейти на одному SHA — лише після «можна»: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`, `pnpm test:db` (без зовнішнього тайм-ауту, коротшого за 45 хв).

## Журнал мутацій (заповнює виконавець)

| Задача | Що прибрано | Що почервоніло |
| --- | --- | --- |
