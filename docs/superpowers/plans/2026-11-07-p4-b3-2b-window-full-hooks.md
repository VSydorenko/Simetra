# П4-B3-2b — вікно, `full` і публічний API читання: план реалізації

> **Статус:** на прийманні архітекторкою П4-B (2026-11-07). Підсумок аудиту —
> наприкінці файла. Виконання — після B3-2a (а отже після B3-1, B1b-1 і
> B1b-2). Інтерфейси B3-1 і B3-2a в цьому плані взято з імен їхніх планів;
> якорі з позначкою «після B3-1» чи «після B3-2a» виконавець **звіряє в
> `main` перед стартом** (`orient --plan`). Розбіжність імені — перейменувати
> в плані за кодом; розбіжність поведінки — до архітекторки. Перед стартом —
> злиття `main` у гілку (без rebase).
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** фасад T4 читає список будь-якого розміру вікном сторінок keyset-ом,
малий довідник — колекцією `full` до межі, і дає застосунку хуки `useRows` і
`useRow` без типів бібліотеки.

**Architecture:** сторінку вікна читає фасад запитом T0 через адаптер (keyset
повним кортежем сортування плюс ключ, `limit` = 100); у колекції сторінка —
підмножина `inArray` її ключів (форма 2), порядок — масив ключів сервера.
`full` — колекція `eager`, чий `queryFn` вибирає множину keyset-ом за ключем
сторінками по 200 до межі; фільтр — обчислювач B3-2a через `fnWhere`. Хуки
(`src/data/hooks.ts`) — `useSyncExternalStore` над хендлами фасаду; React
бачить лише T4, бібліотеку — лише `src/data/facade/`.

**Tech Stack:** TypeScript 7, `@tanstack/db` і `@tanstack/react-db`
1.0.0-rc.1.4, `@tanstack/query-db-collection` 1.5.1, `@tanstack/query-core`
5.107.1, React 19.3, Vitest (node і jsdom на файл), `@testing-library/react`.

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — Рд19,
Рд20, Рд29, §4.1 (`orderBy`, `limit`, `offset`, `count`, бюджет відповіді),
§5.1 (вибір стратегії), §6.1 («Режим синхронізації», форма 2, «Колекція
`full`», «Стратегії списку», «Предикати», «Помилки розробника», «Порядок
рядків»), §6.2 (власність сторінки й вибірки), §6.3, §6.4, §12 (кейси B3-2b
за «Належністю кейсів» і рядок «unit T4 (публічний API)»), §13 (рядок B3-2b),
§14.1 (межа `full`), §14.3 (devDependencies jsdom). [Звіт спайку
B3](../specs/2026-11-07-p4-b3-facade-spike-report.md) — Q1, Q4, Q7. Плани
[B3-1](2026-11-07-p4-b3-1-t4-skeleton.md) і
[B3-2a](2026-11-07-p4-b3-2a-collections.md).

## Global Constraints

- Мова: коментарі — українською, «чому»; JSDoc публічного API — англійською.
- Коміти: Conventional Commits, український опис, без трейлерів; push — за
  дозволом через архітекторку; PR відкриває архітекторка; конфлікт із
  `main` — `git merge origin/main`, не rebase.
- Бібліотеку бачить лише `src/data/facade/`; `src/data/hooks.ts` імпортує
  `react` і фасад, а не `@tanstack/*`; публічні типи `simetra/data` без
  `@tanstack/*` (тест `.d.ts` B3-1).
- Вікно: ні `setWindow`, ні завантаження за курсором RC
  (`ordered-source-loader.ts` тягне префікс); живі запити вікна без
  `orderBy` і `limit`; клієнт рядків вікна не сортує й не порівнює.
- Keyset — повний кортеж сортування плюс ключ, `limit` ≤ `READ_LIMIT_MAX`
  (200); `offset` фасад не вживає; keyset-запиту без просування курсора не
  повторює.
- `fnWhere` — лише над колекцією `eager` (`full`) і лише без join.
- Прямий запис у колекцію `full` — лише через обгортку задачі 5; `write*`
  відсутнього ключа кидає, тож присутність — за `collection.base`
  (§6.2); `writeUpsert` не вживається.
- Поза блоком: `hasNewRows`, `showNew` (B5), `isStale` (B3-3) — цих полів у
  результаті хуків немає; перенесення реєстру власних створень і
  незавершених write-back, `waitPendingSettled` — B3-3; `useCan` — B6.
- Тести: скіл `.agents/skills/writing-tests/SKILL.md`; справжня RC, фейковий
  транспорт B3-2a; jsdom — директивою `// @vitest-environment jsdom` у
  файлі `.test.ts` проєкту `unit`, `createElement` без JSX; без `--` перед
  шаблоном vitest.

## Рішення

