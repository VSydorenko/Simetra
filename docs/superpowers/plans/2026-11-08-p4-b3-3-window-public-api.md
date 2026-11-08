# П4-B3-3. Вікно й публічний API читання — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** список будь-якого розміру читається вікном keyset-сторінок у трьох
ярусах без порожнечі, стрибків і зміни складу від системних подій; клієнт
шле `known` і пакети, тож незмінне не перетягується; T4 дає хуки `useRows`,
`useRow` і `DataRuntimeProvider`, а T5 — один компонент списку на TanStack
Virtual.

**Архітектура:** вікно — новий модуль ядра B3-2 `store/window.ts` поряд з
`readers.ts`; спайк 4 — еталон алгоритмів і сценаріїв, а не код для
перенесення (його ядро — один файл, B3-2 — модулі). Збирач пакета за такт
мікрозадач, правило «ключ іде в `known`», застосування маркера й `include`
тим самим запитом закривають клієнтську частину B1c. Хуки T4 — над
`useSyncExternalStore`; компонент списку T5 — у `src/ui/list/` на
`createElement`, без JSX.

**Стек:** TypeScript, React 19 (`createElement`), TanStack Virtual
(`@tanstack/react-virtual`, точний пін), Vitest (jsdom на файл), fast-check.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §6.1
(стратегії), §6.2, §6.4 (усе), §6.5, §6.7 (частина B3-3), §11 інваріанти 14,
25, 26, §12 рядки «вікно — пам'ять і контракт віртуалізатора», «unit T4
(публічний API, jsdom)», «швидкодія» (T4) і мережеві бюджети читання, §13
рядок B3-3; [звіт спайку 4](../specs/2026-11-08-t4-window-spike-report.md)
§4–§8; [план B3-2](2026-11-08-p4-b3-2-core.md) (інтерфейси ядра); [план
B1c](2026-11-08-p4-b1c-conditional-batched-reads.md) (частини, `known`,
епоха, `acceptEpoch`).

**Поділ і залежності.** Після мерджу B3-2 і B1c. Три частини з власним
«готово»: **B3-3a** (Task 1–5) — вікно в ядрі; **B3-3b** (Task 6–9) —
`known`, пакет і `include` тим самим запитом; **B3-3c** (Task 10–14) —
публічні хуки, компонент списку T5, лінт і бюджети. Імена ядра нижче — з
гілки B3-2 (`feat/p4-b3-2`, `data/store/*`) і плану B1c; виконавець звіряє їх
з `main` (`orient --plan`) перед стартом. Браузерного оракула в B3-3 немає
(B3-6): кадри доводить контрактний тест віртуалізатора й jsdom.

## Global Constraints

