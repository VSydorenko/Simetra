# Права-1a: носії прав і контракт прав об'єкта — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [X]`) syntax for tracking.

Статус: прийнято архітектором задачі 2026-10-18 після аудиту Codex.
Архітектор задачі — сесія, що замовила план (`consumer-reconciliation2`);
якщо її немає — власник.

**Мета:** реєстр видів, T0 і компілятор знають усе, що об'єкт оголошує про права
(дії, вимоги, ефекти, обсяги, власність, контейнер, виміри доступу, прийняті
джерела), і віддають це як контракт прав об'єкта — без SQL і без бази.

**Архітектура:** факти виду — у реєстрі (`actions(obj)` з вимогами й ефектами,
`rightsExtents`, `rightsContainer`, `rightsBinding`); декларації об'єкта й
проєкту — Zod-схеми T0 у `model/schemas/rights.ts`; компілятор резолвить
посилання в загальний індекс (каскад `rename`/`delete` працює без нового
коду операцій), перевіряє правила `rights.*` у стадіях 4–5 і будує
`contracts.rights`, `contracts.accessDimensions`, `contracts.membershipSources`,
`contracts.assignmentSources`. Набори прав і ролі — план
[Права-1b](2026-10-18-rights-1b-sets-roles.md), який залежить від цього.

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM) для
розбору SQL, pnpm workspace.

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — читати повністю;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) §4 «Скоуп»,
§6.7, §6.8, §9; [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3–§6, §8; [спека системної схеми й користувачів](../specs/2026-10-07-system-schema-users-design.md)
§7, §8; [спека промоції](../specs/2026-10-06-promotion-design.md) Пр11, Пр18,
Пр25, §9.3, §9.4, §9.11.

## Global Constraints

- T0 (`packages/simetra/src/model`) не має runtime-залежностей, крім `zod`; Zod-схеми — єдине джерело типів (`z.infer`), без `z.any()`, схеми строгі (`z.strictObject`).
- Кожне розгалуження за видом читає реєстр видів (`KIND_REGISTRY`), а не назву виду; новий факт — поле `KindDefinition` плюс тести.
- Поле схеми є лише там, де його дозволяє факт реєстру (зразок — `trackAuthor` і `authorTracking`).
- Без шимів сумісності: замінене видаляється в тій самій зміні, без аліасів і «deprecated».
- Ідентичність — UUID; посилання у файлах — за логічним іменем; кожне посилання за іменем потрапляє в індекс посилань (`model.references`), інакше червоніє `reference-index-completeness.test.ts`.
- Кожне нове поле схем читає стадія компілятора чи контракт, а `fixtures/kitchen-sink.ts` його задає: інакше червоніє `test/field-ratchet.test.ts`. Новий рядок у `EXCEPTIONS` ратчета — лише за рішенням архітектора.
- Діагностики: коди в `COMPILER_RULES` (`compiler/diagnostics.ts`), попередження — ще й у `WARNING_RULES`; тексти en і uk у `MESSAGES` (`compiler/messages.ts`), uk відрізняється від en. Простір нових кодів — `rights.*`; виняток — `scope.custom-table-cross-tenant` (правило скоупу).
- Коментарі в коді — українською й пояснюють «чому»; JSDoc експортованого API, тексти діагностик en і `description` у `.meta()` схем — англійською.
- Після будь-якої зміни схем: `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`, і згенеровані `packages/simetra/schemas/*.schema.json` ідуть у той самий коміт.
- 🔴 `pnpm --filter <pkg> test <pattern>` — без `--` перед шаблоном, інакше фільтр мовчки ігнорується.
- Коміти: Conventional Commits, опис українською, **без трейлерів** (`Co-Authored-By`, «Generated with» тощо). Комітить виконавець плану лише в межах команди власника `/виконай-задачу`.
- Репо публічне: приклади й фікстури — синтетичні (жодних імен, таблиць чи схем споживача).
- Поза планом: SQL, політики, функції бази, системні об'єкти «Ролі», «Призначення ролей», «Журнал прав», «Версії прав», DB-тести, `runCommand`, `authorize`, ролі в `examples/` (Права-2 і ранній зріз П4).

## Рішення плану

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1a-1 | `KindDefinition.actions` стає функцією `actions(obj): readonly KindAction[]` (`{ name, requires, effects }`); статичний масив видаляється. `requires(obj)` спеки — експортована функція `actionRequires(kind, obj)` над тим самим фактом | немає (§3 називає факти, форма — план) |
| Р1a-2 | Загальне ребро: кожна дія з непорожнім `effects.dml` вимагає `read`; вид додає лише власні ребра (`post ⇒ update`, `unpost ⇒ post`) | спека прав §3 (Задача 0) |
| Р1a-3 | Ефект дії — `{ dml: ("insert"\|"update"\|"delete")[], header: "all" \| string[], tabularSections: boolean }`; `header` — канонічні camelCase-імена стандартних реквізитів чи імена реквізитів об'єкта. Вимоги — лише передумова права, ефекти — власні ефекти дії: дія, що вимагає `update`, його ефектів **не** успадковує; ефекти стандартних дій задає реєстр, кастомна дія оголошує свої | спека прав §3, §5.3 (Задача 0) |
| Р1a-4 | Дія запису незалежного регістра відомостей — `write` з `dml: ["insert","update","delete"]`; `update` константи — `dml: ["insert","update"]` | спека прав §3, §5.3 (Задача 0) |
| Р1a-5 | `rightsExtents` — `readonly ("any"\|"own"\|"dimension")[]`: довідник і документ — усі три, регістри — `any` і `dimension`, константа — `any`, `CustomTable` та види без RLS — порожньо. Контейнер — не обсяг, а рівень: факти `rightsContainer?: true` (Catalog) і `rightsBinding?: true` (Catalog, Document) | немає |
| Р1a-6 | Дія в даних — слово словника або UUID кастомної дії (Рх18); кастомна дія — елемент з `id` і `name` без `physicalName`, новий факт реєстру `idElementFields` | спека прав §3 (Задача 0) |
| Р1a-7 | Імена кастомних дій — camelCase, як слова словника, незалежно від `naming.attributeCase`; ім'я, що збігається зі стандартною дією виду, — помилка | немає |
| Р1a-8 | Ефекти кастомної дії оголошуються як `{ header?: "all" \| string[], tabularSections?: boolean }`; `dml` виводиться: є що писати — `["update"]`, інакше `[]`. Імена в `header` — посилання на реквізити (індекс посилань) | спека прав §3 (Задача 0) |
| Р1a-9 | Мітки виду отримують регістри й константа (Пр25 для всіх видів з RLS); промоція в регістр мітку зберігає, а якщо її не було — призначає за правилом `physicalName`; `labelDropped`, `promote.label-target` і звільнення мітки в `releasedByPromotion` видаляються як мертвий код | промоція §9.11, Пр18, Пр25; П2 §3; платформна спека §4 (Задача 0). Формулювання `AGENTS.md` про зникнення мітки — за власником через архітектора |
| Р1a-10 | Носій (власність, прив'язка, `access`) — рядок (реквізит) або пара `[реквізит, реквізит цілі]` (Рх21); «в межах скоупу» означає складений FK у фізичному знімку (`Target.scope`), а в проєкті без видів скоупу — будь-який одиночний `Ref` | немає |
| Р1a-11 | `ownership: ["ref"]` (ключ) дозволено лише на довіднику з роллю `users` | немає |
| Р1a-12 | Поля: об'єкт-контейнер — `rightsContainer: true`; прив'язка — `containerBinding: <носій>`; виміри проєкту — `accessDimensions`; джерела — `membershipSources`, `assignmentSources`; вимір `{ id, name, target, values: { relation: { object, subject, value } } \| { function: { schema?, name } } }` | немає |
| Р1a-13 | Вимір над нескоупленим довідником — помилка лише в проєкті з видами скоупу | спека прав §4.4 (Задача 0) |
| Р1a-14 | Функція значень виміру — закрита форма функції множини скоупу (`LANGUAGE sql`, `STABLE`, `SECURITY DEFINER`, `SET search_path = ''`, кваліфіковані відношення); перевірка транзитивна за дослівними sql-функціями проєкту; plpgsql чи невідома кваліфікована функція в ланцюжку — помилка (fail-closed); з `simetra.*` дозволено лише `current_user_id()`; згенеровані функції членства дозволені | спека прав §4.4 (Задача 0) |
| Р1a-15 | У цих планах `CustomTable` контракту прав не має (`rightsExtents` порожній, `contracts.rights` її не містить); грант на неї (Права-1b) — `rights.custom-table-no-contract`; дизайн прав прийнятих таблиць відкладено. `AccessContract` тут не є контрактом доступу: `accessContracts` пропускає `declared`-таблиці | немає |
| Р1a-16 | Джерело призначень оголошує рівень сталою (`assignedOn` у формі ролі); одне джерело — один рівень; джерела — іменовані елементи з UUID | спека прав §4.7 (Задача 0) |
| Р1a-17 | Прийняте джерело членства задовольняє вимогу «вид скоупу має членство» (Рх7, перевіряє Права-1b), але `setFunction: "membership"` і далі вимагає довідника: генерація функції з джерела — SQL Прав-2 | немає |
| Р1a-18 | Модуль-власник (Р15) — за П2 §8.6: неявний модуль проєкту, поля модуля немає до П4 | спека прав §4.1 (Задача 0) |
| Р1a-19 | Посилання з файлу об'єкта на елемент проєкту (вид скоупу, вимір, джерело) — новий хук реєстру `projectReferences?(obj)`, ціль — `{ kind: "ScopeKind" \| "Element", id }`; імена елементів проєкту унікальні в усіх його колекціях (інакше адресація `{ kind: "Project", element }` неоднозначна) | немає |
| Р1a-20 | Контракти — у `Contracts` (хешуються через `canonical.ts`); `explain` показує `contracts.rights` об'єкта | немає |
| Р1a-21 | Стандартні дії в `requires` (і в `grant.actions` Прав-1b) — слова платформи, а не посилання на елементи метаданих: виняток `NOT_REFERENCES` у `reference-index-completeness.test.ts` з цією причиною; кастомні дії — посилання (`customAction.requires`, `grant.customAction`), винятку для них немає | немає |
| Р1a-22 | Ім'я кастомної дії унікальне серед усіх сусідніх іменованих колекцій об'єкта (реквізити, виміри й ресурси, ТЧ, кастомні дії): адресація `{ kind, name, element }` бере першу колекцію зі збігом | немає |
| Р1a-23 | `title`/`description` кастомних дій і вимірів відкладено до плану зі споживачем (представлення чи матриця, П4); ратчет не обходиться | немає |
| Р1a-24 | Ціль `ownership` може бути й прийнятою таблицею — джерелом членства виду скоупу об'єкта, якщо її ключ і колонка скоупу дають `UNIQUE (scope, id)` для складеного FK (§4.5) | спека прав §4.2 (Задача 0) |

## Відомі обмеження

- Джерела §4.7 припускають С8 (id користувача = `sub`), бо поки є лише провайдер
  Supabase; другий провайдер вводить факт пресету провайдера й перевірку.
- Заборонене для функції виміру в 1a — лише `simetra.*`, крім
  `current_user_id()`: системних об'єктів прав ще немає. Їхні таблиці додає до
  тієї самої перевірки Права-2.
- Денормалізовані носії ТЧ і шляху (§5.2, Рх21) — SQL Прав-2; контракт 1a
  називає носій (колонку й крок шляху), але колонок ТЧ не додає.

## Review Focus

1. **Перейменування реквізиту-носія** (власність, прив'язка, `access`, обидва кроки шляху, `header` кастомної дії, колонки джерела) переписує всі місця, а видалення блокується — тест каскаду в Задачі 10.
2. **Прихований міжтенантний носій:** `crossScope`-реквізит чи посилання на `CustomTable` без `UNIQUE (scope, id)` як носій — помилка, а не тихий простий FK (Задачі 4–7).
3. **Функція виміру, що читає права опосередковано**, через ланцюжок дослівних функцій — помилка на першій забороненій ланці (Задача 8).
4. **Промоція прийнятої таблиці в регістр** зберігає мітку (і призначає її, якщо мітки не було), а результат компілюється без `identity.kind-label-missing` (Задача 2).
5. **Однакове ім'я в різних колекціях проєкту** (вид скоупу й вимір) — `identity.name-duplicate`, а не тихий вибір першого збігу в `rename` (Задача 7).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/kinds/actions.ts` (новий) | типи `KindAction`, `ActionEffects`, `RightsExtentForm`, будівники стандартних дій, `actionRequires`, `closeRequires` |
| `packages/simetra/src/model/kinds/standard.ts` | нові поля `KindDefinition`, нові `ReferenceRole`, `FoundProjectReference` |
| `packages/simetra/src/model/kinds/{catalog,document,information-register,accumulation-register,constant,custom-table,enumeration,pg-enum,event-subscription}.ts` | `actions(obj)`, `rightsExtents`, факти контейнера, `kindLabel`, посилання нових полів |
| `packages/simetra/src/model/kinds/registry.ts` | `postsMovements` над `actions(obj)` |
| `packages/simetra/src/model/schemas/rights.ts` (новий) | `rightsCarrierSchema`, `customActionSchema`, `accessMappingSchema`, `assignedOnSchema`, `accessDimensionSchema`, `membershipSourceSchema`, `assignmentSourceSchema` |
| `packages/simetra/src/model/schemas/{catalog,document,information-register,accumulation-register,constant,project}.ts` | нові поля |
| `packages/simetra/src/compiler/rights/carriers.ts` (новий) | резолв носія в колонку й ціль |
| `packages/simetra/src/compiler/rights/checks.ts` (новий) | перевірки `rights.*` стадії 4 |
| `packages/simetra/src/compiler/rights/dimension-functions.ts` (новий) | перевірка функцій виміру стадії 5 |
| `packages/simetra/src/compiler/rights/contracts.ts` (новий) | `rightsContracts`, `accessDimensionContracts`, `sourceContracts` |
| `packages/simetra/src/compiler/contracts.ts` | типи контрактів і поля `Contracts` |
| `packages/simetra/src/compiler/stages/identity.ts` | id і імена нових елементів, `projectReferences`, `elementReferences` для всіх видів |
| `packages/simetra/src/compiler/stages/model.ts` | складений FK на `CustomTable` з `UNIQUE (scope, id)` (§4.5) |
| `packages/simetra/src/compiler/{pipeline,explain,diagnostics,messages}.ts` | підключення, `explain`, коди й тексти |
| `packages/simetra/src/compiler/object-files.ts`, `operations/fix.ts` | id для `idElementFields` і нових колекцій проєкту |
| `packages/simetra/src/compiler/operations/promote/{index,kind-file,record}.ts`, `assigned-once.ts` | мітка при промоції |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` (новий) | синтетичний проєкт прав для тестів |
| `packages/designer/skills/simetra-metadata/SKILL.md` | опис нових полів для споживача |

Синтетичний домен фікстури `fixtures/rights.ts` (усі тести плану) —
**мінімальні стабільні типові значення без жодного поля прав**: вид скоупу
`org` (корінь `Organization`), «Користувачі» `Users` (`role: "users"`), членство
`OrgMember` (`membership: { user: "user" }`), довідник `Project`, документ
`Task` (реквізити `assignee` → `OrgMember`, `project` → `Project`, `region` →
`Region`; `trackAuthor: true`), довідник `Region`, зв'язок `MemberRegion`
(`member` → `OrgMember`, `region` → `Region`), довідник `TaskComment` з
реквізитом `task` → `Task`. Поля прав (`rightsContainer`, `containerBinding`,
`ownership`, `access`, `customActions`, виміри, джерела) кожен тест задає
**явним перевизначенням**: `rightsFiles(overrides?: Record<string, Record<string, unknown>>)`
зливає перевизначення з типовим файлом за шляхом на верхньому рівні ключів
(`{ [TASK_FILE]: { ownership: ["assignee"] } }`), тож точні перевірки ранніх
задач (`extents: [{ form: "any" }]`) не ламаються, коли пізніші задачі додають
поля. Експорти: `rightsFiles`, шляхи `TASK_FILE`, `PROJECT_CATALOG_FILE`,
`COMMENT_FILE`, `MEMBER_FILE`, id `TASK_ID`, `PROJECT_ID`, `MEMBER_REGION_ID`,
`ORG_KIND_ID`, а також `compileRights(files): Promise<CompileResult>`. Задача,
що додає поле, доповнює типові значення лише тим, без чого домен не
компілюється, а поле прав — у `fixtures/kitchen-sink.ts` (ратчет).

---

### Задача 0: правки спек (Додаток А спеки прав і вердикт розвилок)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§4 «Поліморфні посилання», §6.7, §6.8, §8.4, §9, Р21, Р24, §13)
- Modify: `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` (§3, С6/§8, §12)
- Modify: `docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` (§3, §6)
- Modify: `docs/superpowers/specs/2026-10-06-promotion-design.md` (Пр11, Пр18, Пр25, §9.2 рядок «Доступ за значеннями полів», §9.3 рядок `access` і речення після таблиці, §9.4, §9.11)
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§3, §4.1, §4.4, §4.7, §5.3, вступ Додатка А)

Кожна правка точкова: одне-два речення в наявному абзаці, з посиланням на
розділ спеки прав, без переказу її змісту (правило «один факт — один документ»).

- [X] **Step 1: Платформна спека.**
  - §6.8, абзац «Права — контракт платформи»: стандартна реалізація — платформи, застосунок може замінити; функції множини — за (дія, об'єкт) у формі обсягу, повертають скоупи, id чи значення носія; «окремо від скоуп-предиката» означає скоуп `RESTRICTIVE` і права `PERMISSIVE`; булева форма для нескоуплених; виняток ТЧ — спека прав §5.2; речення про опцію JWT-claims видалити; «скалярна перевірка … один раз на команду» → «на кожен кореневий рядок команди».
  - §6.7: `EXECUTE` функцій прав, скоупу, членства й `current_user_id` та `USAGE` на `simetra` — також `simetra_command`; сервісна роль отримує порожню множину; `simetra_command` не член `authenticated` і має `SELECT` таблиць виду (для `UPDATE … WHERE` і `RETURNING`).
  - §9, «Згенеровані команди»: перевірка права — на кожен кореневий рядок команди.
  - Р24: нуль змінених рядків — конфлікт версії **або** відмова в праві; ядро розрізняє (спека прав §6.2).
  - §8.4 і Р21: `runCommand` ставить `simetra.command` поруч із claims.
  - §4, «Поліморфні посилання»: виняток «мітка зникає…» видалити — мітку мають усі види з RLS (спека промоції §9.11).
  - §13, рядок прав: перевірити, що вже позначено закритим спекою прав; якщо ні — позначити.
- [X] **Step 2: Спека системної схеми.** С6/§8: ролі — платформна модель спеки прав (профіль і запрошення — застосунку); членство може бути прийнятою таблицею з мапінгом (спека прав §4.7); `EXECUTE` функцій членства — також `simetra_command`. §3: `USAGE` на `simetra` для `simetra_command`. §12 «Видимість Користувачів»: своя функція множини довідника лишається (роль рівня скоупу дає `read` на нескоуплені, Рх7); відкрите питання «прийом з нуля бази Simetra»: системні об'єкти прав і їхні політики розпізнаються як платформні, а не `CustomTable` і борг.
- [X] **Step 3: Спека П2.**
  - §3, перелік «мітка виду об'єкта (…)»: довідник, документ, регістри, константа й `CustomTable` з одноколонковим uuid-ключем.
  - §3, абзац «Призначене раз»: прибрати «і зникнення `kindLabel`, коли вид мітки не має…».
  - §3, «Дослівний SQL»: «функції множини скоупу й прав» → «функції множини скоупу; функція значень виміру доступу — у `metadata/sql/<схема>/` (спека прав §4.4)».
  - §6, «Не в П2»: «видимість "моє"…, ролі» → посилання на спеку прав.
  - §6, «Посилання»: посилання на скоуплену `CustomTable` з `UNIQUE (scope, id)` — складений FK (спека прав §4.5).
  - §6, «Членство»: щонайбільше одне на вид скоупу — скоуплений довідник або прийнята таблиця (спека прав §4.7).
  - §6, ТЧ: стандартні колонки рядка ТЧ — і денормалізовані носії власника (спека прав §5.2).
- [X] **Step 4: Спека промоції.**
  - Пр11 і §9.4, пункт «функції множини скоупу й виду доступу»: закрита форма `(p_action, p_object) RETURNS SETOF uuid` у модулі об'єкта замінюється функцією значень виміру без аргументів, незалежною від гранту, в оголошенні проєкту (SQL — `metadata/sql/<схема>/`; спека прав §4.4).
  - Пр25: мітку мають усі види з RLS.
  - Пр18 і §9.11: промоція мітку зберігає, а якщо мітки не було — призначає за правилом `physicalName`; абзац «Ціль без мітки (регістр відомостей)…» видалити.
  - §9.2, рядок «Доступ за значеннями полів»: вид доступу = вимір доступу (спека прав §4.4); форми `attribute \| ref` зберігаються; гейт еквівалентності «роль × дія × рядок» для прийнятих політик лишається.
  - §9.3: рядок `access` → «доступ за виміром (спека прав §4.4)»; речення «Форму `access` … фіксує план генерації політик» → «форма — спека прав §4.4».
- [X] **Step 5: Спека прав (вердикт розвилок Права-1).**
  - §3: дія в даних — слово словника або UUID кастомної дії (Рх18); кожна дія з DML вимагає `read`; ефекти — `effects(obj)` у формі Р1a-3; вимоги — лише передумова права, ефекти — власні ефекти дії (дія, що вимагає `update`, його ефектів не успадковує); дія запису незалежного регістра — `write`; імена в `header` кастомної дії — посилання на реквізити.
  - §5.3: форма ефектів — посилання на §3; одне речення: вимоги не переносять ефектів.
  - §4.2: ціль власності — й прийнята таблиця-джерело членства виду скоупу об'єкта, якщо вона дає `UNIQUE (scope, id)` для складеного FK (§4.5).
  - §4.1: модуль-власник — за П2 §8.6.
  - §4.4: закрита форма функції значень = форма функції множини скоупу; перевірка транзитивна за дослівними sql-функціями проєкту, plpgsql чи невідома функція — помилка; з `simetra.*` дозволено лише `current_user_id()`; вимір над нескоупленим довідником — помилка лише в проєкті з видами скоупу.
  - §4.7: рівень джерела призначень — стала форми `assignedOn`, одне джерело — один рівень; джерела — іменовані елементи з UUID; ключ ролі — `sourceKeys: [{ source, key }]`.
  - Вступ Додатка А: «решту правок … вносить перший крок плану» → «правки внесено в названі документи; перелік — покажчик місць».
- [X] **Step 6: Перевірка.**

Run: `python3 scripts/check-doc-anchors.py && pnpm format:check`
Expected: обидві команди завершуються з кодом 0.

- [X] **Step 7: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs(spec): правки Додатка А спеки прав і рішень плану Права-1"
```

---

### Задача 1: дії виду як функція налаштувань

**Files:**
- Create: `packages/simetra/src/model/kinds/actions.ts`
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`KindDefinition`), усі `packages/simetra/src/model/kinds/*.ts`, `registry.ts`, `packages/simetra/src/model/index.ts` (експорт)
- Modify: `packages/simetra/src/compiler/pipeline.ts` (`model.actions`)
- Test: `packages/simetra/src/model/__tests__/kind-actions.test.ts` (новий), `packages/simetra/src/model/__tests__/kind-registry.test.ts`

**Interfaces:**
- Produces (T0, `simetra/model`):
  - `type StandardAction = "read" | "create" | "update" | "markDeletion" | "delete" | "post" | "unpost" | "write"`
  - `type Dml = "insert" | "update" | "delete"`
  - `interface ActionEffects { dml: readonly Dml[]; header: "all" | readonly string[]; tabularSections: boolean }`
  - `interface KindAction { name: StandardAction; requires: readonly StandardAction[]; effects: ActionEffects }` — `requires` лише прямі ребра виду (без загального ребра `read`)
  - `type RightsExtentForm = "any" | "own" | "dimension"`
  - `KindDefinition.actions(obj: unknown): readonly KindAction[]`
  - `KindDefinition.rightsExtents: readonly RightsExtentForm[]`
  - `KindDefinition.rightsContainer?: true`, `KindDefinition.rightsBinding?: true`
  - `function actionRequires(action: { requires: readonly string[]; effects: ActionEffects }): string[]` — прямі ребра плюс `read`, коли `dml` непорожній і дія не `read`
  - `function closeRequires(actions: readonly { name: string; requires: readonly string[] }[]): ReadonlyMap<string, readonly string[]>` — транзитивне замикання (без самої дії, відсортоване); на циклі кидає `Error` — перевірку циклу робить компілятор раніше
- Produces (T1): `CompiledModel.actions` — `{ objectId, actions: string[] }`, тепер з `actions(obj)` (імена стандартних дій; кастомні додає Задача 3)

- [X] **Step 1: Write the failing test** `kind-actions.test.ts`

```ts
describe("actions(obj)", () => {
  it("gives a catalog the reference vocabulary with read-only edges", () => {
    const actions = KIND_REGISTRY.Catalog.actions(catalogSchema.parse(minimalCatalog))
    expect(actions.map((a) => [a.name, actionRequires(a)])).toEqual([
      ["read", []],
      ["create", ["read"]],
      ["update", ["read"]],
      ["markDeletion", ["read"]],
      ["delete", ["read"]],
    ])
    expect(actions.find((a) => a.name === "markDeletion")!.effects).toEqual({
      dml: ["update"], header: ["deletionMark"], tabularSections: false,
    })
  })
  it("chains document posting: post requires update, unpost requires post", () => {
    const close = closeRequires(KIND_REGISTRY.Document.actions(minimalDocument).map(
      (a) => ({ name: a.name, requires: actionRequires(a) })))
    expect(close.get("unpost")).toEqual(["post", "read", "update"])
    // Вимога не переносить ефектів: post пише лише свою ознаку, не шапку й ТЧ.
    expect(KIND_REGISTRY.Document.actions(minimalDocument)
      .find((a) => a.name === "post")!.effects)
      .toEqual({ dml: ["update"], header: ["posted"], tabularSections: false })
  })
  it("gives an independent information register a write action and a subordinate one none", () => {
    expect(names(InformationRegister, { writeMode: "Independent" })).toEqual(["read", "write"])
    expect(names(InformationRegister, { writeMode: "RecorderSubordinate" })).toEqual(["read"])
  })
  it("lets a constant insert or update its value", () => {
    expect(KIND_REGISTRY.Constant.actions(minimalConstant)
      .find((a) => a.name === "update")!.effects.dml).toEqual(["insert", "update"])
  })
  it("declares extents and container facts in the registry", () => {
    expect(KIND_REGISTRY.Catalog.rightsExtents).toEqual(["any", "own", "dimension"])
    expect(KIND_REGISTRY.AccumulationRegister.rightsExtents).toEqual(["any", "dimension"])
    expect(KIND_REGISTRY.Constant.rightsExtents).toEqual(["any"])
    expect(KIND_REGISTRY.CustomTable.rightsExtents).toEqual([])
    expect(KIND_REGISTRY.Catalog.rightsContainer).toBe(true)
    expect(KIND_REGISTRY.Document.rightsBinding).toBe(true)
    expect(KIND_REGISTRY.Document.rightsContainer).toBeUndefined()
  })
})
```

`minimalCatalog`, `minimalDocument`, `minimalConstant` — мінімальні розібрані
файли, як у `kind-schemas.test.ts`; `names(kind, overrides)` — локальний
помічник над `actions(...)`.

- [X] **Step 2: Run test to verify it fails**

Run: `pnpm --filter simetra test kind-actions`
Expected: FAIL — `actionRequires` не експортовано, `actions` — масив, а не функція.

- [X] **Step 3: Implement**
  - `actions.ts`: кожна стандартна дія має власні ефекти; вимоги їх не переносять (Р1a-3). `update`: `{ dml: ["update"], header: "all", tabularSections: <має ТЧ> }`, де `tabularSections` — `def.tabularSectionColumns !== undefined`; `post` і `unpost`: `{ dml: ["update"], header: ["posted"], tabularSections: false }` (рухи пише оболонка проведення привілейованим шляхом, не дія).
  - Вид: Catalog — `read, create, update, markDeletion, delete`; Document — ще `post` (`requires: ["update"]`) і `unpost` (`requires: ["post"]`); InformationRegister — `read`, плюс `write` лише за `writeMode === "Independent"`; AccumulationRegister — `read`; Constant — `read`, `update` з `dml: ["insert","update"]`; CustomTable — `read, create, update, delete`; Enumeration, PgEnum, EventSubscription — `[]`.
  - `create`: `{ dml: ["insert"], header: "all", tabularSections }`; `delete`: `{ dml: ["delete"], header: [], tabularSections: false }`; `markDeletion`: `{ dml: ["update"], header: ["deletionMark"], tabularSections: false }`; `read`: `{ dml: [], header: [], tabularSections: false }`.
  - `postsMovements(kind)` → `postsMovements(kind, obj)`: читає `actions(obj)`; оновити всіх викликачів (знайти `grep -rn postsMovements packages/simetra/src`). Якщо викликач має лише вид без розібраного об'єкта — зупинитися й повідомити архітектора, а не повертати статичний перелік.
  - `pipeline.ts`: `actions: KIND_REGISTRY[o.kind].actions(o.data).map((a) => a.name)`.

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test kind-actions kind-registry`
Expected: PASS.

- [X] **Step 5: Повний прогін пакета** (зміна факту зачіпає знімки хешів)

Run: `pnpm --filter simetra test && pnpm --filter simetra typecheck && pnpm --filter simetra lint`
Expected: PASS. Якщо змінився лише хеш моделі в тестах, які його закріплюють, оновити очікування й у звіті назвати файли.

- [X] **Step 6: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(model): дії виду — функція налаштувань з вимогами й ефектами"
```

---

### Задача 2: мітки виду регістрів і констант; промоція зберігає мітку

**Files:**
- Modify: `packages/simetra/src/model/kinds/{information-register,accumulation-register,constant}.ts` (`kindLabel: true`)
- Modify: `packages/simetra/src/model/schemas/{information-register,accumulation-register,constant}.ts` (поле `kindLabel`, як у `catalog.ts`)
- Modify: `packages/simetra/src/compiler/operations/promote/{index,kind-file,record}.ts`, `packages/simetra/src/compiler/assigned-once.ts`, `diagnostics.ts`, `messages.ts`
- Modify: `packages/designer/src/cli/render.ts` (рядок `kind label dropped`) і **кожен** споживач `PromotionRecord` у репо — продакшн (`packages/simetra/src/schema/apply/**`, `packages/designer/src/tools/*`, `packages/designer/src/mcp/tools.ts`) і тести обох пакетів, зокрема DB-тести designer (`packages/designer/src/**/__tests__/*.db.test.ts`); перелік — `grep -rln 'labelDropped\|PromotionRecord\|promotionRecordSchema' packages --include=*.ts`
- Modify: **усі** сирі фікстури регістрів і констант у тестах обох пакетів (файли без мітки дадуть `identity.kind-label-missing`); перелік — `grep -rlE '"?kind"?: "(InformationRegister|AccumulationRegister|Constant)"' packages --include=*.ts` (на момент плану — 32 файли)
- Modify: `examples/reference/metadata/{information-registers,accumulation-registers,constants}/**` (мітки через `simetra fix`)
- Modify: `packages/simetra/schemas/*.schema.json` (регенерація)
- Test: `packages/simetra/src/model/__tests__/kind-registry.test.ts` (`expectsKindLabel`), `packages/simetra/src/compiler/__tests__/kind-label.test.ts`, `operations-promote.test.ts`, `assigned-once.test.ts`

**Interfaces:**
- Consumes: `expectsKindLabel(kind, data)`, `kindLabelOf(object)`, `NameAssigner.assignKindLabels` — без змін, вони вже читають реєстр.
- Produces: `PromotionRecord` без поля `labelDropped`; коду `promote.label-target` немає.

- [X] **Step 1: Write the failing tests**
  - `kind-registry.test.ts`, `describe("expectsKindLabel")`: `it("expects a label on every kind with row-level security")` — для кожного виду з `rowLevelSecurity === "enabled"` і не `declared` `expectsKindLabel(kind, data) === true` (цикл за `METADATA_KINDS`, без переліку назв).
  - `kind-label.test.ts`: `it("reports a missing label on a register and a constant")` — коди `identity.kind-label-missing` з pointer `/kindLabel` для файлів регістра й константи без мітки; `it("fix assigns register labels by the physicalName rule")` — після `completeFiles` у регістра `kindLabel === physicalName`.
  - `operations-promote.test.ts`: тест «promotes an independent information register and drops the label» перейменувати на `"promotes an independent information register and keeps the label"` з `expect(register.kindLabel).toBe("price")` (мітка прийнятої таблиці фікстури); новий `"assigns a label when the adopted table had none"` — `CustomTable` без uuid-ключа промотовано в регістр, `kindLabel` дорівнює `physicalName`, `compile(after, { baseline: files })` без діагностик; тести `promote.label-target` видалити (ціль без мітки серед видів з RLS більше не існує).
  - `assigned-once.test.ts`: тест, де промоція звільняє `kindLabel`, перетворити на `"keeps reporting a removed label after promotion"` — зникнення мітки промотованого об'єкта тепер `identity.assigned-once-changed` (`before: "counterparty", after: "(removed)"`).

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test kind-label kind-registry operations-promote assigned-once`
Expected: FAIL — регістри й константа мітки не очікують, промоція її губить.

- [X] **Step 3: Implement**
  - Факт `kindLabel: true` і поле `kindLabel: physicalNameSchema.optional()` (той самий `.meta`, що в `catalog.ts`) у трьох видах.
  - Промоція: `kind-file.ts` переносить мітку прийнятої таблиці, а відсутню призначає те саме доповнення, що й `fix` (`completeAndCompile`); у `index.ts` прибрати гейт `promote.label-target`; у `record.ts` — поле `labelDropped` з інтерфейсу, схеми й побудови; в `assigned-once.ts` у `releasedByPromotion` прибрати гілку `kindLabel` (лишається лише `physicalName`) разом з `polymorphicTargets`, якщо вона більше ніде не читається (`grep`); коментар до функції оновити.
  - `diagnostics.ts`/`messages.ts`: видалити `promote.label-target`.
  - `designer/src/cli/render.ts`: видалити рядок `kind label dropped`.
  - Регенерувати JSON Schema: `UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`.
  - Мітки прикладів: `node packages/designer/bin/simetra.mjs fix examples/reference/metadata` (перевірити синтаксис командою `node packages/designer/bin/simetra.mjs fix --help`); диф — лише нові `kindLabel` у файлах регістрів і константи.

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test && pnpm --filter simetra typecheck && pnpm --filter @simetra/designer test && pnpm --filter @simetra/designer typecheck && pnpm metadata:check`
Expected: PASS. Typecheck designer обов'язковий: DB-тести designer не входять у `test`, а поле `labelDropped` у їхніх фікстурах ловить лише він. Тести, що закріплюють рендер в'юхи `simetra.kind_labels` чи хеш, отримують рядки регістрів і константи — оновити очікування й назвати файли у звіті.

- [X] **Step 5: Commit**

```bash
git add packages examples
git commit -m "feat(model): мітка виду для регістрів і констант, промоція її зберігає"
```

---

### Задача 3: кастомні дії і контракт прав об'єкта

**Files:**
- Create: `packages/simetra/src/model/schemas/rights.ts` (`customActionSchema`)
- Modify: схеми видів з непорожнім `rightsExtents` (`catalog`, `document`, `information-register`, `accumulation-register`, `constant`) — поле `customActions`
- Modify: `packages/simetra/src/model/kinds/standard.ts` (`idElementFields?: readonly string[]`, ролі `customAction.requires`, `customAction.header`), кінди з `customActions` (`idElementFields: ["customActions"]`, `elementReferences` для `header`)
- Modify: `packages/simetra/src/compiler/object-files.ts` (`namedElementsOf` включає `idElementFields`), `stages/identity.ts` (id, унікальність імені дії в об'єкті, camelCase, посилання `requires` на кастомні дії того самого об'єкта)
- Create: `packages/simetra/src/compiler/rights/contracts.ts`, `packages/simetra/src/compiler/rights/checks.ts`
- Modify: `compiler/contracts.ts` (`RightsContract`, `RightsAction`, `RightsExtent`, `Contracts.rights`), `pipeline.ts`, `stages/integrity.ts` (виклик `checkRights`), `explain.ts`, `diagnostics.ts`, `messages.ts`
- Create: `packages/simetra/src/compiler/__tests__/fixtures/rights.ts`
- Test: `packages/simetra/src/model/__tests__/rights-schemas.test.ts` (новий), `packages/simetra/src/compiler/__tests__/rights-contract.test.ts` (новий), `explain.test.ts`

**Interfaces:**
- Produces (T0):
  - `customActionSchema = z.strictObject({ id: metadataIdSchema.optional(), name: elementNameSchema, requires: z.array(elementNameSchema).default([]), effects: z.strictObject({ header: z.union([z.literal("all"), z.array(elementNameSchema)]).optional(), tabularSections: z.boolean().optional() }).default({}) })` — без `title`/`description` (Р1a-23)
  - `type CustomAction = z.infer<typeof customActionSchema>`
- Produces (T1, `compiler/contracts.ts`):

```ts
export type RightsExtent =
  | { form: "any" }
  | { form: "own" }
  | { form: "dimension"; dimensionId: string }
export interface RightsAction {
  /** Слово словника або UUID кастомної дії (Рх18). */
  action: string
  name: string
  /** Замикання вимог без самої дії, відсортоване. */
  requires: string[]
  /** `header` — фізичні колонки основної таблиці або "all". */
  effects: { dml: Dml[]; header: "all" | string[]; tabularSections: boolean }
  extents: RightsExtent[]
}
export interface RightsContract {
  objectId: string
  kindLabel: string
  table: QualifiedName
  scopeKindId?: string
  actions: RightsAction[]
}
```

  `Contracts.rights: RightsContract[]` — за `objectId`; запис має кожен об'єкт,
  вид якого має непорожній `rightsExtents`. Задачі 5–8 додають поля носіїв і
  обсяги `own`/`dimension`; тут `extents` — `[{ form: "any" }]`.
- Produces: `checkRights(ctx: RightsCheckContext): Diagnostic[]` у `rights/checks.ts`, де `RightsCheckContext = { objects; references; model: ModelStageResult; scopeKinds; project; byId }`; Задачі 4–9 додають у нього правила.
- Коди: `rights.action-unknown` (`{ action, object }`), `rights.custom-action-reserved` (`{ action, kind }`), `rights.requires-cycle` (`{ actions }` — ланцюжок через ` → `), `rights.attribute-unknown` (`{ attribute, field }` — спільний для всіх полів прав).

- [X] **Step 1: Write the failing tests**
  - `rights-schemas.test.ts`: `customActionSchema` приймає `{ name: "invite", requires: ["read"] }` з дефолтами `effects: {}`; відмовляє на невідомому ключі; `catalogSchema` приймає `customActions`, а `customTableSchema` — ні (поле лише там, де `rightsExtents` непорожній).
  - `rights-contract.test.ts`:

```ts
it("builds a rights contract with the kind actions and any extent", async () => {
  const result = await compileRights(rightsFiles())
  const task = result.model!.contracts.rights.find((c) => c.objectId === TASK_ID)!
  expect(task.kindLabel).toBe("task")
  expect(task.actions.map((a) => [a.action, a.requires])).toEqual([
    ["read", []], ["create", ["read"]], ["update", ["read"]],
    ["markDeletion", ["read"]], ["delete", ["read"]],
    ["post", ["read", "update"]], ["unpost", ["post", "read", "update"]],
  ])
  expect(task.actions[0]!.extents).toEqual([{ form: "any" }])
})
it("adds a custom action by its UUID with derived update effects", async () => {
  const files = rightsFiles({ [TASK_FILE]: { customActions: [
    { id: uuid(7701), name: "reassign", requires: ["update"], effects: { header: ["assignee"] } } ] } })
  const action = (await compileRights(files)).model!.contracts.rights
    .find((c) => c.objectId === TASK_ID)!.actions.find((a) => a.name === "reassign")!
  expect(action).toMatchObject({ action: uuid(7701), requires: ["read", "update"],
    effects: { dml: ["update"], header: ["assignee_id"], tabularSections: false } })
})
it("rejects an unknown action, a reserved name and a requires cycle", async () => {
  // три окремі файли; очікування — [code, pointer]
  expect(codes(...)).toEqual([
    ["rights.action-unknown", "/customActions/0/requires/0"],
    ["rights.custom-action-reserved", "/customActions/0/name"],
    ["rights.requires-cycle", "/customActions/0/requires/0"],
  ])
})
it("reports an unknown header attribute", ...) // rights.attribute-unknown, "/customActions/0/effects/header/0"
```

  - `explain.test.ts`: `it("shows the rights contract of an object")` — `explainObject(model, { kind: "Document", name: "Task" }).contracts` містить запис з `kindLabel: "task"`.
  - `it("refuses a custom action named like a sibling attribute")` — кастомна дія `assignee` поруч із реквізитом `assignee` → `identity.name-duplicate` на `/customActions/0/name` (Р1a-22).
  - Фікстура: `fixtures/rights.ts` (домен — у «Структурі файлів»), `fixtures/kitchen-sink.ts` — кастомна дія з `requires`, `effects.header` (обидві гілки: `"all"` в одному об'єкті й список в іншому) і `tabularSections`.

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rights-schemas rights-contract explain`
Expected: FAIL — поля й контракту немає.

- [X] **Step 3: Implement**
  - Ідентичність: кастомна дія отримує id тим самим шляхом, що й реквізит (`namedElementsOf` → `idElementFields`); id перевіряється глобально; ім'я — унікальне серед **усіх сусідніх іменованих колекцій об'єкта** — реквізитів (зокрема вимірів і ресурсів), ТЧ і кастомних дій (`identity.name-duplicate`, Р1a-22) — і в camelCase (`identity.name-case` зі стилем `camelCase`, Р1a-7).
  - Посилання: ім'я кастомної дії в `requires` — `{ to: { kind: "Element", id }, role: "customAction.requires" }` (резолв у `identity.ts` поруч із `resolveMembershipUser`); слова словника посиланнями не є: у `reference-index-completeness.test.ts` — запис `NOT_REFERENCES` для рядків під `requires` (і під `grant.actions`, `deny.actions` Прав-1b), що є словами `StandardAction`, з причиною «стандартна дія — слово платформи, а не посилання на елемент метаданих; кастомні дії — посилання й винятку не мають» (Р1a-21). Предикат винятку перевіряє і місце, і те, що рядок — слово словника: ім'я кастомної дії в тому самому масиві лишається кандидатом. `effects.header` — `elementReferences` з роллю `customAction.header` (власна колонка). `resolveElementReferences` видає `customTable.column-unknown` лише для `declared`-видів; для решти мовчить, а невідоме ім'я звітує `checkRights` кодом `rights.attribute-unknown`.
  - Контракт: стандартні дії з `actions(obj)` у порядку реєстру, далі кастомні за `id`; `requires` — `closeRequires` над прямими ребрами (`actionRequires`), кастомна дія — `requires` з файлу плюс загальне ребро `read`, якщо `dml` непорожній; `header` — фізичні колонки з фізичного знімка (стандартні — за `logicalName`). Цикл перевіряє `checkRights` до побудови контракту.
  - `explain.ts`: додати `...contracts.rights.filter((c) => c.objectId === object.id)` у `blocks`.
  - Діагностики й тексти en/uk (сенс повідомлень: en — `Action "<action>" is not an action of <object>`; uk — `Дія "<action>" не є дією <object>`; решта — так само коротко й з підказкою).

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rights messages field-ratchet reference-index-completeness explain json-schema`
Expected: PASS (JSON Schema регенеровано).

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): контракт прав об'єкта й кастомні дії"
```

---

### Задача 4: складений FK на скоуплену `CustomTable` (§4.5)

**Files:**
- Modify: `packages/simetra/src/compiler/stages/model.ts` (`SnapshotBuilder.scopedKey`)
- Modify: `packages/simetra/src/compiler/stages/integrity.ts` (попередження), `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/stage-scope-model.test.ts`, `stage-scope-integrity.test.ts`

**Interfaces:**
- Produces: фізичний FK посилання скоупленого об'єкта виду на скоуплену `CustomTable` має `scope: { from: <носій джерела>, to: <фізична колонка scopeColumn цілі> }`, коли ціль оголошує `uniques` рівно над `[scopeColumn, <ключ>]` (у будь-якому порядку); інакше FK простий, а стадія 4 дає попередження `scope.custom-table-cross-tenant` (`{ table }`, у `WARNING_RULES`) з підказкою додати обмеження в метадані прийнятої таблиці.
- Produces: функція `inScopeTarget(field): boolean` у `compiler/rights/carriers.ts` — FK поля має складену частину або проєкт не має видів скоупу; її споживають Задачі 5–8.

- [X] **Step 1: Write the failing tests**
  - `stage-scope-model.test.ts`: `it("composes a key to a scoped custom table with UNIQUE (scope, id)")` — у колонки `ledger_id` документа FK `{ table: "ledgers", column: "id", scope: { from: "org_id", to: "org_id" } }`; `it("keeps a plain key to a scoped custom table without UNIQUE (scope, id)")`.
  - `stage-scope-integrity.test.ts`: `it("warns about a reference to a scoped custom table without UNIQUE (scope, id)")` — `[["scope.custom-table-cross-tenant", "warning", "/attributes/0"]]`.

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test stage-scope`
Expected: FAIL.

- [X] **Step 3: Implement** — у `scopedKey` гілка `declared`: замість `return undefined` повертати складену частину, коли ціль має `scopeColumn` того самого виду скоупу й `UNIQUE` над `(scopeColumn, ключ)`; `to` — фізичне ім'я `scopeColumn` цілі. Попередження — у `checkScope` поруч із правилами посилань (`SCOPED_REFERENCE_ROLES`).

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test stage-scope stage-model creation-order`
Expected: PASS.

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): складений FK на скоуплену прийняту таблицю з UNIQUE (scope, id)"
```

---

### Задача 5: власність (§4.2) і носій

**Files:**
- Modify: `model/schemas/rights.ts` (`rightsCarrierSchema`, `ownershipSchema`), схеми видів з `"own"` у `rightsExtents` (`catalog`, `document`) — поле `ownership`
- Modify: `model/kinds/standard.ts` (ролі `rights.carrier`, `rights.carrierPath`), `model/kinds/{catalog,document}.ts` (`elementReferences` носіїв)
- Create: `packages/simetra/src/compiler/rights/carriers.ts`
- Modify: `rights/checks.ts`, `rights/contracts.ts`, `compiler/contracts.ts`, `diagnostics.ts`, `messages.ts`, `stages/identity.ts`
- Test: `rights-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/rights-ownership.test.ts` (новий)

**Interfaces:**
- Produces (T0): `rightsCarrierSchema = z.union([elementNameSchema, z.tuple([elementNameSchema, elementNameSchema])])` (`.meta`: «An attribute of this object, or a path [attribute, attribute of its target]»); `type RightsCarrier = z.infer<…>`; `ownershipSchema = z.array(rightsCarrierSchema).min(1)`.
- Produces (T1):

```ts
/** Носій прав у таблиці: власна колонка або крок шляху (Рх21). */
export interface CarrierContract {
  column: string
  via?: { objectId: string; table: QualifiedName; column: string }
}
```

  `RightsContract.ownership: CarrierContract[]`; обсяг `{ form: "own" }` додається до `extents` кожної дії, коли `ownership` непорожній.
- Produces: `resolveCarrier(object, carrier, ctx): { ok: true; terminal: { object: ParsedObject; field: Field }; contract: CarrierContract } | { ok: false; diagnostic: Diagnostic }` у `carriers.ts` — перший крок шляху мусить бути одиночним неполіморфним `Ref` у межах скоупу (`inScopeTarget`), другий — реквізит його цілі.
- Коди: `rights.carrier-not-ref` (`{ attribute }`), `rights.carrier-cross-tenant` (`{ attribute }`), `rights.ownership-target` (`{ attribute, reason }`).

- [X] **Step 1: Write the failing tests** `rights-ownership.test.ts`
  - `it("accepts a member reference and a users reference as owners")` — `ownership: ["assignee", "createdBy"]` (`assignee` → `OrgMember` в межах скоупу; `trackAuthor: true`): `contracts.rights[Task].ownership` дорівнює `[{ column: "assignee_id" }, { column: "created_by" }]`, а `extents` кожної дії — `[{ form: "any" }, { form: "own" }]`.
  - `it("accepts the key of the users catalog")` — `Users.ownership: ["ref"]` → `[{ column: "id" }]`; на іншому довіднику `["ref"]` → `rights.ownership-target` (`reason: "key"`).
  - `it("accepts a path through an in-scope reference")` — `TaskComment.ownership: [["task", "assignee"]]` → `{ column: "task_id", via: { objectId: TASK_ID, table: { schema: "public", name: "task" }, column: "assignee_id" } }`.
  - `it("rejects carriers that leave the tenant or are not references")` — очікування `[code, pointer]`: `crossScope`-реквізит → `rights.carrier-cross-tenant` `/ownership/0`; рядковий реквізит → `rights.carrier-not-ref`; `Ref` на `Region` (не членство й не «Користувачі») → `rights.ownership-target` (`reason: "target"`); невідомий реквізит → `rights.attribute-unknown` `/ownership/0`; поліморфний перший крок шляху → `rights.carrier-not-ref` `/ownership/0/0`.
  - `rights-schemas.test.ts`: `informationRegisterSchema` не приймає `ownership` (регістр не має обсягу `own`).

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rights-ownership rights-schemas`
Expected: FAIL.

- [X] **Step 3: Implement**
  - Посилання носія: `elementReferences` виду — рядок або перший крок → власна колонка (роль `rights.carrier`); другий крок → колонка цілі першого (`owner` = `ref` першого реквізиту, роль `rights.carrierPath`). Стандартні реквізити (`createdBy`, `ref`) id не мають і в індекс не йдуть — їх не перейменовують.
  - Правило цілі власності: кінцевий `Ref` — на довідник з `membership` того самого виду скоупу, що й об'єкт (складений FK обов'язковий), або на довідник з `role: "users"` (простий FK; §4.2 — предикат AND зі скоупами), або `ref` довідника `users`.
  - `kitchen-sink.ts`: `ownership` з рядком і шляхом.

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rights field-ratchet reference-index-completeness json-schema`
Expected: PASS.

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): власність і носії прав зі шляхом посилань"
```

---

### Задача 6: контейнер і прив'язка (§4.3)

**Files:**
- Modify: `model/schemas/catalog.ts` (`rightsContainer`), `catalog.ts`/`document.ts` (`containerBinding: rightsCarrierSchema.optional()`); `model/kinds/{catalog,document}.ts` (`elementReferences` прив'язки)
- Modify: `rights/checks.ts`, `rights/contracts.ts`, `compiler/contracts.ts`, `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-container.test.ts` (новий), `rights-schemas.test.ts`

**Interfaces:**
- Produces: `RightsContract.container?: true` (об'єкт — контейнер); `RightsContract.binding?: { containerId: string; carrier: CarrierContract }`.
- Коди: `rights.container-target` (`{ attribute, name }` — кінцева ціль не має `rightsContainer`), `rights.container-self` (контейнер прив'язаний до себе), а також `rights.carrier-*` із Задачі 5.

- [X] **Step 1: Write the failing tests** `rights-container.test.ts`
  - `it("binds a document to a container catalog")` — `Task.binding` дорівнює `{ containerId: PROJECT_ID, carrier: { column: "project_id" } }`, `Project.container === true`.
  - `it("binds through a path")` — `TaskComment.containerBinding: ["task", "project"]` → `carrier.via.column === "project_id"`.
  - `it("rejects a binding to an object that is not a container")` → `rights.container-target` `/containerBinding`; `crossScope`-прив'язка → `rights.carrier-cross-tenant`; `Project.containerBinding` на себе → `rights.container-self`.
  - `rights-schemas.test.ts`: `documentSchema` не приймає `rightsContainer`.

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rights-container rights-schemas`
Expected: FAIL.

- [X] **Step 3: Implement** — `resolveCarrier` із Задачі 5; поле в схемі — лише там, де факт реєстру (`rightsContainer` / `rightsBinding`); `kitchen-sink.ts` — обидва поля.

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rights field-ratchet reference-index-completeness json-schema`
Expected: PASS.

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): об'єкт-контейнер і прив'язка до контейнера"
```

---

### Задача 7: виміри доступу й `access` (§4.4, без функцій)

**Files:**
- Modify: `model/schemas/rights.ts` (`accessDimensionSchema`, `accessMappingSchema`), `model/schemas/project.ts` (`accessDimensions`), схеми видів з `"dimension"` у `rightsExtents` (`access`)
- Modify: `model/kinds/standard.ts` (`FoundProjectReference`, `projectReferences?`, ролі `access.dimension`, `access.attribute`, `dimension.target`, `dimension.relationObject`, `dimension.relationField`), відповідні види
- Modify: `compiler/stages/identity.ts` (id і імена `accessDimensions`; унікальність імен елементів проєкту в усіх колекціях; резолв `projectReferences`; посилання виміру на ціль і зв'язок), `compiler/operations/fix.ts` (id для `accessDimensions`)
- Modify: `rights/checks.ts`, `rights/contracts.ts`, `compiler/contracts.ts`, `pipeline.ts`, `diagnostics.ts`, `messages.ts`
- Test: `rights-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/rights-dimensions.test.ts` (новий), `stage-identity.test.ts`

**Interfaces:**
- Produces (T0):

```ts
export const accessDimensionSchema = z.strictObject({
  id: metadataIdSchema.optional(),
  name: elementNameSchema,
  // title/description — з планом, де з'явиться їхній споживач (Р1a-23).
  target: metadataRefSchema,              // скоуплений довідник значень
  values: z.union([
    z.strictObject({ relation: z.strictObject({
      object: metadataRefSchema,          // таблиця «користувач/учасник ↔ значення»
      subject: elementNameSchema,         // Ref на «Користувачі» чи довідник членства
      value: elementNameSchema,           // Ref на target
    }) }),
    z.strictObject({ function: z.strictObject({
      schema: appSchemaNameSchema.min(1).optional(), name: z.string().min(1),
    }) }),
  ]),
})
export const accessMappingSchema = z.union([
  z.strictObject({ attribute: elementNameSchema, dimension: elementNameSchema }),
  z.strictObject({ ref: z.tuple([elementNameSchema, elementNameSchema]), dimension: elementNameSchema }),
])
```

  `projectSchema.accessDimensions: z.array(accessDimensionSchema).default([])`;
  `access: z.array(accessMappingSchema).min(1).optional()` у схемах видів.
- Produces (T0): `interface FoundProjectReference { pointer: string; name: string; collection: "scopeKinds" | "accessDimensions" | "membershipSources" | "assignmentSources"; role: ReferenceRole }`; `KindDefinition.projectReferences?(obj): FoundProjectReference[]`.
- Produces (T1): `RightsContract.access: { dimensionId: string; carrier: CarrierContract }[]`; обсяг `{ form: "dimension", dimensionId }` у `extents` кожної дії; `Contracts.accessDimensions: AccessDimensionContract[]` (за `dimensionId`):

```ts
export interface AccessDimensionContract {
  dimensionId: string
  name: string
  targetId: string
  values:
    | { relation: { objectId: string; table: QualifiedName; subject: string; value: string } }
    | { function: QualifiedName }
}
```

- Коди: `rights.dimension-unknown` (`{ dimension }`), `rights.dimension-target` (`{ dimension, reason }`: `"kind"` — не довідник, `"unscoped"` — нескоуплений у проєкті з видами скоупу), `rights.dimension-relation` (`{ dimension, field, reason }`), `rights.access-target` (`{ attribute, dimension }` — кінцевий `Ref` не на `target` виміру), `rights.access-duplicate` (`{ dimension }`).

- [X] **Step 1: Write the failing tests**
  - `rights-dimensions.test.ts`:
    - `it("maps an attribute to a dimension")` — `Task.access` → `contracts.rights[Task].access` дорівнює `[{ dimensionId: REGION_DIM_ID, carrier: { column: "region_id" } }]`; `extents` — `[{ form: "any" }, { form: "own" }, { form: "dimension", dimensionId: REGION_DIM_ID }]`; `contracts.accessDimensions[0].values.relation` — `{ objectId: MEMBER_REGION_ID, table: …, subject: "member_id", value: "region_id" }`.
    - `it("maps a register dimension")` — `access` на регістрі накопичення з реквізитом-виміром `region`.
    - `it("rejects broken dimension declarations")` — `[code, file, pointer]`: невідомий вимір у `access` → `rights.dimension-unknown`; `target` на документ → `rights.dimension-target` (`kind`); на нескоуплений довідник у скоупленому проєкті → `rights.dimension-target` (`unscoped`), а в однотенантному проєкті — без діагностики; `relation.value` не на `target` → `rights.dimension-relation`; `access` реквізит на `Project` → `rights.access-target`; той самий вимір двічі → `rights.access-duplicate`.
  - `stage-identity.test.ts`: `it("refuses one name in two project collections")` — вид скоупу `org` і вимір `org` → `identity.name-duplicate` (scope `"project elements"`) на `/accessDimensions/0/name`; `it("assigns ids to access dimensions")` через `completeFiles`.
  - `rights-schemas.test.ts`: `constantSchema` не приймає `access` (константа — лише `any`).

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rights-dimensions stage-identity rights-schemas`
Expected: FAIL.

- [X] **Step 3: Implement**
  - `projectReferences` виду повертає `access[].dimension` (`collection: "accessDimensions"`, роль `access.dimension`); `identity.ts` резолвить за іменем у колекції проєкту в `{ kind: "Element", id }` з власником — об'єктом файлу (як `storage.scopeKind`, але з `objectId` об'єкта). `target` і `relation.object` виміру — `resolveObjectRef` з роллю `dimension.target` / `dimension.relationObject` (власник — вимір, `file: "project.meta.json"`); `subject`/`value` — посилання на елемент об'єкта зв'язку (роль `dimension.relationField`).
  - Атрибут `access` — `elementReferences` (роль `access.attribute`, шлях — як носій Задачі 5).
  - Правило зв'язку: `subject` — одиночний `Ref` на довідник `users` чи на довідник членства; `value` — одиночний `Ref` на `target`; об'єкт зв'язку — у межах того самого виду скоупу, що й `target`.
  - Функція значень: контракт отримує `{ function: { schema: schema ?? defaultSchema, name } }`; перевірка тіла — Задача 8.
  - `kitchen-sink.ts`: вимір з `relation` і вимір з `function` (обидві гілки), `access` з `attribute` і з `ref`.

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rights stage-identity field-ratchet reference-index-completeness json-schema`
Expected: PASS.

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): виміри доступу проєкту й мапінг access"
```

---

### Задача 8: функція значень виміру — закрита форма й заборона читати права

**Files:**
- Create: `packages/simetra/src/compiler/rights/dimension-functions.ts`
- Modify: `packages/simetra/src/compiler/stages/links.ts` (виклик; експорт `nullaryFunction`, `volatilityProblem`, `setFunctionClosedProblem` для повторного вжитку), `packages/simetra/src/compiler/pipeline.ts` (передає імена дійсних функцій членства в `checkLinks`), `diagnostics.ts`, `messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/rights-dimension-functions.test.ts` (новий)

**Interfaces:**
- Consumes: `nullaryFunction(units, schema, name, { type: "uuid", setof: true })`, `volatilityProblem(fn)`, `setFunctionClosedProblem(fn, units, schema, name, parse, plpgsql)` з `stages/links.ts`; `unitCalls(unit, parse)`, `unitRelations(unit, parse)` з `sql/dependencies.ts`; `membershipsOf(...)` з `membership-functions.ts` (імена згенерованих функцій членства).
- Produces: `checkDimensionFunctions(project, units, membershipFunctions: ReadonlySet<string>, parse, plpgsql): Diagnostic[]` — викликається з `checkLinks`, який отримує новий параметр `membershipFunctions`.
- **Як імена членства доходять до перевірки (порядок стадій).** `runStages` виконує стадію 4 (`checkIntegrity`, зокрема `checkMembership`) і стадію 5 (`checkLinks`) підряд, а гейт помилок стоїть після обох. Тому `pipeline.ts` між ними будує `membershipFunctions` — кваліфіковані імена `<таблиця>_my_member` і `<таблиця>_member_scopes` з `membershipsOf(...)` **лише для довідників, на файлі яких стадія 4 не дала жодної діагностики `membership.*`**. Зламане членство отже не легалізує виклик: виклик його функції — `unknown`.
- Коди: `rights.dimension-function-missing` (`{ dimension, function }`), `rights.dimension-function-signature` (`{ dimension, function, reason }` — причини ті самі, що в `scope.set-function-signature`; для ланки ланцюжка `function` — ланка), `rights.dimension-function-reads-rights` (`{ dimension, chain, object }` — `chain` — функції від виміру до ланки через ` → `, `object` — заборонене ім'я чи `"plpgsql"`/`"unknown"`).

- [X] **Step 1: Write the failing test** `rights-dimension-functions.test.ts`
  - `it("accepts a closed set function that reads app tables and the current user")` — тіло `SELECT r.region_id FROM public.member_region r WHERE r.user_id = (SELECT simetra.current_user_id())` → без діагностик.
  - `it("follows calls into project sql functions")` — `region_ids()` кличе `public.helper_ids()` (sql, читає таблицю застосунку) → без діагностик; `helper_ids()` читає `simetra.identities` → `rights.dimension-function-reads-rights` з `chain: "public.region_ids → public.helper_ids"`, `object: "simetra.identities"`.
  - `it("fails closed on plpgsql and unknown functions in the chain")` → `object: "plpgsql"` і `object: "unknown"` для `ext.foo()`.
  - `it("allows generated membership functions and builtins")` — виклик `public.org_member_my_member(...)` і `coalesce(...)` → без діагностик.
  - `it("reports a missing function and a wrong signature")` — `rights.dimension-function-missing` і `rights.dimension-function-signature` на `project.meta.json` `/accessDimensions/0/values/function`.
  - `it("checks the closed form of every function in the chain")` — ланка `public.helper_ids()` з `SET search_path = simetra`, що читає некваліфіковане `identities` (непряме читання `simetra.identities`) → `rights.dimension-function-signature` з `function: "public.helper_ids"`; ланка без `SET search_path = ''` чи з некваліфікованим відношенням — так само.
  - `it("does not trust functions of a broken membership")` — довідник членства з `membership.user` не на «Користувачів» і функція виміру, що кличе його `<таблиця>_my_member` → є і `membership.user-not-users-ref`, і `rights.dimension-function-reads-rights` з `object: "unknown"`.

- [X] **Step 2: Run test to verify it fails**

Run: `pnpm --filter simetra test rights-dimension-functions`
Expected: FAIL.

- [X] **Step 3: Implement** — обхід у ширину від функції виміру за `unitCalls`; **кожна** функція ланцюжка проходить закриту форму — `LANGUAGE sql`, `SET search_path = ''`, кваліфіковані відношення (`setFunctionClosedProblem` чи його частина; від ланок не вимагаються `STABLE` і `SECURITY DEFINER` — їх вимагає лише функція виміру). Інакше `search_path` ланки міг би непомітно спрямувати некваліфіковане ім'я в `simetra`. Некваліфікований виклик без одиниці проєкту — вбудована функція `pg_catalog` (дозволено: `search_path = ''`); кваліфікований виклик — одиниця проєкту `LANGUAGE sql` (йти далі), ім'я з `membershipFunctions` (лист), `simetra.current_user_id` (лист), інакше `plpgsql`/`unknown`; кожна одиниця ланцюжка — `unitRelations` без схеми `simetra`. Відвідані одиниці — множина (цикл викликів не зациклює обхід).

- [X] **Step 4: Run test to verify it passes**

Run: `pnpm --filter simetra test rights-dimension-functions rights-dimensions messages`
Expected: PASS.

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): закрита форма функції значень виміру без читання прав"
```

---

### Задача 9: прийняті джерела членства й призначень (§4.7) і «Користувачі» (§4.6)

**Files:**
- Modify: `model/schemas/rights.ts` (`assignedOnSchema`, `membershipSourceSchema`, `assignmentSourceSchema`), `model/schemas/project.ts` (`membershipSources`, `assignmentSources`; однорядковий коментар про С8 біля оголошення)
- Modify: `compiler/stages/identity.ts` (id, імена, посилання `table`, колонки, `scopeKind`, `assignedOn.container`), `operations/fix.ts`
- Modify: `rights/checks.ts`, `rights/contracts.ts`, `compiler/contracts.ts`, `pipeline.ts`, `diagnostics.ts`, `messages.ts`
- Test: `rights-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/rights-sources.test.ts` (новий)

**Interfaces:**
- Produces (T0):

```ts
export const assignedOnSchema = z.union([
  z.literal("global"),
  z.strictObject({ scopeKind: elementNameSchema }),
  z.strictObject({ container: metadataRefSchema }),
])
export const membershipSourceSchema = z.strictObject({
  id: metadataIdSchema.optional(), name: elementNameSchema,
  scopeKind: elementNameSchema, table: metadataRefSchema,
  columns: z.strictObject({ scope: elementNameSchema, user: elementNameSchema,
    active: elementNameSchema.optional() }),
})
export const assignmentSourceSchema = z.strictObject({
  id: metadataIdSchema.optional(), name: elementNameSchema,
  assignedOn: assignedOnSchema, table: metadataRefSchema,
  columns: z.strictObject({ member: elementNameSchema, role: elementNameSchema,
    container: elementNameSchema.optional(), active: elementNameSchema.optional() }),
})
```

  (`assignedOnSchema` споживає і роль у Права-1b.)
- Produces (T1): `CompiledAssignedOn = { level: "global" } | { level: "scope"; scopeKindId: string } | { level: "container"; containerId: string }`; `Contracts.membershipSources: MembershipSourceContract[]`, `Contracts.assignmentSources: AssignmentSourceContract[]` (за id):

```ts
export interface MembershipSourceContract {
  sourceId: string; name: string; scopeKindId: string; table: QualifiedName
  scope: string; user: string; active?: string
}
export interface AssignmentSourceContract {
  sourceId: string; name: string; assignedOn: CompiledAssignedOn; table: QualifiedName
  member: string; role: string; container?: string; active?: string
}
```

- Produces: `membershipOfScopeKind(scopeKindId, objects, contracts): "catalog" | "source" | undefined` у `rights/checks.ts` — Права-1b читає його для Рх7.
- Коди: `rights.source-table` (`{ source }` — ціль не `CustomTable`), `rights.source-forced-rls` (`{ source, table }` — `rowLevelSecurity: "forced"`), `rights.membership-source-duplicate` (`{ scopeKind }` — у виду вже є довідник членства чи інше джерело), `rights.source-container-column` (`{ source, reason }`: `"missing"` для контейнерного рівня, `"unexpected"` для інших), `rights.scope-kind-unknown` (`{ scopeKind }`), `rights.container-target` (з Задачі 6, для `assignedOn.container`), `rights.users-missing` (`{}` — у проєкті є декларації прав, але немає ні довідника `users`, ні джерела членства; на `project.meta.json` `""`).

- [X] **Step 1: Write the failing tests** `rights-sources.test.ts`
  - `it("compiles a membership source and an assignment source")` — `CustomTable` `Membership` (`scopeColumn`, колонки `org_id`, `user_id`, `is_active`) і `RoleGrant` (`member_id`, `role_key`, `project_id`); контракти дорівнюють очікуваним записам з фізичними колонками.
  - `it("rejects broken sources")` — `[code, pointer]`: `table` на довідник → `rights.source-table`; `rowLevelSecurity: "forced"` → `rights.source-forced-rls`; джерело членства для виду, що має `OrgMember` → `rights.membership-source-duplicate`; контейнерний рівень без `columns.container` → `rights.source-container-column` (`missing`); невідомий вид скоупу → `rights.scope-kind-unknown`; невідома колонка → `customTable.column-unknown`.
  - `it("requires users or a membership source for rights declarations")` — `ownership` без довідника `users` і без джерела → `rights.users-missing`; з джерелом членства — без діагностики.
  - `it("accepts an owner that refers to the adopted membership source")` (Р1a-24) — `Task.assignee` → `CustomTable` `Membership` (джерело членства виду `org`, `uniques` над `[org_id, id]`): `ownership: ["assignee"]` компілюється, носій `{ column: "assignee_id" }`, FK складений; та сама таблиця без `UNIQUE (scope, id)` → `rights.carrier-cross-tenant`; прийнята таблиця, що не є джерелом членства цього виду, → `rights.ownership-target` (`reason: "target"`).
  - `rights-schemas.test.ts`: `assignedOnSchema` приймає три форми й відмовляє на `{ scopeKind, container }`.

- [X] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rights-sources rights-schemas`
Expected: FAIL.

- [X] **Step 3: Implement** — правило цілі власності Задачі 5 розширюється (Р1a-24): кінцевий `Ref` може вести й на `CustomTable` — джерело членства виду скоупу об'єкта, за умови складеного FK (Задача 4); колонки джерела — посилання на елементи `CustomTable` за логічним іменем (роль `source.column`, власник — джерело, як `storage.scopeKind`), тож перейменування колонки переписує мапінг (§4.7); «декларації прав» для `rights.users-missing` — непорожні `ownership`, `access`, `containerBinding`, `accessDimensions` чи `assignmentSources` (Права-1b додасть ролі й набори); коментар біля `membershipSources`: `// Джерела припускають С8 (id користувача = sub): провайдер поки один — Supabase; другий провайдер введе факт пресету й перевірку.` `kitchen-sink.ts` — обидва джерела й усі три форми `assignedOn`.

- [X] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rights field-ratchet reference-index-completeness json-schema`
Expected: PASS.

- [X] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): прийняті джерела членства й призначень"
```

---

### Задача 10: інструменти designer над новими полями і скіл споживача

**Files:**
- Test: `packages/simetra/src/compiler/__tests__/operations-rights.test.ts` (новий)
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (розділ про права: `customActions`, `ownership`, `rightsContainer`, `containerBinding`, `access`, `accessDimensions`, `membershipSources`, `assignmentSources`, носій-шлях; англійською)

**Interfaces:**
- Consumes: `createObject`, `addElement`, `renameElement`, `deleteElement`, `explainObject` з `simetra/compiler`; поля й ролі Задач 3–9.

- [X] **Step 1: Write the failing tests** `operations-rights.test.ts`
  - `it("adds a custom action and an access dimension with ids")` — `addElement({ target: { kind: "Document", name: "Task" }, collection: "customActions", element: { name: "reassign" } })` і `addElement({ target: { kind: "Project" }, collection: "accessDimensions", element: {...} })` → у результаті є `id`, компіляція чиста.
  - `it("renames an attribute in every rights place")` — перейменування `Task.assignee` → `owner` переписує `ownership`, `TaskComment.ownership[0][1]` і `effects.header` кастомної дії; перейменування `Task.project` переписує `containerBinding` і `TaskComment.containerBinding[1]`; перейменування колонки джерела переписує `columns`.
  - `it("renames a dimension and a custom action")` — `{ kind: "Project", element: ["region"] }` → переписано `access[].dimension`; кастомна дія → переписано `requires` іншої кастомної дії.
  - `it("refuses to delete a dimension, a container and a carrier that are referenced")` — `operation.delete-referenced` з ролями `access.dimension`, `rights.carrier`.
  - `it("creates a container catalog with rights fields")` — `createObject` з `data: { rightsContainer: true, ... }`.
  - `it("addresses a custom action unambiguously")` (Р1a-22) — `addElement` кастомної дії з іменем наявного реквізиту → відмова з `identity.name-duplicate` і без запису файлів; `renameElement` і `deleteElement` з `{ kind: "Document", name: "Task", element: ["reassign"] }` діють саме на кастомну дію: після перейменування `model.references` з роллю `customAction.requires` має `to.id` = UUID кастомної дії, а реквізити не змінено.

- [X] **Step 2: Run test to verify it fails or passes**

Run: `pnpm --filter simetra test operations-rights`
Expected: тести, які покриває загальний механізм, проходять одразу; червоні вказують на пропущене посилання чи колекцію — виправити в коді відповідної задачі (не в операціях) і назвати у звіті.

- [X] **Step 3: Скіл споживача** — розділ «Rights declarations» у `SKILL.md`: кожне поле — одне речення й приклад форми з плейсхолдерами, посилання на правила компілятора (`rights.*`); без переказу спеки.

Run: `pnpm --filter @simetra/designer test skill-examples && python3 scripts/check-doc-anchors.py`
Expected: PASS.

- [X] **Step 4: Commit**

```bash
git add packages
git commit -m "test(compiler): мутації designer над полями прав; скіл описує права"
```

---

### Задача 11: гейти

- [X] **Step 1:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — усе зелене.
- [X] **Step 2:** `pnpm metadata:check` — код 0.
- [X] **Step 3:** `python3 scripts/check-doc-anchors.py` — код 0.
- [X] **Step 4:** `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-18-rights-1a-carriers-contract.md` — якорі плану відповідають коду.
- [X] **Step 5:** `pnpm db:start` (якщо стек не запущено) і повний `pnpm test:db` на одному SHA, без змін у дереві під час прогону; результат — у звіт з SHA. Нових DB-тестів немає: прогін доводить, що мітки регістрів, складений FK на `CustomTable` і зміна запису промоції не зламали тінь, рендер і застосування.
- [X] **Step 6:** якщо гейти дали правки форматування — `pnpm format:fix` і коміт `style: форматування Права-1a`.

## Критерії приймання

- `KindDefinition.actions` — функція; статичного масиву й `postsMovements(kind)` без об'єкта немає.
- Регістри й константа мають мітку виду; у коді немає `labelDropped` і `promote.label-target`.
- `contracts.rights` є в кожного об'єкта виду з непорожнім `rightsExtents`, з діями (стандартні й кастомні за UUID), замиканням вимог, ефектами й обсягами `any`/`own`/вимір; `explain` його показує.
- Усі коди `rights.*` цього плану мають тести, тексти en/uk і місце в `COMPILER_RULES`.
- `field-ratchet` і `reference-index-completeness` зелені без нових винятків (крім, можливо, слів словника дій — рішення архітектора у Задачі 3).
- Гейти Задачі 11 зелені на одному SHA.