Розвилки Ф1–Ф11 погодила архітекторка П4-B 2026-11-07 (Ф3, Ф6, Ф7 — з
умовами, внесеними нижче).

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Ф1 | `setVisibleRange({ first, last })` — ключі першого й останнього видимого рядка, не індекси (індекси зсуваються після вивантаження передніх сторінок, `goTo`, `goToEnd`); індекс віртуалізатора T5 мапить на ключ через `rows` хука | §6.4 |
| Ф2 | Оновлення сторінки — завжди перебудова ланцюжка від неї до кінця вікна з однією нижньою keyset-межею (значення кортежу на момент читання); гілки «проміжна сторінка» немає. Верхня межа з'їла б бюджет фільтра (~62 вузли з 64 на 4 терми й ключ); вартість обмежує розмір вікна (Ф11) | §6.4, §12 (unit T4 фасаду), §13 (рядок B3-2b) |
| Ф3 | Бюджет фільтра (`FILTER_NODES_MAX` 64, `FILTER_DEPTH_MAX` 8) перевіряється **під час відкриття вікна, до першого запиту**: фільтр користувача плюс найбільша keyset-умова цього `orderBy`; понад межу — `CommandFailure` `command.invalid` з `path`, без запиту. `readQuerySchema` на кожному запиті — запобіжник | §6.4 |
| Ф4 | Вхід `useRows` — `count?: true`; результат — плюс `error`, `atStart`, `atEnd`; синхронно виявлена `DataError` кидається під час рендеру; рантайм — через `DataRuntimeProvider`, без нього хук кидає `Error` | §6.4 |
| Ф5 | Опції `createDataRuntime`: `residency?: Record<"<kind>.<name>", "full" \| "window">` — логічне ім'я, рантайм резолвить його каталогом у `createDataRuntime` і тримає UUID об'єкта (невідомий — `TypeError`); `fullLimit?` (типово 5 000); `strict?` (типово `false`; host П4-D ставить `true` у розробці); `log?` (типово `console.warn`) з записом `full-truncated` | §6.1, §14.1 (рядок закрито) |
| Ф6 | `full` з `include` — два етапи: фільтр і сортування над `eager` без join; ключі цілей кожного `include` дедупліковано, поділено на шматки ≤ 200 і завантажено підмножинами форми 1 колекції цілі з паралельністю `FULL_INCLUDE_PARALLEL = 4`; `refs` — пошук у колекції цілі за ключем. Причина: `fnWhere` компілятор застосовує після join (`query/compiler/index.ts`), тож лінива потреба цілі йшла б за всіма рядками `full`, а не лише за відфільтрованими | §6.2 `include` |
| Ф7 | Сортування `full` за типом: `String`/`Text` — `locale` без явної локалі (Рд29: різниця з колляцією бази у `window` прийнята); `Numeric` — `custom` числовий; `DateTime` — `lexical` (`normaliseDateTime` у `wire.ts` дає фіксовану ширину UTC з мікросекундами — умова в коментарі компаратора й у тесті); `UUID` — `lexical` (база віддає нижній регістр); `Date` — `lexical`; перерахування — `custom` за міткою значення (`label` з `enumValues` запису каталогу): колонка перерахування — `text` + `CHECK` з фізичними мітками (М15 [спеки П2](../specs/2026-09-28-p2-metamodel-compiler-design.md); мітки — `packages/simetra/src/compiler/runtime-catalog.ts`, `facts.enumValues`; `PgEnum` до каталогу рантайму не потрапляє), тож база сортує мітку колляцією, а рядок T4 несе логічне ім'я; мітки порівнюються тим самим правилом, що `String`; `Integer` (`number`) і `BigInt` (`bigint` після `decodeScalar`) — примітивне порівняння RC, без компаратора; реквізити, яких не сортує будівник (пара `Ref`, `Bytes`, `Json`, `Raw`, масив), — `command.invalid` в обох стратегіях (аудит, раунд 1). `nulls` з `orderBy` запиту має перевагу; без нього — як Postgres (`asc` → `last`, `desc` → `first`), бо типове RC — `first` | §6.1 «Порядок рядків» |
| Ф8 | Картка `full`: ключ у `base` — `writeUpdate` за правилом версії; відсутній — `writeInsert`; порожня відповідь — `row` `undefined` без `writeDelete` (інв. 9 — B3-3/B5) | немає |
| Ф9 | Перестворення без `strict` у B3-2b не чекає транзакцій і не переносить реєстру; точку `rebuildAsWindow` (задача 5) розширює B3-3 | немає |
| Ф10 | Видима підмножина — на яку підписаний хоч один хук; `needsRefresh` підмножини ТЧ картки під підписаним хуком — одразу `refresh()` | §6.2 «Свіжість ТЧ картки» |
| Ф11 | Сторінка вікна — `WINDOW_PAGE_SIZE = 100`; запас — одна сторінка з кожного боку. Межа пам'яті вікна: видимі сторінки + 2 сторінки запасу, тобто (видимих + 2) × 100 рядків шапки плюс лінива сторона їхніх `include` | немає |

## Review Focus

1. **`NULL` у колонці сортування на межі сторінки** — рядок не губиться й не
   дублюється між сторінками за `nulls` `first`/`last`, `asc`/`desc`;
   задачі 2 і 4.
2. **Нічия значень сортування через межу сторінки** — розв'язує ключ останнім;
   задача 4 (250 рядків з однаковим значенням, сторінки по 100).
3. **`full` рівно на межі** — 5 000 рядків з останньою повною сторінкою 200 —
   не перевищення (ще один запит дає 0); 5 001 — перевищення; задача 5.
4. **Порядок `full` проти `window` після `truncated`** — `NULL`, `Numeric`
   `"10"`/`"9"`, `DateTime`; той самий список у двох стратегіях — той самий
   порядок на ASCII-фікстурі; задачі 5 і 7.
5. **Розмонтування хука посеред читання сторінки й подвійний монтаж
   StrictMode** — пізня відповідь не відкриває підмножини, жодна підмножина не
   лишається відкритою; задача 7.

---

### Task 0: спека (у коміті плану)

**Files:** `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`.

- [x] Рішення з колонкою «Вплив на спеку»: §6.1 (опції `residency`,
  `fullLimit`, `strict`, `log`; «Порядок рядків» — Ф7), §6.2 (`include` над
  `full` — Ф6; «Свіжість ТЧ картки» — що таке «видима», Ф10), §6.4 (форма
  хуків Ф4, `setVisibleRange({ first, last })` Ф1, «Оновлення сторінки» —
  лише перебудова ланцюжка Ф2, примітка про бюджет фільтра Ф3), §12 рядок
  «unit T4 фасаду» — «оновлення сторінки перебудовує ланцюжок» замість
  «вставляє проміжну сторінку чи перебудовує ланцюжок» (Ф2), §13 рядок B3-2b —
  «оновлення сторінки перебудовою ланцюжка» (Ф2); §14.1 рядок «Число межі
  повної колекції» — закрито: 5 000, опція `fullLimit`.
- [x] Додаток А, рядок «платформна спека §8.1» (блок `B3`): колонка «Блок» —
  `B3-2b` (стратегії списку, сторінка вікна фасадом) і `B3-3` (write-back,
  рядок без власника).
- [x] `python3 scripts/check-doc-anchors.py`; коміт разом із планом:
  `docs(plan): план П4-B3-2b і форма API читання в спеці`.

### Task 1: опції рантайму й стратегія об'єкта

**Files:** Modify `packages/simetra/src/data/facade/runtime.ts`,
`packages/simetra/src/data/index.ts` (після B3-1); Create
`packages/simetra/src/data/facade/strategy.ts`; Test
`packages/simetra/src/data/facade/__tests__/strategy.test.ts`.

**Interfaces:**
- Consumes (після B3-1): `createDataRuntime`, `facadeOf(runtime)`,
  `DataError`; (після B3-2a) опція `collationLocale`.
- Produces: опції `createDataRuntime` — `residency?: Readonly<Record<string, "full" | "window">>`
  (ключ — логічне `"<kind>.<name>"`; `createDataRuntime` резолвить його
  каталогом і тримає UUID об'єкта), `fullLimit?: number` (ціле ≥ 1, типово
  `FULL_LIMIT_DEFAULT = 5_000`), `strict?: boolean` (типово `false`),
  `log?: (entry: DataLogEntry) => void` (типово `console.warn`);
  `export type DataLogEntry = { kind: "full-truncated"; object: MetadataRef; limit: number }`
  (B3-3 додає свої види).
- `strategyOf(runtime, object: MetadataRef): { strategy: "full" | "window"; truncated: boolean }`;
  `onStrategyChange(runtime, object, listener: () => void): () => void`;
  `markTruncated(runtime, object): void` — `window` + `truncated: true`,
  сповіщає слухачів один раз.
- Реєстр відкритих хендлів — з B3-2a (`trackHandle`, задача 8 B3-2a:
  `dispose()` закриває кожен хендл, потім `cleanup({ dependents: true })`
  кожної колекції). B3-2b розширює його: хендли задач 3–7 (`openPage`,
  `openWindow`, `openFullList`, `openList`) реєструються так само, а хендл
  хука має ще `disposed()` — знімок стає порожнім (`status: "loading"`), щоб
  хук не показав рядків після `dispose()`. Кожна асинхронна гілка фасаду
  B3-2b (`readPage`, `fullQueryFn`, шматки `include` над `full`, картка
  `full`, `readCount`, `rebuildAsWindow`) після кожного `await` перевіряє
  `runtime.disposed` і нічого не реєструє, не відкриває й не пише: охорона
  «відповідь після `dispose()` ігнорується» є лише в обгортці транспорту
  B3-1, а адаптер-перевизначення застосунку (`selectSource({ override })`)
  її обходить. Після B3-2a звірити ім'я реєстру
  в `main`.
