# П4-B5a. Тригери `resume()` та інтервалу — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** рантайм T4 сам підтримує свіжість видимих виглядів без каналу
сигналів. Повернення вкладки (`resume()`), навігація (`navigated()`) й
інтервал `revalidateIntervalMs` перечитують видимі вигляди пакетом з
`known`, з межею частоти `resumeMinIntervalMs`. Звірка `version` на
`resume()` іде завжди, прихована вкладка не шле нічого.

**Архітектура:** стан свіжості на вигляді ядра (відмітка успішного
читання, спроба, лічильник збоїв, ознака польоту); `revalidate` з
single-flight і вибором виглядів; один предикат цілей для таймера й
`revalidate`; планувальник рантайму з одним таймером на найближчий строк;
події host-а `resume()`, `suspend()`, `navigated()` і початкова видимість;
`requestVersion()` з B3-4. Події однієї мікрозадачі збирає збирач B3-3 в
один запит.

**Стек:** TypeScript, Vitest (фейкові таймери), fast-check, Playwright
(`page.clock`).

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §6.1,
§6.3 («Частота»), §8.4 («Збіжність без нового приєднання», «Максимальний
час збіжності», «Зворотний тиск»), §10 («Перевірка версії»), §12 (рядки
бюджетів `resume()`, такту, прихованої вкладки), §13 (рядок B5), Рд37,
Рд44; платформна Р39, Р42; плани
[B3-3](2026-11-08-p4-b3-3-window-public-api.md) (збирач, `countingTransport`),
[B3-4/B3-5](2026-11-08-p4-b3-4-b3-5-write-receipts.md) Task 4 (частина
`version`, `requestVersion()`, таблиця «подія → `version`»),
[B3-6](2026-11-08-p4-b3-6-oracle-host-ssr.md) (тестовий хост, Task 11),
[B1c](2026-11-08-p4-b1c-conditional-batched-reads.md) (пакет читань,
`READ_BATCH_MAX`, `known`).

**Залежності:** після B3-4 і B3-6 (за порядком блоків; Task 5 — на хості
B3-6). Канал, приймач, приєднання без `recovered`, частина `rights` і звірка
прав на `resume()` — **B5b**. Імена ядра — з B3-2 (`CoreSession`,
`createCore`, `Subset`) і планів B3-3, B3-4; виконавець звіряє їх з `main`
(`orient --plan`). `requestVersion()` з B3-4 (форму вписано в план B3-4 Task 4, погоджено архітекторкою): метод
`CoreSession.requestVersion(): void` кладе частину `version` у збирач
поточної мікрозадачі; запит у дорозі чи частина, вже покладена в цій
мікрозадачі, — другої немає; останній запит `version` будь-якого джерела
ставить спільну відмітку `lastVersionAt` (Р8).

## Global Constraints

