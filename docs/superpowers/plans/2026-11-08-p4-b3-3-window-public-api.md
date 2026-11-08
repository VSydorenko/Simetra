# П4-B3-3. Вікно й публічний API читання — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** список будь-якого розміру читається вікном keyset-сторінок у трьох
ярусах без порожнечі, стрибків і зміни складу від системних подій, а знімок
показу не обходить прав, надгробків і епохи; клієнт шле `known` і пакети, тож
незмінне не перетягується; T4 дає хуки `useRows`, `useRow` і
`DataRuntimeProvider`, а T5 — один компонент списку на TanStack Virtual.

**Архітектура:** вікно — новий модуль ядра B3-2 `store/window.ts`; спайк 4 —
еталон алгоритмів і сценаріїв, а не код для перенесення (його ядро — один
файл, B3-2 — модулі). Збирач пакета за такт мікрозадач, правило «ключ іде в
`known`», застосування маркера й `include` тим самим запитом закривають
клієнтську частину B1c. Хуки T4 — над `useSyncExternalStore` і тримачем
`runtime/holder.ts`, вхід `simetra/data/react`; компонент списку T5 — `src/ui/list/` на
`createElement`, вхід пакета `./ui`.

**Стек:** TypeScript, React 19 (`createElement`), `@tanstack/react-virtual`
(точний пін), Vitest (jsdom на файл), fast-check.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §3, §6.1,
§6.2, §6.4, §6.5, §6.7 (частина B3-3), §11 інваріанти 14, 25, 26, §12 рядки
«вікно — пам'ять і контракт віртуалізатора», «unit T4 (публічний API, jsdom)»,
«швидкодія» (T4) і мережеві бюджети читання, §13 рядок B3-3; [звіт спайку
4](../specs/2026-11-08-t4-window-spike-report.md) §4–§8; [план
B3-2](2026-11-08-p4-b3-2-core.md); [план
B1c](2026-11-08-p4-b1c-conditional-batched-reads.md).

**Поділ і залежності.** Після мерджу B3-2, B1c і ПГ-1 (B3-3c змінює
`packages/simetra/package.json`, який змінює й ПГ-1). П'ять частин з власним
«готово»: **B3-3a1** (Task 1–2) — форма `window`, ланцюжок, яруси;
**B3-3a2** (Task 3–5) — ланцюжки, перечитування, права на знімках, модельний
тест і пам'ять; **B3-3b** (Task 6–9) — збирач, лінивий `count`, `known`, `include`, бюджети;
**B3-3c1** (Task 10) — хуки; **B3-3c2** (Task 11–13) — компонент списку,
пакування `./ui`, лінт, спеки. Імена ядра — з гілки B3-2 і плану B1c;
виконавець звіряє їх з `main` (`orient --plan`). Браузерного оракула немає
(B3-6). Кейси, яким потрібен журнал мутацій (сторінка з незавершеною
зміною, власне створення, скидання чернетки, свіжість після write-back), —
у B3-4: B3-3 дає гачок і тестує його фейковим журналом.

## Global Constraints