- `dispose()` прибирає слухачів стратегії; нові структури задач 3–6
  (`pendingPages`, шматки `include` над `full`, single-flight лічильника)
  реєструють прибирання в тому самому `dispose()` (тест у задачах 3 і 5:
  після `dispose()` структури порожні).

- [ ] **Step 1: Failing tests:** типова стратегія — `window`, `truncated`
  false; `residency` `full` для одного об'єкта — лише для нього; ключ
  `residency` поза каталогом і `fullLimit` 0 чи дробовий — `TypeError` у
  `createDataRuntime`; `markTruncated` — стратегія `window`, `truncated`
  true, слухач викликано один раз, повторний виклик слухача не кличе;
  відписка працює; `dispose()` із зареєстрованим хендлом, що тримає живий
  запит над колекцією, — `disposed()` хендла викликано, колекція в стані
  `cleaned-up` і має `size` 0; адаптер-перевизначення з затримкою і
  `dispose()` у польоті для `openWindow`, `include` над `full` і картки
  `full` — після відповіді `pendingPages` порожній, нових підмножин немає,
  `size` 0.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test strategy`).
- [ ] **Step 5: Commit** — `feat(data): стратегія читання об'єкта й опції full`.

### Task 2: keyset — порядок і умова «після»

**Files:** Create `packages/simetra/src/data/facade/keyset.ts`; Test
`packages/simetra/src/data/facade/__tests__/keyset.test.ts`.

**Interfaces:**
- `type OrderTerm = { attribute: string; direction: "asc" | "desc"; nulls: "first" | "last" }`;
  `type Tuple = readonly unknown[]` (значення термів у логічній формі, ключ
  останнім).
- `normalizeOrder(entry: CatalogEntry, orderBy: OrderBy | undefined): OrderTerm[]`
  — явні `nulls` за правилом Postgres (`asc` → `last`, `desc` → `first`),
  ключ останнім (`asc`), якщо його немає; ключ не останнім — `DataError`
  `data.unsupported-predicate`. Реквізит, якого не сортує будівник
  (`sortable` у `server/read.ts`: масив, пара `Ref`, `Json`, `Bytes`,
  `Raw`), — `CommandFailure` `command.invalid` з `path`
  `orderBy.<i>.attribute`, той самий, що дав би сервер; лінивий реквізит —
  `command.invalid` з `reason: "lazy"`, як у будівника; так і для `full`,
  щоб `truncated` не змінив прийнятності сортування.
- `reverseOrder(order): OrderTerm[]` — обернені `direction` і `nulls`.
- `tupleOf(order, row: LogicalRow): Tuple`.
- `keysetFilter(entry, order, tuple, inclusive: boolean): Filter` — рядки
  строго після кортежу (чи після-або-рівні) у порядку `order`.
- `pageQuery(entry, { object, where?, order, after?: { tuple; inclusive }, limit }): ReadQuery`
  — `and(where, keyset)`; результат перевірено `readQuerySchema` (запобіжник);
  відмова — `CommandFailure` `command.invalid` з `path` першої помилки.
- `pageQuery` розгортає `where`, що вже є `and`, в один `and` з keyset-умовою:
  інакше обгортка додала б рівень глибини.
- `checkWindowBudget(entry, where: Filter | undefined, order): void` (Ф3) —
  будує `pageQuery` з найбільшою keyset-умовою і перевіряє `readQuerySchema`;
  понад межу — `CommandFailure` `command.invalid` з `path`. Найбільша умова —
  максимум за обома напрямками (`order` і `reverseOrder(order)`: `loadBefore`
  і `goToEnd` читають оберненим) і `inclusive`; для кожного необов'язкового
  терму береться більша з гілок — `null` (`not(isNull)`, 2 вузли за `first`)
  чи не-`null` (`or(gt|lt, isNull)`, 3 вузли за `last`). Рахувати перебором
  кортежів «кожен необов'язковий терм — `null` чи значення» тією самою
  `pageQuery` (≤ 2⁴ кортежі на напрям), а не окремою формулою.

Алгоритм `keysetFilter` (не визначений сигнатурою): `or` за `k = 1..n`
кон'юнкцій «перші `k−1` термів рівні» і «`k`-й строго після»; для
`inclusive` — ще одна кон'юнкція «усі `n` рівні». Рівність з `null` —
`isNull`; «строго після» значення `v` терму:

| `v` | `nulls` | після `v` |
| --- | --- | --- |
| `null` | `last` | нічого — кон'юнкцію пропустити |
| `null` | `first` | `not(isNull)` |
| не `null` | `last` | `or(gt\|lt v, isNull)` (`gt` для `asc`, `lt` для `desc`) |
| не `null` | `first` | `gt\|lt v` |

Реквізит, обов'язковий за каталогом, і ключ `isNull`-гілок не отримують.

- [ ] **Step 1: Failing tests (unit, таблиця):** для фікстури з 12 рядків,
  де є `NULL`, нічиї, кирилиця й перерахування, і кожного з порядків (`asc`/`desc` ×
  `first`/`last`, два терми + ключ) множина рядків, які обчислювач B3-2a
  (`createFilterEvaluator("en-US")`) пропускає за `keysetFilter(tupleOf(r))`,
  дорівнює рядкам після `r` у порядку, що дає та сама фікстура, відсортована
  еталонним компаратором тесту (кожен `r`, `inclusive` true/false);
  `normalizeOrder` без `nulls` дає Postgres-типові, явні `nulls` запиту
  лишаються; ключ не останнім — `DataError`; сортування за парою `Ref` чи
  `Bytes` — `command.invalid` з `path` `orderBy.0.attribute` (таблиця
  `sortable` будівника); `checkWindowBudget` з фільтром на 40 вузлів і 4
  необов'язковими термами — `command.invalid`; той самий фільтр з одним
  термом — проходить; фільтр, який `checkWindowBudget` пропустив, проходить
  `pageQuery` з будь-яким кортежем фікстури в обох напрямках (таблиця);
  `where` глибини 8 з `and` угорі проходить (розгортається), глибини 8 з
  `or` чи `not` угорі — ні (обгортка дає 9), глибини 9 — ні.
- [ ] **Step 2: DB-кейс** (причина DB: колляція й порядок `NULL` дає
  Postgres): у `packages/designer/src/__tests__/read-query.db.test.ts` (поруч
  із кейсом еквівалентності B3-2a) — фікстура ≤ 200 рядків з `NULL`,
  нічиями й реквізитом-перерахуванням (мітки в порядку, відмінному від
  імен; порядок із перерахуванням у першому термі серед порядків кроку 1;
  еквівалентність обчислювача й будівника для `gt` за перерахуванням); для кожного порядку з кроку 1 обхід сторінками по 7 через
  `runtime.read(pageQuery(…))` дає ту саму послідовність id, що одне читання
  `limit` 200 з тим самим `orderBy`, і так само в оберненому порядку
  (`reverseOrder`). `pageQuery`, `normalizeOrder`, `reverseOrder` designer
  бере через `packages/simetra/test/support.ts` (як `createFilterEvaluator`
  у B3-2a), публічного експорту немає.