- Системне перечитування — лише видимих виглядів видимої вкладки; прихована вкладка — 0 запитів планувальника (хвостові завантаження, запис і опитування квитанцій планувальник не чіпає).
- `resume()` перечитує вигляд, лише коли його `refreshedAt` старший за `resumeMinIntervalMs` (типово 15 000 мс); частину `version` `resume()` шле завжди, крім злиття Р8.
- `refreshedAt` — час **старту** читання, а ставить його лише успішне осідання (Р2).
- Інтервал `revalidateIntervalMs` (типово 60 000 мс) — один таймер на рантайм на найближчий строк серед цілей; такт забирає всі цілі зі строком до `now + 0,1 × revalidateIntervalMs`.
- Після збою — пауза `min(I, 0,1 × I × 2^(failures − 1))` від старту спроби; успіх скидає її (Р7).
- `navigated()` — запит `version` не частіше разу на 60 000 мс від останнього запиту `version` будь-якого джерела; у прихованій вкладці — 0 запитів; перечитувань навігація не запускає.
- Одна подія — один синхронний прохід: `revalidate` усіх об'єктів без `await` між ними і `requestVersion()` у тій самій мікрозадачі, тож збирач B3-3 шле першу фазу одним запитом (до `READ_BATCH_MAX` частин; понад — кілька пакетів за B1c).
- Зворотний тиск §8.4 (чотири читання одночасно) — обмежувач B1c на рівні запиту; single-flight на вигляд — Р5.
- Після `dispose()` чи закриття сесії — 0 таймерів планувальника й 0 запитів.
- T4 не читає `document` і роутера: події й початкову видимість дає host.
- Опції `revalidateIntervalMs`, `resumeMinIntervalMs` — скінченні цілі > 0, `resumeMinIntervalMs ≤ revalidateIntervalMs`; інакше `TypeError` під час створення.
- Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Подія `runtime.suspend()` — `visibilitychange` у `hidden` (погоджено архітекторкою): знімає лише таймер свіжості; опитування квитанцій, запити в дорозі, `session-changed` і `purge` працюють далі; ідемпотентна; `resume()` коректний і без `suspend()`; після `dispose()` — нічого. Початкова видимість — опція `createDataRuntime({ visible })` (типово `true`): host передає `!document.hidden`, бо вкладка, відкрита у фоні, `visibilitychange` до першого показу не шле; серверний рантайм (B3-6) передає `false` і таймера не має | §8.4 вимагає інтервалу «лише поки вкладка видима», а T4 не читає `document` | §6.1 — `suspend()`, опція `visible` (Task 0) |
| Р2 | Стан свіжості `Subset`: `refreshedAt` (старт останнього успішного читання), `attemptAt` (старт останньої спроби), `failures`, `inFlight`; годинник — опція ядра `now`, типово `performance.now()` (монотонний: переведення системного часу строків не ламає; сон пристрою відкладає такт, але повернення дає `resume()`). Вигляд, що став `loaded` без читання (картка зі сховища, гідратація B3-6), отримує `refreshedAt = now` у момент `loaded` | старт, а не осідання, тримає межу §8.4 `I + rt`, а не `I + 2rt`; без відмітки такий вигляд не потрапив би в такт ніколи | §6.3 «Частота» — значення відмітки (Task 6) |
| Р3 | Один предикат цілей ядра `freshnessTargets(object)`: `loaded`, видимий, не в польоті, ТЧ — лише змонтована (як фільтр `revalidate`); його беруть і таймер, і `revalidate` | інакше кандидат, якого `revalidate` не бере, тримає таймер на нулі без запитів | немає |
| Р4 | `CoreSession.revalidate(object, { visibleOnly, select? })`: `select(view: FreshnessView) => boolean` — вибір планувальника; без `select` — як було. `CoreSession.freshnessOf(object): readonly FreshnessView[]` — легка вибірка без ключів (лише цілі Р3) | `activeViews` копіює склад; планувальник кличе вибірку на кожній зміні | немає |
| Р5 | Single-flight `revalidate`: вигляд з перечитуванням чи завантаженням у дорозі пропускається (`inFlight`), як `load()` | `resume()` під час такту в дорозі інакше дав би друге читання того самого вигляду | немає |
| Р6 | Планувальник — `runtime/freshness.ts` у рантаймі; таймер знімається синхронно на старті такту й `resume()`, а ставиться наново лише після осідання всіх читань проходу (`Promise.allSettled`) і на зміні стану свіжості (колбек ядра, злитий у мікрозадачу); строк вигляду: збоїв немає — `refreshedAt + I`, є — `attemptAt + пауза Р7` | таймер, поставлений до осідання, бачив би старий строк і дав другий запит | немає |
| Р7 | Пауза після збою (погоджено архітекторкою) — `min(I, 0,1 × I × 2^(failures − 1))`; `resume()` вигляду з паузою, що ще не минула, не перечитує | мертвий сервер інакше отримує запит щотакту від кожної вкладки | §8.4 — пауза після збою (Task 6) |
| Р8 | Злиття `resume()` (погоджено архітекторкою): другий `resume()` за `RESUME_COALESCE_MS` (1 000 мс) після попереднього не шле запитів, навіть частини `version`, але таймер свіжості відновлює, якщо його зняв `suspend()` між ними — злиття гасить запити, а не таймер; `requestVersion()` single-flight; спільна відмітка `lastVersionAt` для межі `navigated()` | повернення вкладки шле `visibilitychange` і `focus` окремими задачами — два запити при бюджеті «1» | §6.1, §12 — злиття подій повернення (Task 0) |
| Р9 | Бюджет «`resume()` чи такт, нічого не змінено» — ≤ 1 запит на фазу на рантайм (погоджено архітекторкою), і кожен сценарій бюджету в §12 і в тестах називає число фаз явно: вікно й картка без `full` та `include` — 1 запит; `full` на N сторінок — N; `include` — +1 фаза; `full` на кілька сторінок, `include` і дочитування зниклих ключів дають свої наступні фази (≤ 1 запит на фазу на рантайм), понад `READ_BATCH_MAX` частин — кілька пакетів за B1c; читання через перевизначений адаптер об'єкта — свій запит його групи | `fetchFull` і `readFullAgain` читають фази послідовно — інакше бюджет недосяжний | §12 — уточнення рядка бюджету (Task 0) |