- Сторінка вікна — 100 рядків; keyset — повний кортеж сортування плюс ключ, `nulls first/last` явні; `offset` понад 10 000 не вживається; keyset-запит без просування курсора не повторюється.
- Яруси: власні — видимі ± `marginPages` (2); знімки показу — сторінка поза запасом через `unloadDelayMs` (1 000 мс), власність звільнено (зокрема цілей `include`); понад `ghostBytes` (4 МіБ, оцінка з `refs`) — найдальші знімки з країв відкидаються разом з місцем.
- Порядок у вікні — серверний масив ключів; клієнт рядків вікна не сортує.
- Склад і порядок змінюють лише дії користувача; системні події — лише `hasNewRows`, `needsRefresh`, `removed` на місці, нові значення на місці (§6.5).
- Кожен запис результату читання — через `acceptEpoch` (B1c) і токен покоління читання сторінки (Р9); після `dispose()` — жодного кадру, запиту й рядка.
- Знімок показу не обходить жодного правила сховища: надгробків ключа й пари, позначок `removed`, горизонту, `purge`, звуження прав, епохи (Р8).
- Хуки: `getServerSnapshot === getSnapshot`; без Suspense, `useOptimistic`, `useTransition` для сховища; хук без провайдера кидає `Error`; закритий рантайм — сталий знімок з причиною, не `loading`.
- Позначка «може бути застарілим» знімка показу — у хуку через 500 мс; стани `removed`, `purged` і сховані значення — у тому самому кадрі.
- Лічильник бюджетів — обгортка `DataTransport`.
- Імена B3-2: дискримінатор `ViewSpec` — `kind`; `ViewSnapshot` уже має `atEnd`, `strategy`, `truncated`; публічний тримач рантайму — `runtime/holder.ts` (внутрішній хендл — `runtime/handle.ts`).
- Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | `ViewSpec` отримує `{ kind: "window", object, where?, orderBy?, include?, count? }`; `useRows` обирає `full` чи `window` за `residency` налаштувань рантайму (`createDataRuntime({ residency })`, логічні імена резолвляться в UUID, невідомий об'єкт — `TypeError`); `full` понад межу без `strict` — справжній `window` (заглушку прибрано) | §6.1 | немає |
| Р2 | Позначку «може бути застарілим» ставить хук через 500 мс; ядро дає `stale` чесно | звіт спайку §8.1 | немає |
| Р3 | Частковий маркер частини з `include` несе й колонки посилань `include`; заборону `known` + `include` з B1c знято (T0 і будівник T3) | id цілей маркерного рядка тоді відомі серверу в тому самому операторі | П4-B Рд40, §4.1, §4.2 (Task 13) |
| Р4 | Збирач — реалізація `CoreSource`, яку ядро передає як `ctx.source`, тож через нього йдуть усі читачі (`readKeys`, `fetchFull`, `readIncluded`, вікно); він лише накопичує частини одного такту мікрозадач і кличе джерело B1c, а поділ понад `READ_BATCH_MAX`, обмежувач і повтори лишаються за B1c; частина — `CorePart = { query: RowsQuery \| CountQuery; known?: KnownVersions }`, результат — `CoreReadItem = { ok: true; value: ReadPartValue; epoch: string \| null } \| { ok: false; error: CommandError }` (рядки з `KnownMarker` чи лічильник); `count` іде групою транспорту (Server Function) навіть за перевизначеного адаптера об'єкта, тож з об'єктом на типовому адаптері — той самий запит; частини `version` і `rights` — B3-6 і B5 | один шар повторів і один обмежувач; `count` — лише через Server Function (§4.1) | немає |
| Р5 | Лічильник бюджетів — `countingTransport(transport: DataTransport)` у `src/data/testing/`; той самий помічник бере тестовий хост B3-6 | `count` і `version` ідуть повз адаптер; §12 — обгортка транспорту | немає |
| Р6 | Компонент списку T5 — `src/ui/list/virtual-list.ts` на `createElement`; DOM-типи — окремий проєкт TypeScript `packages/simetra/tsconfig.dom.json` (`lib: ["ES2022", "DOM"]`) для `src/ui/**`, `src/data/react/**` і jsdom-тестів; основний `tsconfig.json` їх виключає, а `typecheck` перевіряє обидва (директива `/// <reference lib>` діяла б на всю програму, і DOM-глобали побачив би T0); публічний тримач рантайму — `runtime/holder.ts` (`createRuntimeHolder`), `runtime/handle.ts` лишається внутрішнім; хуки й провайдер — окремий вхід `simetra/data/react`, тож `simetra/data` лишається без `react` для серверного споживача | §6.4: якір і перемонтування — в одному компоненті; JSX-конфігурації в пакеті немає | немає |
| Р7 | `@tanstack/react-virtual` — необов'язковий peer входу `./ui` (діапазон мажора) з точним dev-піном і групою syncpack `sameRange`; вхід tsdown і `publishConfig.exports` `./ui`; тест пакування — `./ui` у переліку exports і «серверний споживач без `react` і virtual» | peer віртуалізатора — `react` і `react-dom`, тож як залежність він затягнув би React серверу | П4-B §3 (Task 13) |
| Р8 | Знімок показу на ключ зберігає: показані значення (через `visibleRow`, тож сховане не потрапляє), підтверджений рядок (`ServerRow` з `versionEpoch` B1c і копіями; лінивих полів список не читає), скоуп, епоху читання, `refs` з об'єктом і скоупом кожної цілі. `remove`, надгробки ключа й пари, `purge` і звуження (Р11) доходять до знімків. На поверненні: (а) якщо сховище має запис ключа — підтверджений рядок знімка спершу проходить `put` за правилом версії, далі слот показує `visibleRow` запису, а значення знімка відкидаються; (б) інакше ключ проходить перевірки `put` (`buriedSince` ключа й пари, позначка звуження Р11, горизонт, пам'ять версій новіша за підтверджений рядок — `stale`): поховане й `removed` — слот без значень, звужене чи за горизонтом — значення сховано до перечитування; (в) кожна ціль `refs`: якщо сховище має її запис — `refs[attr]` береться з `visibleRow` запису (`null` для слота `removed` чи схованого), інакше — ті самі перевірки за її об'єктом і скоупом, а за невдачі — `row: null`; (г) знімок іншої епохи версій — `stale` з причиною `epoch`. `known` знімка — з підтвердженого рядка й його `versionEpoch`; маркер вносить підтверджений рядок через `put(row, { buryEpoch, horizonEpoch })`: надгробки — від епохи читання знімка, горизонт і зняття позначок — від старту читання маркера (сервер щойно звірив RLS і версію) | інакше повернення знімка показало б видалене, невидиме під RLS, старшу версію чи значення цілі після втрати доступу, а маркер підтвердив би передбачене значення | немає |
| Р9 | Токен читання сторінки — пара (ланцюжок, покоління сторінки); відповідь пише лише тоді, коли сторінка в тому самому ярусі й ланцюжку; `revalidate` вікна несе `chain` | токена підмножини замало: вікно має кілька одночасних читань | немає |
| Р10 | Гачок закріплення `pinned(key)`: сторінка з закріпленим ключем не вивантажується; B3-4 під'єднує його до журналу | журналу мутацій до B3-4 немає | немає |
| Р11 | Точка звуження прав `Writer.narrow(object, keys, verdict: false \| "unknown")` — у B3-3 (кличе B6): `false` — `purge` ключа; `unknown` — значення сховано, `revalidate` виглядів ключа і запис епохи звуження ключа в `Epochs` (`narrowedSince(key, readEpoch)`; витіснення запису піднімає горизонт, як надгробок): вставка з читання, що почалось до звуження, ховає значення; `purge` і `narrow` об'єкта ховають значення його `count` до лінивого перечитування; межа записів звуження — `tombstonesMax`. Контракт для B6: `Writer.rowsForRights(object)` дає рядки сховища, підтверджені рядки знімків зі скоупом і цілі `refs` знімків, тож `can(read, row)` B6 досягає й ключів, що є лише в знімках; до B6 звуження дає `revalidate` виглядів, і він позначає знімки об'єкта схованими до перечитування | знімок і читання в польоті мусять бачити звуження, а позначка лише в знімку губилась би, коли ключ вставляє читання, що стартувало раніше | немає |

