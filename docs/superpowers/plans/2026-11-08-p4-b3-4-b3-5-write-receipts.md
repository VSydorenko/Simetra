# П4-B3-4 і B3-5. Запис: журнал, політики, write-back і квитанції `run` — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Мета:** T4 пише командами через `DataWriter`: власна зміна або
підтверджується рядком бази одним кадром, або лишається видимою зі станом
`failed`, `conflict` чи `unknown` і діями; `run` ідемпотентний — кожна спроба
несе `mutationId`, T3 пише квитанцію в транзакції команди, а `unknown`
розв'язує запит стану, а не порівняння значень.

**Архітектура:** **B3-4** — журнал мутацій ядра B3-2 (`store/journal.ts` з
індексом за ключем), шар показу «підтверджений ⊕ живі `predict`» у
`computeRowView`, черга ключа, політики `await` і `predict`, write-back
одним `commit`, дельти рядка ТЧ, таблиця «код → стан і дія», позначка
«застарілий» і `DataWriter`. **B3-5** — квитанції: таблиця й функції в стані
застосування схеми `simetra`, заявка й запис у транзакції `run`, тип конверта
`receipt`, `mutationId` у конверті й розв'язання `unknown` у ядрі. Прототип
журналу `spike/t4-core` — еталон алгоритмів (черга, поглинання, `noop`,
перебазування, write-back), а не код для перенесення.

**Стек:** TypeScript, Zod, Vitest, fast-check, Postgres 17 (DB — локальний
стек Supabase).

**Спека:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §7.1–§7.4,
§6.2 (журнал як власник, межа журналу), §6.5 (стани й дії), §10 (позначка
«застарілий»), §12 рядки «unit T4 запису», DB (квитанції), мутаційні
перевірки, §13 рядки B3-4 і B3-5, Рд6, Рд7, Рд24, Рд27, Рд34, Рд35;
[платформна спека](../specs/2026-09-24-simetra-platform-design.md) Р37, Р38;
[звіт спайку ядра](../specs/2026-11-08-t4-core-spike-report.md) §2, §4a, §5,
§8, §9; плани [B3-3](2026-11-08-p4-b3-3-window-public-api.md) (гачок
`pinned`, слабкі власники, лінивий `count`) і
[B1c](2026-11-08-p4-b1c-conditional-batched-reads.md).

**Шляхи.** Відносні шляхи `store/…`, `runtime/…`, `adapter.ts`, `errors.ts`, `index.ts` у B3-4 — від `packages/simetra/src/data/`; шляхи T3 у B3-5 — від `packages/simetra/src/server/`, а `envelope.ts`, `limits.ts` — від `packages/simetra/src/model/runtime/`.

**Поділ і залежності.** **B3-4** (Task 0–7) — після B3-3 і B1b-3; **B3-5**
(Task 8–12) — після B3-4 і B1e. Кожна частина — з власним «готово». Імена
ядра — з гілки B3-2 (`feat/p4-b3-2`) і планів B3-3, B1c; виконавець звіряє
їх з `main` (`orient --plan`).

## Global Constraints

- Один виклик методу `DataWriter` — одна логічна мутація й один `run` (пакет фаз у порядку операцій); `batch` — до `BATCH_MAX`, понад — `command.invalid` `batch-too-large` без транспорту.
- `settled` ніколи не відхиляється: `{ ok: true, rows }` чи `{ ok: false, error }`; помилка розробника — `DataError` синхронно (`data.version-required`, `data.tabular-incomplete`, `data.journal-full`).
- Політика: `await` — значення не змінюється до відповіді; `predict` — лише для дій з ознакою каталогу; об'єкт без ознаки — `await`.
- Мутації того самого ключа — послідовно; база наступної — підтверджений рядок попередньої, записаний тим самим `commit`, що осідає її.
- Write-back: рядки результату за правилом версії для ключів з власником і власних створень + зняття мутації — один `commit`; ключі без рядка результату (неповний рядок, без `rows`, квитанція, новіший надгробок) перечитуються **до** осідання; рядки ТЧ клієнта підтвердженими не стають — «ТЧ власника» перечитується до осідання (межа 5 с).
- Журнал — сильний власник рядків своїх мутацій (B3-3 Р8: не слабкий); межа — 500 мутацій; індекс за ключем — дія над ключем не сканує журналу.
- Перебазування — лише `predict`, до трьох спроб, лише без розбіжності полів; `await` і чернетка — `conflict` без автоповтору. CAS за полями — поза блоком (§14.1).
- Без автоповтору `run` після `command.unavailable`: стан `unknown`.
- Квитанція не зберігає значень рядків: `{ id, version }` на операцію й набір змін.
- `mutationId` — UUID на спробу; «Повторити», «Перезаписати», перебазування — новий `mutationId`.
- `RECEIPT_TTL` — доба (стала T0); налаштування T3 лише збільшує: функції беруть `p_ttl interval` і самі рахують `GREATEST(p_ttl, <нижня межа>)`, де нижню межу емітер бере з T0 `RECEIPT_TTL` (не літерал руками; тест звіряє літерал SQL зі сталою), тож зменшений строк, переданий помилкою T3, не видаляє квитанції, молодшої за добу.
- Коментарі — українською й про «чому»; повідомлення — en/uk у `messages.ts`.