Р1, Р7, Р8, Р9 погоджено архітекторкою; решта — розвилки до погодження.

## Review Focus

1. **Повернення вкладки (`visibilitychange` → `visible`, потім `focus`)**:
   рівно 1 запит (Task 3, Task 5).
2. **Сервер недоступний 10 хв**: рівно 12 запитів одного вигляду, а не
   петля чи запит щотакту (Task 2).
3. **Картка зі сховища без живого списку**: перечитана тактом (Task 1,
   Task 2).
4. **Вкладка, відкрита у фоні**: 0 запитів до першого показу (Task 3,
   Task 5).
5. **`dispose()` під час перечитування в дорозі**: після його осідання — 0
   таймерів (Task 2).

---

### Task 0: Поділ рядка B5 і події host-а в спеці

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
  - §13: рядок B5 ділиться на **B5a** «Тригери `resume()` та інтервалу» (обсяг цього плану; залежності B3-4, B3-6; готово — unit планувальника, бюджети й модельний тест з подіями зелені, браузерні бюджети — у чотирьох ногах) і **B5b** «Приймач сигналів і знімок прав» (решта рядка B5; залежності B2, ПГ-4, B5a);
  - §12 «Належність кейсів блокам» — «частота — B5a, сигнали — B5b»; у рядках бюджетів частина `rights` — «з B5b»; рядок «`resume()` чи такт, нічого не змінено» — уточнення Р9 з числом фаз кожного сценарію (вікно й картка — 1; `full` на N сторінок — N; `include` — +1);
  - §6.1 — `resume()`, `suspend()`, `navigated()` як API рантайму, межі Р1, опція `visible`, злиття Р8 (усі правки §6.1 — лише тут);
  - решта посилань на B5 у спеці й Додатку А — на B5a чи B5b за змістом.
- Modify: плани з посиланнями на B5 (`grep -rn 'B5' docs/superpowers/plans docs/superpowers/specs`): B3-3 Р4, B3-6 Task 11, B3-4 Task 4 — на B5a чи B5b за змістом.

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Commit.** `docs(spec): поділ B5 на B5a і B5b, події повернення вкладки`

### Task 1: Стан свіжості вигляду, предикат цілей і single-flight `revalidate`