- [ ] **Step 3–4:** implement → green (`pnpm --filter simetra test keyset`,
  `pnpm --filter @simetrajs/designer test:db read-query`).
- [ ] **Step 5: Commit** — `feat(data): keyset повним кортежем сортування`.

### Task 3: сторінка — читання фасадом і форма підмножини 2

**Files:** Create `packages/simetra/src/data/facade/page.ts`; Modify
`packages/simetra/src/data/facade/subsets.ts`,
`packages/simetra/src/data/facade/__tests__/fake-transport.ts` (після
B3-2a); Test `page.test.ts`.

**Interfaces:**
- Consumes (після B3-2a): `subsetFormOf`, `readSubset`, `keepNewer`,
  `liveRows(runtime, { object, keys, include? })`; адаптер — джерело
  рантайму (`selectSource`, B3-1).
- `readPage(runtime, entry, query: ReadQuery): Promise<{ keys: string[]; first?: Tuple; last?: Tuple; more: boolean; full: boolean }>`
  — запит через адаптер (`readQueryToWire` → `source.read` →
  `readResultFromWire`); `full` = `rows.length === limit`; рядки сторінки
  реєструє як очікувані за набором ключів (`pendingPages`, мапа «відсортований
  набір ключів → рядки»), бо `meta` живого запиту — рівня колекції.
- Форма 2 — це форма 1 (`{ kind: "keys" }`) для `queryKey`, `loadSubset` і
  `unloadSubset`: ключ запиту будується лише з набору ключів, однаково
  (`qdc/query.ts` будує ключ з опцій і при завантаженні, і при
  вивантаженні). Сторінка відрізняється лише всередині `queryFn`: якщо набір
  є в `pendingPages`, `queryFn` віддає зареєстровані рядки (через
  `keepNewer`) без запиту й знімає реєстрацію; інакше — перечитування за
  ключами. `subsetFormOf` B3-2a лишається чистою функцією без рантайму.
- Порожню сторінку (0 рядків) підмножиною не відкривати: `in` вимагає 1…200
  значень.
- Хендли B3-2a (`LiveHandle` з `liveRows`, `CardHandle`, `SectionHandle`)
  отримують `subscribe(listener: () => void): () => void` — над
  `subscribeChanges`, `on("status:change")` і `on("health:change")` **живого
  запиту** (не базової колекції: прямої підписки на базову колекцію B3-2b не
  відкриває; підписки хендла знімає його `close()`) (перехід у `ready` без рядків і `error` подій змін не дають,
  `live-query-observer.ts`); знімок (`rows()`, `row()`) незмінний за
  посиланням між подіями (потреба `useSyncExternalStore`, задача 7). Files:
  Modify `facade/live.ts`, `facade/card.ts`, `facade/sections.ts` (після
  B3-2a).
- `openPage(runtime, object, page, include?): LiveHandle` — `liveRows` з
  ключами сторінки. Якщо набір уже має власника (інша сторінка того самого
  набору, другий хук на той самий список), бібліотека лише збільшує лічильник
  і `queryFn` не кличе (`qdc/query.ts`): після готовності живого запиту
  реєстрація, яку не забрав `queryFn`, означає саме це, і `openPage` робить
  `loadSubset` цієї форми з `refetch: true` (Р7 B3-2a) — `queryFn` забирає
  реєстрацію; цей виклик збільшує лічильник посилань (`qdc/query.ts`), тож
  після його завершення (успіх чи відмова) — `unloadSubset` тим самим об'єктом
  опцій; власність живого запиту лишається. `close()` знімає незабрану реєстрацію.
- Фейковий транспорт: списочна форма з `where` і `orderBy`
  (`readQueryFromWire` + обчислювач B3-2a + еталонний компаратор з
  `nulls`), бюджет у рядках для `more: true`, журнал запитів.