- Сторінка вікна — 100 рядків (`limit` ≤ `READ_LIMIT_MAX`); keyset — повний кортеж сортування плюс ключ, `nulls first/last` явні; `offset` понад 10 000 не вживається; keyset-запит без просування курсора не повторюється.
- Яруси: власні — видимі ± `marginPages` (типово 2); знімки показу — сторінка поза запасом через `unloadDelayMs` (типово 1 000 мс), власність звільнено; понад `ghostBytes` (типово 4 МіБ) — найдальші знімки з країв відкидаються разом з місцем. Сторінка з незавершеною власною зміною не вивантажується.
- Порядок у вікні — серверний масив ключів; клієнт рядків вікна не сортує й не порівнює.
- Склад і порядок змінюють лише дії користувача (`refresh`, `showNew`, завантаження й перехід вікна, власне створення один раз, підтверджене власне видалення); системні події — лише `hasNewRows`, `needsRefresh`, `removed` на місці, нові значення на місці (§6.5).
- Кожен запис результату читання у сховище — через `acceptEpoch` (B1c) і токен покоління; після `dispose()` — жодного кадру, запиту й рядка.
- Знімок показу зберігає скоуп рядка; `purge` і звуження прав діють і на знімки (§6.2 правило 4).
- Ключ іде в `known` лише за правилом §6.7; маркер застосовується як рядок версії `v` зі значеннями сховища, а за розбіжності — не пише нічого й ставить ключ на перечитування без `known`.
- Хуки: `getServerSnapshot === getSnapshot`; без Suspense, `useOptimistic`, `useTransition` для сховища; хук без провайдера кидає `Error`.
- Залежності: `@tanstack/react-virtual` — точна версія (спайк — 3.14.26; виконавець бере найновішу стабільну, старшу за два тижні, і фіксує її в контрактному тесті); devDependencies jsdom-тестів — `jsdom`, `@testing-library/react`, `react-dom`, `@types/react` (точні версії, група syncpack); T5 імпортує лише React, контракти T4 і `@tanstack/react-virtual`.
- Файли ПГ-1 не чіпати (перелік — план B1e). Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | `ViewSpec` отримує форму `window { object, where, orderBy, include }`; `useRows` обирає `full` чи `window` за `residency` налаштувань рантайму; `full` понад межу без `strict` переходить на справжній `window` з тим самим фільтром і сортуванням (заглушку `readers.ts` прибрано) | §6.1 перелічує `window` формою підмножини; одна форма для обох шляхів | немає |
| Р2 | Позначку «може бути застарілим» знімка показу ставить хук через 500 мс без оновлення; ядро дає `stale` чесно | звіт спайку §8.1; коротка позначка блимала б | немає |
| Р3 | Частковий маркер для частини з `include` несе й колонки посилань, які читає `include`; B3-3 знімає заборону `known` + `include` з B1c (T0 і будівник T3) | id цілей маркерного рядка тоді відомі серверу в тому самому операторі | П4-B §4.1 (Task 14) |
| Р4 | Збирач пакета — один на рантайм: частини, поставлені в одному такті мікрозадач, ідуть одним запитом на адаптер, `rights` і `version` першими; таймера немає | §6.7 «Вікно збирання» | немає |
| Р5 | Лічильник бюджетів — тестова обгортка адаптера джерела (`countingAdapter`), а не API ядра: запит адаптера Server Function = один запит транспорту; той самий помічник бере тестовий хост B3-6 | бюджети §12 міряють запити й `jsonBytes`; нове публічне API для тестів не потрібне | немає |
| Р6 | Компонент списку T5 — `src/ui/list/virtual-list.ts` на `createElement`; один компонент тримає якір читання, перемонтування нового ланцюжка й `setVisibleRange` | §6.4: якір і перемонтування — в одному компоненті; пакет ще не має JSX-конфігурації | немає |

Кожне рішення — розвилка до погодження архітекторкою.

## Review Focus

1. **Відповідь сторінки, що прийшла після `dispose()` чи нового ланцюжка**:
   нічого не пише й не дає кадру — Task 3.
2. **Знімок показу рядка, до якого втрачено доступ** (`purge` скоупу,
   звуження з `unknown`): прибрано чи значення сховано, а повернення
   сторінки не показує його без перечитування — Task 4.
3. **Маркер для ключа, що за час польоту вийшов з власності чи змінив
   версію**: нічого не пише, ключ перечитується без `known` — Task 7.
4. **Повторне монтування хука під StrictMode**: без запиту й без порожнього
   кадру — Task 10.
5. **Прокрутка 100 тис. рядків**: сховище й знімки в межах, після
   `dispose()` сесію зібрано GC — Task 5.

---

## B3-3a. Вікно в ядрі

### Task 1: Форма `window` і ланцюжок сторінок

**Files:**
- Create: `packages/simetra/src/data/store/window.ts`
- Modify: `packages/simetra/src/data/store/types.ts` (`ViewSpec` з `window`; `ViewSnapshot` — `chain`, `target`, `atStart`, `atEnd`, `count?`), `forms.ts` (`formOf` для `window`, бюджет фільтра — фільтр користувача разом з найбільшою keyset-умовою цього `orderBy`), `filter.ts` (`keysetAfter`, `keysetFromValue`, `reverseOrder` — повний кортеж з `NULL`), `subsets.ts` (реєстрація вигляду), `readers.ts` (прибрати заглушку `window`)
- Test: `packages/simetra/src/data/store/__tests__/window.test.ts` (Create), `filter.test.ts`

