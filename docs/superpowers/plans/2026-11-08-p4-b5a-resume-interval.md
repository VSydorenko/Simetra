# П4-B5a. Тригери `resume()` та інтервалу — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** рантайм T4 сам підтримує свіжість видимих виглядів без каналу
сигналів. Фокус чи повернення вкладки (`resume()`), навігація
(`navigated()`) й інтервал `revalidateIntervalMs` перечитують видимі вигляди
одним пакетом з `known`, з межею частоти `resumeMinIntervalMs`. Звірка
`version` на `resume()` іде завжди.

**Архітектура:** відмітка останнього успішного осідання на вигляді ядра;
`revalidate` з фільтром строку; планувальник рантайму з одним таймером на
найближчий строк серед видимих виглядів; події host-а `resume()`,
`suspend()` і `navigated()`; частина `version` — через `requestVersion()` з
B3-4. Пакет збирає збирач B3-3 (одна мікрозадача — один запит).

**Стек:** TypeScript, Vitest (фейкові таймери), fast-check.

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §6.1
(події host-а, опції рантайму), §6.3 (перечитування, «Частота»), §8.4
(«Збіжність без нового приєднання», «Максимальний час збіжності»,
«Зворотний тиск»), §10 («Перевірка версії»), §12 (рядки бюджетів
`resume()`, такту інтервалу й прихованої вкладки), §13 (рядок B5), Рд37,
Рд44; платформна Р39; план
[B3-4/B3-5](2026-11-08-p4-b3-4-b3-5-write-receipts.md) Task 4 (таблиця
«подія → `version`», `requestVersion()`), план
[B3-3](2026-11-08-p4-b3-3-window-public-api.md) (збирач, `countingTransport`),
план [B3-6](2026-11-08-p4-b3-6-oracle-host-ssr.md) Task 11 (браузерні
бюджети `resume()` віддано в B5).

**Залежності:** після B3-4 (`requestVersion()`, частина `version` у збирачі)
і B3-6 (тестовий хост — лише для Task 5). Канал, приймач сигналів,
приєднання без `recovered`, частина `rights` і звірка прав на `resume()` —
**B5b** (після ПГ-4 і B2). Імена ядра — з B3-2 і планів B3-3, B3-4;
виконавець звіряє їх з `main` (`orient --plan`).

## Global Constraints

- Системне перечитування — лише видимих виглядів видимої вкладки; прихована вкладка — 0 запитів.
- `resume()` перечитує вигляд лише тоді, коли його остання відмітка старша за `resumeMinIntervalMs` (типово 15 000 мс); частину `version` `resume()` шле завжди.
- Відмітку вигляд отримує після успішного осідання (завантаження чи перечитування), а не на відправці; помилка відмітки не ставить.
- Інтервал `revalidateIntervalMs` (типово 60 000 мс) — один таймер на рантайм на найближчий строк серед видимих виглядів; такт забирає одним пакетом усі вигляди, чий строк настав чи настане протягом 10 % інтервалу; інтервал вигляду скидається після кожного його перечитування.
- `navigated()` — запит `version` не частіше разу на 60 000 мс; перечитування виглядів навігація не запускає.
- Один пакет — одна мікрозадача збирача B3-3: усі перечитування й частина `version` однієї події йдуть одним запитом транспорту (до `READ_BATCH_MAX` частин; понад — кілька пакетів за правилом B1c).
- Зворотний тиск §8.4: не більше чотирьох читань одночасно, single-flight на вигляд — наявні механізми ядра; планувальник не обходить їх.
- Після `dispose()` чи закриття сесії — жодного таймера й запиту.
- T4 не читає `document` і роутера: події кличе host.
- Коментарі — українською й про «чому».

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Подія host-а `runtime.suspend()` — `visibilitychange` у `hidden`; між `suspend()` і `resume()` таймер інтервалу знято, і жодна подія перечитувань не запускає | §8.4 вимагає інтервалу «лише поки вкладка видима», а T4 не читає `document`; без події T4 не знає, що вкладку сховано | §6.1 — подія `suspend()` (Task 0) |
| Р2 | Відмітка — `refreshedAt` на підмножині ядра (`Subset`), час з `Date.now()` через годинник рантайму, який підставляє тест; ставить її `commit`, що осідає завантаження чи перечитування вигляду | одне місце осідання для обох шляхів; відмітка на відправці дала б «свіжий» вигляд, чия відповідь упала | немає |
| Р3 | `Core.revalidate(object, { visibleOnly, dueBy? })`: `dueBy` (мс) лишає лише вигляди з `refreshedAt + interval ≤ dueBy`, де `interval` — параметр виклику; без `dueBy` — як було | перечитувати слід лише вигляди, чий строк настав; решта йде своїм тактом | немає |
| Р4 | Планувальник — модуль `runtime/freshness.ts` у рантаймі, не в ядрі: він знає опції, події host-а й годинник, а ядро дає лише `revalidate`, `activeViews` і відмітки | ядро лишається без таймерів подій; один таймер на рантайм | немає |
| Р5 | `resume()` кличе `revalidate` усіх об'єктів з видимими виглядами з `dueBy = now` та `interval = resumeMinIntervalMs` і `requestVersion()` в одній мікрозадачі | §12: «`resume()`, нічого не змінено — 1 на рантайм» | немає |
| Р6 | Такт інтервалу — `revalidate` з `dueBy = now + 0,1 × revalidateIntervalMs` та `interval = revalidateIntervalMs`, потім перепланування на новий найближчий строк | §8.4: такт забирає й вигляди, чий строк настане протягом 10 % | немає |