- [ ] **Step 1: Failing tests:** `readPage` — запит містить `orderBy` з
  явними `nulls` і ключем останнім, `limit` 100, keyset у `where`; підмножина
  сторінки в журналі `loadSubset` — `in` ключів без `orderBy`, `limit`,
  `offset`, `cursor`; перший `queryFn` сторінки не дає запиту транспорту
  (рядки з реєстрації), рефетч тієї самої підмножини — один запит форми 1;
  зареєстрований рядок v4 при v5 у колекції — у колекції v5; `close()` до
  `queryFn` — реєстрації немає; `more: true` при бюджеті 30 рядків — сторінка
  з 30 ключами, `full` false; перший рядок понад бюджет — відхилення
  `response-too-large`, повтору немає; шпигуни на `setWindow` живого запиту й `requestLimitedSnapshot` підписки
  колекції (`collection/subscription.ts`) — не викликано.
  `subscribe` хендла: подія після застосування рядків, `rows()` між подіями
  повертає той самий масив, після події — новий; порожня підмножина дає
  подію переходу в `ready`; `open → refetch → close` сторінки — кеш
  `QueryClient` порожній і колекція порожня (один ключ запиту); друга
  сторінка з тим самим набором і зміненим полем рядка на сервері — у
  колекції нове значення, реєстрації не лишилося; набір понад 200 ключів —
  `data.unbounded-subset`.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test page`).
- [ ] **Step 5: Commit** — `feat(data): сторінка вікна як підмножина ключів`.

### Task 4: вікно — ланцюжок сторінок

**Files:** Create `packages/simetra/src/data/facade/window.ts`; Test
`window.test.ts`.

**Interfaces:**
- `openWindow(runtime, { object, where?, orderBy?, include? }): WindowHandle`
  — спершу `checkWindowBudget` (Ф3): відмова дає хендл зі `status` `error` і
  жодного запиту;
  — `{ rows(): Array<Row & { refs? }>; atStart; atEnd; status; error?; loadBefore(): Promise<void>; loadAfter(): Promise<void>; goTo(value: unknown): Promise<void>; goToStart(): Promise<void>; goToEnd(): Promise<void>; setVisibleRange(range: { first: string; last: string }): void; refreshFrom(pageIndex: number): Promise<void>; subscribe(listener): () => void; close(): void }`.
- Сторінка: `{ keys; first: Tuple; last: Tuple; lower?: { tuple: Tuple; inclusive: boolean } | { goTo: unknown }; live: LiveHandle }`
  — `first`/`last` і `lower` завжди в прямому порядку (сторінку, прочитану
  оберненим, переводять у прямий при вставці); `lower` — нижня межа, з якої
  сторінку прочитано: `last` попередньої (`{ tuple, inclusive: false }`), для
  першої сторінки після `goTo` — `{ goTo: value }`, на початку списку —
  немає.
  `rows()` — для кожної сторінки ключі в серверному порядку, значення — рядок
  колекції за ключем (відсутній ключ пропущено); ключ, що є в кількох
  сторінках (рядок змінив поле сортування й потрапив у перечитаний хвіст
  `refreshFrom`), показано один раз — у сторінці, прочитаній пізніше; снапшот
  незмінний між подіями.
- `loadAfter` — `after = { last останньої сторінки, inclusive: false }`;
  `loadBefore` — `reverseOrder` від `first` першої сторінки, ключі
  обернено; `atEnd`/`atStart` — сторінка без `more` і з меншою за `limit`
  кількістю рядків у тому напрямку; на краю метод — без запиту.
- `goToStart()` — вікно скинуто, перша сторінка без keyset, `atStart` true;
  `goToEnd()` — обернений порядок, `atEnd` true; `goTo(value)` —
  `keysetFilter` однотермового порядку першого терму з `inclusive` (так
  `NULL` за `nulls: "last"` лишаються після значення), `atStart` false.
- `setVisibleRange` — тримає сторінки з `first`…`last` плюс одну з кожного
  боку (Ф11); сторінки поза ними `close()`; видима крайня сторінка без
  сусіда — `loadBefore`/`loadAfter` (single-flight на напрям). Ключ поза
  вікном — виклик ігнорується. Без жодного `setVisibleRange` видимою
  вважається остання завантажена сторінка (після `loadBefore` — перша):
  межа Ф11 діє й без віртуалізації.
- `refreshFrom(i)` (Ф2, single-flight з хвостом) — від `lower` сторінки `i`
  (для `i = 0` без `atStart` і без `lower` — `{ first сторінки 0, inclusive:
  true }`; з `atStart` — початок списку) читає стільки сторінок, скільки було від `i` до
  кінця, чи до кінця списку; нові сторінки відкриває, старі закриває після
  відкриття нових (рядок, що лишився, не мерехтить).
- Курсор: запит з тим самим `after`, що попередній запит того самого напрямку,
  не надсилається.
- Покоління вікна: лічильник, який збільшують `goTo`, `goToStart`,
  `goToEnd`, `refreshFrom`, `close()` і `disposed()`; кожне читання сторінки запам'ятовує
  покоління на старті, і відповідь старого покоління не вставляє сторінки й
  не відкриває підмножини, а знімає свою реєстрацію в `pendingPages`.
- `refreshFrom(0)` для сторінки з `lower` `{ goTo }` повторює умову `goTo`.
- Поки активний `refreshFrom`, `loadBefore`/`loadAfter` (зокрема з
  `setVisibleRange`) чекають його завершення й стартують від нового
  ланцюжка: інакше дописана сторінка дала б дубль чи пропуск.

- [ ] **Step 1: Failing tests** (фейк, 250 рядків, частина з `NULL` у
  першому терміні й 30 з однаковим значенням):
  - `loadAfter` до кінця — послідовність id = одне еталонне сортування, без
    повторів і пропусків (Review Focus 1, 2); на `atEnd` — нуль запитів;
  - `more: true` (бюджет 30) — сторінки по 30, ланцюжок продовжено від
    останнього рядка короткої сторінки, у журналі немає двох запитів з тим
    самим `after`;
  - `goToEnd` → `loadBefore` до початку — та сама послідовність;
    `goTo(значення)` — перший рядок ≥ значення, рядки з `NULL` першого
    терму (`nulls: "last"`) досяжні `loadAfter`, `atEnd` не раніше них;
    `goToEnd` → `refreshFrom(0)` — сторінки ті самі, читання не почалося з
    початку списку;
    `refreshFrom` при сторінках з `more: true` — ланцюжок без пропусків;
  - `setVisibleRange` по 20 сторінках прокрутки — `collection.size` ≤ 3 ×
    100 + рядки інших підмножин; 20 викликів `loadAfter` без
    `setVisibleRange` — так само; рядок, який тримає відкрита картка, після
    вивантаження сторінки лишається;
  - зміна значення сортування рядка в колекції (прямий запис фейку + рефетч
    форми 1) — рядок на тій самій позиції до `refreshFrom`, після — на
    новій; рядок, вставлений у джерело між двома сторінками, після
    `refreshFrom(0)` присутній рівно один раз, жоден рядок не загублено;
    рядок сторінки 0 змінив поле сортування так, що потрапляє в сторінку 2,
    і `refreshFrom(1)` — ключ у `rows()` один раз, на новій позиції;
  - `refreshFrom` двічі під час активного — один хвостовий запит ланцюжка;
  - `close()` — усі підмножини сторінок закрито, рядків вікна в колекції
    немає;
  - фільтр понад бюджет разом із keyset — `status` `error`, `command.invalid`,
    журнал транспорту порожній (Ф3);
  - гонка: `loadAfter` у польоті, потім `goToStart` — пізня відповідь
    `loadAfter` не додає сторінки, підмножини не відкриває, реєстрація
    знята; те саме для `refreshFrom` і `goTo`; `goTo` → `refreshFrom(0)` —
    перша сторінка та сама; `loadAfter` під час `refreshFrom` — послідовність
    id без дублів і пропусків.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test window`).
- [ ] **Step 5: Commit** — `feat(data): вікно сторінок з keyset і вивантаженням`.

### Task 5: `full` — `eager`, межа, перестворення, картка

**Files:** Create `packages/simetra/src/data/facade/full.ts`; Modify
`packages/simetra/src/data/facade/collections.ts`,
`packages/simetra/src/data/facade/card.ts` (після B3-2a); Test `full.test.ts`.

**Interfaces:**
- `collectionsOf(runtime).objectCollection(object)` для стратегії `full` —
  `syncMode: "eager"` з `fullQueryFn`; для `window` — як у B3-2a.
- `fullQueryFn` — сторінки по 200 за ключем (`orderBy` ключ `asc`, keyset
  `gt` ключа останнього рядка) через адаптер; зупинка — лише сторінка без
  `more` і з меншою за 200 кількістю; сума понад `fullLimit` — далі не читає:
  `strict` — відхилення `DataError` `data.full-too-large`; без `strict` —
  `log({ kind: "full-truncated", object, limit })`, відхилення внутрішньою
  помилкою, яку хендли не показують, і `rebuildAsWindow` окремою задачею
  (`queueMicrotask`) без очікування: `queryFn` не чекає `cleanup()` власної
  колекції. Результат —
  через `keepNewer`.
- `queryKey` колекції `full` — `[...префікс рантайму, "full", <UUID>]`: він не
  має префіксом базу on-demand колекції того самого об'єкта
  (`[..., "object", <UUID>]`), бо on-demand колекція відстежує й латає всі
  запити зі своїм префіксом (`qdc/query.ts`), а під час перестворення обидві
  колекції живі.
- `rebuildAsWindow(runtime, object): Promise<void>` (Ф9; точка розширення
  B3-3: очікування осідання транзакцій і перенесення реєстру власних
  створень і незавершених write-back стають перед кроком 3) — порядок:
  1) прибрати `eager` з кешу колекцій рантайму; 2) `markTruncated` — хендли
  об'єкта (`onStrategyChange`) закривають свої живі запити над `eager` і
  відкриваються на `on-demand`; 3) `await cleanup({ dependents: true })` колекції `eager`:
  звичайний `cleanup()` відхиляє з `CollectionHasSubscribersError`, якщо
  якийсь залежний живий запит лишився (`collection/index.ts`), і колекція з
  рядками до `fullLimit` повисла б поза кешем рантайму; `cleanup` `eager`
  сам прибирає свої запити з кешу `QueryClient`. Після `dispose()` —
  нічого не робить.
