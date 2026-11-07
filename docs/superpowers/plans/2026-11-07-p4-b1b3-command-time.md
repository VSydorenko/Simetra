# П4-B1b-3 — бюджет часу, коди команди й масиви ТЧ: план реалізації

> **Статус:** на прийманні архітекторкою П4-B (2026-11-07). Підсумок аудиту —
> наприкінці файла.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** транзакція команди T3 тримає бюджет часу й межі простою, мапить
тайм-аути, замки й обриви на окремі коди, не валить процес на `FATAL`
простоюючого клієнта, а масив ТЧ з MCP і `ctx.run` не видаляє рядків, яких
викликач не назвав.

**Architecture:** усе в T3 (`simetra/server`) і designer; T0 отримує лише код
`command.busy` і поле `deleteIds` схеми операції. Єдина точка перед кожним
оператором — `Transaction.enqueue` (`server/transaction.ts`): там бюджет
часу, `statement_timeout` і межа `COMMIT`. Порт `fromPgPool` тримає слухача
`error` на час видачі клієнта.

**Tech Stack:** TypeScript 7, Zod 4, Vitest (fake timers), `pg`, PostgreSQL 17.

**Spec:** [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) — §7.1
(«Межі й тайм-аути команди», «Час», «Утрата з'єднання»), §7.3, §11 інв. 17,
§12 (кейси B1b-3 за «Належністю кейсів»), §13 (рядок B1b-3), Додаток А (рядки
з B1b-3). Чинна транзакція — [спека П4](../specs/2026-10-26-p4-runtime-design.md)
§6.5, §6.9, §6.10, §6.14.

## Global Constraints

- Мова: коментарі коду — українською, «чому»; JSDoc, опис MCP, скіл — англійською.
- Коміти: Conventional Commits, український опис, без трейлерів; коміти й
  push дозволено, PR відкриває архітекторка.
- T0 — лише `zod`; без реекспортів старих шляхів.
- Сталі зі спеки (§7.1): бюджет транзакції — орієнтир 60 с; стеля оператора —
  30 с; `statement_timeout` = залишок, округлений вгору, ≥ 1 мс, **ніколи 0**;
  залишок ≤ 1 мс — `command.timeout` без оператора; `lock_timeout` — орієнтир 5 с.
- `25P03`/`25P04` → `command.timeout` зі знищенням з'єднання **лише до
  надсилання `COMMIT`**; будь-яка втрата з'єднання з надсиланням `COMMIT` і
  після — `command.unavailable`.
- `55P03` → `command.busy`; `57014` → `command.timeout` і для фаз запису.
- Повтор `40P01` — з паузою й джитером.
- Тести: скіл `.agents/skills/writing-tests/SKILL.md`; без `--` перед шаблоном
  vitest; DB-тест каже, чого не дає unit; повний `pnpm test:db` — раз, у
  задачі 9.
- Час у unit-тестах — `vi.useFakeTimers({ toFake: ["performance", "setTimeout"] })`;
  рантайм бере час з `performance.now()`, без інжекції годинника в API.
- Паралельно B1b-1 змінює T0 і T1 (`model/runtime/*`, `compiler/runtime-catalog.ts`):
  текстовий конфлікт розв'язує той, хто мерджить другим (rebase на `main`).

## Рішення архітекторки (2026-11-07)

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Ф1 | B1b-3 вводить сталу T0 `BATCH_MAX = 500` (`model/runtime/operation.ts`; одна стала, без зменшених налаштувань — їх дає B1b-2); межа фаз `ctx.run` рахується проти неї; понад межу — `command.depth` `reason: "phases"`. Окремої опції немає | §13: `BATCH_MAX` — з рядка B1b-2 у B1b-3 (у B1b-2 лишаються зменшені межі); §6.10 П4 — `reason` |
| Ф2 | Бюджет — на один виклик `runtime.run`, разом із повторами й паузами | §7.1 П4-B — одне речення |
| Ф3 | `deleteIds?: { <ТЧ>: uuid[] }` в операції `update` (у `create` — відмова схеми). Перевіряє T3 одиницею `[CONTEXT, check]` на початку фази, до хуків (контекст — той самий стан сесії, що в ядра; видимість простого SELECT від нього не залежить), **без замка рядка**: перевірка бачить надмножину рядків ядра (SELECT проти SELECT ∩ UPDATE/DELETE ядра) — fail-closed (замок перевернув би порядок замків ієрархічного довідника й у READ COMMITTED не серіалізує). Один оператор на ТЧ: версія власника й перший відсутній id. Власника не видно — перевірку пропущено (вердикт ядра); версія ≠ `expectedVersion` — пропущено (ядро дасть `command.conflict`); інакше пропущений наявний id — `command.invalid` `reason: "tabular-rows-missing"`, `path` ТЧ. Коректність без замка тримається на двох фактах — обидва умови механіки: (1) `expectedVersion` обов'язковий для `update` (`expectedVersionSchema` у `model/runtime/operation.ts`; лише `update` несе `tabularSections` з наявним власником); (2) кожна зміна змістових колонок рядків ТЧ підвищує версію власника (Рд27) — поширення копій носіїв виняток, але рядків не додає й не видаляє; тож паралельна вставка між перевіркою й ядром дає `command.conflict`. Перевіряється **вхідний** масив операції (того, хто її шле); правка повного масиву хуком — свідома дія довіреного коду. id і в масиві, і в `deleteIds` — `command.invalid`; зниклий id з `deleteIds` ігнорується. Сувора перевірка **типова (fail-closed)** для `runtime.run` і `ctx.run`; вимикає лише опція виклику `{ fullTabularArrays: true }` (ставитиме `createDataHandler`, B1b-2). Форма передачі `deleteIds` не несе | §7.1 П4-B — `reason`, механіка, типовий режим; §13 рядок B1b-2 — обробник ставить опцію |
| Ф4 | Без I/O при створенні рантайму. Запобіжники ставить оператор claims транзакції команди: `lock_timeout`, `idle_in_transaction_session_timeout` = бюджет + 1 с, і `transaction_timeout` = бюджет + 1 с лише за умови SQL `current_setting('server_version_num')::int >= 170000` — без зайвого кругового запиту й кешу версії | §7.1 П4-B — речення про PostgreSQL < 17; П4 §9 — «PostgreSQL ≥ 17» |
| Ф5 | `command.busy` — у `COMMAND_ERROR_CODES` T0 | немає |
| Ф6 | Стеля оператора тримається завжди: `statement_timeout = min(30 000, залишок)` в операторі claims команди (без кругового запиту), а перед оператором — нижче, коли залишок менший за чинне значення; ніколи 0 | §7.1 — одне речення |
| Ф7 | DB-кейс `transaction_timeout` (`25P04`) недосяжний — запобіжник = бюджет + 1 с, бюджет спрацьовує раніше; збережені `25P04`/`25P03` доводить unit межі `COMMIT`, DB — лише простій `FATAL` через драйвер `pg` | §12, рядок «DB simetra» |

Пункти реєстру боргу §7 (`23514` у ТЧ, спільний помічник утримання замка — лише
в `support/` без зміни поведінки кейсів, `UPDATE parent_id` у `carrier-locks`)
прибираються з реєстру в тому самому PR (задача 9).

## Review Focus

1. **`statement_timeout = 0`** за округлення чи від'ємного залишку — Postgres
   вимкнув би межу; тест задачі 3 («never sets 0»).
2. **`FATAL` на простоюючому клієнті** між операторами (хук чекає) не валить
   процес і не перетворюється на `command.unavailable` до `COMMIT`; DB-кейс
   задачі 8 через драйвер `pg`.
3. **Обрив саме на `COMMIT`** — результат невідомий, тож `command.unavailable`,
   навіть якщо збережено `25P03`; а відмова запобіжника на `COMMIT` (`42501`)
   — відомий відкат і лишається `command.forbidden`; тести задачі 4.
4. **`deleteIds` на першій фазі пакета й під правами**: перевірка мусить бачити
   рядки так само, як ядро, — інакше «порожній успіх» і тиха втрата; паралельна
   вставка між перевіркою й ядром дає `command.conflict` через версію; DB-кейс
   задачі 8 на фікстурі з функціями прав.
5. **Повтор після паузи вичерпує бюджет** — `command.timeout`, а не
   `command.retry-exhausted`; тест задачі 5.

---

### Task 1: коди команди

**Files:** Modify `packages/simetra/src/model/runtime/errors.ts`,
`packages/simetra/src/server/errors.ts`; Test `packages/simetra/src/server/__tests__/errors.test.ts`.

**Interfaces:** Produces `"command.busy"` у `COMMAND_ERROR_CODES`.

- [ ] **Step 1: Failing tests** (таблиця `it.each` у `errors.test.ts`): `55P03`
  у фазі запису й читання → `{ code: "command.busy" }`; `57014` у фазі запису
  й без фази → `{ code: "command.timeout" }`; `23514` CHECK реквізиту ТЧ
  (`table` = таблиця ТЧ, обмеження з колонкою) → `command.constraint` `check`
  з `attributes: ["<ТЧ>.<реквізит>"]` (пункт реєстру боргу §7 «`23514` у ТЧ»).
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test errors`.
- [ ] **Step 3: Implement** — гілки `55P03` і `57014` у `mapDatabaseError`;
  `logsDatabaseError` їх не логує як internal.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(server): коди command.busy і command.timeout команди`.

### Task 2: порт `fromPgPool` — слухач `error` на час видачі

**Files:** Modify `packages/simetra/src/server/port.ts`; Test `server/__tests__/port.test.ts`.

**Interfaces:**
- `PgPoolLike.connect()` повертає клієнта з `on(event: "error", fn)` і
  `removeListener(event: "error", fn)` (як `pg.PoolClient`).
- Produces: клієнт порту запам'ятовує першу помилку події `error`; наступний
  `query` відхиляється саме нею (з її `code`, напр. `25P03`), а не загальною
  «not queryable»; `release` знімає слухача.

- [ ] **Step 1: Failing tests** — `fakePool()` з емітером: подія `error` з
  `code: "25P03"` між запитами не кидає з процесу (немає необробленої
  помилки); наступний `query` відхиляється помилкою з `code: "25P03"`;
  після `release` слухач знято (кількість слухачів 0).
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test port`.
- [ ] **Step 3: Implement** — `node:events` не потрібен: тип структурний.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck` (designer передає `pg.Pool`).
- [ ] **Step 5: Commit** — `fix(server): слухач error клієнта порту на час видачі`.

### Task 3: бюджет часу транзакції

**Files:** Modify `packages/simetra/src/server/{transaction,runtime}.ts`;
Test `server/__tests__/transaction.test.ts`, `runtime.test.ts`, `harness.ts`.

**Interfaces:**
- `CommandRuntimeOptions.commandBudgetMs?: number` (ціле ≥ 1000, типово 60 000),
  `lockTimeoutMs?: number` (ціле ≥ 1, типово 5 000).
- `RuntimeState` + `budgetMs`, `lockTimeoutMs`.
- `STATEMENT_CEILING_MS = 30_000` (T3, не експортується з пакета); claims
  команди ставить `statement_timeout = max(1, min(STATEMENT_CEILING_MS, ceil(remaining)))` (Ф6).
- `harness.ts`: окрема стала claims команди; claims читання (`read-runtime.test.ts`)
  не змінюється.
- Дедлайн — `performance.now() + budgetMs` на початку `runCommand` (Ф2).

- [ ] **Step 1: Failing tests** (fake timers; послідовність викликів порту з
  `harness.ts`):
  - оператор claims **команди** (не читання) додає до наявних `set_config`
    `set_config('lock_timeout', $2, true)`,
    `set_config('idle_in_transaction_session_timeout', $3, true)` і
    `CASE WHEN current_setting('server_version_num')::int >= 170000 THEN set_config('transaction_timeout', $3, true) END`
    з `"5000"` і `"61000"` (Ф4); оператор claims читання не змінюється; окремого
    кругового запиту немає;
  - claims команди несе `set_config('statement_timeout', …)` = `max(1, min(30000, ceil(залишок)))`
    (і на повторі після паузи — від залишку, а не від повного бюджету):
    `"30000"` за бюджету 60 с і `"1000"` за бюджету 1 с (Ф6);
  - залишок ≥ 30 с — жодного окремого `statement_timeout`; залишок 12 345,2 мс перед
    оператором → перед ним `SELECT set_config('statement_timeout', $1, true)`
    з `"12346"`;
  - залишок 0,4 мс і від'ємний — `command.timeout` без надсилання оператора,
    далі `ROLLBACK`; «never sets 0»: залишок 1,2 мс → `"2"`, а не `"0"`/`"1"`;
  - перевірка між фазами: час вичерпано під час `beforeWrite` (JS) → наступна
    фаза не надсилає оператора, `command.timeout`;
  - `ctx.read` усередині хука проходить ту саму перевірку;
  - `commandBudgetMs: 500` і `lockTimeoutMs: 0` — відмова `createCommandRuntime`
    без I/O.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test transaction runtime`.
- [ ] **Step 3: Implement** — у `enqueue` перед кожним оператором:
  `remaining = deadline - performance.now()`; `remaining <= 1` →
  `this.close({ failure: command.timeout, retry: false, destroy: false })`;
  `remaining` менший за чинне значення `statement_timeout` (`Transaction` його
  пам'ятає) → спершу `statement_timeout` =
  `String(Math.max(1, Math.ceil(remaining)))` — крім `BEGIN` (поза
  транзакцією `set_config(…, true)` нічого не дає) і крім самого оператора
  claims. Ціна — додатковий круговий запит на оператор в останні 30 с
  бюджету; прийнята свідомо. Налаштування — у функції
  claims команди (окремо від `claimsStatement` читання); значення — зв'язаними
  параметрами.
- [ ] **Step 4: Run** — PASS; `pnpm --filter simetra test`; `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(server): бюджет часу транзакції команди`.

### Task 4: межа `COMMIT` і збережений `FATAL`

**Files:** Modify `packages/simetra/src/server/transaction.ts`; Test `transaction.test.ts`.

**Interfaces:** `terminalOf(raw, state, phase, commitSent: boolean)`; `Terminal` несе `code?: string` (SQLSTATE) — його читає пауза задачі 5.

- [ ] **Step 1: Failing tests:**
  - `25P03` і `25P04` на операторі фази (до `COMMIT`) → `command.timeout`,
    `release(true)` без `ROLLBACK`;
  - `25P03` у відповідь на `COMMIT` → `command.unavailable`, `release(true)`;
  - помилка без SQLSTATE на `COMMIT` → `command.unavailable` (як зараз);
  - `40001` на `COMMIT` і далі повторюється, а `42501` запобіжника на `COMMIT`
    лишається `command.forbidden` (наявні кейси `retries a 40001 on COMMIT` і
    `maps a guard refusal answered at COMMIT` зелені);
  - `25P03` на прелюдії `statement_timeout` перед `COMMIT` — `command.timeout`
    (`COMMIT` ще не надіслано).
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter simetra test transaction`.
- [ ] **Step 3: Implement** — `enqueue` позначає `commitSent` після перевірки
  бюджету й прелюдії, безпосередньо перед `query(COMMIT)`; `terminalOf`:
  `commitSent` і (`connectionLost` чи `25P03`/`25P04`) → `command.unavailable`
  `destroy: true`; решта SQLSTATE на `COMMIT` мапиться як зараз; до `COMMIT`
  `25P03`/`25P04` → `command.timeout` `destroy: true`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(server): межа COMMIT для тайм-аутів простою й транзакції`.

### Task 5: пауза з джитером перед повтором `40P01`

**Files:** `server/transaction.ts`; Test `transaction.test.ts`.

- [ ] **Step 1: Failing tests** (fake timers, `Math.random` підмінено):
  перед другою спробою після `40P01` — пауза `base·2^(n−1) + jitter`, де
  `base` = 20 мс, `jitter ∈ [0, base·2^(n−1))`; `40001` повторюється без паузи;
  пауза, що перетинає дедлайн, — `command.timeout` без нової спроби (Review
  Focus 5).
- [ ] **Step 2–4:** red → implement (`await new Promise(r => setTimeout(r, ms))`
  у `runCommand`) → green.
- [ ] **Step 5: Commit** — `feat(server): пауза з джитером перед повтором 40P01`.

### Task 6: `BATCH_MAX` і межа фаз `ctx.run`

**Files:** `packages/simetra/src/model/runtime/operation.ts`,
`packages/simetra/src/server/{transaction,hook-context}.ts`; Test `hooks.test.ts`,
`model/__tests__/runtime-contracts.test.ts`.

**Interfaces:** Produces T0 `export const BATCH_MAX = 500` (JSDoc: the most
phases of one batch and of `ctx.run` in one transaction); лічильник фаз
`ctx.run` у `Transaction`. Межу схеми пакета й конверта (`batch-too-large`)
дає B1b-2 — тут стала лише оголошується й рахує `ctx.run` (Ф1).

- [ ] **Step 1: Failing tests:** хук кличе `ctx.run` `BATCH_MAX + 1` разів (з
  `vi.spyOn` неможливо — стала; кейс будує фейкова база з відповідями на кожну
  фазу) → остання — `command.depth` `{ reason: "phases" }`, транзакція
  відкочена; фази вхідного пакета в лік не входять; T0: `BATCH_MAX === 500`.
- [ ] **Step 2–4:** red → implement → green; `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(server): межа кількості фаз ctx.run за BATCH_MAX`.

### Task 7: масиви ТЧ — `deleteIds`, хук бачить ТЧ цілком

**Files:** Modify `packages/simetra/src/model/runtime/{operation,module}.ts`,
`packages/simetra/src/server/{phase,hook-context,runtime,values}.ts`,
`packages/designer/src/tools/data-tools.ts`; Test
`model/__tests__/runtime-contracts.test.ts`, `server/__tests__/{runtime,hooks,values}.test.ts`,
`packages/designer/src/__tests__/data-tools.test.ts`, `mcp.test.ts` (бюджет
`TOOLS_LIST_BUDGET` — перезамір за правилом файла).

**Interfaces:**
- T0: `update` — `deleteIds?: Record<string, string[]>` (UUID, унікальні, ключ —
  логічне ім'я ТЧ, яка є в `tabularSections` операції); у `create` поля немає
  (сувора схема відхиляє); `Draft` — без `deleteIds`.
- T3: `runtime.run(session, input, options?: { fullTabularArrays?: true })` — сувора перевірка типова; опція її вимикає (Ф3).

- [ ] **Step 1: Failing tests:**
  - схема: `deleteIds` без відповідної ТЧ у `tabularSections`, дубль id,
    не-UUID, `deleteIds` у `create` — відмова зі шляхом;
  - сувора перевірка (типово і в `run`, і в `ctx.run`) — на початку фази, до
    `beforeWrite`, одиниця `[CONTEXT, check]` (той самий оператор контексту,
    що й перед ядром; асерт порядку викликів порту), на кожну ТЧ операції:
    `SELECT o."<версія>"::text AS version, (SELECT s."id" FROM <ТЧ> s WHERE s.<колонки FK> = o.<колонки цілі> AND s."id" <> ALL(ARRAY[$2::uuid, …]) LIMIT 1) AS missing FROM <власник> o WHERE o."<ключ>" = $1`
    (колонки — `parentConstraint` і `references` каталогу; масив параметрів —
    id масиву й `deleteIds`, параметр на id; порожній набір —
    `'{}'::uuid[]`, бо `ARRAY[]` — синтаксична помилка; без замка);
  - порожній масив ТЧ без `deleteIds`: наявні рядки → `tabular-rows-missing`,
    порожня ТЧ → проходить;
    - рядка немає (власника не видно) — перевірку пропущено, ядро вирішує;
    - `version` ≠ `expectedVersion` — пропущено, ядро дає `command.conflict`;
    - `missing` не `NULL` → `command.invalid` `{ reason: "tabular-rows-missing", path: "<ТЧ>" }`
      без виклику хуків і ядра;
  - id і в масиві, і в `deleteIds` → `command.invalid` `path: "deleteIds.<ТЧ>.<i>"`
    до бази; id з `deleteIds`, якого немає, — проходить;
  - тест-сторож умови (1): схема `update` без `expectedVersion` — відмова
    (якщо колись поле стане необов'язковим, сувора перевірка без нього має
    відмовляти, а не пропускати — коментар біля перевірки);
  - перевіряється вхідний масив операції: хук, що прибрав рядок із повного
    масиву в чернетці, не дає відмови (свідома дія довіреного коду);
  - з `{ fullTabularArrays: true }` `run` оператора перевірки не надсилає
    (повна заміна масивом, як зараз); `ctx.run` опції не має;
  - `create` (нового власника) перевірки не робить;
  - хук `beforeWrite` бачить `draft.tabularSections.<ТЧ>` — масив операції
    цілком (рядки логічної форми), без `deleteIds`;
  - MCP `data-command` кличе `run` без опції (сувора перевірка); опис інструмента
    (англійською): масив ТЧ — повна заміна; кожен наявний рядок — у масиві чи
    в `deleteIds`.
- [ ] **Step 2: Run, expect FAIL** —
  `pnpm --filter simetra test runtime-contracts runtime hooks values` і
  `pnpm --filter @simetrajs/designer test data-tools mcp`.
- [ ] **Step 3: Implement** — одиниця `[CONTEXT, check]` іде через `tx.enqueue`
  з фазою запису (бюджет і коди діють; оператор контексту — той самий текст,
  що в `callCore`, `phase.ts`); `deleteIds` до ядра не передається.
  Наявні unit- і DB-тести, що шлють масиви ТЧ в `update`, отримують у
  послідовності викликів оператор перевірки (чи називають рядки в масиві);
  поведінку їхніх асертів не міняти.
- [ ] **Step 4: Run** — PASS; `pnpm typecheck`, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(server): deleteIds для масиву ТЧ з MCP і ctx.run`.

### Task 8: DB-кейси тайм-аутів, кодів і `deleteIds`

Причина DB-рівня: замки, `FATAL` з'єднання, поведінка драйвера `pg` і
серіалізація замком вирішує Postgres; порт-фейк цього не доводить. Один новий
файл, сценарії.

**Files:** Create `packages/designer/src/__tests__/command-time.db.test.ts`;
Modify `packages/designer/src/__tests__/support/db.ts` (спільний помічник утримання
замка замість кожного локального `heldEnv`/`heldTarget` — знайти
`grep -rln "heldEnv\|heldTarget" packages/designer/src/__tests__`; лише в
`support/`, без зміни поведінки кейсів — пункт реєстру §7), `carrier-locks.db.test.ts` (кейс `UPDATE parent_id`),
`command-runtime.db.test.ts` (`23514` у ТЧ), `data-tools.db.test.ts` (`deleteIds`).

- [ ] **Step 1: Write DB tests** (рантайм над тінню, `fromPgPool` над
  справжнім `pg.Pool`; `commandBudgetMs`/`lockTimeoutMs` малі):
  1. «lock_timeout is command.busy»: інша сесія тримає замок рядка →
     `update` → `command.busy`;
  1a. «statement_timeout is command.timeout»: `commandBudgetMs` = 2000,
     `lockTimeoutMs` = 10 000 — оператор фази чекає замка довше за стелю
     `statement_timeout` (Ф6) → `57014` → `command.timeout`;
  2. «budget runs out between statements»: хук `beforeWrite` чекає довше за
     бюджет → `command.timeout`, нічого не записано;
  3. «idle FATAL through the pg driver keeps the process alive»: хук чекає
     довше за межу простою (`commandBudgetMs` = 1000, тож межа простою —
     2 с): під час очікування `FATAL 25P03` приходить на простоюючому
     клієнті (подія `error`), далі перевірка бюджету перед наступним
     оператором дає `command.timeout`, а `ROLLBACK` на мертвому з'єднанні
     веде до `release(true)` → `command.timeout`, з'єднання
     знищено, наступна команда через той самий пул проходить, необробленої
     помилки немає (`process.on("uncaughtException")` у тесті не спрацював);
  4. регресійний «backend terminated before COMMIT is command.unavailable»:
     `beforeStatement` перед `COMMIT` завершує бекенд (`pg_terminate_backend`
     іншою сесією) → `57P01` → `command.unavailable`. Межу `COMMIT` цей кейс не
     доводить (обрив до надсилання) — її доводить unit задачі 4;
  5. «deleteIds sees what the core sees» — на фікстурі з функціями прав
     (`runtimeValuesLayer()`/`readQueryLayer()`), **на першій фазі пакета** і
     на другій: `run` з неповним масивом → `tabular-rows-missing`, рядки на
     місці; повний масив + `deleteIds` → рядок видалено; гонка:
     `beforeStatement` між одиницею перевірки й одиницею ядра комітить
     паралельну вставку рядка ТЧ (інша команда) → результат `command.conflict`,
     доданий рядок на місці, нічого не видалено;
  6. `carrier-locks.db.test.ts`: `UPDATE` рядка ТЧ зі зміною `parent_id` чекає
     замка нового власника → `command.busy` під `lock_timeout` (пункт реєстру §7);
  7. `command-runtime.db.test.ts`: CHECK реквізиту ТЧ → `command.constraint`
     `check` з `<ТЧ>.<реквізит>`;
  8. `data-tools.db.test.ts`: `data-command` з масивом ТЧ без наявного рядка →
     `tabular-rows-missing`; з `deleteIds` → проходить.
- [ ] **Step 2: Run** —
  `pnpm --filter @simetrajs/designer test:db command-time carrier-locks command-runtime data-tools read-query rights-maintenance rights-admin-commands` — PASS.
- [ ] **Step 3: Mutation check (обов'язковий, без коміту):** прибрати слухача
  `error` у `fromPgPool` → кейс 3 червоніє (необроблена помилка); мапити
  `25P03` на `COMMIT` як `command.timeout` → unit задачі 4 червоніє; повернути
  в перевірку `FOR NO KEY UPDATE` (як у першій редакції плану) → кейс 5 на
  першій фазі червоніє («порожній успіх» під політиками UPDATE); пропускати
  перевірку взагалі → кейс 5 червоніє;
  прибрати порівняння версії → кейс 5 дає `tabular-rows-missing` замість
  `command.conflict`. Повернути код.
- [ ] **Step 4: Commit** — `test(designer): DB-кейси бюджету часу, кодів команди й deleteIds`.

### Task 9: документація й гейти

**Files:** `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`
(§7.1 — Ф2, Ф3 разом з умовами механіки, Ф4, Ф6, приклад межі `COMMIT`:
відмова запобіжника `42501` на `COMMIT` — відомий відкат, `command.forbidden`;
§12 — Ф7; §13 — `BATCH_MAX` у рядок B1b-3, опція `fullTabularArrays` у рядок B1b-2 (Ф1, Ф3); рядки Додатку А з B1b-3 → «внесено (B1b-3)»),
`docs/superpowers/specs/2026-10-26-p4-runtime-design.md` (§6.4 — масив ТЧ і
`deleteIds`, §6.5, §6.9, §6.10 за Додатком А; назву інструмента вирівняти:
у коді — `data-command`, у спеках і Додатку А — `data-write`; §9 — у рядок «Хостований Supabase» «PostgreSQL ≥ 17
(`transaction_timeout`); на старішій версії запобіжника немає — тримають
бюджет T3 і межа простою»), `packages/designer/skills/simetra-metadata/`
(великі ТЧ: набір понад `TABULAR_LINES_MAX` чи такий, що редагується
частинами, — окремий об'єкт чи регістр; масив ТЧ — лише з форми картки чи
«ТЧ власника»; `deleteIds` у `data-command`), `docs/superpowers/plans/2026-10-30-archive-residual-debt.md`
(прибрати три закриті пункти §7), `docs/ROADMAP.md` (рядок П4: B1b-3 виконано).

- [ ] **Step 1:** правки рядок у рядок; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти:**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm metadata:check
pnpm test:db
pnpm build:packages && pnpm test:packaging   # нова опція runtime.run і поле операції — публічний API
```

- [ ] **Step 3: Commit** — `docs(spec): П4-B1b-3 — правки Додатку А, PostgreSQL ≥ 17, скіл`.

## Готово (спека §13, рядок B1b-3)

- unit T3 зелені (бюджет, межа `COMMIT`, коди, пауза, межа фаз, `deleteIds`);
- DB-кейси тайм-аутів (зокрема `FATAL` через драйвер `pg`), межі `COMMIT`,
  кодів команди й MCP `data-command` з `deleteIds` зелені;
- вимогу «PostgreSQL ≥ 17» записано в §7.1 і в П4 §9 (доступу до хостованого
  стеку немає — рішення архітекторки).

## Підсумок аудиту плану

- **Раунд 1** — два незалежні аудитори (Opus): «покриття й вірність спеці» і
  «правда проти коду, PG і node-postgres». Обидва знайшли той самий blocker:
  перевірка `deleteIds` з `FOR NO KEY UPDATE` до контексту фази проходила
  порожньою під політиками UPDATE ролі команд, і ядро мовчки видаляло рядки.
  Major: інверсія замків з advisory-замком ієрархії, хибне обґрунтування
  замка в READ COMMITTED, правило `commitSent` ламало відмову запобіжника на
  `COMMIT`, бракувало DB-кейсу `statement_timeout`, `25P04` на DB недосяжний,
  кейс 4 не доводив межу `COMMIT`, не визначено, який масив перевіряється.
  Механіку Ф3 переписано (без замка, з порівнянням версії); Ф6, Ф7 і звуження
  `commitSent` погодила архітекторка; решту виправлено.
- **Раунд 2** — один аудитор (Opus) на виправлення: blocker і безпекових
  major — 0. Виправлено несекурний major (мутація «без `CONTEXT`» не могла
  почервоніти — замінено на повернення `FOR NO KEY UPDATE`; «видимість та
  сама» → «надмножина, fail-closed») і 2 minor (порожній `ARRAY[]`, формула Ф6).
- **Codex** (`gpt-6-sol`, заморожене дерево) — blocker, безпекових major і
  major за §7.1/§13 не знайдено.
- **Підсумок:** blocker — 0, безпекових major — 0.