Правило заміни ланцюжка: `put` і `own` нового ланцюжка — до звільнення старого в тому самому `commit` (як `diffOwn`/`applyIncluded` B3-2), інакше слот `removed` старого ланцюжка поховав би ключ, який новий ланцюжок отримав.

Кожне рішення — розвилка до погодження архітекторкою. Дайджест сторінки
(§14.3) лишається відкладеним: B3-3 записує його в §14.3 з умовою «коли
бюджет `full` вимагатиме».

## Review Focus

1. **Повернення знімка ключа, видаленого чи прибраного, поки сторінка була
   знімком**: слот без значень, значень немає — Task 4.
2. **`purge` цілі `include`**: `refs` знімка обнулено — Task 4.
3. **Маркер для ключа знімка, що мав `predict` чи стару епоху**: передбачене
   не стає підтвердженим, стара епоха — повна відповідь — Task 7.
4. **Відповідь читання сторінки, що вже стала знімком чи відкинута**: нічого
   не пише, власності не бере — Task 3.
5. **`dispose()` з частиною в черзі збирача**: нуль запитів, обіцянки
   відхилено без запису — Task 6.
6. **`narrow(unknown)` під час перечитування повернення**: відповідь, що
   стартувала до звуження, значень не показує — Task 4 (рядок) і Task 7
   (маркер).

---

## B3-3a1. Форма `window`, ланцюжок, яруси

### Task 1: Форма `window` і ланцюжок сторінок

**Files:**
- Create: `packages/simetra/src/data/store/window.ts`
- Modify: `packages/simetra/src/data/store/types.ts` (`ViewSpec` з `kind: "window"`; `ViewSnapshot` — `chain`, `target`, `atStart`, `count?`), `forms.ts` (`formOf` для `window`; бюджет фільтра — фільтр користувача з найбільшою keyset-умовою цього `orderBy`), `filter.ts` (`keysetFromValue`, `reverseOrder` поряд з `keysetAfter`, повний кортеж з `NULL`), `subsets.ts`, `readers.ts` (прибрати заглушку), `packages/simetra/src/data/runtime/runtime.ts` (`residency`)
- Test: `packages/simetra/src/data/store/__tests__/window.test.ts` (Create), `filter.test.ts`, `full.test.ts` (оновити кейс заглушки)

**Interfaces:**
- Produces: `WindowPage = { keys: readonly string[]; lower: WindowLower; tier: "own" | "ghost"; generation: number; bytes: number }`; `WindowLower = { kind: "start" } | { kind: "after"; key: string } | { kind: "from"; key: string } | { kind: "value"; value: unknown }`; дії `ViewHandle` вікна: `loadBefore()`, `loadAfter()`, `setVisibleRange({ first, last })`, `goTo(value)`, `goToStart()`, `goToEnd()`.

- [ ] **Step 1: Unit:** перша сторінка — 100 рядків з `lower: start`; `loadAfter` — keyset від останнього рядка; `loadBefore` після `goToEnd` — зворотний keyset; сторінка з `more: true` — коротша, продовження від її останнього рядка; keyset без просування курсора не повторюється; умова з `NULL` проходить схему T0 і бюджет; фільтр понад бюджет — `command.invalid` з `path` без запиту; `full` понад межу без `strict` — справжній `window` з `truncated: true`; `residency` з невідомим об'єктом — `TypeError`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window filter full runtime`.
- [ ] **Step 3: Commit.** `feat(data): вигляд window — ланцюжок keyset-сторінок`