**Interfaces:**
- Produces: `ViewSpec = … | { form: "window"; object; where?; orderBy?; include? }`; `WindowPage = { keys: readonly string[]; lower: WindowLower; tier: "own" | "ghost"; bytes: number }`; `WindowLower = { kind: "start" } | { kind: "after"; key } | { kind: "from"; key } | { kind: "value"; value }`; дії `ViewHandle` для вікна: `loadBefore()`, `loadAfter()`, `setVisibleRange({ first, last })`, `goTo(value)`, `goToStart()`, `goToEnd()`; знімок — `rows` (ключі всіх ярусів у порядку), `chain: number`, `target: "start" | "end" | "keep"`, `atStart`, `atEnd`.

- [ ] **Step 1: Unit `window.test.ts` (фейкове джерело B3-2):** перша сторінка — 100 рядків з `lower: start`; `loadAfter` — keyset від останнього рядка, `loadBefore` після `goToEnd` — зворотний keyset; сторінка з `more: true` — коротша, продовження від її останнього рядка; keyset без просування курсора не повторюється; умова з `NULL` у кортежі проходить схему T0 і бюджет фільтра; фільтр понад бюджет — `command.invalid` з `path` без запиту; `full` понад межу без `strict` — справжній `window` з `truncated: true`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window filter full`.
- [ ] **Step 3: Commit.** `feat(data): вигляд window — ланцюжок keyset-сторінок`

### Task 2: Яруси, вивантаження й знімки показу

**Files:**
- Modify: `packages/simetra/src/data/store/window.ts` (яруси, `unloadDelayMs`, `ghostBytes`, оцінка байтів знімка, повернення сторінки), `subsets.ts` (власність сторінок), `types.ts` (`WindowOptions` у `CoreLimits`: `marginPages`, `unloadDelayMs`, `ghostBytes`)
- Test: `window.test.ts`

**Interfaces:**
- Produces: `setVisibleRange` тримає власними видимі ± `marginPages`; сторінка поза запасом через `unloadDelayMs` стає знімком показу (останні показані рядки зі скоупом і місцем, стан `stale`); повернення знімка одразу показує його, бере власність і перечитує сторінку **за ключами**: склад не змінюється, зникле — `removed` на місці; понад `ghostBytes` найдальші знімки з країв відкидаються разом з місцем, `atStart`/`atEnd` = `false`, повернення — новий діапазон зі слотом завантаження на краю.

- [ ] **Step 1: Unit:** запас і вивантаження за `unloadDelayMs` (фейковий годинник); сторінка з власною незавершеною зміною не вивантажується; повернення знімка — склад той самий, зникле — `removed`; межа `ghostBytes` — відкидання з дальнього краю; ключ поза ланцюжком у `setVisibleRange` лишає останній відомий діапазон.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window`.
- [ ] **Step 3: Commit.** `feat(data): яруси вікна — власні, знімки показу, відкинуті`

### Task 3: Новий ланцюжок, `refresh`, `showNew`, системне перечитування

**Files:**
- Modify: `packages/simetra/src/data/store/window.ts`, `writer.ts` (`revalidate` для вікна й `full` — keyset кожної власної сторінки від її курсора одним пакетом; ключ, що випав, — читання за ключем), `core.ts`
- Test: `window.test.ts`

**Interfaces:**
- Produces: `goTo`, `goToStart`, `goToEnd`, `showNew` будують новий ланцюжок: поки він читається, видно старий (`refreshing`); новий заміняє старий одним `commit` з `chain + 1` і `target`; пізня відповідь старого ланцюжка нічого не пише (токен покоління); `refresh()` перебудовує від першої видимої сторінки до кінця власних тим самим числом сторінок, від курсора кожної; рядок, що переїхав, лишає старе місце; знімки нижче відкидаються; системне перечитування — значення на місці, зниклі — `removed`, нові ключі — `hasNewRows`; власний `create`, що підходить предикату, показано на початку першої завантаженої сторінки один раз (ключ не в масиві ключів сторінки).