Кожне рішення — розвилка до погодження архітекторкою.

## Review Focus

1. **`resume()` двічі поспіль за 1 с**: друге перечитує нуль виглядів, але
   частину `version` шле (Task 3).
2. **Вигляд, чиє перечитування впало**: відмітки немає, тож наступний
   `resume()` перечитує його знову (Task 1, Task 3).
3. **`suspend()` під час перечитування в дорозі**: відповідь осідає, але
   новий таймер не ставиться до `resume()` (Task 2).
4. **Невидимий вигляд, що став видимим** (`setVisible(true)`): потрапляє в
   найближчий такт за своєю відміткою, а не чекає повного інтервалу від
   моменту появи (Task 2).
5. **`dispose()` з таймером, що вже спрацював і чекає мікрозадачі**: запиту
   немає (Task 2).

---

### Task 0: Поділ рядка B5 і подія `suspend()` у спеці

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` — §13: рядок B5 ділиться на **B5a** «Тригери `resume()` та інтервалу» (обсяг цього плану; залежність B3-4, для браузерних бюджетів — B3-6; готово: unit планувальника й бюджети `resume()` та такту зелені) і **B5b** «Приймач сигналів і знімок прав» (решта рядка B5: знімок прав, частина `rights` і її звірка на `resume()`, приймач, приєднання без `recovered`, `./data/centrifugo`, `purge` за втратою `read`, `refreshTokens`; залежності B2, ПГ-4, B5a); §12 «Належність кейсів блокам» — «частота — B5a, сигнали — B5b»; рядки бюджетів §12 «з B5» → «з B5b» для частини `rights`; посилання на B5 в інших рядках §13 і Додатку А (`grep -n 'B5' …`) — на B5a чи B5b за змістом; §6.1 — подія `runtime.suspend()` (Р1)
- Modify: `docs/superpowers/plans/2026-11-08-p4-b3-4-b3-5-write-receipts.md` — таблиця «подія → `version`» уже називає B5a і B5b; перевірити, що назви збігаються

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Commit.** `docs(spec): поділ B5 на B5a і B5b, подія suspend()`

### Task 1: Відмітка свіжості й `revalidate` за строком

**Files:**
- Modify: `packages/simetra/src/data/store/subsets.ts` (`refreshedAt?: number` на `Subset`), `store/writer.ts` (`revalidate` з `dueBy` і `interval`; відмітка в `commit` осідання), `store/core.ts` (опція `now: () => number` ядра, типово `Date.now`; `revalidate(object, { visibleOnly, dueBy?, interval? })`; `refreshedAt` у `ActiveView`), `store/types.ts` (`ActiveView.refreshedAt`)
- Test: `packages/simetra/src/data/store/__tests__/writer.test.ts` (наявні кейси `revalidate`), `model.test.ts`

**Interfaces:**
- Produces: `ActiveView.refreshedAt: number | undefined`; `Core.revalidate(object, { visibleOnly: boolean; dueBy?: number; interval?: number }): Promise<void>`; `CoreOptions.now?: () => number`.

- [ ] **Step 1: Unit (`it.each`):** завантаження ставить `refreshedAt = now` тим самим `commit`, що осідає; перечитування — так само; помилка читання — відмітку не змінює; `revalidate` з `dueBy` перечитує лише вигляди з `refreshedAt + interval ≤ dueBy`; без `dueBy` — усі, як було; невидимий вигляд з `visibleOnly` — пропущено; `purge` після старту — повторний прохід за тим самим правилом строку; відповідь старого покоління відмітки не ставить.
- [ ] **Step 2: Модельний тест** — крок «плин часу» вже є (B3-2); інваріант «`refreshedAt` вигляду ≤ `now` і не зменшується»; самотест: дефект «ставити відмітку на відправці» червонить модель (`store/defects.ts`).
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test writer model`.
- [ ] **Step 4: Commit.** `feat(data): відмітка свіжості вигляду й revalidate за строком`