### Task 2: Яруси, вивантаження й знімки показу

**Files:**
- Modify: `window.ts` (яруси, `unloadDelayMs`, `ghostBytes` з `refs`, структура знімка за Р8, гачок `pinned` Р10), `subsets.ts` (власність сторінок і їхніх цілей `include`), `types.ts` (`marginPages`, `unloadDelayMs`, `ghostBytes` у `CoreLimits`)
- Test: `window.test.ts`

**Interfaces:**
- Produces: `GhostRow = { shown: RowView; confirmed: ServerRow; scope: string | null; readEpoch: number; refs: Readonly<Record<string, { object: string; scope: string | null; row: RowView | null }>> }`; `setVisibleRange` тримає власними видимі ± `marginPages`; повернення знімка — перевірка кожного ключа за Р8, показ, власність, перечитування сторінки за ключами з `known` (Task 7; до нього — без `known`).

- [ ] **Step 1: Unit:** вивантаження за `unloadDelayMs` (фейковий годинник) звільняє власність рядків і цілей `include`; закріплений фейковим журналом ключ (`pinned`) тримає сторінку; повернення знімка — склад той самий, зникле — `removed`; межа `ghostBytes` з урахуванням `refs` — відкидання з дальнього краю, `atStart`/`atEnd` = `false`; ключ поза ланцюжком у `setVisibleRange` лишає останній відомий діапазон; знімок бере значення через `visibleRow` (сховане не потрапляє).
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window`.
- [ ] **Step 3: Commit.** `feat(data): яруси вікна — власні, знімки показу, відкинуті`

**Готово B3-3a1:** тести Task 1–2 зелені; заглушки `window` у `readers.ts` немає.

## B3-3a2. Ланцюжки, перечитування, права, модель

### Task 3: Новий ланцюжок, `refresh`, `showNew`, системне перечитування

**Files:**
- Modify: `window.ts` (токен читання сторінки Р9), `writer.ts` (`revalidate` вікна й `full` — keyset кожної власної сторінки від її курсора одним пакетом, курсори сторінок `full` — у підмножині; ключ, що випав, — читання за ключем: відсутній — `removed`, присутній — значення й `needsRefresh`), `core.ts`
- Test: `window.test.ts`

**Interfaces:**
- Produces: `goTo`, `goToStart`, `goToEnd`, `showNew` будують новий ланцюжок (старий видно як `refreshing`, новий заміняє одним `commit` з `chain + 1` і `target`); `refresh()` — від першої видимої сторінки до кінця власних тим самим числом сторінок; рядок, що переїхав, лишає старе місце; знімки нижче відкидаються.

- [ ] **Step 1: Unit:** новий ланцюжок одним `commit`; пізня відповідь старого ланцюжка, відповідь для сторінки, що стала знімком чи відкинута, і відповідь після `dispose()` — жодного запису, власності й сповіщення; `revalidate`, що стартував до нового ланцюжка, не ставить `hasNewRows` новому; `refresh` від першої видимої; системне перечитування не змінює складу; новий ключ — `hasNewRows`, `showNew` — оновлення від початку; ключ, що переїхав за межу сторінок, — читання за ключем.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window writer`.
- [ ] **Step 3: Commit.** `feat(data): ланцюжки вікна, refresh і системне перечитування`

### Task 4: Права, видалення й `purge` на знімках показу

**Files:**
- Modify: `window.ts`, `writer.ts` (`remove`, надгробки ключа й пари, `purge`, `narrow` доходять до знімків; `Writer.narrow`), `object-store.ts`, `epoch.ts` (`narrowedSince`)
- Test: `window.test.ts`