**Files:**
- Modify: `packages/simetra/src/data/store/subsets.ts` (поля Р2 на `Subset`; `refreshedAt = now` у місцях, де `loaded` стає `true` без читання — картка зі сховища в `start()`; відмітка й `failures` на осіданні `load()`), `store/writer.ts` (`revalidate` з `select`; `revalidateViews` ставить `inFlight` і `attemptAt` на старті, `refreshedAt` = старт і `failures = 0` на успішному осіданні, `failures + 1` на збої, пропускає `inFlight` — Р5; старе покоління й відповідь після `purge` стану не пишуть), `store/core.ts` (опції `now` і `onFreshnessChange` у `createCore`; `freshnessTargets`, `freshnessOf` — Р3/Р4; колбек з `setVisible` і місць осідання), `store/types.ts` (`FreshnessView`), `store/defects.ts` (прапорці Step 3)
- Test: `packages/simetra/src/data/store/__tests__/writer.test.ts`, `views.test.ts`, `model.test.ts`

**Interfaces:**
- Produces: `FreshnessView = { spec: ViewSpec; refreshedAt: number; attemptAt?: number; failures: number }`; `CoreSession.freshnessOf(object): readonly FreshnessView[]`; `CoreSession.revalidate(object, { visibleOnly: boolean; select?: (v: FreshnessView) => boolean }): Promise<void>`; `createCore({ …, now?: () => number, onFreshnessChange?: () => void })`.

- [ ] **Step 1: Unit `writer.test.ts` (`it.each`, фейковий годинник просувається між відправкою й відповіддю):** до відповіді `refreshedAt` незмінний; після успіху — дорівнює часу старту, `failures` 0; збій — `refreshedAt` незмінний, `attemptAt` = старт, `failures + 1`; `select` перечитує лише вибрані; без `select` — як було; `revalidate` під час завантаження чи перечитування того самого вигляду — другого читання немає; старе покоління й відповідь після `purge` стану свіжості не пишуть; конкурентне завантаження, що стартувало пізніше, — `refreshedAt = max`.
- [ ] **Step 2: Unit `views.test.ts`:** картка зі сховища (`loaded` без читання) — `refreshedAt = now`; ТЧ з `setVisible(true)` без слухачів — не в `freshnessOf`; невидимий вигляд — не в `freshnessOf`.
- [ ] **Step 3: Модельний тест:** інваріанти — `refreshedAt` не зменшується; вигляд, чиє останнє читання впало, зберіг попередню відмітку; кожен вигляд з `loaded` має `refreshedAt`. Самотест: дефекти `freshness-stamp-on-send` (відмітка на відправці) і `freshness-stamp-on-failure` (відмітка на збої) — модель червона.
- [ ] **Step 4: Червоний → реалізація → зелений.** `pnpm --filter simetra test writer views model`.
- [ ] **Step 5: Commit.** `feat(data): стан свіжості вигляду й single-flight revalidate`

### Task 2: Планувальник інтервалу

**Files:**
- Create: `packages/simetra/src/data/runtime/freshness.ts`, `packages/simetra/src/data/runtime/__tests__/freshness.test.ts`
- Modify: `runtime/runtime.ts` (опції `revalidateIntervalMs`, `resumeMinIntervalMs`, `visible`, `now` з перевіркою `TypeError`; створення планувальника; `dispose()` зупиняє його); наявні тести рантайму з фейковими таймерами понад 60 с (`runtime/__tests__/*.test.ts`) — виконавець перевіряє, що живий таймер не додав їм запитів

**Interfaces:**
- Consumes: `CoreSession.freshnessOf`, `revalidate` з `select` (Task 1); `CoreSession.requestVersion()` (B3-4, форма — у «Залежностях»).
- Produces: `createFreshness({ core, objects, now, setTimer, clearTimer, intervalMs, resumeMinMs, visible, defects? }): { resume(): void; suspend(): void; navigated(): void; dispose(): void }`; `setTimer`/`clearTimer` типово `setTimeout`/`clearTimeout`; `defects` — прапорці самотесту Task 4.