- [ ] **Step 1: Unit:** новий ланцюжок одним `commit`, `chain` змінюється лише з новим складом; пізня відповідь старого ланцюжка й відповідь після `dispose()` — жодного запису й сповіщення; `refresh` від першої видимої; системне перечитування не змінює складу; новий ключ — `hasNewRows`, `showNew` — оновлення від початку; власне створення — один раз на початку.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window writer`.
- [ ] **Step 3: Commit.** `feat(data): ланцюжки вікна, refresh і системне перечитування`

### Task 4: Права й `purge` на знімках показу, лінивий `count`

**Files:**
- Modify: `packages/simetra/src/data/store/window.ts` (знімок зберігає скоуп рядка; `purge` пари й ключа прибирає рядок і зі знімків; звуження з `unknown` ховає значення до перечитування), `writer.ts` (`purge` і звуження доходять до знімків), `readers.ts` (`count` частиною з межею 10 000, ліниво)
- Test: `window.test.ts`

- [ ] **Step 1: Unit:** `purge` скоупу прибирає рядки цього скоупу з власних сторінок і знімків одним `commit`; звуження `false` — рядок прибрано зі знімка, `unknown` — значення сховано, повернення сторінки показує їх лише з читання після звуження; `removed` за звуженням скидає чернетку (стан `purged` для `card`); `count` — лише за `count: true`, `capped` за 10 000, свіжіє після власного write-back і сигналу об'єкта; надгробок `purge` не знімає читання, що стартувало до нього.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window`.
- [ ] **Step 3: Commit.** `feat(data): права й purge на знімках показу вікна, лінивий count`

### Task 5: Модельний тест і тест пам'яті вікна

**Files:**
- Modify: модельний тест B3-2 (`packages/simetra/src/data/store/__tests__/model.test.ts`: кроки `loadAfter`, `loadBefore`, `setVisibleRange`, плин часу `unloadDelayMs`, `goTo`, `refresh`, `showNew`, чужа правка й видалення сторінкових ключів; нові дефекти в `DefectFlag`)
- Create: `packages/simetra/src/data/store/__tests__/window-memory.test.ts` (за методом спайку 4: відповіді через структурну копію, GC після макрозадач)

- [ ] **Step 1: Модельний тест:** інваріанти після кожного кроку — правило стабільності (жодна системна подія не змінює складу й порядку видимого списку), межі пам'яті вікна, видалене й `purge` не воскресають, після `dispose()` — жодного кадру й запиту; самотест: дефекти «асинхронний рендер без запасу», «системне перечитування змінює склад», «знімок показу без скоупу» червонять модель.
- [ ] **Step 2: Тест пам'яті:** прокрутка 100 тис. рядків через `setVisibleRange` — сховище ≤ 500 рядків у власності й стале, знімки ≤ `ghostBytes`, разом ≤ сума меж; після `dispose()` сесію зібрано GC.
- [ ] **Step 3: Зелений.** `pnpm --filter simetra test model window-memory`.
- [ ] **Step 4: Commit.** `test(data): модельний тест і пам'ять вікна`

**Готово B3-3a:** цільові тести вікна, модельний тест з кроками вікна й тест пам'яті зелені; заглушки `window` у `readers.ts` немає.

## B3-3b. `known`, пакет і `include` тим самим запитом

### Task 6: Збирач пакета

**Files:**
- Create: `packages/simetra/src/data/store/batcher.ts`
- Modify: `packages/simetra/src/data/store/source.ts` (`CoreSource.read` через збирач), `core.ts`
- Test: `packages/simetra/src/data/store/__tests__/batcher.test.ts` (Create)

**Interfaces:**
- Produces: `createBatcher(source: CoreSource, limiter: ReadLimiter): { enqueue(part: CorePart): Promise<CorePartResult> }` — частини одного такту мікрозадач — один запит на адаптер, понад `READ_BATCH_MAX` — кілька, не більше чотирьох одночасно (обмежувач); `rights` і `version` першими (з B5); `batch-aborted` — повтор без упалої частини з паузою, `batch-budget` — наступним запитом.