- [ ] **Step 1: Unit:** ключ знімка, видалений іншим виглядом (`remove`), похований надгробком чи прибраний «Прибрати», — при поверненні слот без значень; надгробок пари — так само; ключ за горизонтом — значення сховано до перечитування; `purge` скоупу прибирає рядки й зі знімків одним `commit`; `purge` чи звуження цілі `include` обнуляє відповідний `ref` знімка; `narrow` `false` — рядок прибрано, `unknown` — значення сховано, повернення показує їх лише з читання після звуження; `narrow(unknown)` під час перечитування повернення — рядок відповіді, що стартувала раніше, значень не показує; `Writer.rowsForRights` дає й ключі знімків і цілі `refs`; ціль `refs`, яку сховище має як `removed` чи з прихованими значеннями (зокрема переїзд цілі в прибраний скоуп), — `null`; до B6 звуження ховає знімки об'єкта до перечитування; `count` після `purge` об'єкта — значення сховано до перечитування; таймери `unloadDelayMs` після `dispose()` нічого не пишуть; ключ знімка, який сховище має в іншого власника з прихованими значеннями чи новішою версією, — слот за сховищем; ціль `refs`, похована чи за горизонтом, — `row: null`; знімок іншої епохи — `stale` з причиною `epoch`; ключ, `removed` у старому ланцюжку й присутній у новому, — показано в новому.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test window`.
- [ ] **Step 3: Commit.** `feat(data): права й видалення на знімках показу`

### Task 5: Модельний тест і пам'ять вікна

**Files:**
- Modify: модельний тест B3-2 і перелік дефектів самотесту (`defects.ts` гілки B3-2 та гілки дефектів у `window.ts`; `packages/simetra/src/data/store/__tests__/model.test.ts`: кроки `loadAfter`, `loadBefore`, `setVisibleRange`, плин часу, `goTo`, `refresh`, `showNew`, `remove` і `purge` ключів знімків, `narrow`; нові дефекти в `DefectFlag`)
- Create: `packages/simetra/src/data/store/__tests__/window-memory.test.ts`

- [ ] **Step 1: Модельний тест:** інваріанти — правило стабільності; межі пам'яті вікна; видалене, `purge` і сховане не показується знімком; після `dispose()` — жодного кадру й запиту; самотест — дефекти «системне перечитування змінює склад», «знімок без скоупу», «повернення знімка без перевірки надгробків», «відповідь сторінки без токена покоління» червонять модель.
- [ ] **Step 2: Пам'ять** (метод спайку 4: структурна копія відповідей, GC після макрозадач): 100 тис. рядків — сховище ≤ 500 рядків у власності й стале, знімки ≤ `ghostBytes`, разом ≤ сума меж; після `dispose()` сесію зібрано GC.
- [ ] **Step 3: Зелений.** `pnpm --filter simetra test model window-memory`.
- [ ] **Step 4: Commit.** `test(data): модельний тест і пам'ять вікна`

**Готово B3-3a2:** тести Task 3–5 зелені.

## B3-3b. `known`, пакет, `include`, бюджети

### Task 6: Збирач пакета

**Files:**
- Create: `packages/simetra/src/data/store/batcher.ts`
- Modify: `core.ts` (збирач — `ctx.source`), `source.ts` (`CorePart`, `CoreReadItem`, `CountQuery = Extract<ReadQuery, { count: true }>`, група транспорту для `count`: `createCoreSource` отримує адаптер Server Function поряд із `sourceFor`), `packages/simetra/src/data/runtime/runtime.ts` (передача адаптера Server Function), `readers.ts`, `window.ts` (лінивий `count`)
- Test: `packages/simetra/src/data/store/__tests__/batcher.test.ts` (Create)

**Interfaces:**
- Produces: `CoreSource.read(parts: readonly CorePart[]): Promise<{ items: CoreReadItem[] }>` (типи Р4; правка сигнатури B1c); `createBatcher(source: CoreSource): CoreSource & { close(): void }` — частини одного такту мікрозадач — один виклик внутрішнього джерела; таймера немає; `close()` (з `dispose()`) відхиляє черговані обіцянки без запису й без запиту; лінивий `count` вигляду (`count: true`, межа 10 000, `capped`) — частиною `CountQuery`, свіжіє після сигналу об'єкта й після `purge`/`narrow` об'єкта (після write-back — B3-4).

- [ ] **Step 1: Unit:** три вигляди одного синхронного commit-у (через `readKeys`, `fetchFull` і `readIncluded`) — один виклик; сторінка вікна й її `count` — один запит; `count` об'єкта з перевизначеним адаптером — запит транспорту; `purge` об'єкта — `count` застарілий і перечитується ліниво; частина наступного такту — другий; порядок результатів збережено; жодної затримки на фейковому годиннику; `enqueue` → `dispose` → мікрозадача — нуль запитів, обіцянка відхилена.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test batcher`.
- [ ] **Step 3: Commit.** `feat(data): збирач пакета читань за такт мікрозадач`

### Task 7: Правило `known` і застосування маркера

**Files:**
- Modify: `source.ts` (`known` у частинах `keys`, `card` без ТЧ, сторінок вікна й `full`), `object-store.ts` (`applyMarker`), `readers.ts`, `window.ts` (знімки за Р8), `writer.ts`
- Test: тести `source`, `object-store`, `window`

**Interfaces:**
- Produces: `knownFor(entry, form): KnownVersions | undefined` — ключ іде в `known`, коли рядок показує значення, версія `v` підтверджена, копія повна для форми, вигляд володіє ключем до осідання й епоха запису — поточна; для знімка — з підтвердженого рядка й `versionEpoch` знімка; `applyMarker(key, confirmed: ServerRow, copies, epochs: { buryEpoch; horizonEpoch })` — для ключа сховища `confirmed` — його підтверджений рядок, для ключа знімка — `GhostRow.confirmed`; рядок через `put` (правило версії, надгробки, епохи, позначки); розбіжність — нічого не пише, ключ у перечитування без `known`.

- [ ] **Step 1: Unit (`it.each`):** `removed`, сховане, неповна копія, ліниве поле іншої версії, ключ без власника, інша епоха — без `known`; маркер рядка, що за час польоту отримав новішу версію, — нічого не пише й перечитує; маркер знімка з `predict` — показ дорівнює підтвердженому рядку, а не передбаченому; знімок попередньої епохи — повна відповідь; маркер не обходить надгробка, новішого за епоху читання знімка; знімок, старший за горизонт свого кошика, з маркером — показано без другого запиту (горизонт — від старту читання маркера); `narrow(unknown)` під час перечитування повернення з `known` — маркер читання, що стартувало раніше, значень не показує.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test source object-store window`.
- [ ] **Step 3: Commit.** `feat(data): known у частинах і застосування маркера`