### Task 2: Планувальник інтервалу

**Files:**
- Create: `packages/simetra/src/data/runtime/freshness.ts`, `packages/simetra/src/data/runtime/__tests__/freshness.test.ts`
- Modify: `runtime/runtime.ts` (опції `revalidateIntervalMs`, `resumeMinIntervalMs`, `now`; створення планувальника; `dispose()` зупиняє його), `store/core.ts` (сповіщення планувальника про зміну видимості чи відмітки — колбек `onFreshnessChange`, без таймерів у ядрі)

**Interfaces:**
- Consumes: `Core.activeViews`, `Core.revalidate` з Task 1, `requestVersion()` з B3-4.
- Produces: `createFreshness({ core, objects, now, setTimer, clearTimer, intervalMs, resumeMinMs, requestVersion }): { resume(): void; suspend(): void; navigated(): void; reschedule(): void; dispose(): void }` — `setTimer`/`clearTimer` типово `setTimeout`/`clearTimeout`.

- [ ] **Step 1: Unit (фейкові таймери Vitest):** один таймер на рантайм за будь-якої кількості видимих виглядів (лічильник `setTimer` активних ≤ 1); таймер — на найближчий строк `min(refreshedAt) + intervalMs` серед видимих; такт перечитує вигляди зі строком до `now + 0,1 × intervalMs` одним викликом транспорту (`countingTransport`); після такту — перепланування; вигляд без відмітки (не завантажено) таймера не ставить; `setVisible(true)` вигляду зі старою відміткою — перепланування на його строк; `suspend()` знімає таймер, відповідь у дорозі осідає, а новий таймер до `resume()` не ставиться; `dispose()` — таймер знято, такт, що вже спрацював, запиту не шле; закриття сесії (`session-changed`) — те саме; вкладка прихована 10 хв — 0 запитів.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test freshness`.
- [ ] **Step 3: Commit.** `feat(data): планувальник інтервалу перечитувань з одним таймером`

### Task 3: `resume()` і `navigated()`

**Files:**
- Modify: `runtime/freshness.ts`, `runtime/runtime.ts` (публічні `DataRuntime.resume()`, `suspend()`, `navigated()`), `packages/simetra/src/data/index.ts` (типи), `packages/simetra/src/data/react/` — без змін (події кличе host, не хуки)
- Test: `runtime/__tests__/freshness.test.ts`

**Interfaces:**
- Produces: `DataRuntime.resume(): void`, `DataRuntime.suspend(): void`, `DataRuntime.navigated(): void`; JSDoc кожної — яку подію браузера host до неї веде (§6.1).

- [ ] **Step 1: Unit:** `resume()` — один запит транспорту з частиною `version` і перечитуванням видимих виглядів, старших за `resumeMinIntervalMs`; `resume()` двічі за 1 с — другий запит лише з частиною `version`; `resume()` без видимих виглядів — лише `version`; `resume()` після `suspend()` — ставить таймер інтервалу наново; вигляд, чиє перечитування впало, наступний `resume()` перечитує; `navigated()` — запит `version` не частіше разу на 60 с (два виклики за 30 с — один запит), перечитувань не запускає; `resume()` після `dispose()` — нічого; перечитування з `known` (B1c): сторінка без змін — відповідь з маркерами.
- [ ] **Step 2: Бюджети §12 через `countingTransport` (B3-3 Р5):** `resume()` раніше за `resumeMinIntervalMs` — 1 запит, тіло й відповідь ≤ 2 КіБ + 128 Б × об'єктів каталогу (без частини `rights` — B5b); `resume()` чи такт, нічого не змінено — 1 на рантайм, відповідь ≤ 8 Б × рядків + 2 КіБ (для `resume()` — плюс частина `version`); прихована вкладка — 0.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test freshness`.
- [ ] **Step 4: Commit.** `feat(data): resume(), suspend() і navigated() рантайму`