- [ ] **Step 1: Unit:** три вигляди, змонтовані в одному commit-і React (синхронно), — один запит; частина в наступному такті — другий; 20 частин — два запити; порядок результатів збережено; без таймера (жодної затримки на фейковому годиннику).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test batcher source`.
- [ ] **Step 3: Commit.** `feat(data): збирач пакета читань за такт мікрозадач`

### Task 7: Правило `known` і застосування маркера

**Files:**
- Modify: `packages/simetra/src/data/store/source.ts` (`known` у частині для `keys`, `card` без ТЧ, сторінок вікна й `full`), `object-store.ts` (`applyMarker(key, v, copies?, readEpoch)`), `readers.ts`, `window.ts`, `writer.ts`
- Test: тести `source`, `object-store`, `window`

**Interfaces:**
- Produces: `knownFor(entry, form): { keys, versions } | undefined` — ключ іде в `known` лише коли рядок показує значення (не `removed`, не `purge`, не сховано), версія `v` підтверджена, копія повна для форми (кожна колонка переліку читання; для картки — кожне ліниве поле з версією проєкції `v`), вигляд володіє ключем до осідання і епоха запису — поточна; `applyMarker` — рядок версії `v` зі значеннями сховища через той самий шлях запису (правило версії, надгробки, епохи, позначки); сховище тримає не `v` чи значень немає — нічого не пише, ключ — у перечитування без `known`; частковий маркер пише копії частковим злиттям.

- [ ] **Step 1: Unit:** кожна умова правила — окремий кейс `it.each` (`removed`, сховане, неповна копія, ліниве поле іншої версії, ключ без власника, інша епоха — без `known`); маркер для рядка, що за час польоту отримав новішу версію, — нічого не пише й перечитує; маркер знімає `stale.minVersion` за своїм правилом; повернення сторінки-знімка з `known` — відповідь із маркерів не змінює значень.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test source object-store window`.
- [ ] **Step 3: Commit.** `feat(data): known у частинах і застосування маркера`

### Task 8: `include` тим самим запитом

**Files:**
- Modify (T0 і T3, знімає заборону B1c): `packages/simetra/src/model/runtime/envelope.ts` (`known` з `include` дозволено), `packages/simetra/src/server/read.ts` (частковий маркер частини з `include` несе й колонки посилань `include`)
- Modify (T4): `packages/simetra/src/data/store/include.ts` (перша сторінка й картка просять `include` у частині; `included` — перший результат підмножини `keys` цілі тим самим `commit`; наступні сторінки дочитують відсутні цілі частиною `keys` наступного пакета), `readers.ts`
- Test: `packages/simetra/src/server/__tests__/read.test.ts`, `packages/simetra/src/model/runtime/__tests__/envelope.test.ts`, тести `include` B3-2

- [ ] **Step 1: Unit T0/T3:** `known` з `include` проходить схему; частковий маркер — `$known`, колонки `copy` і колонки посилань `include`; оператор `include` бере id цілей і з маркерних рядків.
- [ ] **Step 2: Unit T4:** відкриття списку з `include` — один запит, рядки цілей — у підмножині `keys`, власник — вигляд, надгробки й епоха — як для будь-якого читання; рядки цілей зникають разом із виглядом.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test read envelope include`.
- [ ] **Step 4: Commit.** `feat(data): include тим самим запитом, known разом з include`

### Task 9: Бюджети сценаріїв читання ядра

**Files:**
- Create: `packages/simetra/src/data/store/testing/counting-adapter.ts`
- Create: `packages/simetra/src/data/store/__tests__/budgets.test.ts`

**Interfaces:**
- Produces: `countingAdapter(adapter: SourceAdapter): { adapter: SourceAdapter; stats(): { requests: number; parts: number; requestBytes: number; responseBytes: number; usefulBytes: number } }` — `jsonBytes` запиту й відповіді; корисні байти — рядки, яких не було в сховищі чи з іншою версією.

- [ ] **Step 1: Unit `budgets.test.ts`** (рядки бюджетів §12, що стосуються ядра читання): відкриття списку з `include` і `count` — 1 запит, відповідь ≤ 1,1 × корисних + 2 КіБ; прокрутка на нову сторінку — ≤ 1 запит; повернення сторінки-знімка без змін — 1 запит, відповідь ≤ 8 Б × рядків + 2 КіБ (для об'єкта з копіями — плюс ключ, версія й копії на рядок), тіло ≤ 64 Б × ключів `known` + 2 КіБ; список → картка зі сховища — 1 запит; картка → список у межах `releaseDelayMs` — 0; системне перечитування вікна без змін — 1 запит.
- [ ] **Step 2: Червоний → зелений.** `pnpm --filter simetra test budgets`.
- [ ] **Step 3: Commit.** `test(data): мережеві бюджети сценаріїв читання ядра`

**Готово B3-3b:** unit-тести збирача, `known`, `include` і бюджети зелені; заборони `known` + `include` немає.

## B3-3c. Публічні хуки, компонент списку T5, лінт

### Task 10: `DataRuntimeProvider` і хуки

**Files:**
- Create: `packages/simetra/src/data/react/provider.ts`, `use-rows.ts`, `use-row.ts`, `holder.ts` (тримач рантайму)
- Modify: `packages/simetra/src/data/index.ts` (експорт хуків і провайдера), `packages/simetra/package.json` (devDependencies `jsdom`, `@testing-library/react`, `react-dom`, `@types/react` — точні версії; група syncpack)
- Test: `packages/simetra/src/data/react/__tests__/hooks.test.ts` (Create, `// @vitest-environment jsdom`, `createElement` без JSX)