### Task 8: `include` тим самим запитом

**Files:**
- Modify (T0, T3): `packages/simetra/src/model/runtime/envelope.ts` (`known` з `include` дозволено), `mapping.ts` і `packages/simetra/src/server/decode.ts` (колонки посилань у частковому маркері), будь-яке інше місце відмови `known-form`, `packages/simetra/src/server/read.ts` (частковий маркер з колонками посилань `include`; оператор `include` бере id і з маркерних рядків)
- Modify (T4): `include.ts` (перша сторінка й картка просять `include` частиною; `included` — перший результат підмножини `keys` цілі тим самим `commit`; наступні сторінки дочитують відсутні цілі частиною `keys` наступного пакета), `readers.ts`
- Test: `packages/simetra/src/server/__tests__/read.test.ts`, `packages/simetra/src/model/runtime/__tests__/envelope.test.ts`, `packages/simetra/src/data/store/__tests__/include.test.ts` (Create), `packages/designer/src/__tests__/read-batch.db.test.ts`

- [ ] **Step 1: Unit T0/T3:** `known` з `include` проходить схему; частковий маркер — `$known`, колонки `copy` і колонки посилань; оператор `include` бере id з маркерних рядків.
- [ ] **Step 2: DB `read-batch.db.test.ts`** (причина DB: RLS цілі): `known` + `include` — маркер з колонками посилань, ціль, невидима під RLS, відсутня в `included`, рядок лишається.
- [ ] **Step 3: Unit T4:** відкриття списку з `include` — один запит; рядки цілей — у підмножині `keys`, власник — вигляд; рядки цілей зникають разом із виглядом.
- [ ] **Step 4: Червоний → реалізація → зелений.** `pnpm --filter simetra test read envelope include`, `pnpm --filter @simetrajs/designer test:db read-batch`.
- [ ] **Step 5: Commit.** `feat(data): include тим самим запитом, known разом з include`

### Task 9: Бюджети сценаріїв читання ядра

**Files:**
- Create: `packages/simetra/src/data/testing/counting-transport.ts`, `packages/simetra/src/data/store/__tests__/budgets.test.ts`

**Interfaces:**
- Produces: `countingTransport(transport: DataTransport): { transport: DataTransport; stats(): { requests: number; byType: Record<string, number>; parts: number; requestBytes: number; responseBytes: number } }` — `jsonBytes` запиту й відповіді; корисні байти рахує тест з фікстури.

- [ ] **Step 1: Unit `budgets.test.ts`:** відкриття списку з `include` і `count` — 1 запит (частини `query` і `count` одного пакета), відповідь ≤ 1,1 × корисних + 2 КіБ; прокрутка на нову сторінку — ≤ 1 запит; повернення сторінки-знімка без змін — 1 запит, відповідь ≤ 8 Б × рядків + 2 КіБ (з копіями — плюс ключ, версія й копії на рядок), тіло ≤ 64 Б × ключів `known` + 2 КіБ; список → картка зі сховища з ТЧ і `include` — 1 запит; картка → список у межах `releaseDelayMs` — 0; системне перечитування вікна без змін — 1 запит.
- [ ] **Step 2: Зелений.** `pnpm --filter simetra test budgets`.
- [ ] **Step 3: Гейти B3-3b.** `pnpm --filter simetra test`, `pnpm metadata:check`, `pnpm test:db`.
- [ ] **Step 4: Commit.** `test(data): мережеві бюджети сценаріїв читання ядра`

**Готово B3-3b:** тести Task 6–9 і DB-кейс зелені; заборони `known` + `include` немає.

## B3-3c1. Хуки

### Task 10: `DataRuntimeProvider` і хуки