## Рішення плану

| № | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р1 | Журнал — модуль `store/journal.ts` з індексом `Map<keyId, Rec[]>` від першого дня | спайк дав квадратичну деградацію за ~1000 мутацій без відповіді (звіт §5) | немає |
| Р2 | Ознаку політики виводить **компілятор** з метаданих (погоджено архітекторкою): поле клієнтського каталогу `predict: readonly ("update" \| "markDeletion" \| "delete" \| "create")[]` на об'єкт. Правило консервативне й перевірюване: дія входить, коли на неї не підписано жодного SQL-обробника з `write: true` (`beforeWrite`, `onWrite` у `compiler/subscription-units.ts`) — читання полів компілятор не аналізує, тож будь-який такий обробник знімає дію; TS-модулі об'єкта (`beforeWrite`, `onWrite`, `OBJECT_MODULE_KEYS`) компілятор не бачить, тому `createCommandRuntime` відмовляє помилкою конфігурації (код — у реєстрі діагностик), коли будь-який хук фази запису TS-модуля, що може змінити рядок чи відмовити (`beforeWrite`, `onWrite` і подібні), дано об'єкту, у якого каталог має непорожній `predict` (погоджено архітекторкою) (автор ставить `writePolicy: "await"`); механіка виду не присвоює реквізитів на сервері (номер чи код ключа на `create` — факт реєстру видів). `update` з `predict` передбачає лише присвоєння простого атрибута чи перемикача (тип з кодеком §4.4); інше поле в тій самій мутації — `await` для всієї мутації. `create` — лише з UUID клієнта й не для кореня виду скоупу. Автор метаданих може лише звузити: необов'язкове поле `writePolicy: "await"` спільної частини схем об'єктів видів T0 (там, де живуть загальні поля об'єкта, як `physicalName`) знімає `predict` з усіх дій; розширити не може | §3 і §7.1 вимагають ознаки каталогу, а в коді її немає; ручна ознака дала б передбачення, яке сервер змінить | П4-B §3 і §7.1, спека метамоделі — поле `writePolicy` (Task 7) |
| Р3 | Шар показу — розширення `computeRowView`: `RowView` отримує `pendingFields`, `deleting`, `server` (рядок для `conflict`), `mutation` (ідентифікатор і дії); кеш рядків перераховується на зміні журналу ключа | §6.5: показ = підтверджений ⊕ живі `predict` за порядком журналу | немає |
| Р4 | `CoreSource.run(ops: readonly WireOperation[], options: { mutationId: string; kernels }): Promise<CoreRunResult>` і `CoreSource.receipt(mutationId)` (B3-5) — над `send` рантайму: `createCoreSource` отримує `send` і передає його так само, як читання; без `AbortSignal` (`DataTransport` його не має, а після `dispose()` `send` і так відмовляє без транспорту); ядро заповнює `kernels` кожного `run` з `kernelHash` клієнтського каталогу об'єктів операцій | порт запису — `DataTransport` (§5.1); без `kernels` `stale-client` для запису не спрацює (§10) | немає |
| Р5 | Квитанції — у стані застосування схеми `simetra` (`renderApplyState`, безумовно, як `version_epoch` B1e): таблиця `simetra.run_receipts (mutation_id uuid PRIMARY KEY, subject text NOT NULL, request_hash text NOT NULL, state text NOT NULL CHECK (state IN ('claimed', 'done', 'closed')), result jsonb, created_at timestamptz NOT NULL DEFAULT now(), CHECK ((state = 'done') = (result IS NOT NULL)))` з індексами `(created_at)` і `(subject, created_at)`; запис і читання — функції `SECURITY DEFINER` `simetra.receipt_claim(p_id, p_hash, p_ttl)`, `simetra.receipt_complete(p_id, p_result)`, `simetra.receipt_close(p_id, p_ttl)` з `EXECUTE` лише ролі команд; `subject` функції беруть з claims транзакції (`sub`, як `current_user_id()`), а не з параметра; порожній — виняток | квитанція потрібна кожному проєкту, незалежно від прав і «Користувачів»; таблиці схеми `simetra` закриті відсутністю грантів, а запис через дефайнер — наявний патерн прав | П4-B §7.4, спека системної схеми §3 (Task 12) |
| Р6 | Хеш пакета — SHA-256 (`sha256HexSync` T1) канонічної форми передачі операцій (`canonicalize` T1) до мапінгу | форма передачі — те, що прийшло з дроту; логічна залежить від каталогу сервера | немає |
| Р7 | Прибирання квитанцій — на заявці (погоджено архітекторкою): та сама функція `receipt_claim` видаляє до 100 рядків, старших за строк з Global Constraints, через `DELETE … WHERE mutation_id IN (SELECT … WHERE created_at < … ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)`; індекс `run_receipts (created_at)`, тож DELETE не сканує таблицю й не чекає квитанції, яку тримає чужа транзакція | без планувальника, який є не в кожному профілі; обмежена робота на запит | П4-B §7.4 (Task 12) |
| Р8 | Повтор з тим самим `mutationId`, `subject` і хешем — збережений результат без `rows` (як результат понад бюджет: ядро перечитує ключі під RLS) | §7.4 | немає |