**Interfaces:**
- Produces: `DataRuntimeProvider({ holder, children })`; `useRows({ object, where?, orderBy?, include?, count? })` → знімок §6.4 з діями вікна; `useRow({ object, id, tabularSections? })` → `{ row, tabularSections, version, editable, status, error?, needsRefresh, isStale }`; тримач міняє рантайм і сповіщає хуки; позначка знімка показу «може бути застарілим» — у хуку через 500 мс без оновлення.

- [ ] **Step 1: jsdom-тести:** `getServerSnapshot === getSnapshot`; незмінний вигляд — та сама посилка; жодного Suspense; `loading` лише без даних, далі `refreshing`; картка зі сховища — одразу; `refresh()` і `showNew()` змінюють склад, системне перечитування — ні; `strategy` і `truncated`; `refs`; `version` і `editable`; лінивий `count`; StrictMode «туди й назад» без запиту й без порожнього кадру; заміна рантайму тримачем — хуки не показують рядків старого; хук без провайдера кидає `Error`; позначка знімка — через 500 мс, не раніше.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test hooks`.
- [ ] **Step 3: Перевірка `.d.ts` і пакування.** Публічні типи `simetra/data` не згадують сесії, сховищ, `Scope`, `@tanstack/*`: `pnpm build:packages && pnpm test:packaging`.
- [ ] **Step 4: Commit.** `feat(data): DataRuntimeProvider, useRows і useRow`

### Task 11: Компонент списку T5 і контрактний тест віртуалізатора

**Files:**
- Create: `packages/simetra/src/ui/list/virtual-list.ts`, `packages/simetra/src/ui/list/__tests__/virtual-contract.test.ts`, `virtual-list.test.ts` (jsdom)
- Modify: `packages/simetra/src/ui/index.ts` (експорт), `packages/simetra/package.json` (`@tanstack/react-virtual` — точний пін; peer чи залежність — за правилом §3 для T5), tsdown-вхід T5, якщо його немає

**Interfaces:**
- Produces: `VirtualList({ view, renderRow, estimateSize, height })` — `useVirtualizer` з `getItemKey` за ключем рядка, сталі ключі слотів завантаження на краях, рядки в потоці під одним `translateY`, `anchorTo: "end"`, `virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false` (властивість екземпляра), власний якір читання в layout-ефекті (перший видимий рядок і відступ), перемонтування за `chain` з `initialOffset` цілі, SSR — `initialRect`, `overflowAnchor: "none"`; видимий діапазон ключами — у `view.setVisibleRange`, після гідратації SSR — лише після першої прокрутки; рядок `removed` — слот того самого розміру.

- [ ] **Step 1: Контрактний тест на піні:** вбудована компенсація росту за замовчуванням є; її вимикає `shouldAdjustScrollPositionOnItemSizeChange` як властивість екземпляра; версії `@tanstack/react-virtual` і `virtual-core` дорівнюють піну.
- [ ] **Step 2: jsdom `virtual-list.test.ts`:** `setVisibleRange` отримує ключі першого й останнього видимого; новий `chain` перемонтовує список з ціллю; ріст рядка над видимими не зсуває першого видимого (якір); до першої прокрутки після гідратації діапазон не звітується.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test virtual-contract virtual-list`.
- [ ] **Step 4: Commit.** `feat(ui): компонент списку на TanStack Virtual з якорем`

### Task 12: Лінт зони T5

**Files:**
- Modify: `packages/simetra/eslint.tier-zones.js` (у наявних опціях `no-restricted-imports` зони T5 — `@tanstack/react-virtual` поза `src/ui/list/**` і `useOptimistic` з `react`; `no-restricted-globals` — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`; `no-restricted-syntax` — атрибут `onScroll` і `addEventListener("scroll", …)` поза `src/ui/list/**`, атрибут `suppressHydrationWarning`; `no-restricted-properties` — `Math.random`; блок `src/ui/list/**` повторює повний перелік заборон T5 без двох винятків теки списку)
- Test: `packages/simetra/test/tier-boundary.test.ts`

- [ ] **Step 1: Негативні тести:** кожне правило — відмова на віртуальній фікстурі в `src/ui/**`; `@tanstack/react-virtual` і `onScroll` у `src/ui/list/**` — прохід; ярусні заборони T5 у `src/ui/list/**` лишаються (опції flat config заміняються цілком — тест доводить, що жодна не загубилась).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test tier-boundary`, `pnpm lint`.
- [ ] **Step 3: Commit.** `feat(lint): правила зони T5 проти відомих джерел мерехтіння`

### Task 13: Гейти B3-3

- [ ] **Step 1:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm deps:check`, `pnpm build:packages && pnpm test:packaging`, модельний тест повним прогоном.
- [ ] **Step 2: Commit** (лише якщо гейти змінили файли).

### Task 14: Спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§4.1 — `known` разом з `include`, частковий маркер з колонками посилань; §6.4 — розташування компонента списку `src/ui/list/`; §14.3 — рядки B3-3 закрито: devDependencies jsdom-тестів (узгодити суперечність §12 і §14.3), межі пам'яті з виміру; Додаток А — рядки B3-3 «внесено (B3-3)»), `docs/ROADMAP.md` (стан B3-3)

- [ ] **Step 1: Правки** за переліком; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Commit.** `docs(spec): вікно, known з include і хуки під B3-3`

**Готово B3-3c:** jsdom-тести хуків і компонента, контрактний тест віртуалізатора, негативні тести лінту, пакування з `.d.ts` зелені; спеки оновлено.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| сортувати рядки вікна на клієнті | `window.test.ts` |
| повторити keyset-запит без просування курсора | `window.test.ts` |
| системне перечитування змінює склад | `window.test.ts`, модельний тест |
| пізня відповідь старого ланцюжка пише | `window.test.ts` |
| знімок показу без скоупу (`purge` не прибирає) | `window.test.ts`, модельний тест |
| повернення знімка показує значення без перечитування після звуження | `window.test.ts` |
| вивантажити сторінку з незавершеною зміною | `window.test.ts` |
| маркер для рядка зі зміненою версією пише значення | `object-store.test.ts` |
| ключ без власника в `known` | `source.test.ts` |
| збирач з таймером замість такту | `batcher.test.ts` |
| `include` окремим запитом після сторінки | `budgets.test.ts` |
| `getServerSnapshot` відмінний від `getSnapshot` | `hooks.test.ts` |
| Suspense на даних | `hooks.test.ts` |
| позначка знімка без затримки 500 мс | `hooks.test.ts` |
| вбудована компенсація росту не вимкнена | `virtual-list.test.ts` (якір) |
| правило лінту T5 губить ярусну заборону в теці списку | `tier-boundary.test.ts` |