**Files:**
- Create: `packages/simetra/src/data/react/index.ts`, `provider.ts`, `use-rows.ts`, `use-row.ts`, `packages/simetra/src/data/runtime/holder.ts`, `packages/simetra/tsconfig.dom.json`
- Modify: `packages/simetra/tsconfig.json` (виключити файли проєкту DOM), скрипт `typecheck` (обидва проєкти), `packages/simetra/tsdown.config.ts` і `publishConfig.exports` / dev-`exports` (`./data/react`), `packages/designer/test/packaging/published-packages.pack.test.ts` (`simetra/data` — без `react`; `simetra/data/react` — у споживачі з `react`), лінт-зона T4 (вхід `src/data/react/**` може імпортувати `react`), `packages/simetra/src/data/index.ts` (лише `createRuntimeHolder` і типи), `packages/simetra/package.json` (devDependencies `jsdom`, `@testing-library/react`, `@testing-library/dom`, `react-dom`, `@types/react`, `@types/react-dom` — точні версії, група syncpack)
- Test: `packages/simetra/src/data/react/__tests__/hooks.test.ts` (Create, `// @vitest-environment jsdom`, проєкт `tsconfig.dom.json`, `createElement`)

**Interfaces:**
- Produces: `createRuntimeHolder(): RuntimeHolder`, `RuntimeHolder = { current(): DataRuntime | null; closed(): CloseReason | null; replace(next: DataRuntime | null, reason?: CloseReason): void; subscribe(listener: () => void): () => void }` (експорт з `simetra/data`; B3-6 бере його для SSR); `DataRuntimeProvider({ holder, children })`, `useRows`, `useRow` — з `simetra/data/react`; `useRows(spec)` → знімок §6.4 з діями вікна; `useRow({ object, id, tabularSections? })` → `{ row, tabularSections, version, editable, status, error?, needsRefresh, isStale }`.