Кожне рішення — розвилка до погодження архітекторкою.

## Review Focus

1. **Відповідь `run` після `cancel`, `retry` чи `dispose()`**: нічого не
   пише (токен спроби) — Task 3.
2. **Повтор `run` з `mutationId` іншого суб'єкта**: `mutation-reused` без
   подробиць і без виконання — Task 9.
3. **Пізня спроба після `receipt` зі станом «закрито»**: не виконується —
   Task 9 (DB).
4. **Дві швидкі правки одного ключа, перша відмовлена**: друга лишається,
   перша `failed` — Task 3.
5. **Дельта рядка ТЧ, рядок-ціль якого видалили паралельно**: `conflict`
   без тихого повторного вставлення — Task 5.

---

## B3-4. Журнал, політики, write-back

### Task 0: Поправка спеки §7.1 — правило виведення `predict`

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` §7.1 (пункт «Політика дії») і §3 (ознака `predict`)

- [ ] **Step 1: Два речення в §7.1** (рішення архітекторки): «SQL-підписка з `write: true` знімає `predict` з дії, на яку підписана. TS-хук фази запису (`beforeWrite`, `onWrite` і подібні) на об'єкті з непорожнім `predict` — помилка конфігурації рантайму; автор ставить `writePolicy: "await"`.» У §3 — `writePolicy` лише звужує. `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Commit.** `docs(spec): правило виведення predict`


### Task 1: Журнал, `DataWriter` і порт запису

**Files:**
- Create: `packages/simetra/src/data/store/journal.ts`, `packages/simetra/src/data/data-writer.ts` (`writerOf(runtime)`; ім'я не `writer.ts`, бо `store/writer.ts` — `Writer` ядра всередині `commit`), `packages/simetra/src/data/react/use-writer.ts`, `packages/simetra/src/data/store/__tests__/journal.test.ts`
- Modify: `store/source.ts` (`CoreSource.run`), `adapter.ts` (адаптер Server Function — `run`), `store/core.ts` (журнал у сесії; `dispose()` прибирає журнал), `store/types.ts` (`Mutation`, `MutationState`, `MutationActions`), `errors.ts` (`data.journal-full`; `data.version-required` уже є в B3-2), `index.ts` і `react/index.ts` (експорт)

**Interfaces:**
- Produces: `WriteOp = { action: "create"; object; id?: string; values } | { action: "update"; object; id; values; tabularSections?; expectedVersion? } | { action: "markDeletion" | "delete"; object; id; expectedVersion? } | { action: "addLine" | "updateLine" | "removeLine"; object; owner; section; lineId?; values? }`; `DataWriter = { create; update; markDeletion; delete; addLine; updateLine; removeLine` — кожен з полями свого варіанта `WriteOp` — `; batch(ops: readonly WriteOp[]) }`; `create` без `id` бере `crypto.randomUUID()`; кожен метод повертає `Mutation = { id: string; settled: Promise<{ ok: true; rows: readonly (ServerRow | undefined)[] } | { ok: false; error: CommandError }> }`; `MutationState = "pending" | "failed" | "conflict" | "unknown"`; `MutationActions = { retry?(); cancel(); takeServer?(); overwrite?(); hide?() }` — набір дій за станом §6.5 (`hide` — «Скасувати показ» для `unknown`, `takeServer`/`overwrite` — для `conflict`), видимий у `RowView.mutation`; `writerOf(runtime): DataWriter`, `useWriter(): DataWriter`; журнал — сильний власник рядків своїх мутацій; гачок B3-3 `pinned(key)` повертає `true` для ключа з живою чи відмовленою мутацією.

- [ ] **Step 1: Unit:** межа 500 — нова дія `data.journal-full` синхронно, без транспорту; `update` без бази й без `expectedVersion` — `data.version-required`; `batch` понад `BATCH_MAX` — `batch-too-large` без транспорту; дія над ключем не сканує всього журналу (лічильник звернень до індексу); рядок мутації не витісняється, доки мутація не осяде чи не скасована; `pinned` тримає сторінку вікна; після `dispose()` — жодного запиту; `dispose()` синхронно розв'язує `settled` кожної живої мутації як `{ ok: false, error: disposed }`, і пізня відповідь мутації, що була в дорозі, цього вже не змінює (обробник UI старого суб'єкта не бачить рядків); `mutationId` — з `crypto.randomUUID()`; кожен `run` несе `kernels` об'єктів своїх операцій.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test journal`.
- [ ] **Step 3: Commit.** `feat(data): журнал мутацій, DataWriter і порт запису`

### Task 2: Шар показу, політики `await` і `predict`, `noop`, поглинання

**Files:**
- Modify: `store/snapshot.ts` (`computeRowView` — Р3; кеш рядків перераховується на зміні журналу ключа), `store/journal.ts` (`build` спроби: змінені поля проти бази, `noop` лише для `predict`-присвоєння без обробників; поглинання полів у `failed`/`conflict`), `store/types.ts` (`RowView` з `pendingFields`, `deleting`, `server`, `mutation`)
- Test: `journal.test.ts`, `snapshot.test.ts`

