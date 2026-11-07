# П4-B3-2a — колекції, підмножини й власність: план реалізації

> **Статус:** на прийманні архітекторкою П4-B (2026-11-07). Підсумок аудиту —
> наприкінці файла. Виконання — після B3-1 (а отже після B1b-1 і B1b-2:
> причина `response-too-large` з'являється в B1b-2); перед стартом — злиття
> `main` у гілку (без rebase) і `orient --plan`.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** модуль фасаду T4 тримає колекцію на об'єкт і на ТЧ над RC TanStack DB,
наповнює їх лише підмножинами з власником (ключі, картка, «ТЧ власника»), не
зменшує версії рядка, веде повноту й свіжість ТЧ, відкриває картку
паралельними підмножинами, вносить цілі посилань лінивим `leftJoin` і
прибирає все в `dispose()`. Обчислювач фільтра T0 у T4 дає ту саму множину,
що будівник T3.

**Architecture:** бібліотека — лише в `packages/simetra/src/data/facade/`
(Рд5) над рантаймом даних і адаптером B3-1; обчислювач фільтра — у
`src/data/filter.ts` без бібліотеки. Публічних хуків блок не дає (B3-2b):
він дає внутрішній API фасаду. Запити — логічна форма T0, маплення у форму
передачі й декодування — функції T0 (B1b-1: `readQueryToWire`,
`readResultFromWire`, що вже декодує через `decodeRow`).

**Tech Stack:** TypeScript 7, `@tanstack/db` і `@tanstack/react-db`
1.0.0-rc.1.4, `@tanstack/query-db-collection` 1.5.1, `@tanstack/query-core`
5.107.1, Vitest (node), PostgreSQL 17 (DB-кейс еквівалентності).

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — Рд13,
Рд14, Рд21–Рд24, Рд27, §4.1, §4.4, §6.1 («Колекція об'єкта», «Колекція ТЧ»,
«Колекція запитів», «Режим синхронізації», «Колекція `on-demand`»,
«Предикати», «Помилки розробника»), §6.2, §6.3, §11 інв. 13, 14, 15
(повнота), 16, 17 (картка й «ТЧ власника» понад бюджет), §12 (кейси B3-2a за
«Належністю кейсів»), §13 (рядок B3-2a). [Звіт спайку B3](../specs/2026-11-07-p4-b3-facade-spike-report.md)
— Q1–Q4, Q6. [План B3-1](2026-11-07-p4-b3-1-t4-skeleton.md).

## Global Constraints

- Мова: коментарі — українською, «чому»; JSDoc — англійською.
- Коміти: Conventional Commits, український опис, без трейлерів; коміти й
  push — за дозволом власника (через архітекторку); PR відкриває архітекторка;
  гілка з конфліктом із `main` — `git merge origin/main`, не rebase.
- Бібліотеку бачить лише `src/data/facade/`; публічні типи `simetra/data` без
  `@tanstack/*`.
- Колекції — `queryCollectionOptions`, `rowUpdateMode` типовий `partial`,
  `retry: false` (query-core у браузері повторює тричі — суперечило б §7.3);
  власного адаптера синхронізації немає; `queryFn` повертає рядки.
- Форми підмножин on-demand: `in(<ключ>, …)` — ключі (і для одного ключа);
  `eq(<ключ>)` — лише картка; `eq(<власник>)` у колекції ТЧ — «ТЧ власника».
  Фасад ніколи не будує `eq(<ключ>)` поза карткою. Інша форма — `DataError`
  `data.unbounded-subset` без запиту. Форма сторінки вікна з токеном — B3-2b.
- Рядок колекції ніколи не заміняється рядком меншої версії (Рд24); ТЧ — на
  рівні підмножини за `ownerVersion`.
- Поля пізніших частин (`hasNewRows`, `showNew`, `isStale`, реєстр власних
  створень, write-back, `waitPendingSettled`) у блоці не з'являються.
- Тести: скіл `.agents/skills/writing-tests/SKILL.md`; справжня RC, фейковий
  транспорт; без `--` перед шаблоном vitest.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Обчислювач фільтра T0 у T4 замість перекладу у вираз бібліотеки; рядки `lt`/`lte`/`gt`/`gte` — `Intl.Collator` з локаллю колляції бази (типово `en-US`), нічия колатора — порівняння байтів UTF-8; `eq`/`ne`/`in` — точна рівність, `in` з `null` — відмова як у будівника; `contains`/`startsWith` — літерал підрядка/префікса через `toLowerCase`; тризначна логіка; `fnWhere` — лише `full` (B3-2b) (рішення архітекторки) | §6.1, інв. 16, Рд23, §12 — у коміті плану |
| Р2 | Видимість підмножини для `needsRefresh` задає B3-2b; у B3-2a — стан `needsRefresh` і `refresh()` | немає |
| Р3 | Внутрішній API фасаду (не експортується з `simetra/data`) — імена в задачах; B3-2b будує на ньому хуки | немає |
| Р4 | Об'єкт поза клієнтським каталогом — `TypeError` (помилка конфігурації розробника); коди `data.*` — для неправильного вживання даних (§6.1) | немає |
| Р5 | Монотонність — мапа найбільших версій ключа у фасаді (результати `queryFn`, власні записи); заміна — у момент повернення `queryFn`; ТЧ — на рівні підмножини; запис мапи прибирається з вивантаженням ключа (`collection.base` не бачить записів у черзі) | §6.2 правило 2 — у коміті плану |
| Р6 | `ownerVersion` підмножини — з результату «ТЧ власника» (фасад тримає на власника) і переноситься на підмножину, коли резолвиться проміс завантаження чи перезапиту (контракт `LoadSubsetFn`: після видимості записів); так і для порожньої ТЧ | §6.2 — у коміті плану |
| Р7 | Скидання повноти — через одну обгортку записів фасаду в колекції ТЧ (події бібліотеки не несуть джерела); перезапит однієї підмножини — `loadSubset` її форми з `refetch: true` (чекає застосування; `refetchQueries` розв'язується на межі вибірки), відповідне `unloadSubset` — тим самим об'єктом опцій | §6.2, §6.3 — у коміті плану |
| Р8 | `waitPendingSettled` — у B3-3 (транзакції з'являються там); інв. 9 (видалення рядка, якого перечитування не повернуло) — B3-3/B5; у B3-2a рефетч підмножини, що не повернув рядка, знімає власність сам | §13, §12 — у коміті плану |
| Р9 | Рантайм даних B3-1 отримує опцію `collationLocale?: string` (типово `"en-US"`) і типовий адаптер `selectSource({ profile: catalog.provider, serverFunction: createServerFunctionAdapter(runtime) })`; один обчислювач фільтра на рантайм | немає |

## Review Focus

1. **Застарілий результат поверх новішого** — гонка двох підмножин того самого
   ключа й відкладене застосування (спайк Q6); тест задачі 3.
2. **Воскреслий рядок ТЧ** із застарілого результату «ТЧ власника»; тест задачі 3.
3. **Неповна ТЧ, що вважається повною** — запис не з «ТЧ власника» скидає
   повноту; `ownerVersion` порожньої ТЧ; тести задачі 5.
4. **Картка без лінивих колонок** після рівної підмножини ключів — `eq` лише
   для картки; тест задачі 2.
5. **`%`/`_` і змішаний регістр** — обчислювач = будівник; задача 4.

---

### Task 0: спека (у коміті плану)

- [ ] §13: B3-2 → B3-2a і B3-2b; `waitPendingSettled` — у B3-3 (Р8); §12
  «Належність кейсів» — за змістом; інв. 9 — B3-3/B5.
- [ ] Р1 (§6.1 «Предикати», інв. 16, Рд23, §12 з мутаціями «без екранування»
  й «кодові точки»), Р5–Р7 (§6.1 форма 1 — `eq` лише картка; §6.2 правило 2,
  «Повна підмножина ТЧ»; §6.3 — перезапит за ключем фасаду, `retry: false`).
- [ ] `python3 scripts/check-doc-anchors.py`; коміт разом із планом:
  `docs(plan): план П4-B3-2a, поділ B3-2 і правила фасаду в спеці`.

### Task 1: колекції об'єкта й ТЧ, опції рантайму

**Files:** Create `packages/simetra/src/data/facade/collections.ts`,
`packages/simetra/src/data/facade/__tests__/fake-transport.ts`; Modify
`packages/simetra/src/data/facade/runtime.ts`, `packages/simetra/src/data/index.ts`
(B3-1: опція `collationLocale`, типовий адаптер, Р9); Test
`packages/simetra/src/data/facade/__tests__/collections.test.ts`.

**Interfaces:**
- `collectionsOf(runtime: DataRuntime, test?: { keyPrefix?: readonly unknown[] }): Collections`
  — ліниво створює й кешує на рантаймі `objectCollection(object: MetadataRef)` і
  `sectionCollection(object: MetadataRef, section: string)`; `syncMode: "on-demand"`;
  `getKey` — id рядка; `queryKey` — функція-будівник фасаду (`TQueryKeyBuilder`;
  будує ключ із `SubsetForm`, ігноруючи `signal`/`subscription`, на поганій формі
  не кидає — відмову дає `queryFn`; `queryKey({})` — базовий префікс, похідні
  ключі його продовжують): префікс рантайму
  (або `test.keyPrefix` — лише для тесту ізоляції) + `["object", <UUID>]` /
  `["section", <UUID ТЧ>]` + підмножина; `queryClient` рантайму;
  `retry: false`; `gcTime` — опція (типово бібліотечний, у тестах малий).
- `fake-transport.ts` — таблиці в пам'яті, журнал запитів (форма передачі),
  затримка й керований порядок відповідей, поріг `response-too-large`.

- [ ] **Step 1: Failing tests:** та сама колекція на повторний виклик, різні
  для двох об'єктів; контрактний тест «`rowUpdateMode` не перевизначено —
  `partial`» (спайк Q3); створення без запиту; `retry` запиту в кеші —
  `false` (`queryClient.getQueryCache().getAll()[0].options.retry`), і
  відмова транспорту дає рівно один виклик навіть з `isServer = false`
  (`environmentManager.setIsServer(() => false)`, повернення в `afterEach`); об'єкт поза каталогом — `TypeError` (Р4);
  `createDataRuntime({ collationLocale })` — у фасаді один обчислювач з цією
  локаллю (той самий об'єкт на повторний виклик).
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test collections`).
- [ ] **Step 5: Commit** — `feat(data): колекції об'єкта й ТЧ у фасаді`.

### Task 2: `queryFn` — форми підмножин і читання

**Files:** Create `packages/simetra/src/data/facade/subsets.ts`; Test `subsets.test.ts`.

**Interfaces:**
- `subsetFormOf(options: LoadSubsetOptions, kind: "object" | "section"): SubsetForm`
  — `parseLoadSubsetOptions` у `try` (на `or`, `like`, `not` він кидає `Error`):
  `in(<ключ>)` → `{ kind: "keys", keys }`; `eq(<ключ>)` → `{ kind: "card", id }`;
  `eq(<власник>)` у ТЧ → `{ kind: "ownerSection", owner }`; у колекції ТЧ
  `in`/`eq(<ключ>)` — `data.unbounded-subset`; відсутній `where`,
  зайвий фільтр, `orderBy`, `limit`, `offset`, `cursor`, виняток розбору →
  `DataError` `data.unbounded-subset`.
- `readSubset(runtime, entry, form): Promise<{ rows: Row[]; ownerVersion?: number }>`
  — ключі → списочна форма `where in` з `limit` = кількість ключів, по ≤ 200;
  картка → форма картки; «ТЧ власника» → `{ object, tabularSection, owner }`.
  `readQueryToWire` → `Mapped`: `unknown`/`invalid` — помилка розробника
  (`TypeError`), успіх звужується до `WireRowsQuery`; результат —
  `readResultFromWire` (уже декодує, окремого `decodeRow` немає;
  `WireDecodeError` — відхилення промісу завантаження з `command.internal`).
- `response-too-large` для ключів — поділ навпіл до одного ключа; один ключ,
  картка чи «ТЧ власника» понад бюджет — відхилення `CommandFailure`
  `response-too-large` (інв. 17).
- `DataError` з `queryFn` доходить до викликача через відхилення промісу
  завантаження підмножини (`preload`/`toArrayWhenReady`) і `status`/`health`
  колекції; інші підмножини колекції працюють (тест).

- [ ] **Step 1: Failing tests:** `inArray(id, 450)` → три запити (200, 200, 50),
  один масив; `inArray(id, [один])` — форма «ключі», не картка; картка
  `eq(id)` після рівної підмножини `inArray(id, [той самий])` читає **форму
  картки** з лінивими колонками (Review Focus 4); `eq(parent)` колекції ТЧ →
  «ТЧ власника»; неключовий `where`, `or`, `like`, без `where`, з
  `offset`/`cursor` → `data.unbounded-subset`, нуль запитів, інша підмножина
  тієї самої колекції після цього читається; `response-too-large` на 8 ключах
  → 8 → 4+4 → …; картка й «ТЧ власника» понад бюджет — відхилення; рядки
  декодовано (`bigint`, `Numeric`-рядок, пара).
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(data): форми підмножин і читання через адаптер`.

### Task 3: монотонність версії (Р5)

**Files:** Create `packages/simetra/src/data/facade/versions.ts`; Modify `subsets.ts`;
Test `monotonic.test.ts`.

**Interfaces:** `versionsOf(runtime, collection)` — мапа `key → { version, row }`
найбільшої побаченої версії; `keepNewer(rows): Row[]` у момент повернення
`queryFn`; для ТЧ — `keepNewerSection(owner, result): { rows; ownerVersion }`:
мапа тримає на власника рядки результату з найбільшою `ownerVersion`;
результат з меншою `ownerVersion` відкинуто цілком і заміщено саме цими
рядками (не видимим станом колекції — той без прийнятого в чергу результату й
з оптимістичними накладками); запис мапи
прибирається з вивантаженням ключа (власник — з останньою підмножиною).

- [ ] **Step 1: Failing tests:**
  - колекція має v5; перечитування віддає v4 → у колекції v5; v6 → заміна;
    рівна версія не стирає лінивого поля;
  - гонка двох підмножин (Review Focus 1): фейковий транспорт віддає
    відповідь підмножини A (v5) **після** відповіді підмножини B (v6) того
    самого ключа → у колекції v6;
  - відкладене застосування: поки в колекції `persisting` транзакція
    (`createTransaction` у тесті фасаду), результат v4 повертається, а прямий
    запис v5 стоїть у черзі → після осідання у колекції v5;
  - ТЧ: свіжий результат v6 `{a, b}`, потім застарілий v5 `{a, b, c}` → у
    колекції `{a, b}` (рядок `c` не воскрес, Review Focus 2) — і коли свіжий
    стоїть у черзі за `persisting`-транзакцією в мить приходу застарілого;
  - рядок картки заміщено рядком рівної/новішої версії без лінивого поля →
    картку освіжає правило 3 (задача 6);
  - мапа: після вивантаження ключа запису немає.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(data): версія рядка в колекції не зменшується`.

### Task 4: обчислювач фільтра T0 і еквівалентність із будівником

**Files:** Create `packages/simetra/src/data/filter.ts`; Test
`packages/simetra/src/data/__tests__/filter.test.ts`; Modify
`packages/simetra/test/support.ts` (реекспорт `createFilterEvaluator` для тестів
designer — `eslint.zones.js` designer дозволяє `test/support` у `__tests__`;
публічного експорту немає); `packages/designer/src/__tests__/read-query.db.test.ts`.

**Interfaces:** `createFilterEvaluator(locale: string): { matches(entry: CatalogEntry, row: LogicalRow, filter: Filter): boolean }`
— колатор `new Intl.Collator(locale)` один на обчислювач; `true` лише для
`TRUE` тризначної логіки; невідомий вузол чи `in` з `null` — `DataError`
`data.unsupported-predicate`.

- [ ] **Step 1: Failing tests (unit, таблиця):** кожен оператор за типами
  каталогу (рядки, `bigint`, `Numeric` числово — `"10"` > `"9"`, `DateTime`
  ISO з різними зсувами, пара `{ type, id }`); `contains`/`startsWith` без
  регістру (латиниця, кирилиця), значення `50%_\` — літерал; `lt`/`gt` на
  `"a"`, `"B"`, `"á"`, `"b"` — порядок ICU `en-US`; нічия колатора (NFC проти
  NFD того самого символу) — порядок байтів UTF-8; `eq` — точна рівність
  (`"a"` ≠ `"A"`); `ne`/`not` над `NULL` — рядок не проходить; `in` з `null`
  — `DataError`.
- [ ] **Step 2: DB-кейс** (причина DB: колляцію, `ILIKE` і тризначну логіку
  дає Postgres) у `read-query.db.test.ts`: запис каталогу —
  `buildClientCatalog(runtimeCatalog)` (`simetra/compiler`); мала фікстура
  (≤ 200 рядків — межа `limit`); фільтри: кожен оператор, вкладені
  `or`/`not`, `%`/`_` у `contains`/`startsWith`, `lt`/`gt` на змішаному
  регістрі й діакритиці, пара `Ref`, `Numeric`, `DateTime`, `NULL` для
  `ne`/`not` — множина id `runtime.read` = множина id, які `matches`
  пропускає з повної вибірки того самого скоупу.
- [ ] **Step 3–4:** implement → green (`pnpm --filter simetra test filter`,
  `pnpm --filter @simetrajs/designer test:db read-query`).
- [ ] **Step 5: Commit** — `feat(data): обчислювач фільтра T0 з семантикою будівника`.

### Task 5: колекції ТЧ — повнота, `ownerVersion`, свіжість

**Files:** Create `packages/simetra/src/data/facade/sections.ts`,
`packages/simetra/src/data/facade/writes.ts`; Test `sections.test.ts`.

**Interfaces:**
- `openOwnerSection(runtime, object, section, owner): SectionHandle` —
  `{ rows(): Row[]; complete: boolean; ownerVersion?: number; needsRefresh: boolean; refresh(): Promise<void>; close(): void }`.
  `complete` = підмножину не скинуто **і** `ownerVersion` = синхронізованій
  версії шапки власника (§6.2). Кожен рядок ТЧ несе клієнтське `ownerVersion`.
- `ownerVersion` — за Р6 (з результату, переноситься при резолві промісу
  завантаження чи перезапиту).
- `sectionWrites(runtime, collection)` — **єдина** обгортка записів фасаду в
  колекції ТЧ (Р7): будь-який запис у ключі ТЧ власника не з результату
  «ТЧ власника» скидає повноту; новий ключ ТЧ вона не пише (лише латає й
  видаляє ключі, присутні в `collection.base` — нових рядків ТЧ фасад
  напряму не пише, Рд27); видалення рядка прибирає його й зі збережених у
  мапі версій рядків найновішого результату власника (задача 3), тож
  пізніший застарілий результат, заміщений збереженими рядками, видаленого
  рядка не поверне. Пряме `utils.write*` поза обгорткою в фасаді
  не вживається (AST-гард B3-1 і рев'ю).
- `refresh()` — `loadSubset({ ...форма, refetch: true })` (Р7); `ownerVersion`
  переноситься на резолві саме цього промісу; single-flight з одним хвостом (§6.3).

- [ ] **Step 1: Failing tests:** колекцію ТЧ наповнює лише «ТЧ власника»;
  порожня ТЧ видимого власника — `ownerVersion` є, `complete` true;
  `ownerVersion` не змінюється, поки проміс перезапиту не резолвився (транзакція
  іншого ключа в `persisting` тримає застосування — спайк Q6), і
  оновлюється після; запис через `sectionWrites` не з результату — `complete`
  false; `sectionWrites` з новим ключем ТЧ — нічого не записано (рядка
  немає); послідовність «свіжий результат v6 `{a, b}` → видалення `b` через
  `sectionWrites` → застарілий результат v5» — у колекції `{a}` (`b` не
  воскрес); оптимістичний стан повноти не скидає; `refresh()` повертає повноту;
  версія шапки росте → `needsRefresh`; `refresh()`: два виклики під час
  активного — активний і **один хвостовий** запит; три — так само;
  `tabular-too-large` — відхилення з `path` ТЧ.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(data): колекції ТЧ з повнотою й ownerVersion`.

### Task 6: картка — паралельні підмножини

**Files:** Create `packages/simetra/src/data/facade/card.ts`; Test `card.test.ts`.

**Interfaces:** `openCard(runtime, object, id, sections?: string[] | true): CardHandle`
— `{ row(): Row | undefined; sections(): Record<string, SectionHandle>; version?: number; close(): void }`;
шапка — підмножина `eq(<ключ>)` (форма картки), ТЧ — `openOwnerSection`,
паралельно; `close()` кличе `cleanup()` своїх живих запитів (інакше рядки
зникнуть лише після `gcTime`, спайк Q4).

- [ ] **Step 1: Failing tests:** запити шапки й ТЧ стартують паралельно;
  `version` — версія шапки; закриття останньої підмножини ТЧ власника прибирає
  рядки ТЧ (за лічильником посилань); інша підмножина рядка тримає його;
  невидимий рядок — `row()` `undefined`; правило 3 §6.2: рядок шапки новішої
  версії без лінивої колонки (з іншої підмножини) при відкритій картці → один
  перезапит підмножини картки (single-flight), ліниве поле свіже.
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(data): картка паралельними підмножинами`.

### Task 7: `include` — лінивий `leftJoin` і `refs`

**Files:** Create `packages/simetra/src/data/facade/live.ts`; Test `include.test.ts`.

**Interfaces:** `liveRows(runtime, { object, keys: string[], include?: string[] }): LiveHandle`
— `{ rows(): Array<Row & { refs?: Record<string, Row | null> }>; close(): void }`;
активна сторона — `inArray(<ключ>, keys)` (≤ 200, і для одного ключа);
`leftJoin` на ціль кожного одноцільового `Ref` з `ref` у каталозі; результат
за власним ключем рядка (ключ рядка join складений); колекція цілі —
`createIndex((r) => r[<ключ>], { indexType: BasicIndex })` (`BasicIndex` з
`@tanstack/db`; без `indexType` бібліотека кидає).

- [ ] **Step 1: Failing tests:** 200 ключів активної сторони з 260 різними
  цілями → лінива сторона отримує один `inArray`, `queryFn` ділить по 200 (два
  запити); `refs` — рядок цілі чи `null`; рядок цілі зникає після `close()`
  усіх списків, лишається, поки тримає хоч один; зміна FK — нова лінива
  підмножина; немає попередження `Join requires an index on` (шпигун
  `console.warn`, `NODE_ENV` ≠ `production`); живий запит фасаду не має
  `fnWhere`, `groupBy`, `distinct` і не-`left` join (перевірка IR запиту).
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(data): include цілей посилань лінивим leftJoin`.

### Task 8: життєвий цикл, `dispose()` і ізоляція

**Files:** `collections.ts`, `facade/runtime.ts`; Test `lifecycle.test.ts`.

**Interfaces:** `peekRow(collection, key): Row | undefined` (після `cleanup` —
`undefined`); `singleFlight(fn)`; `stateOf(collection): { status; health }` без
типів бібліотеки; `dispose()` (синхронний, B3-1) кличе `cleanup()` кожної
колекції без очікування й прибирає їх з кешу рантайму.

- [ ] **Step 1: Failing tests:** `peekRow` після спливу `gcTime` (малий у
  тесті) — `undefined`; single-flight: три виклики під час активного — один
  хвостовий; збій однієї колекції не зупиняє іншої (`stateOf`); `dispose()` —
  колекції прибрано з кешу, рядків немає, кеш запитів `QueryClient` порожній
  (`getQueryCache().getAll()` — `[]`); ізоляція (§12): два рантайми з
  `collectionsOf(r, { keyPrefix: [] })` — однакові ключі запитів, одне
  фейкове сховище — рядки одного не видно в іншому (власний `QueryClient`).
- [ ] **Step 2–4:** red → implement → green.
- [ ] **Step 5: Commit** — `feat(data): життєвий цикл колекцій і dispose()`.

### Task 9: мутації, документація й гейти

- [ ] **Step 1: Mutation check (обов'язковий, без коміту; кожна червоніє):**
  результат `queryFn` поверх більшої версії (задача 3); ТЧ порядково замість
  підмножини (задача 3, `c` воскресає); колекцію ТЧ наповнити формою ключів
  (задача 5); не скидати повноту в `sectionWrites` (задача 5); оновити
  `ownerVersion` до резолву промісу (задача 5); прибрати перевірку «літерал»
  у `contains` (задача 4); порівняння рядків кодовими точками (задача 4);
  писати рядки `include` прямим записом (задача 7); `dispose()` без
  `cleanup()` колекцій (задача 8); `retry` типовий (задача 1). Повернути код.
- [ ] **Step 2:** спека П4-B — рядки Додатку А й §14.3, які закриває B3-2a,
  «внесено (B3-2a)»; `docs/ROADMAP.md` (рядок П4); `check-doc-anchors.py`.
- [ ] **Step 3: Гейти:**

```bash
pnpm deps:check
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm metadata:check
pnpm test:db
pnpm build:packages && pnpm test:packaging
```

- [ ] **Step 4: Commit** — `docs(spec): П4-B3-2a — рядки Додатку А й ROADMAP`.

## Готово (§13, рядок B3-2a)

- кейси B3-2a з §12 зелені на справжній RC (форми підмножин, монотонність з
  гонкою й відкладеним застосуванням, ТЧ і повнота, картка, `include`,
  життєвий цикл, `dispose()`, ізоляція, `retry: false`);
- DB-еквівалентність обчислювача фільтра й будівника T3 зелена;
- мутації кроку 1 задачі 9 червоніють.

## Підсумок аудиту плану

- **Раунд 1** — два незалежні аудитори (Opus): «план і спека проти рішень» і
  «правда проти коду RC». Blocker — 0, безпекових major — 0 (блок не торкається
  бази й прав). Major виправлено: картку неможливо позначити через `meta` —
  `eq` лише для картки; монотонність за `collection.base` мала гонку з
  відкладеним застосуванням — мапа версій фасаду й ТЧ на рівні підмножини;
  `ownerVersion` порожньої ТЧ — з результату й резолву промісу; механізм
  скидання повноти й перезапиту однієї підмножини; `retry: false`;
  single-flight з хвостом; ізоляція без префікса; DB-кейс через
  `test/support`; джерело адаптера й локалі; мутації.
- **Раунд 2** — один аудитор (Opus) на виправлення з кодом RC: blocker і
  безпекових major — 0; 2 несекурні major виправлено: перезапит підмножини —
  `loadSubset` з `refetch: true` (`refetchQueries` розв'язується до
  застосування); відкинутий застарілий результат ТЧ заміщується рядками
  найновішого результату з мапи, а не видимим станом колекції; minor —
  будівник ключа з `SubsetForm`, `setIsServer`, відмова `keys`/`card` у ТЧ,
  `profile` з `catalog.provider`, `WireDecodeError`.
- **Codex** (`gpt-6-sol`; ізоляція відмовила читати файли — план і розділи
  спеки вбудовано в промпт за ранбуком): 1 знахідка з позначкою blocker —
  видалення рядка ТЧ через обгортку не прибирало його зі збереженого в мапі
  результату власника, і заміщений застарілий результат повернув би рядок;
  виправлено (обгортка оновлює мапу, тест послідовності); 2 major виправлено
  (обгортка не пише нових ключів ТЧ; `dispose()` — порожній кеш `QueryClient`).
- **Підсумок:** blocker — 0 (знахідку Codex виправлено), безпекових major — 0.