- `applyFullRows(runtime, object, rows: Row[]): Promise<void>` — єдина
  обгортка прямих записів у колекцію `full`: ключ у `collection.base` —
  `writeUpdate`, якщо версія ≥ найбільшої баченої (мапа B3-2a); відсутній —
  `writeInsert` (Ф8); мапу версій оновлює. `write*` перевіряє прийняті записи
  черги, яких `base` не бачить, і відмовляє відхиленням: проміс чекати;
  `DuplicateKeySyncError` — `writeUpdate` за правилом версії,
  `*ItemNotFoundError` — проковтнути (рядок прибрала повна вибірка).
  `SyncNotInitializedError` (кидається синхронно, коли колекції вже немає:
  вікно перестворення чи `dispose()`) і `SyncTransactionAbortedError` —
  проковтнути як «колекція вже не поточна»: виклик і `await` — в одному
  `try`; помилки розпізнавати через `instanceof` (у
  `SyncTransactionAbortedError` поле `name` — `"AbortError"`, `db/errors.ts`). Інші відхилення не виходять з обгортки (журнал `log`).
- `openFullList(runtime, { object, where?, orderBy?, include? }): ListHandle`
  — живий запит над `eager`: `fn.where(r => evaluator.matches(entry, r, where))`
  (без `where` — без `fnWhere`), `orderBy` за `normalizeOrder` з
  `compareOptions` за типом (Ф7; перерахування — `custom`: логічне ім'я →
  мітка з `enumValues`, порівняння міток як `String`, бо колонка — `text` +
  `CHECK` з мітками (М15); `Numeric` — точне порівняння десяткового
  рядка (знак, довжина цілої частини, цифри; без `Number()`, що губить
  точність понад 15–17 значущих цифр), `-Infinity` < числа < `Infinity` <
  `NaN`, як Postgres: декодер пропускає будь-який рядок `Numeric` прийнятої
  таблиці), без
  `limit` і join. `include` (Ф6): ключі цілей кожного реквізиту з рядків
  результату дедупліковано й відсортовано, поділено на шматки ≤ 200, кожен
  шматок — підмножина форми 1 колекції цілі (`liveRows` цілі з цими ключами),
  не більше `FULL_INCLUDE_PARALLEL = 4` завантажень одночасно; зміна набору
  відкриває лише нові шматки й закриває зниклі; ціль `full` — ті самі шматки
  `liveRows` (над `eager` вони запитів не дають), тож зміна рядка цілі
  доходить до `refs` подією живого запиту, без прямої підписки на базову
  колекцію; `refs` — рядок колекції цілі за ключем чи `null`; перехід цілі в
  `truncated` (`onStrategyChange` цілі) перевідкриває шматки на новій
  колекції. Методи вікна — без запиту, `atStart`/`atEnd` true.
- `openList(runtime, input): ListHandle` — єдиний хендл списку для хука:
  `ListHandle` = `WindowHandle` задачі 4 плюс `strategy`, `truncated`; за
  `strategyOf` відкриває `openWindow` чи `openFullList`, на
  `onStrategyChange` перевідкриває внутрішній список, зберігаючи себе й
  підписників. Так само `openCard` перевідкриває шапку картки об'єкта, що
  став `truncated` (підмножина `eq(<ключ>)` on-demand).
- Обчислювач фільтра B3-2a (Modify `packages/simetra/src/data/filter.ts`,
  після B3-2a): `lt`/`lte`/`gt`/`gte` над перерахуванням порівнюють **мітки**
  з `enumValues` колатором обчислювача (колляція бази), як сервер
  (`model/runtime/values.ts` підставляє мітку); `eq`/`ne`/`in` — за логічним
  ім'ям (ім'я ↔ мітка — бієкція). Інакше `where` над `full` дав би іншу
  множину, ніж `window`, а фейковий транспорт — keyset, неузгоджений із
  сортуванням.
- `openCard` для `full` — шапка формою картки власним викликом
  (`readSubset` форми `card`) і `applyFullRows`; ТЧ — `openOwnerSection` як у
  B3-2a; порожня відповідь — `row()` `undefined`.

- [ ] **Step 1: Failing tests:**
  - `queryFn` колекції `full` викликано один раз з порожніми опціями; запити
    сторінок — `limit` 200, keyset за ключем; живі запити з `where`,
    `orderBy` — нуль нових запитів;
  - правило зупинки: 400 рядків (дві повні сторінки) — третій запит дає 0 і
    вибірка завершена; сторінка з `more: true` (бюджет 50) — вибірку
    продовжено;
  - межа (Review Focus 3, `fullLimit` 400 у тесті): 400 рядків — без
    перевищення; 401 — `strict`: відхилення `data.full-too-large`, у хендлі
    `status` `error` і `error` — ця `DataError`; без `strict`: `log` один раз
    з `{ kind: "full-truncated", limit: 400 }`, `strategyOf` — `window` і
    `truncated`, хендл списку дає ті самі перші 100 рядків з вікна,
    запитів понад `fullLimit + 200` рядків немає;
  - фільтр: `where` з `contains` і `lt` за рядком — множина = обчислювач;
    `gt` за перерахуванням — за мітками (мітки в порядку, відмінному від
    імен);
    IR живого запиту `full` має `fnWhere` і не має `join`; IR вікна й
    картки `on-demand` не має `fnWhere`;
  - сортування (Review Focus 4): `Numeric` `"10"` після `"9"` (`asc`), `NULL`
    останнім для `asc` і першим для `desc`, явне `nulls: "first"` для `asc`
    — першим; `DateTime` у нормалізованій формі `wire.ts` хронологічно;
    `BigInt` `2^53+1` після `2^53`; перерахування, де порядок міток
    відрізняється від порядку логічних імен і від порядку оголошення, — за
    мітками; `Numeric` `"NaN"` після `"Infinity"`, а та — після всіх чисел;
    два 20-значні `Numeric`, що різняться останньою цифрою, — не нічия — порядок `full` =
    порядок вікна над тим самим фейком (ASCII-фікстура);
  - `include` над 900 рядками `full` з 450 різними цілями `on-demand` (кожна
    ціль у двох рядках) — у журналі цілей лише `in` по ≤ 200, кожен ключ
    цілі запитано один раз, одночасно не більше 4 запитів (фейк з
    керованим порядком відповідей), `refs` у кожному рядку;
  - `applyFullRows`: присутній ключ — `writeUpdate`, менша версія не пише;
    відсутній — `writeInsert` і рядок видно в живому запиті; наступна повна
    вибірка без цього рядка прибирає його; результат `fullQueryFn` v4 після
    `applyFullRows` v5 — у колекції v5;
  - картка `full`: запит форми картки, ліниве поле з'явилося в рядку
    колекції, рядок списку той самий об'єкт за ключем; ключ поза колекцією —
    вставлено; порожня відповідь — `row()` `undefined`, рядок колекції не
    видалено;
  - перестворення: живий список і картка над `full` → перевищення без
    `strict` → кінцевий стан: обидва хендли працюють на `on-demand`, стара
    колекція в стані `cleaned-up`, запису з ключем `full` у кеші
    `QueryClient` немає (проміжного статусу `error` колекції `eager` тест не
    вимагає: мікрозадача перестворення зазвичай випереджає сповіщення
    Query); `dispose()` під час вибірки `full` — після відповіді нічого не
    записано й `rebuildAsWindow` не викликано;
  - ізоляція: два рантайми з `residency` `full` і `keyPrefix: []` (B3-2a) —
    рядки одного не видно в іншому.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test full`).
- [ ] **Step 5: Commit** — `feat(data): колекція full з межею і перестворенням як window`.

### Task 6: лінивий `count`

**Files:** Create `packages/simetra/src/data/facade/count.ts`; Test `count.test.ts`.

**Interfaces:** `readCount(runtime, { object, where? }): Promise<{ count: number; capped: boolean }>`
— `{ object, where, count: true }` через **обгортку** транспорту рантайму
B3-1 (вона додає `subject`, межу тіла, `session-changed` і відмову після
`dispose()`), не через адаптер (§5.1) і ніколи через сирий
`options.transport`. Після B3-1 звірити, як фасад дістає обгортку
(`facadeOf(runtime)`); якщо її там немає — додати в `facadeOf` саме обгортку.
Single-flight на (об'єкт, `where`).

- [ ] **Step 1: Failing tests:** запит лише на виклик (відкриття вікна
  `count` не читає); `{ count: 10000, capped: true }` → `capped` true; два
  виклики під час активного — один запит і один хвостовий; `readCount` після
  `dispose()` — відхилення без виклику транспорту; запит несе `subject`.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test count`).