- [ ] **Step 1: Unit:** `await` — значення не змінюється до відповіді, стан `pending`; `predict` — значення одразу, підтвердження рівного — лише `pending` → `synced` тим самим кадром; поглинання полів — показане поле нове, мутація без полів зникає; `noop` лише для `predict`-присвоєння, `await` з тим самим значенням іде на сервер; пріоритет станів `removed` > `conflict` > `failed` > `unknown` > `pending` > `stale` > `synced`; `delete` — `deleting` на місці до підтвердження; `purge` ключа з живою мутацією — мутація лишається в журналі без показу значень, лише причина й «Скасувати»; `removed` з незавершеною мутацією — причина й «Скасувати»; `purge` не воскрешає рядка й після осідання мутації.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test journal snapshot`.
- [ ] **Step 3: Commit.** `feat(data): шар показу журналу й політики await і predict`

### Task 3: Черга ключа, спроба, write-back

**Files:**
- Modify: `store/journal.ts` (черга ключа, спроба з токеном, перебазування `predict`), `store/core.ts` (write-back одним `commit`; ключі без рядка результату — перечитування до осідання за `readKeys`; рядки об'єктів без вигляду не пишуться; зміни набору змін поза ключами — перечитування за ключем; лінивий `count` об'єкта — застарілий після write-back), `store/window.ts` (файл B3-3 — задача після B3-3: власне створення один раз на початку першої завантаженої сторінки, ключ не в масиві ключів сторінки)

- [ ] **Step 1: Unit:** база наступної мутації ключа — підтверджений рядок попередньої, без `conflict` між своїми правками; дві швидкі правки, перша відмовлена — друга лишається, перша `failed`; перебазування `predict` до трьох разів без розбіжності полів, розбіжність — `conflict`; `await` і чернетка — `conflict` без автоповтору; `retry` і «Перезаписати» — нова спроба з недійсним токеном старої; `cancel` — показ одним кадром до підтвердженого; write-back і зняття мутації — одне сповіщення; неповний рядок, результат без `rows`, ключ з новішим надгробком — перечитування до осідання; перечитування не вдалось за 5 с — `{ ok: true }` з `rows` `undefined` і `stale`, не база наступної; збій запису після `COMMIT` — журнал і перечитування без `failed`; власне створення — один раз на початку; відповідь після `cancel`, `retry` чи `dispose()` — нічого не пише; `count` після write-back свіжіє; §7.2 п. 7–8: зміна лінивого атрибута чи результат без `rows` — перечитування вигляду `card`; перечитування `section` до осідання замінює передбачені рядки ТЧ підтвердженими одним кадром; збій перечитування ТЧ — ТЧ `stale`, і вона не база наступної дельти; рядки об'єкта без вигляду не пишуться; зміни поза `rows` — перечитування; ключ клієнта стабільний після підтвердження створення; перечитування після запису, конфлікту й `unknown` — одним пакетом збирача B3-3 з `known` (B1c); бюджети запису через `countingTransport` (B3-3 Р5): правка `await` — 1 `run`, без перечитування, коли рядок результату повний; правка з неповним рядком — 1 `run` і 1 `read`.
- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test journal core window`.
- [ ] **Step 3: Commit.** `feat(data): черга ключа, спроба й write-back одним commit`

### Task 4: Таблиця «код → стан і дія», `unknown` без розв'язання, позначка «застарілий»