### Task 4: Модельний тест — кроки подій

**Files:**
- Modify: `store/__tests__/model.test.ts` (або тест рантайму поверх моделі — виконавець бере місце, де вже є кроки плину часу), `store/defects.ts`

- [ ] **Step 1: Кроки:** `resume()`, `suspend()`, `navigated()`, такт таймера, плин часу; інваріанти: між `suspend()` і `resume()` — 0 запитів; у кожен момент активних таймерів планувальника ≤ 1; видимий вигляд на живій вкладці перечитано не пізніше `revalidateIntervalMs` + час одного перечитування після попередньої відмітки (межа збіжності §8.4); `resume()` не перечитує вигляду, свіжішого за `resumeMinIntervalMs`.
- [ ] **Step 2: Самотест:** дефекти «таймер на кожен вигляд», «перечитувати на `resume()` без межі частоти», «інтервал працює після `suspend()`», «`resume()` без частини `version`» — модель червона.
- [ ] **Step 3: Зелений.** `pnpm --filter simetra test model`.
- [ ] **Step 4: Commit.** `test(data): модельний тест з подіями свіжості`

### Task 5: Браузерні бюджети `resume()` (тестовий хост B3-6)

**Files:**
- Modify: `packages/test-host/src/client.tsx` (host кличе `resume()` на `focus` і `visibilitychange` → `visible`, `suspend()` на `visibilitychange` → `hidden`, `navigated()` на зміні маршруту роутера), `packages/test-host/e2e/budgets.spec.ts`, маніфести тестів ніг (`packages/test-host/e2e/manifest.*.json`, B3-6 Р8)

- [ ] **Step 1: Бюджети** (лічильник звіряється з мережевим журналом `/_serverFn/`, B3-6 Р7): фокус раніше за `resumeMinIntervalMs` — 1 запит у межах рядка §12; фокус після межі без змін — 1 запит, відповідь з маркерами; вкладка прихована (`page.evaluate` з `visibilityState` через емуляцію Playwright) на 2 інтервали — 0 запитів, з позитивним контролем (та сама тривалість видимою — ≥ 1 такт); навігація двічі за 30 с — 1 запит `version`.
- [ ] **Step 2: Прогін у чотирьох комбінаціях** (`ORACLE_BUILD` × `--project`).
- [ ] **Step 3: Commit.** `test(test-host): браузерні бюджети resume() та інтервалу`

### Task 6: Спеки й гейти

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§6.1 — `resume()`, `suspend()`, `navigated()` як API рантайму; §6.3 «Частота» — відмітка `refreshedAt` і `dueBy`; Додаток А — рядки B5a «внесено (B5a)»), `docs/ROADMAP.md` (B5a)

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm build:packages && pnpm test:packaging`; Task 5 — `ORACLE_BUILD=production pnpm --filter test-host e2e --project=chromium` і решта ніг.
- [ ] **Step 3: Commit.** `docs(spec): тригери resume() та інтервалу під B5a`

**Готово B5a:** unit планувальника, `resume()`/`navigated()`, бюджети через `countingTransport` і модельний тест з подіями зелені; браузерні бюджети зелені в чотирьох ногах.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| відмітка на відправці, а не на осіданні | `writer.test.ts`, модельний тест |
| помилка читання ставить відмітку | `writer.test.ts` |
| таймер на кожен вигляд | `freshness.test.ts`, модельний тест |
| такт без вікна 10 % (кожен вигляд окремим пакетом) | `freshness.test.ts` (лічильник запитів) |
| інтервал працює після `suspend()` | `freshness.test.ts`, модельний тест |
| `resume()` без межі `resumeMinIntervalMs` | `freshness.test.ts`, модельний тест |
| `resume()` без частини `version` | `freshness.test.ts`, модельний тест |
| `navigated()` без межі 60 с | `freshness.test.ts` |
| таймер переживає `dispose()` | `freshness.test.ts` |
| перечитування невидимого вигляду | `freshness.test.ts`, `budgets.spec.ts` (прихована вкладка) |