- [ ] **Step 5: Commit** — `feat(data): лінивий лічильник списку`.

### Task 7: публічний API — `useRows`, `useRow`

**Files:** Create `packages/simetra/src/data/hooks.ts`; Modify
`packages/simetra/src/data/index.ts`, `packages/simetra/package.json`
(devDependencies), `.syncpackrc.json` (якщо група версій B3-1 цього
потребує); Test `packages/simetra/src/data/__tests__/hooks.test.ts`.

**Interfaces:**
- `export function DataRuntimeProvider(props: { runtime: DataRuntime; children?: ReactNode }): ReactElement`.
- `export function useRows(input: { object: MetadataRef; where?: Filter; orderBy?: OrderBy; include?: string[]; count?: true }): RowsResult`;
  `RowsResult = { rows: ReadonlyArray<LogicalRow & { refs?: Record<string, LogicalRow | null> }>; status: "loading" | "ready" | "error"; health: DataHealth; error?: unknown; strategy: "full" | "window"; truncated: boolean; count?: { count: number; capped: boolean }; atStart: boolean; atEnd: boolean; setVisibleRange(range: { first: string; last: string }): void; loadBefore(): Promise<void>; loadAfter(): Promise<void>; goTo(value: unknown): Promise<void>; goToStart(): Promise<void>; goToEnd(): Promise<void> }`.
- `export function useRow(input: { object: MetadataRef; id: string; tabularSections?: true | string[] }): RowResult`;
  `RowResult = { row?: LogicalRow; tabularSections: Record<string, readonly LogicalRow[]>; version?: number; editable: boolean; status; health; error? }`;
  `editable` — `false`, якщо версія шапки ≠ `ownerVersion` будь-якої
  підмножини ТЧ картки чи будь-яка підмножина картки має `needsRefresh`;
  інакше `true` (§6.4).
- Хендл (`openList`, `openCard`) відкривається в ефекті з залежностями
  «рантайм з провайдера + стабільний ключ входу» (`JSON.stringify` з
  `bigint` як рядком), закривається в очищенні: новий рантайм у провайдері
  (зміна користувача) закриває хендл старого. `dispose()` рантайму сповіщає
  відкриті хендли, і їхній знімок — порожні рядки з `status: "loading"`:
  рядки попереднього користувача на екрані не лишаються. `getSnapshot`
  повертає порожній знімок `loading`, коли рантайм хендла ≠ рантайму з
  контексту: рендер з новим рантаймом іде до очищення ефекту, і без цього
  кадр показав би рядки старого. Так само порожній знімок `loading`, коли
  ключ входу хендла ≠ ключу поточного входу хука (зміна `where`, `orderBy`,
  `object`, `id` у тому самому рантаймі): до відкриття нового хендла рядки
  старого фільтра не показуються.
- Валідація входу — під час рендеру, однаково для обох стратегій: об'єкт у
  каталозі, `filterSchema` і підтримка вузлів обчислювачем (`DataError`
  `data.unsupported-predicate`), `normalizeOrder` і `checkWindowBudget` —
  для обох стратегій, бо `truncated` не має міняти прийнятності запиту;
  синхронна `DataError`
  кидається з рендеру, `command.invalid` сортування — `status: "error"`. стан —
  `useSyncExternalStore` (серверний снапшот — `status: "loading"`, рядки
  порожні). Ф10: `needsRefresh` підмножини ТЧ під хуком — `refresh()`.
- Немає полів `hasNewRows`, `showNew`, `isStale`.
- devDependencies (точні, звірити `npm view` перед стартом і правило «не
  молодше двох тижнів»): `jsdom` 31.0.0, `@testing-library/react` 16.3.3,
  `@testing-library/dom` 10.4.2, `react-dom` 19.3.1, `@types/react` 19.3.0,
  `@types/react-dom` 19.3.0.

- [ ] **Step 1: Failing tests** (jsdom, фейковий транспорт, `renderHook` з
  обгорткою `DataRuntimeProvider`):
  - `useRows` з фільтром T0 за логічними іменами — рядки декодовані, ключі
    результату — лише перелічені в `RowsResult` (немає `hasNewRows`,
    `showNew`, `isStale`);
  - `loadAfter` і `setVisibleRange` міняють `rows`; `strategy`/`truncated` —
    `window`/`false`, для `residency` `full` — `full`/`false`, після
    перевищення без `strict` — `window`/`true` без перемонтування;
  - `count: true` — `count` з'являється; без нього запиту лічильника немає;
  - `refs` з `include`;
  - `useRow` — `row`, `tabularSections`, `version`, `editable` true; версія
    шапки росте → `editable` false до перезапиту ТЧ, потім true (Ф10);
  - відповідь `command.invalid` — `status` `error`, `error` — `CommandFailure`;
    фільтр з невідомим вузлом над `full` — `DataError` кинуто під час
    рендеру (error boundary тесту);
  - Review Focus 5: розмонтування до відповіді сторінки — після відповіді
    живих запитів фасаду немає (`collection.size` 0, журнал `loadSubset`
    без відкриття); `StrictMode` — після стабілізації одна відкрита
    підмножина на сторінку;
  - хук без провайдера — `Error`;
  - заміна рантайму в провайдері — хендл старого закрито, рядки старого
    рантайму не з'являються в **жодному** рендері (тест пише кожен рендер,
    а не лише `result.current`); `dispose()` рантайму зі змонтованими
    `useRows` (`window` і `full`) і `useRow` — `rows` порожні, кожна
    колекція в стані `cleaned-up` і має `size` 0;
  - `health` є в результаті обох хуків і змінюється за збою колекції;
  - зміна `where` у тому самому рантаймі — жоден проміжний рендер не має
    рядків старого фільтра (тест пише кожен рендер);
  - `include` з ціллю `full`: зміна рядка цілі (`applyFullRows`) — `refs`
    оновлено;
  - порожній список — `status` `ready`, а не вічне `loading`.