- [ ] **Step 1: Unit (фейкові таймери Vitest; активні таймери — `vi.getTimerCount()` мінус таймери ядра з `serviceSizes()`):**
  - є видимі цілі — рівно 1 таймер; `resume()` п'ять разів поспіль — 1 таймер; цілей немає — 0;
  - строки t, t + 0,05·I, t + 0,15·I (три вигляди двох об'єктів): такт бере перші два одним викликом транспорту (`countingTransport`) і не бере третього; третій — своїм тактом;
  - п'ять виглядів трьох об'єктів зі спільним строком — 1 виклик транспорту (прохід синхронний);
  - таймер знімається на старті такту й ставиться після осідання: такт з відповіддю через 5 с — другого запиту до наступного строку немає;
  - збій: сервер недоступний з `t = 0`, вигляд свіжий у `t = 0`, `I` = 60 с — за 600 с рівно 12 запитів (60, 66, 78, 102, 150, 210 … 570 с); кроки паузи 6/12/24/48/60 с перевірено окремо; успіх скидає паузу до 6 с;
  - невидимий завантажений вигляд поряд із видимим — не перечитано;
  - ТЧ без слухачів з `setVisible(true)` — таймер не стоїть на нулі (0 спрацювань за 10 с);
  - `setVisible(true)` кількох виглядів у одній мікрозадачі — одне перепланування;
  - `suspend()` — 0 таймерів; запит у дорозі осідає; новий таймер до `resume()` не ставиться; `suspend()` не зупиняє опитування квитанції `unknown` (B3-5) і хвостового завантаження;
  - прихована 10 хв — 0 запитів планувальника; позитивний контроль — той самий сценарій видимим: 10 запитів;
  - `visible: false` на створенні — 0 таймерів до `resume()`;
  - `dispose()` — 0 таймерів; такт, що вже спрацював, запиту не шле; `dispose()` під час перечитування в дорозі — після осідання 0 таймерів; закриття сесії — те саме;
  - опції `0`, `NaN`, `resumeMinIntervalMs > revalidateIntervalMs` — `TypeError`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test freshness runtime`.
- [ ] **Step 3: Commit.** `feat(data): планувальник інтервалу з одним таймером і паузою після збою`

### Task 3: `resume()`, `suspend()`, `navigated()` і бюджети

**Files:**
- Modify: `runtime/freshness.ts`, `runtime/runtime.ts` (публічні `DataRuntime.resume()`, `suspend()`, `navigated()` з JSDoc події браузера; опція `visible`), `packages/simetra/src/data/index.ts` (типи)
- Test: `runtime/__tests__/freshness.test.ts`, `runtime/__tests__/budgets.test.ts` (Create)

**Interfaces:**
- Produces: `DataRuntime.resume(): void`, `suspend(): void`, `navigated(): void`; `DataRuntimeOptions.visible?: boolean`, `revalidateIntervalMs?`, `resumeMinIntervalMs?`; сталі T4 `RESUME_COALESCE_MS = 1000`, `NAVIGATION_VERSION_MIN_MS = 60_000`.

- [ ] **Step 1: Unit:**
  - `resume()` — 1 запит: частина `version` і перечитування цілей з `refreshedAt`, старшим за `resumeMinIntervalMs`; другий `resume()` через 2 с — 1 запит лише з `version`; другий за 500 мс (злиття Р8) — 0;
  - справжня послідовність повернення: `resume()` (`visibilitychange`), за 50 мс `resume()` (`focus`) — 1 запит;
  - `resume` → `suspend` → `resume` у межах 1 000 мс — другий `resume()` запитів не шле, але таймер свіжості знову один (0 → 1 після другого `resume()`);
  - `suspend, suspend, resume` і `resume, resume` (за 2 с) — перечитування лише в першому запиті; таймер один;
  - `resume()` без цілей — лише `version`; `resume()` вигляду з паузою після збою, що ще не минула, — без його перечитування;
  - `resume()` під час такту в дорозі — другого читання вигляду немає;
  - `navigated()` двічі за 30 с — 1 запит `version`; рівно через 60 с — другий; одразу після `resume()` — 0 (спільна відмітка `lastVersionAt`); у прихованій вкладці — 0; перечитувань не запускає;
  - `resume()`, `suspend()`, `navigated()` після `dispose()` — нічого.
- [ ] **Step 2: Бюджети `budgets.test.ts`** (`countingTransport`; фікстура без перевизначених адаптерів — вікно, картка, ТЧ, `full` на одній сторінці; окремо — `full` на трьох сторінках з `include`; фікстури з копіями носіїв і без): `resume()` раніше за `resumeMinIntervalMs` — 1 запит, тіло ≤ 2 КіБ + 128 Б × об'єктів каталогу (без `rights` — B5b); `resume()` чи такт, нічого не змінено, вікно й картка без `full` та `include` — рівно 1 запит, тіло ≤ 64 Б × ключів `known` + 2 КіБ, відповідь ≤ 8 Б × рядків + 2 КіБ (для `resume()` — плюс частина `version`; у такту `version` немає); `full` на трьох сторінках — рівно 3 запити, з `include` — рівно 4 (Р9, фази названо в тесті); 17 об'єктів з видимими виглядами — 2 пакети (`READ_BATCH_MAX`); прихована вкладка — 0 з позитивним контролем.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test freshness budgets`.
- [ ] **Step 4: Commit.** `feat(data): resume(), suspend() і navigated() рантайму з бюджетами`

### Task 4: Модельний тест — кроки подій

**Files:**
- Modify: `packages/simetra/src/data/store/__tests__/model.test.ts` (рантайм-шар поверх наявної моделі: планувальник з `createFreshness` над ядром моделі й фейковим годинником), `store/defects.ts`

- [ ] **Step 1: Кроки:** `resume()`, `suspend()`, `navigated()`, `setVisible`, крок «до найближчого строку планувальника», чужа зміна на фейковому сервері, збій сервера на N кроків; модель бере малі інтервали (`revalidateIntervalMs` 2 000, `resumeMinIntervalMs` 500), тож такти справді трапляються.
- [ ] **Step 2: Інваріанти:** між `suspend()` і `resume()` — 0 перечитувань, які запустив планувальник; активних таймерів планувальника ≤ 1, і рівно 1, коли є видима ціль і вкладка видима; на ногах без збоїв зміна на сервері в момент `t` видима у видимому вигляді не пізніше `t + I + rt` (межа §8.4 від моменту зміни, з урахуванням черги обмежувача); `resume()` не перечитує вигляду, свіжішого за `resumeMinIntervalMs`.
- [ ] **Step 3: Самотест** (прапорці передаються в `createFreshness({ defects })`): `freshness-timer-per-view`, `freshness-resume-no-limit`, `freshness-interval-after-suspend`, `freshness-resume-no-version`, `freshness-no-reschedule` (такт не перепланується — проти межі збіжності) — модель червона; кожен прогін самотесту вимагає щонайменше одного такту.
- [ ] **Step 4: Зелений.** `pnpm --filter simetra test model`.
- [ ] **Step 5: Commit.** `test(data): модельний тест з подіями свіжості`

### Task 5: Браузерні бюджети (тестовий хост B3-6)

**Files:**
- Modify: `packages/test-host/src/client.tsx` (`createDataRuntime({ visible: !document.hidden, … })`; `resume()` на `focus` і `visibilitychange` → `visible`, `suspend()` на `visibilitychange` → `hidden`, `navigated()` на зміні маршруту; малі інтервали з конфігурації хоста лише для e2e: `revalidateIntervalMs` 2 000, `resumeMinIntervalMs` 500), `src/router.tsx` (серверний рантайм — `visible: false`), `packages/test-host/e2e/budgets.spec.ts`, маніфести ніг `packages/test-host/e2e/manifest.<project>.<build>.json` (B3-6 Р8)

- [ ] **Step 1: Бюджети** (час — `page.clock`; видимість — `addInitScript`, що перевизначає `document.visibilityState` і `hidden`, і `dispatchEvent(new Event("visibilitychange"))`: перевіряється проводка хоста, а не браузерний механізм видимості; лічильник звіряється з мережевим журналом `/_serverFn/`, B3-6 Р7, і частина `version` теж іде через `/_serverFn/`):
  - повернення `hidden → visible`, потім `focus` за 50 мс — рівно 1 запит;
  - фокус після межі без змін — 1 запит, відповідь з маркерами;
  - прихована на 5 інтервалів — 0 запитів; позитивний контроль — та сама тривалість видимою: рівно 5;
  - сторінка відкрита прихованою (`visibilityState = "hidden"` до завантаження) — 0 запитів після гідратації до першого показу; показ — 1;
  - навігація двічі за 30 с — 1 запит `version`.
- [ ] **Step 2: Маніфести ніг** — додати id нових тестів; повний прогін `e2e` у чотирьох комбінаціях зелений (нові обробники `focus` не зсувають кадрів наявних сценаріїв).
- [ ] **Step 3: Commit.** `test(test-host): браузерні бюджети resume() та інтервалу`

### Task 6: Спеки й гейти

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§6.3 «Частота» — значення відмітки Р2, предикат Р3, single-flight Р5; §8.4 — пауза Р7; Додаток А — рядки B5a «внесено (B5a)»; §6.1 не чіпається — Task 0), `docs/ROADMAP.md` (B5a)

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm build:packages && pnpm test:packaging`; `ORACLE_BUILD=production pnpm --filter test-host e2e --project=chromium` і решта ніг.
- [ ] **Step 3: Commit.** `docs(spec): тригери resume() та інтервалу під B5a`

**Готово B5a:** unit стану свіжості, планувальника, подій і бюджетів, модельний тест з подіями зелені; браузерні бюджети зелені в чотирьох ногах.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| відмітка на відправці, а не на осіданні | `writer.test.ts` (годинник між відправкою й відповіддю), модельний тест (`freshness-stamp-on-send`) |
| відмітка на збої | `writer.test.ts`, модельний тест |
| відмітка = час осідання замість старту | `writer.test.ts` |
| картка зі сховища без відмітки | `views.test.ts`, `freshness.test.ts` |
| `revalidate` без single-flight | `writer.test.ts`, `freshness.test.ts` (`resume()` під час такту) |
| таймер на кожен вигляд | `freshness.test.ts` (рівно 1 таймер), модельний тест |
| такт без вікна 10 % чи з усіма видимими | `freshness.test.ts` (строки t, t + 0,05·I, t + 0,15·I) |
| таймер ставиться до осідання | `freshness.test.ts` |
| повтор після збою без паузи | `freshness.test.ts` (рівно 12 за 600 с) |
| пауза не скидається на успіху | `freshness.test.ts` |
| інтервал після `suspend()` | `freshness.test.ts`, модельний тест |
| `visible: false` ігнорується | `freshness.test.ts`, `budgets.spec.ts` (відкрита прихованою) |
| `resume()` без межі `resumeMinIntervalMs` | `freshness.test.ts`, модельний тест |
| `resume()` без частини `version` | `freshness.test.ts`, модельний тест |
| два `resume()` повернення — два запити | `freshness.test.ts`, `budgets.spec.ts` |
| злиття `resume()` гасить і відновлення таймера | `freshness.test.ts` (`resume` → `suspend` → `resume`) |
| `navigated()` без межі 60 с чи без спільної відмітки | `freshness.test.ts` |
| `suspend()` зупиняє опитування квитанції | `freshness.test.ts` |
| таймер переживає `dispose()` | `freshness.test.ts` (0 таймерів після осідання) |
| перечитування невидимого вигляду | `freshness.test.ts` |
| прохід з `await` між об'єктами | `freshness.test.ts` (5 виглядів — 1 виклик) |