- [ ] **Step 1: jsdom-тести:** `getServerSnapshot === getSnapshot`; незмінний вигляд — та сама посилка; жодного Suspense; `DataError` фільтра поза обчислювачем кидається в рендері до error boundary; `loading` лише без даних, далі `refreshing`; словник станів §6.5 у знімку (`synced`, `stale`, `removed` — з фейкового джерела); картка зі сховища — одразу; методи вікна в хуку; `refresh()` і `showNew()` змінюють склад, системне перечитування — ні; `strategy`, `truncated`, `refs`, `version`, `editable`, лінивий `count`; StrictMode «туди й назад» без запиту й без порожнього кадру; закритий рантайм — сталий знімок з причиною, не `loading`, доки вигляд нового рантайму не отримає даних; заміна рантайму тримачем — без рядків старого; хук без провайдера кидає `Error`; позначка знімка — через 500 мс, а `removed` і `purged` — у тому самому кадрі.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test hooks`.
- [ ] **Step 3: `.d.ts` і пакування.** Публічні типи без сесії, сховищ, `Scope`, `@tanstack/*`: `pnpm build:packages && pnpm test:packaging`.
- [ ] **Step 4: Commit.** `feat(data): DataRuntimeProvider, useRows і useRow`

**Готово B3-3c1:** jsdom-тести хуків і пакування зелені.

## B3-3c2. Компонент списку, пакування `./ui`, лінт, спеки

### Task 11: Компонент списку T5, вхід `./ui` і контрактний тест

**Files:**
- Create: `packages/simetra/src/ui/list/virtual-list.ts`, `packages/simetra/src/ui/list/__tests__/virtual-contract.test.ts`, `virtual-list.test.ts` (jsdom)
- Modify: `packages/simetra/src/ui/index.ts`, `packages/simetra/package.json` (`@tanstack/react-virtual` за Р7; `publishConfig.exports` і dev-`exports` `./ui`), `packages/simetra/tsdown.config.ts` (вхід `ui`), syncpack-конфігурація, `packages/designer/test/packaging/published-packages.pack.test.ts` (`./ui` у переліку exports; «each tier is self-contained» з `ui`; кейс `declares react as the only, optional peer` → `react` і `@tanstack/react-virtual`, обидва `optional`; серверний споживач без них)

**Interfaces:**
- Produces: `VirtualList({ view, renderRow, estimateSize, height })` — `useVirtualizer` з `getItemKey` за ключем, сталі ключі слотів завантаження, рядки в потоці під одним `translateY`, `anchorTo: "end"`, `virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false`, якір читання в layout-ефекті, перемонтування за `chain` з `initialOffset`, SSR — `initialRect`, `overflowAnchor: "none"`; видимий діапазон — у `view.setVisibleRange`, після гідратації — лише після першої прокрутки; `removed` — слот того самого розміру.

- [ ] **Step 1: Контрактний тест на піні:** вбудована компенсація росту за замовчуванням є; її вимикає властивість екземпляра; версії `@tanstack/react-virtual` і `virtual-core` дорівнюють піну.
- [ ] **Step 2: jsdom `virtual-list.test.ts`** (розкладки jsdom не має: `vi.mock("@tanstack/react-virtual")` зливає в опції `useVirtualizer` підмінені `observeElementRect`, `observeElementOffset`, `measureElement` і `scrollToFn`, що пише журнал прокрутки; `getBoundingClientRect` рядків — стаб; публічних пропсів для цього немає): `setVisibleRange` отримує ключі першого й останнього видимого; новий `chain` перемонтовує список з ціллю; ріст підміненої висоти рядка над видимими дає в журналі прокрутки зсув рівно на приріст (якір), а не на два (без вимкненої компенсації); до першої прокрутки після гідратації діапазон не звітується.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test virtual-contract virtual-list`.
- [ ] **Step 4: Пакування.** `pnpm build:packages && pnpm test:packaging`, `pnpm deps:check`.
- [ ] **Step 5: Commit.** `feat(ui): компонент списку на TanStack Virtual, вхід ./ui`

### Task 12: Лінт зони T5

**Files:**
- Modify: `packages/simetra/eslint.tier-zones.js` (наявні опції `no-restricted-imports` зони T5 — `@tanstack/react-virtual` і `@tanstack/virtual-core` поза `src/ui/list/**`, `useOptimistic` з `react`; `no-restricted-globals` — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`; `no-restricted-properties` — `Math.random`; блок `src/ui/list/**` повторює повний перелік заборон T5 без двох винятків теки), `packages/simetra/eslint.standard-columns.js` або спільний модуль (`no-restricted-syntax` для `src/ui/**` зливає селектори стандартних колонок і T5 в одних опціях, бо пізніший блок заміняє опції цілком: `onScroll` і `suppressHydrationWarning` — і як `JSXAttribute`, і як `Property` в об'єкті props `createElement`; `addEventListener("scroll", …)` поза `src/ui/list/**`)
- Test: `packages/simetra/test/tier-boundary.test.ts`

- [ ] **Step 1: Негативні тести** на `.ts` і `.tsx`: кожне правило — відмова в `src/ui/**`; `@tanstack/react-virtual` і `onScroll` у `src/ui/list/**` — прохід; ярусні заборони T5 і правила стандартних колонок у `src/ui/**` і `src/ui/list/**` лишаються.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test tier-boundary`, `pnpm lint`.
- [ ] **Step 3: Commit.** `feat(lint): правила зони T5 проти відомих джерел мерехтіння`

### Task 13: Гейти й спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (Рд40, §4.1, §4.2 — частковий маркер з колонками посилань і `known` разом з `include`; §3 — вхід `./ui` і peer віртуалізатора; §6.4 — `src/ui/list/`, структура знімка показу Р8, токен сторінки Р9; §14.3 — devDependencies jsdom-тестів (узгодити §12 і §14.3), межі пам'яті з виміру, дайджест сторінки відкладено з умовою; Додаток А — рядки B3-3 «внесено (B3-3)»), `docs/ROADMAP.md`

- [ ] **Step 1: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm deps:check`, `pnpm metadata:check`, `pnpm test:db`, `pnpm build:packages && pnpm test:packaging`, модельний тест повним прогоном.
- [ ] **Step 2: Правки спек**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 3: Commit.** `docs(spec): вікно, знімки показу, known з include і вхід ./ui під B3-3`

**Готово B3-3c2:** контрактний тест, jsdom-тести компонента, негативні тести лінту, пакування `./ui` зелені; спеки оновлено.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| сортувати рядки вікна на клієнті | `window.test.ts` |
| повторити keyset-запит без просування курсора | `window.test.ts` |
| системне перечитування змінює склад | `window.test.ts`, модельний тест |
| відповідь сторінки без токена покоління | `window.test.ts`, модельний тест |
| знімок без скоупу (`purge` не прибирає) | `window.test.ts`, модельний тест |
| повернення знімка без перевірки надгробків і `removed` | `window.test.ts`, модельний тест |
| `refs` знімка після `purge` цілі | `window.test.ts` |
| знімок бере значення повз `visibleRow` | `window.test.ts` |
| маркер знімка з показаних (`predict`) значень | `window.test.ts` |
| ключ без власника в `known` | `source.test.ts` |
| збирач з таймером замість такту | `batcher.test.ts` |
| збирач надсилає після `dispose()` | `batcher.test.ts` |
| `include` окремим запитом після сторінки | `budgets.test.ts` |
| `count` через адаптер замість транспорту | `batcher.test.ts` (перевизначений адаптер) |
| ref знімка повз запис сховища | `window.test.ts` |
| звуження не досягає ключів знімків (`rowsForRights` без знімків) | `window.test.ts` |
| хуки в `simetra/data` замість `simetra/data/react` | `published-packages.pack.test.ts` (споживач без `react`) |
| `getServerSnapshot` відмінний від `getSnapshot` | `hooks.test.ts` |
| затримка 500 мс на `purged` | `hooks.test.ts` |
| вбудована компенсація росту не вимкнена | `virtual-list.test.ts` |
| віртуалізатор — залежність, а не peer | `published-packages.pack.test.ts` (кейс peer) |
| позначка звуження лише в знімку, не в `Epochs` | `window.test.ts` (`narrow` під час перечитування) |
| повернення без перевірки цілей `refs` | `window.test.ts` |
| знімок перекриває запис сховища | `window.test.ts`, модельний тест |
| правило лінту T5 губить ярусну заборону чи правило стандартних колонок | `tier-boundary.test.ts` |