**Files:**
- Modify: `store/journal.ts`, `store/core.ts`, `runtime/runtime.ts` (`onStaleClient`; `send` віддає й `serverHash` відповіді, а не лише `value`), `store/source.ts` і збирач B3-3 (частина `version` — `CorePart`/`CoreReadItem` зі значенням `VersionValue` у `readParts` B1c; окремого типу запиту `version` після B1c немає; частина `version` іде в групі Server Function навіть за перевизначеного адаптера об'єкта (тест у `batcher.test.ts`); це переносить сюди Р4 плану B3-6, і B3-6 частину лише вживає), `store/types.ts` (`isStale` вигляду)

- [ ] **Step 1: Unit (`it.each` за кодом §7.3):** `command.conflict` `version` — `conflict` з поточним серверним рядком, перечитування ключа й `section` власника з видимою ТЧ; `command.forbidden` — `failed`, перечитування рядків фаз, відсутній — `removed`; `command.forbidden` `origin` — лише `failed` без перечитування (§14.3); `stale-client` — `failed`, запит `version`, `onStaleClient(object)`, без повтору; `session-changed` — закриття з причиною; `unavailable` з `disposed` — нічого; `unavailable` на `run`, тайм-аут, обрив — `unknown` з «Скасувати показ» і без розв'язання (B3-5); `busy`, `timeout` — `failed` без автоповтору, крім `busy` з `reason: "receipt"` (замок заявки зайняв дубль того самого `mutationId`) — `unknown` з розв'язанням квитанцією; позначка «застарілий»: транспорт чергує відповіді `version` двох каталогів — позначка ставиться й знімається без циклу; запис позначеного об'єкта — `stale-client` без транспорту; відповідь `version` лише оновлює хеш і позначки й не запускає нового запиту (§10); таблиця «подія → запит `version`» у B3-4 — `stale-client` і зміна `serverHash` у будь-якій відповіді; гідратація — B3-6, `resume()` і навігація — B5a, приєднання без `recovered` і `schema` — B5b; ядро дає їм `requestVersion()` вже тут. Розподіл подій за блоками (погоджено; B5a і B5b беруть його звідси):

  | Подія → запит `version` | Блок |
  | --- | --- |
  | `stale-client`, зміна `serverHash` у будь-якій відповіді | B3-4 |
  | гідратація | B3-6 |
  | `resume()`, навігація з обмеженням частоти | B5a |
  | приєднання без `recovered`, сигнал `schema` | B5b |

- [ ] **Step 2: Червоний → реалізація → зелений.** `pnpm --filter simetra test journal core runtime`.
- [ ] **Step 3: Commit.** `feat(data): коди відмов, unknown і позначка «застарілий»`

### Task 5: Дельти рядка ТЧ і чернетка з ревізіями

**Files:**
- Modify: `store/journal.ts` (дельта на повну підмножину ТЧ з `ownerVersion` = підтвердженій версії шапки на старті спроби; очікування незавершеного перечитування ТЧ з межею 5 с, далі `conflict`; повний масив з `ownerVersion` як `expectedVersion`), `store/section-store.ts`
- Create: `packages/simetra/src/data/store/__tests__/draft-contract.test.ts` (фейкова форма)

- [ ] **Step 1: Unit:** `update` з `tabularSections` без `expectedVersion` — `data.version-required`; дельта на повну підмножину — повний масив з `ownerVersion`; дві дельти різних рядків — обидві успішні; рядок-ціль видалено паралельно — `conflict`, без повторного вставлення; без повної підмножини й без вигляду `section` — `data.tabular-incomplete`; «Повторити» дельти для власника `removed` — `conflict` з причиною; масив ТЧ клієнта підтвердженим не стає; журнал тримає ТЧ дельти після закриття вигляду `section`.
- [ ] **Step 2: Контракт чернетки** (фейкова форма над `DataWriter`): відповідь на ревізію A не перезаписує правок ревізії B; `conflict` лишає всі правки; «Скасувати» скидає одним кадром; стан `purged` вигляду `card` скидає чернетку.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test journal section-store draft-contract`.
- [ ] **Step 4: Commit.** `feat(data): дельти рядка ТЧ і контракт чернетки`

### Task 6: Модельний тест — кроки журналу

**Files:**
- Modify: `store/__tests__/model.test.ts`, `store/defects.ts` (нові прапорці)

- [ ] **Step 1: Кроки** (до наявних кроків B3-2): власна правка обох політик, власне видалення й створення, відповідь на будь-яку спробу в будь-якому порядку (`ok`, `forbidden`, `conflict`, невідомий результат), `retry`, `cancel`, чужа правка й чуже видалення ключа з мутацією, `purge` ключа з мутацією, `dispose()` з мутаціями в дорозі, плин часу (межа 5 с перечитування ТЧ); інваріанти: показаний рядок = еталон (підтверджений ⊕ живі `predict` з поглинанням, незалежна проста модель); `await` не змінює значення до відповіді; рядок живої чи відмовленої мутації не витісняється; відмова не прибирає зміну мовчки; межа журналу; видалене й `purge` не воскресають через мутацію; після `dispose()` жоден `settled` не дає `ok: true`.
- [ ] **Step 2: Самотест:** дефекти «показати значення `await` до відповіді», «не тримати рядок журналом», «прибрати поглинання», «осідати окремим `commit`», «брати базу до осідання попередньої», «перебазувати `await`», «перебазувати за розбіжності полів», «записати масив ТЧ клієнта як підтверджений», «показати значення `purge`-ключа з журналу» — модель червона.
- [ ] **Step 3: Зелений.** `pnpm --filter simetra test model`.
- [ ] **Step 4: Commit.** `test(data): модельний тест з кроками журналу`

### Task 7: Ознака `predict` у каталозі й спеки B3-4

**Files:**
- Modify: схема об'єкта T0 у `packages/simetra/src/model/` (необов'язкове `writePolicy: "await"`, тест схеми), `packages/simetra/src/compiler/client-catalog.ts`, `runtime-catalog.ts` (ознака Р2 з підписок запису й фактів реєстру видів), `packages/simetra/src/model/runtime/client-catalog.ts` і `catalog.ts` (схема поля), тести `runtime-catalog.test.ts`; `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§3 і §7.1 — поле `predict` і правило виводу; Додаток А — додати рядки B3-4 «внесено (B3-4)»); `packages/simetra/src/server/runtime.ts` (відмова модулю запису для `predict`-об'єкта)

- [ ] **Step 1: Unit T1 (`it.each`):** об'єкт без обробника запису — `predict` з дій `update`, `markDeletion`, `delete`, `create`; обробник `beforeWrite`, що читає чи присвоює поле, — без дії, на яку він підписаний; вид, що присвоює номер чи код на вставці, — без `create`; корінь виду скоупу — без `create`; `writePolicy: "await"` — порожньо; `kernelHash` від ознаки не залежить. Unit T3 (`it.each` за хуками фази запису `OBJECT_MODULE_KEYS`): `createCommandRuntime` з хуком для об'єкта з непорожнім `predict` — помилка конфігурації з кодом реєстру діагностик; з `writePolicy: "await"` — прийнято; мутація «прибрати перевірку» червонить цей тест. Unit T4: `update` з `predict`-об'єкта, що змінює непросте поле, іде як `await`.
- [ ] **Step 2: Гейти B3-4.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 3: Commit.** `feat(compiler): ознака predict у клієнтському каталозі; docs(spec): B3-4`

**Готово B3-4:** цільові тести запису, контракт чернетки й модельний тест з кроками журналу зелені.

## B3-5. Квитанції `run`

### Task 8: Квитанції в схемі `simetra`

**Files:**
- Modify: `packages/simetra/src/schema/apply/state.ts` (`renderApplyState`: таблиця, індекси й три функції Р5 — тим самим механізмом, яким B1e рендерить `version_epoch` і `row_version_epoch()`, тож наявна база отримує їх на наступному `simetra apply`; `STATE_TABLES`, `functionId` і `applyStateOf` узагальнюються з однієї функції на перелік; `readApplyState` знає таблицю; `planPlatformFunctions`)
- Test: `packages/simetra/src/schema/apply/__tests__/state.test.ts`, `packages/simetra/test/db/receipts.db.test.ts` (Create)

**Interfaces:**
- Produces: `simetra.receipt_claim(p_id uuid, p_hash text, p_ttl interval) RETURNS TABLE(verdict text, result jsonb)` — `INSERT … (state 'claimed') ON CONFLICT DO NOTHING RETURNING`; вставлено — `fresh`; інакше `SELECT … FOR UPDATE` наявного рядка й вердикт, який рахує сама функція: свій `subject`, рівний хеш і `done` — `duplicate` з `result`; будь-що інше (чужий `subject`, інший хеш, `closed`) — `reused` без `result`; прибирає до 100 прострочених за Р7. `simetra.receipt_complete(p_id uuid, p_result jsonb) RETURNS void` — оновлює лише рядок `claimed` свого `subject`, інакше виняток (рівно один рядок). `simetra.receipt_close(p_id uuid, p_ttl interval) RETURNS TABLE(state text, result jsonb)` — немає рядка: вставляє `closed` і повертає `void`, але понад `RECEIPT_CLOSED_MAX` (1 000) рядків `closed` свого `subject` у вікні `RECEIPT_TTL` — виняток, який T3 мапить у `command.busy` `receipts-exhausted`; свій `done` — `committed` з `result`; чужий `subject` — `void` без запису; так само прибирає прострочені за Р7. Усі — `SECURITY DEFINER`, `SET search_path = ''`, `EXECUTE` лише ролі команд.

- [ ] **Step 1: Unit `state.test.ts`:** розібрані оператори таблиці й функцій, гранти лише ролі команд; літерал нижньої межі в `GREATEST` дорівнює `RECEIPT_TTL` T0.
- [ ] **Step 2: DB `receipts.db.test.ts`** (причина DB: замки й транзакції Postgres; розгортання `renderDesiredState` + `renderApplyState`): заявка (`fresh`) і завершення в одній транзакції; закомічений рядок `claimed` неможливий без `receipt_complete` (CHECK і виняток `receipt_complete` для чужого чи не `claimed` рядка); відкат прибирає заявку; дубль після `done` — `duplicate`, інший хеш — `reused` без `result`; конкурентна заявка того самого `mutationId` чекає замка й бачить результат першої; `receipt_close` під час транзакції спроби чекає й бачить результат; чужий `subject` — `void` без запису й `reused` без `result` на заявці; `subject` береться з claims (виклик з чужими claims бачить лише своє); межа `RECEIPT_CLOSED_MAX` — виняток на 1 001-му `receipt_close` того самого `subject`; прострочені рядки прибираються на заявці й на `receipt_close`; дві конкурентні довгі транзакції заявки при наявних прострочених рядках не чекають одна одну; прострочена квитанція, замкнена іншою транзакцією, не блокує заявку (`SKIP LOCKED`, друга транзакція не чекає); план DELETE іде за індексом `created_at`; `p_ttl` менший за добу не видаляє рядка, молодшого за добу, а більший тримає довше; під `PROVIDER_API_ROLES[provider].user` функції — `42501`.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test state`, `pnpm --filter simetra test:db receipts`.
- [ ] **Step 4: Commit.** `feat(schema): квитанції run у схемі simetra`

### Task 9: Квитанції в транзакції `run` і тип конверта `receipt`

**Files:**
- Modify: `packages/simetra/src/model/runtime/envelope.ts` (`mutationId` у `run` — обов'язковий UUID; тип `{ type: "receipt", mutationId }`; відповідь `{ state: "committed", result: StoredRunResult } | { state: "void" }`), `result.ts` (`storedRunResultSchema` — `CommandResult` без `rows`: `{ id, version }` на операцію й `changes`; форма і дубля `run`, і `receipt`), `errors.ts` (`LIMIT_REASONS.mutationReused`, `receiptsExhausted`), `limits.ts` (`RECEIPT_TTL`, `RECEIPT_CLOSED_MAX`), `packages/simetra/src/compiler/index.ts` (експорт `sha256HexSync` поряд з `canonicalize` — T3 бере обидва з T1, імпорт униз), `packages/simetra/src/server/compatibility.ts` (`receipt` операцій не має — `checkCompatibility` пропускає його без перевірки контрактів), T4: `store/journal.ts` і `adapter.ts` (ядро шле `mutationId` спроби в цій самій задачі, тож `main` між комітами зелений), `packages/simetra/src/server/transaction.ts` (заявка — оператор кожної спроби одразу після перевірки `CURRENT_USER` і дійсного користувача; квитанція «виконано» — перед `COMMIT`; відкат спроби прибирає заявку, тож повтор `40001`/`40P01` заявляє наново, а `receipt` у проміжку закриває її і повтор отримує `mutation-reused`; транзакція `receipt` — ті самі кроки: `BEGIN`, claims з `lock_timeout` і `statement_timeout`, роль команд, перевірка `CURRENT_USER` і дійсного користувача, потім `receipt_close`; відмова замка заявки — `command.busy` з `reason: "receipt"`), `data-handler.ts` (хеш Р6, `receipt`), `runtime.ts` (`run` з необов'язковим `mutationId` для API в процесі; новий метод `CommandRuntime.receipt(subject, mutationId): Promise<{ state: "committed"; result: StoredRunResult } | { state: "void" }>`; дубль `run` повертає `StoredRunResult` до виконання фаз; `p_ttl` — з налаштування T3 `receiptTtlMs`, типово `RECEIPT_TTL`; JSDoc `receiptTtlMs`: строк понад добу швидше заповнює `RECEIPT_CLOSED_MAX`, тож росте ризик `receipts-exhausted`), `origin.ts` (`receipt` не в `inProcess`)
- Test: `packages/simetra/src/server/__tests__/transaction.test.ts`, `data-handler.test.ts`, `origin.test.ts`, `packages/designer/src/__tests__/run-receipts.db.test.ts` (Create)

- [ ] **Step 1: Unit T3:** повтор з тим самим `mutationId`, `subject` і хешем — збережений результат без виконання й без `rows`; інший хеш, інший `subject` чи стан «закрито» — `command.invalid` `mutation-reused` без подробиць; `receipt` без квитанції — `void`, і пізня спроба після нього не виконується; `receipt` чужого `subject` — `void`; `receipt` і `run` під `inProcess` — відмова походження; `ctx.run` хука `mutationId` не має; недійсний користувач на дублі — `command.unauthenticated` без збереженого результату; `receipt` недійсного користувача — те саме.
- [ ] **Step 2: DB `run-receipts.db.test.ts`** (причина DB: справжня транзакція команди): квитанція в транзакції команди, `ROLLBACK` її прибирає; повтор `40001` не дає другої квитанції; конкурентний дубль повертає результат першого; `receipt` під час транзакції спроби чекає й бачить результат; `receipt` між відкотом спроби `40001` і її повтором — повтор отримує `mutation-reused` і не виконується.
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test transaction data-handler origin`, `pnpm --filter @simetrajs/designer test:db run-receipts`.
- [ ] **Step 4: Commit.** `feat(server): квитанції run і тип конверта receipt`

### Task 10: Розв'язання `unknown` у ядрі

**Files:**
- Modify: `store/journal.ts` (`unknown` питає `receipt` з паузою, що зростає до хвилини, поки сесія жива; `committed` — успіх за §7.2 з перечитуванням ключів; `void` — `failed` «не дійшло» з «Повторити» й «Скасувати»; мутація, старша за `RECEIPT_TTL` мінус година, — перечитування й `conflict` з серверним рядком), `store/source.ts` (`CoreSource.receipt(mutationId)`), `adapter.ts`, `store/__tests__/model.test.ts` (кроки квитанції)
- Test: `journal.test.ts`

- [ ] **Step 1: Unit:** `committed` — успіх зі збереженим результатом і перечитуванням; `void` — `failed`; збій запиту стану — `unknown` і повтор з паузою; стара мутація — `conflict`; порівняння значень не вживається (мутація зі значеннями, рівними чужій зміні, з `void` — `failed`, а не «дійшло»); `create` кореня виду скоупу з `unknown` — ще й перечитування знімка прав і переліку скоупів (з B5 — знімок прав; до нього — перелік скоупів); «Повторити» — новий `mutationId`; «Скасувати показ» повертає показ до підтвердженого рядка, а опитування квитанції триває поза межею журналу й на `committed` перечитує ключі пакетом з `known`.
- [ ] **Step 2: Модельний тест** — кроки «запит стану» й «втрачена відповідь»; інваріант «`unknown` розв'язує квитанція, а не порівняння значень».
- [ ] **Step 3: Червоний → реалізація → зелений.** `pnpm --filter simetra test journal model`.
- [ ] **Step 4: Commit.** `feat(data): розв'язання unknown квитанцією`

### Task 11: Інваріанти ТЧ у команді: суцільний номер рядка й версія власника

Рядок B2 §13 називає обидва інваріанти, а DB-тесту на них немає; це шар команд T3, тож вони тут (доручення архітекторки). З B1e-2 Task 6 не перетинається: там підвищення версії за колонками, які переписав двигун під час застосування схеми, а тут — запис командою. Обидва покладаються на тригер версії B1e-1 (`nextval` послідовності).

**Files:**
- Modify: `packages/simetra/test/db/catalog-command.db.test.ts` (нові сценарії; спільний будівник фікстур файлу)
- Modify (лише якщо тест червоніє): `packages/simetra/src/compiler/catalog-command/units.ts` (номер рядка — `x.ord` повної підмножини; підвищення версії шапки за зміною ТЧ)

- [ ] **Step 1: DB-тест суцільного номера** (причина DB: номер присвоює згенерована функція команди): створення документа з трьома рядками ТЧ — номери 1, 2, 3; `update` повним масивом без середнього рядка — 1, 2; дельта з додаванням рядка в середину й видаленням першого (повний масив з `ownerVersion`) — номери суцільні 1…N у порядку масиву; `ctx.run` хука з тією самою зміною — так само. Перевірка: відсортовані номери кожного власника дорівнюють `generate_series(1, N)`.
- [ ] **Step 2: DB-тест версії власника:** `update` лише зі зміною змістової колонки одного рядка ТЧ (шапка без змін) — `version` шапки зросла, і `expectedVersion` зі старою версією далі дає `command.conflict` `version`; перестановка рядків (зміна лише номерів) — версія зросла; масив ТЧ, рівний збереженому, — тест фіксує поведінку ядра, і якщо вона розходиться з §7.2, це розвилка архітекторці, а не тиха правка.
- [ ] **Step 3: Червоний → виправлення ядра → зелений.** Червоний сценарій — правка в `units.ts` з тестом генератора поряд. `pnpm --filter simetra test:db catalog-command`.
- [ ] **Step 4: Commit.** `test(server): інваріанти ТЧ у команді — суцільний номер і версія власника`

### Task 12: Спеки й гейти B3-5

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md` (§7.4 — розташування квитанцій у стані застосування, функції Р5, хеш Р6, прибирання Р7, стан `claimed` і вердикт заявки, `subject` з claims, межа `RECEIPT_CLOSED_MAX`; §7.3 — `command.busy` `receipt` → `unknown`, `receipts-exhausted`; §13 рядок B3-5 — «фонове прибирання» замінити прибиранням на заявці; §13 рядок B2 — інваріанти суцільного номера й версії власника перенесено в B3-5; Додаток А — рядки B3-5 «внесено (B3-5)»), `docs/superpowers/specs/2026-10-07-system-schema-users-design.md` §3 (таблиця й функції квитанцій), `docs/superpowers/specs/2026-10-26-p4-runtime-design.md` §6.4 і §6.10 (`mutationId`, `receipt`)

- [ ] **Step 1: Правки**; `python3 scripts/check-doc-anchors.py`.
- [ ] **Step 2: Гейти.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `pnpm test:db`, `pnpm build:packages && pnpm test:packaging`.
- [ ] **Step 3: Commit.** `docs(spec): квитанції run під B3-5`

**Готово B3-5:** unit T3, DB-кейси квитанцій й інваріантів ТЧ (Task 11) і модельний тест з кроками квитанції зелені; `unknown` розв'язується без порівняння значень.

## Мутаційні перевірки (кожна червонить названий тест)

| Мутація | Тест |
| --- | --- |
| показати значення `await` до відповіді | `journal.test.ts`, модельний тест |
| не тримати рядок журналом | модельний тест |
| прибрати поглинання полів | модельний тест |
| осідати мутацію окремим від запису рядка `commit` | `journal.test.ts`, модельний тест |
| брати базу наступної мутації до осідання попередньої | модельний тест |
| перебазувати `await` | `journal.test.ts`, модельний тест |
| записати масив ТЧ клієнта як підтверджений | `journal.test.ts` |
| повторно вставити рядок, видалений паралельно, за дельтою | `journal.test.ts` |
| прийняти `update` з `tabularSections` без `expectedVersion` | `journal.test.ts` |
| перезаписати правки ревізії B відповіддю на ревізію A | `draft-contract.test.ts` |
| повторити `run` після `command.unavailable` автоматично | `journal.test.ts` |
| лінійний пошук журналу замість індексу | `journal.test.ts` (лічильник) |
| вирішувати `unknown` порівнянням значень | `journal.test.ts`, модельний тест |
| виконати спробу з уже закритим `mutationId` | `receipts.db.test.ts`, `run-receipts.db.test.ts` |
| показати квитанцію чужому `subject` | `receipts.db.test.ts` |
| дозволити `receipt` під `inProcess` | `origin.test.ts` |
| квитанція зберігає значення рядків | `data-handler.test.ts` |
| номер рядка ТЧ з розривом після видалення | `catalog-command.db.test.ts` (Task 11) |
| зміна лише ТЧ не підвищує версії шапки | `catalog-command.db.test.ts` (Task 11) |
| будувати масив ТЧ без `ownerVersion` | `journal.test.ts` (Task 5) |
| переносити чернетку на новішу версію замість `command.conflict` | `draft-contract.test.ts` |
| додати власний `create` у масив ключів сторінки | `window.test.ts` (Task 3) |
| ставити позначку «застарілий» за колонкою чи не знімати її | `runtime.test.ts` (Task 4) |
| `run` без `kernels` | `journal.test.ts` (Task 1) |
| пізня відповідь змінює `settled` після `dispose()` | `journal.test.ts` (Task 1), модельний тест |
| `p_ttl` менший за добу видаляє квитанцію | `receipts.db.test.ts` |
| модуль запису на `predict`-об'єкті приймається | `runtime.test.ts` T3 (Task 7) |