- [ ] **Step 2–4:** red → implement → green (`pnpm --filter simetra test hooks`).
- [ ] **Step 5:** `index.ts` експортує `DataRuntimeProvider`, `useRows`,
  `useRow`, типи `RowsResult`, `RowResult`, `DataLogEntry`; тест `.d.ts`
  B3-1 зелений (`pnpm build:packages && pnpm test:packaging`).
- [ ] **Step 6: Commit** — `feat(data): useRows і useRow над фасадом`.

### Task 8: мутації, документація й гейти

- [ ] **Step 1: Mutation check (обов'язковий, без коміту; кожна червоніє):**
  `setWindow` чи `limit` у живому запиті вікна (задачі 3, 4); сортувати рядки
  вікна на клієнті (задача 4 — позиція зміненого рядка); повторити keyset-запит
  без просування курсора (задача 4); `queryFn` сторінки без реєстрації —
  запит транспорту (задача 3); прибрати `isNull`-гілку в `keysetFilter`
  (задача 2, Review Focus 1); зупиняти вибірку `full` на сторінці з `more`
  (задача 5); `>=` замість `>` у межі `full` (задача 5, Review Focus 3);
  `fnWhere` у живому запиті вікна (задача 5, IR); `nulls` типові RC у
  `full` (задача 5, Review Focus 4); не дедуплікувати ключі цілей `include`
  над `full` (задача 5); читання сторінки без `limit` (задача 3, §12
  «виконати `queryFn` у `window` без `limit`»); `dispose()` без
  `cleanup({ dependents: true })` (задача 1 — колекція не `cleaned-up`);
  завантаження за курсором RC
  (`requestLimitedSnapshot`) у вікні (задача 3); ключ запиту сторінки з
  власною формою замість форми 1 (задача 3 — кеш не порожній після
  `close`); хендл без рантайму в залежностях ефекту (задача 7 — заміна
  рантайму); `writeUpdate` відсутнього ключа в
  картці `full` (задача 5 — виняток); не закривати хендл у очищенні ефекту
  (задача 7). Повернути код.
- [ ] **Step 2:** спека П4-B — рядок §14.3 «devDependencies jsdom-тестів» —
  «внесено (B3-2b)»; рядок §14.3 «Повторна адверсарійна перевірка правок
  третього раунду» — частину B3-2b (правила фасаду для бюджету відповіді на
  сторінці вікна: `more: true`, без порожнього префікса, `response-too-large`
  першого рядка — задачі 3–4; свіжість ТЧ картки під хуком — задача 7)
  позначити «закрито (B3-2b)»; рядок §14.1 «Число межі» — за задачею 0; рядок
  Додатку А «платформна спека §8.1» — внести в
  `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §8.1 частину
  B3-2b (стратегії списку `full` і `window`, картка за ключем, сторінку вікна
  читає фасад, тож завантаження за курсором бібліотеки вікно не вживає) і
  позначити «внесено частково (B3-2b)»; решту вносить B3-3; `docs/ROADMAP.md` (рядок П4: B3-2b); скіл споживача
  `packages/designer/skills/` — якщо в ньому є розділ читання даних
  застосунком, додати `useRows`/`useRow` і `residency`; інакше — нічого;
  `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 3: Гейти:**

```bash
pnpm deps:check
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm metadata:check
pnpm test:db
pnpm build:packages && pnpm test:packaging
```

- [ ] **Step 4: Commit** — `docs(spec): П4-B3-2b — §14 і ROADMAP`.

## Готово (§13, рядок B3-2b)

- кейси B3-2b з §12 (вікно, `full`, лінивий `count`) і рядок «unit T4
  (публічний API)» у частині B3-2b зелені на справжній RC;
- DB-кейс keyset (задача 2) зелений;
- мутації кроку 1 задачі 8 червоніють; гейти зелені.

## Підсумок аудиту плану

- **Розвилки** Ф1–Ф11 погодила архітекторка до аудиту (Ф3, Ф6, Ф7 — з
  умовами); уточнення Ф6/Ф7 після раунду 1 (пара `Ref`/`Bytes` не
  сортуються; перерахування — за міткою, бо колонка `text` + `CHECK`, М15) і
  рядок §14.1 про порядок перерахування — погоджено.
- **Раунд 1** — два аудитори (Opus): «план проти спеки й рішень» і «план
  проти коду RC». Blocker — 0. Безпекові major — 2, виправлено: хуки не
  реагували на заміну рантайму; лічильник міг іти повз обгортку транспорту
  B3-1. Несекурні major виправлено: ключ запиту сторінки = форма 1; сторінка з
  уже власним набором ключів — `refetch: true`; найбільша keyset-умова в
  обох напрямках; сортування за несортованим реквізитом — `command.invalid`;
  нижня межа `refreshFrom(0)` і `goTo` з `NULL`; `openList` і перевідкриття
  за стратегією; порядок `rebuildAsWindow`; події `status`/`health`;
  компаратор перерахувань.
- **Раунд 2** — ті самі лінзи. Blocker — 0. Безпекові major — 2,
  виправлено: рядки переживали `dispose()` зі змонтованим хуком (RC
  відхиляє `cleanup()` без `dependents`; той самий дефект у плані B3-2a —
  виправлено окремим комітом за рішенням архітекторки); кадр зі старим
  рантаймом після заміни провайдера. Несекурні: покоління вікна, пара
  `unloadSubset`, ключ `full` без перетину префіксів, точний `Numeric`,
  глибина фільтра після розгортання `and`, `applyFullRows` з помилками RC.
- **Раунд 3** — ті самі лінзи. Blocker — 0. Безпековий major — 1,
  виправлено: пізня відповідь адаптера-перевизначення після `dispose()`
  відкривала підмножину (тепер `disposed()` збільшує покоління, асинхронні
  гілки перевіряють `runtime.disposed`). Несекурні: перерахування в
  обчислювачі фільтра — за мітками, `loadAfter` під час `refreshFrom`,
  лінивий реквізит у сортуванні, тип `lower`, `instanceof`.
- **Codex** (`gpt-6-sol`, дерево заморожено `git archive`, план і розділи
  спеки вбудовано в промпт за ранбуком): 1 знахідка з позначкою blocker —
  вставка відсутнього ключа карткою `full` суперечить §6.2 — спростовано
  §6.1 («перечитаний рядок, що підходить множині, фасад вставляє прямо:
  власник — сама колекція») і Ф8; у §6.2 додано посилання на цей виняток.
  3 major виправлено: дубль ключа між сторінками після `refreshFrom`
  (показ один раз — у пізніше прочитаній сторінці); `refs` цілі `full`
  через шматки `liveRows`, а не без підписки; порожній знімок і за зміни
  входу хука в тому самому рантаймі.
- **Підсумок:** blocker — 0, безпекових major — 0 (усі п'ять безпекових
  major трьох раундів виправлено, останнє виправлення раунду 3 і правки
  Codex окремим раундом не перевірялися — межа ≤ 3 раунди); minor
  виправлено або лишено виконавцю.
