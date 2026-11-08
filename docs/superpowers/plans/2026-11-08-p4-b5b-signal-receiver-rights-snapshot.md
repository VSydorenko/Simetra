# П4-B5b — знімок прав клієнта, приймач сигналів і транспорт Centrifugo: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Блок B5b спеки П4-B. Межі B5a/B5b задає план
> B5a (задача 0: поділ рядка B5 у §13). Дві частини, кожна має своє «готово»
> й окремий PR (рішення архітекторки):
> - **A** — знімок прав клієнта;
> - **B** — приймач сигналів і транспорт.
>
> **Залежності.** Частина A — після B1c, B3-2, B3-3, B3-6 і B5a. Частина B —
> ще й після ПГ-4/B2 частин B і C. Якорі на незмерджене позначено «після X».
> На `main` зараз немає ядра T4 (`createCore`, `CoreSession`), частини пакета
> `read`, функцій сигналу й `SignalTokens`: усе це дають плани
> [B3-2](2026-11-08-p4-b3-2-core.md), [B3-3](2026-11-08-p4-b3-3-window-public-api.md),
> [B3-4/B3-5](2026-11-08-p4-b3-4-b3-5-write-receipts.md),
> [B3-6](2026-11-08-p4-b3-6-oracle-host-ssr.md),
> [B1c](2026-11-08-p4-b1c-conditional-batched-reads.md), B5a і
> [ПГ-4/B2](2026-11-08-pg-4-b2-signal-transport.md).
> **Межа з B6** (рішення архітекторки). Функції сигналів прав, підписка на
> `simetra-rights:` і `simetra-user:`, реакція на їхні сигнали, контракт
> прав у каталозі, обчислювач і `useCan` — B6. B5b дає `refreshTokens` як
> метод порту з тестом на фейковому каналі й підписується лише на канали
> змін. **B6 розширює `rightsSnapshot`, не дублює:** знімок прав клієнта —
> одне сховище; B6 додає до нього права дій поряд зі `scopeSets` і другого
> кешу прав не заводить.
> **Спільні стеки.** Виконавець **ніколи** не виконує `pnpm db:stop`,
> `pnpm db:start`, `pnpm db:pg:stop`, `supabase stop`. DB-тести запускає
> лише через `pnpm --filter … test:db*` під замками стеків.
> **Перед стартом кожної частини:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`.
> Імена ядра звір з `main`. Якщо розходиться ім'я — перейменуй у плані за
> кодом. Якщо розходиться поведінка — звертайся до архітекторки.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- клієнт тримає знімок прав поточного користувача одним сховищем;
- клієнт підписується на канали змін пар (скоуп, об'єкт), де має право
  `read`;
- сигнал оновлює рядки ядра одним пакетом читань за правилами §8.4;
- втрата доступу прибирає дані (`purge`) незалежно від каналу.

**Architecture:**
- **A.** `simetra.rights_client_snapshot()` — генерований SQL T1
  (`STABLE SECURITY INVOKER`). Читає його `runtime.rightsSnapshot(session)`
  T3 частиною `rights` пакета `read`. Сховище знімка й порівняння знімків
  живуть у ядрі T4.
- **A.** Предикат підписки — чиста функція T4 над знімком, дзеркало режиму
  підписки `signal_topic_allowed`. Їхню еквівалентність доводить DB-тест.
- **B.** Порт `SignalTransport` T0 розширюється до форми §8.5. Реалізація —
  `simetra/data/centrifugo` над необов'язковою peer `centrifuge`.
- **B.** Приймач — модуль рантайму T4 над портом і ядром. Він не пише в
  сховище інакше, ніж через `commit` з токеном (§6.1).

**Tech Stack:** TypeScript 7, Zod, Vitest 5 (фейкові таймери), fast-check,
`pg` 8.23.1, Postgres 17, Centrifugo v6 (стенд ПГ-4/B2), `centrifuge` 5.8.0.

**Spec:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md):
- §4.5 (частина `rights`), §6.1, §6.2 правило 4, §6.5, §6.6 (`rightsVersion`);
- §8.1, §8.3–§8.6, §9.1, §9.3, §10;
- §12 (рядки «unit T4 (приймач…)», «DB `simetra`» — кейси знімка й
  еквівалентності, «стенд сигналу», мутації), §13 рядок B5b;
- платформна Р39, Р42; рішення T4 §3.6;
- [звіт спайку realtime](../specs/2026-11-08-t4-realtime-spike-report.md).

Правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською й пояснюють «чому». JSDoc експортованого API
  — англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів. Push і PR
  робить архітекторка.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Команди DB-тестів: стек `postgres` — `pnpm --filter <пакет> test:db <шаблон>`,
  стек `supabase` — `pnpm --filter <пакет> test:db:supabase <шаблон>` (лише
  `*.supabase.db.test.ts`). Кейс «на обох стеках» — спільне тіло в
  `*.support.ts` і два тонкі файли.
- Приймач і знімок пишуть у сховище лише через `core.commit(fn, token)`;
  `commit` зі старим токеном нічого не пише (§6.1). Сигнал чи відповідь,
  що прийшли після `dispose()` чи закриття, — 0 записів і 0 запитів.
- Одна подія — один синхронний прохід; частини йдуть у збирач B3-3 в одній
  мікрозадачі (як B5a).
- **Бюджети Р42** — кожен сценарій у тесті називає число запитів явно
  (`countingTransport` B3-3):
  - пачка сигналів одного об'єкта на N ≤ 200 ключів — рівно 1 запит;
  - пачка на кількох об'єктах (до `READ_BATCH_MAX` частин) — рівно 1 запит;
  - власне відлуння — 0;
  - приєднання з `recovered: true` — 0 перечитувань;
  - приєднання без `recovered` — рівно 1 запит (частини `version`, `rights`
    і перечитування видимих виглядів) після джитера;
  - сигнал `delete` для ключа поза сховищем — 0;
  - відмова `auth` каналу змін — 0 запитів, лише `purge`.
- Пачка сигналів: тиша `QUIET_MS = 50`, найдовше `MAX_BATCH_MS = 2000`;
  бюджет ключів `KEYS_PER_READ = 200`; дочитування очікуваної мінімальної
  версії — до `MIN_VERSION_RETRIES = 3`; джитер приєднання без `recovered` —
  рівномірно 0–2000 мс (`REJOIN_JITTER_MS = 2000`). Сталі — T4,
  `src/data/runtime/signals.ts`.
- Дедуплікація — за `id` повідомлення (десятковий рядок id рядка outbox,
  Р4 плану ПГ-4/B2), множина останніх `SEEN_SIGNALS_MAX = 4096` id.
- Об'єкт у рядках знімка — мітка виду (`kindLabel`); T4 мапить її на UUID
  об'єкта клієнтським каталогом. Невідома мітка — рядок пропускається.
- Пакет `simetra` без `centrifuge` у `dependencies`; `centrifuge` — лише
  необов'язкова peer і devDependency. `src/data/**`, крім
  `src/data/centrifugo/**`, `centrifuge` не імпортує (лінт-зона).
- Без shims (`AGENTS.md`, принцип 5): стара форма порту `SignalTransport`
  прибирається в тій самій зміні.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Поділ на A і B, межа з B6 і правило «B6 розширює `rightsSnapshot`, не дублює» — рішення архітекторки | §13 рядки B5b і B6 (задача 0) |
| Р2 | **Межа B5b для втрати доступу без сигналу прав** (рішення архітекторки). До B6 втрату доступу ловлять: порівняння знімків на звірці — гідратація, `resume()`, приєднання без `recovered`, перечитування знімка за `command.unavailable` на `create` кореня; а також `command.forbidden` чи відсутній рядок (Р36). Затримку обмежує інтервал свіжості `revalidateIntervalMs`. B6 посилює цю межу сигналами прав | §8.4 — абзац межі B5b (задача 0) |
| Р3 | Форма знімка T0 — `rightsSnapshotSchema`: `{ userId: uuid \| null; projectionVersion?: string; versions?: { scopeKind, scope, version: string }[]; scopeSets: { scopeKind, scope }[]; rights: { level, levelId, scope, container, object, action, extent, dimension }[] }`. `rights` — рядки `rights_mine()` у camelCase, `object` — `kindLabel`. Поля `scopes`, `dimensionValues`, `containers` §9.1 додає B6 разом з обчислювачем: B5b їх не споживає | §9.1 — поля за блоками (задача 0) |
| Р4 | `rightsVersion` — рядок `<projectionVersion>:<sha-256 відсортованих versions>` (T0 `rightsVersionOf(snapshot)`); без `projectionVersion` — `undefined`. Однакові знімки дають однаковий рядок | §6.6 — значення `rightsVersion` (задача 0) |
| Р5 | Порівняння знімків (§6.2 правило 4): пара (скоуп, об'єкт), де в старому знімку предикат `read` (будь-який обсяг, зокрема контейнер) істинний, а в новому — ні, або скоуп зник зі `scopeSets` → `purge` пари. Звуження обсягу (набір `extent` для пари зменшився, але не до нуля) → `revalidate` усіх виглядів об'єкта, зокрема невидимих (до B6). Зміна `userId` — закриття сесії `session-changed` | немає |
| Р6 | Предикат підписки `canSubscribe(snapshot, channel, catalog): boolean` — режим підписки `signal_topic_allowed` для каналу змін (§8.3): `userId` `null` → `false`; несигнальний чи невідомий об'єкт → `false`; `publicRead` → `true`; скоуплений — скоуп у `scopeSets` виду **і** рядок `rights` з `action = 'read'`, `object` = мітка, `extent` ∈ `any`, `own`, вимір, а `level` глобальний чи скоуп рядка = скоуп каналу; нескоуплений — такий рядок на будь-якому рівні, крім контейнерного. Канали `simetra-rights:`, `simetra-user:` → `false` (до B6) | немає |
| Р7 | Канали підписки — для кожного сигнального об'єкта з **активними** виглядами (видимими й невидимими змонтованими, §8.4), для кожного скоупу `scopeSets` виду, де `canSubscribe` істинний; `publicRead` — ще скоупи активних виглядів; нескоуплений — `ZERO_UUID`. Перерахунок — на кожній заміні знімка й на зміні множини об'єктів з активними виглядами, злитий в одну мікрозадачу. Канал, відхилений `auth`, не повторюється до наступної заміни знімка | немає |
| Р8 | Порт T0 (§8.5): `subscribe(channels, onSignal, onError({ kind, channel? }))`, `onSubscribed(({ channel, recovered }) => void)`, `refreshTokens(channels?): Promise<void>`. Реалізація `createCentrifugoTransport` — `src/data/centrifugo/`, вхід `simetra/data/centrifugo`, лінт-зона дозволяє `centrifuge` лише там | §8.5 — вже така форма; немає |
| Р9 | Сигнал `schema` — це відповідь читання `command.unavailable` з `reason: "schema"` (таблиця «подія → `version`» B3-4). Приймач кличе `core.requestVersion()` раз на подію | немає |
| Р10 | Позначки «розрив» (`markDisconnected`) — на `onError({ kind: "transport" })` для каналу (без каналу — усіх). Знімає їх: `recovered: true` — після пачки відновлених сигналів; `recovered: false` — `revalidate` (B3-2: `revalidate` позначки не знімає, тож приймач кличе `clearDisconnected(channel)` після успішного `revalidate` виглядів каналу) | немає |

## Review Focus

1. **Токен каналу після втрати доступу.** Знімок без права `read` на пару
   (скоуп, об'єкт): `purge` рядків пари, канал знято з підписки,
   `refreshTokens` для нього не просить токена. Тест — задачі 4 і 11.
2. **Сигнал від старого покоління.** Сигнал чи відповідь перечитування,
   що прийшли після `purge`, `session-changed` чи `dispose()`, нічого не
   пишуть (`commit` зі старим токеном). Тест — задачі 10 і 13.
3. **Знімок SSR іншого суб'єкта.** Гідратація знімка з `subject` чи
   `rightsVersion`, відмінними від звірки, — `purge` усіх ключів знімка й
   причина в UI. Тест — задача 6.
4. **Канал чужого скоупу.** Сигнал у топіку зі скоупом поза моїми
   `scopeSets` (підробка на транспорті) приймач відкидає, без запиту. Тест —
   задача 10.
5. **Приєднання з `recovered: true`** — 0 перечитувань, а позначки «розрив»
   знято лише після пачки відновлених сигналів. Тест — задача 12.

---

## Частина A — знімок прав клієнта

### Task 0: поправки спеки

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
  - §8.4 — абзац «Межа B5b»: Р2;
  - §9.1 — поля знімка за блоками (Р3);
  - §6.6 — значення `rightsVersion` (Р4);
  - §13 рядок B5b — частини A і B, межа з B6, рядок «B6 розширює
    `rightsSnapshot`, не дублює»; рядок B6 — «розширює знімок B5b».
  
  Звір із поділом, який вносить B5a.

- [ ] **Step 1:** правки. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): B5b — знімок прав, межа з B6, rightsVersion`.

### Task 1: T0 — схема знімка, `rightsVersion`, частина `rights`

**Files:**
- Create: `packages/simetra/src/model/runtime/rights-snapshot.ts`
- Modify: `packages/simetra/src/model/runtime/envelope.ts` (після B1c: схема
  частини пакета `read` дістає `{ type: "rights" }`), `model/runtime/index.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/rights-snapshot.test.ts`,
  тест конверта (B1c)

**Interfaces:**
- Produces:
  - `rightsSnapshotSchema` і `type RightsSnapshot` за Р3 (Zod strict);
  - `function rightsVersionOf(s: RightsSnapshot): Promise<string | undefined>`
    (Р4, WebCrypto `SHA-256`);
  - частина `{ type: "rights" }` у пакеті `read`; відповідь —
    `{ ok: true, value: RightsSnapshot }`; не більше однієї частини `rights`
    на пакет (друга — `command.invalid`).

- [ ] **Step 1: failing tests:**
  - схема приймає вихід з усіма полями й без `versions`/`projectionVersion`;
    зайве поле — відмова;
  - `rightsVersionOf` однаковий для переставлених `versions`, інший для
    іншої версії; без `projectionVersion` — `undefined`;
  - пакет з двома частинами `rights` — відмова схеми.
- [ ] **Step 2:** `pnpm --filter simetra test rights-snapshot envelope` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(model): знімок прав клієнта й частина rights пакета read`.

### Task 2: T1 — `simetra.rights_client_snapshot()`

**Files:**
- Create: `packages/simetra/src/compiler/rights/client-snapshot.ts`
- Modify: генератор функцій прав — підключити одиницю там, де генеруються
  функції фактів (`compiler/rights/functions.ts`), за тією самою умовою
  «є функції прав»
- Test: `packages/simetra/src/compiler/__tests__/rights-client-snapshot.test.ts`,
  `packages/simetra/test/db/rights-client-snapshot.support.ts`,
  `rights-client-snapshot.db.test.ts`, `rights-client-snapshot.supabase.db.test.ts`

**Interfaces:**
- Produces: `simetra.rights_client_snapshot() RETURNS jsonb` — `STABLE SECURITY INVOKER SET search_path = ''`.
  `EXECUTE` — роль запиту `user` профілю (`PROVIDER_API_ROLES`) і
  `simetra_command`; `REVOKE … FROM PUBLIC`. Тіло:
  - кличе лише `current_user_id()`, `rights_mine()`, `scopeSetCall` кожного
    виду скоупу (`compiler/access-units.ts`), а з довідниками прав — ще
    `rights_versions()` і `rights_projection_version()`. Нової
    definer-поверхні немає (§9.1);
  - `userId` `NULL` → `{ "userId": null, "scopeSets": [], "rights": [] }`;
  - числа версій — рядками.

- [ ] **Step 1: failing unit tests** (дерево SQL):
  - функція `SECURITY INVOKER`, `search_path = ''`, `EXECUTE` за переліком;
  - `scopeSets` будує той самий `scopeSetCall`, що й `<t>_scope_read`
    (мутація «`rights_scope_set` для всіх видів» червоніє);
  - без довідників прав немає `rights_versions()`.
- [ ] **Step 2: failing DB tests** (обидва стеки, рядок «DB `simetra`» §12):
  - знімок — лише власні факти: `userId` = `current_user_id()`;
  - `scopeSets` = вихід `scopeSetCall` на кожен вид: вид із членством —
    непорожній, вид з дослівною функцією множини — її вихід;
  - проєкт без довідників прав — знімок працює без `versions`;
  - транзакція `READ ONLY` — без запису;
  - анонім і недійсний користувач — `userId: null`, порожні масиви;
  - вихід проходить `rightsSnapshotSchema`.
- [ ] **Step 3:** FAIL → **Step 4:** реалізація → **Step 5:** PASS обох стеків.
- [ ] **Step 6: Commit** — `feat(compiler): rights_client_snapshot — знімок прав користувача`.

### Task 3: T3 — `runtime.rightsSnapshot` і частина `rights`

**Files:**
- Modify: `packages/simetra/src/server/runtime.ts` (`CommandRuntime.rightsSnapshot`,
  `readParts` після B1c), `packages/simetra/src/server/data-handler.ts`
  (частина `rights`, `inProcess`)
- Test: `packages/simetra/src/server/__tests__/rights-snapshot.test.ts`,
  `packages/designer/src/__tests__/rights-snapshot.db.test.ts`

**Interfaces:**
- Produces:
  - `rightsSnapshot(session: SessionClaims): Promise<RightsSnapshot>`.
    `sessionKind` (ПГ-3) ≠ `"user"` → `{ userId: null, scopeSets: [], rights: [] }`
    без бази. Інакше транзакція `READ ONLY` під роллю `user`,
    `SELECT simetra.rights_client_snapshot()`, вихід — через
    `rightsSnapshotSchema` (розбіжність — `command.internal` і журнал);
  - частина `rights` пакета `read` — у тій самій транзакції, що й частини
    `query` пакета (§4.5 крок 5); `inProcess` теж дає частину `rights`.

- [ ] **Step 1: failing tests:**
  - unit (фейкова база): анонім — без запиту; невалідна відповідь бази —
    `command.internal`; пакет `[query, rights]` — рівно один `BEGIN … READ ONLY`
    і один `COMMIT`;
  - DB: `rights.userId` = id користувача сесії; `inProcess` дає ту саму
    відповідь, що й конверт.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(server): rightsSnapshot і частина rights пакета read`.

### Task 4: T4 — сховище знімка, порівняння, предикат підписки

**Files:**
- Create: `packages/simetra/src/data/rights/snapshot-store.ts`,
  `packages/simetra/src/data/rights/subscribe.ts`
- Modify (після B3-2): `packages/simetra/src/data/store/` — `createCore` дістає
  сховище знімка; `CorePart` (B3-3) дістає `rights`
- Test: `packages/simetra/src/data/rights/__tests__/snapshot-store.test.ts`,
  `subscribe.test.ts`

**Interfaces:**
- Produces:
  - `CoreSession.rightsSnapshot(): RightsSnapshot | undefined` — **єдине**
    джерело `scopeSets` у T4 (Р1);
  - `CoreSession.requestRights(): void` — частина `rights` у збирачі
    поточної мікрозадачі, single-flight з одним хвостом, як
    `requestVersion()` (B5a);
  - `CoreSession.onRightsChange(listener: (next: RightsSnapshot, prev?: RightsSnapshot) => void): () => void`;
  - на кожну відповідь частини `rights` — `diffSnapshots(prev, next, catalog): { purge: { scope: string | null; object: ObjectName }[]; revalidate: ObjectName[]; sessionChanged: boolean }`
    (Р5) і застосування одним `commit`: `purge` пар, далі `revalidate`
    об'єктів, `sessionChanged` → `core.close("session-changed")`;
  - `canSubscribe(snapshot, channel: Channel, catalog: ClientCatalog): boolean` (Р6).

- [ ] **Step 1: failing tests:**
  - `canSubscribe` — `it.each` за кейсами режиму підписки §12 (свій скоуп з
    правом, учасник без `read`, чужий скоуп, лише `own`, лише контейнер,
    нескоуплений з `own`, роль рівня скоупу на нескоупленому, `publicRead`,
    «Користувачі», корінь свій і чужий, `userId: null`, канали прав);
  - `diffSnapshots`:
    - зникла пара — `purge`;
    - зник скоуп зі `scopeSets` — `purge` усіх пар скоупу;
    - зник лише контейнерний обсяг — `purge` (Review Focus 1);
    - звуження `any` → `own` — `revalidate` без `purge`;
    - новий `userId` — `sessionChanged`;
  - сховище: заміна знімка зі старим токеном — нічого (Review Focus 2);
  - у T4 немає іншого джерела `scopeSets`: тест-інваріант — `grep` по
    `src/data` знаходить читання `scopeSets` лише в `rights/`.
- [ ] **Step 2:** `pnpm --filter simetra test snapshot-store subscribe` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): знімок прав клієнта, порівняння й предикат підписки`.

### Task 5: DB-еквівалентність предиката з `signal_topic_allowed`

**Files:**
- Create: `packages/designer/src/__tests__/subscribe-equivalence.support.ts`,
  `subscribe-equivalence.db.test.ts`, `subscribe-equivalence.supabase.db.test.ts`

**Interfaces:**
- Consumes: Task 2–4; `signal_topic_allowed` (ПГ-4/B2 Task 7).

- [ ] **Step 1: failing DB test.** Фікстури прав — кожна пара «користувач,
  скоуп, сигнальний об'єкт», зокрема:
  - лише контейнерне право;
  - роль рівня скоупу на нескоупленому об'єкті;
  - вид з дослівною функцією множини.
  
  Для кожної пари `canSubscribe(знімок користувача, канал)` дорівнює
  `signal_topic_allowed(канал, false)` під claims того самого користувача.
  Вибір скоупів для `publicRead` — поза еквівалентністю (§12).
- [ ] **Step 2:** FAIL (до Task 4) → **Step 3:** PASS обох стеків.
- [ ] **Step 4: Commit** — `test(db): предикат підписки T4 еквівалентний signal_topic_allowed`.

### Task 6: тригери перечитування знімка й SSR `rightsVersion`

**Files:**
- Modify (після B3-6): `packages/simetra/src/data/runtime/ssr.ts`
  (`dehydrate`: `meta.rightsVersion`; `verifyAfterHydration`: частина
  `rights` і звірка)
- Modify (після B5a): `packages/simetra/src/data/runtime/freshness.ts` —
  `resume()` кладе `requestRights()` поряд із `requestVersion()`
- Modify (після B3-4): обробка `command.unavailable` на `create` кореня виду
  скоупу — `requestRights()`
- Modify (після B3-4): зміна `serverHash` у відповіді — `requestRights()`
  поряд із `requestVersion()` (§9.3)
- Test: `packages/simetra/src/data/runtime/__tests__/ssr.test.ts`,
  `freshness.test.ts`, тест запису B3-4

**Interfaces:**
- Produces:
  - `SnapshotMeta.rightsVersion?: string` = `rightsVersionOf(core.rightsSnapshot())`;
  - звірка після гідратації — один запит: `version` + `rights`;
    `subject` чи `rightsVersion` знімка ≠ звірки → `purge` усіх ключів
    знімка й причина `access-changed` (§6.5; Review Focus 3); проєкт без
    `rightsVersion` — як B3-6 (одразу `revalidate`).

- [ ] **Step 1: failing tests:**
  - гідратація: свіжий знімок з тим самим `rightsVersion` — рівно 1 запит
    (`version` + `rights`), без `purge`;
  - інший `rightsVersion` — `purge` усіх ключів знімка, причина в UI;
  - інший `subject` — те саме;
  - `resume()` — рівно 1 запит з частинами `version`, `rights` і
    перечитуваннями (бюджет B5a з частиною `rights`);
  - `command.unavailable` на `create` кореня — рівно 1 запит `rights`;
  - зміна `serverHash` — `version` і `rights` одним запитом.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): знімок прав на гідратації, resume() і зміні serverHash`.

### Task 7: гейти частини A

- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  `pnpm metadata:check` — зелені.
- [ ] **Step 3:** `pnpm test:db:pg` — зелений; повний `pnpm test:db`
  (регресія Supabase) — один раз на частину.
- [ ] **Step 4:** модельний тест ядра (B3-2) — повний прогін, зелений.
- [ ] **Step 5:** `docs/ROADMAP.md` — статус B5b-A; commit
  `docs: ROADMAP — B5b частина A`.

### Готово — частина A

- `rights_client_snapshot` дає лише власні факти; `scopeSets` — вихід
  `scopeSetCall` кожного виду.
- Частина `rights` іде в пакеті `read` однією транзакцією з `query`.
- Знімок у T4 — одне сховище. Порівняння знімків дає `purge` втраченої
  пари й `revalidate` звуження.
- `canSubscribe` еквівалентний `signal_topic_allowed` на фікстурах обох
  стеків.
- Знімок SSR з іншим `subject` чи `rightsVersion` — `purge`.
- `resume()` і зміна `serverHash` перечитують знімок у тому самому запиті.

## Частина B — приймач сигналів і транспорт

### Task 8: порт `SignalTransport` T0 за §8.5

**Files:**
- Modify: `packages/simetra/src/model/runtime/ports.ts`
- Modify: споживачі старої форми — `grep -rn "SignalTransport\|onSubscribed" packages/*/src packages/*/test`
- Test: `packages/simetra/src/model/runtime/__tests__/ports.test.ts` (type-тест)

**Interfaces:**
- Produces (Р8):
  ```text
  type SignalError = { kind: "auth" | "transport"; channel?: string }
  interface SignalTransport {
    subscribe(channels: readonly string[], onSignal: (topic: string, payload: unknown) => void,
              onError: (e: SignalError) => void): Unsubscribe
    onSubscribed(handler: (e: { channel: string; recovered: boolean }) => void): Unsubscribe
    refreshTokens(channels?: readonly string[]): Promise<void>
  }
  ```

- [ ] **Step 1:** type-тест (`expectTypeOf`) форми → FAIL.
- [ ] **Step 2:** реалізація; стара форма прибрана → PASS; `pnpm typecheck`.
- [ ] **Step 3: Commit** — `feat(model): порт каналу сигналів за §8.5`.

### Task 9: фейковий канал для тестів

**Files:**
- Create (після B3-6 Р6): `packages/simetra/src/data/testing/fake-signal-transport.ts`
  (вхід `simetra/data/testing`)

**Interfaces:**
- Produces: `fakeSignalTransport(): SignalTransport & { emit(topic, payload): void; join(channel, recovered: boolean): void; fail(e: SignalError): void; refused: Set<string>; subscribed(): readonly string[]; refreshCalls(): readonly (readonly string[] | undefined)[] }`.
  `refreshTokens` закриває канали з `refused` і кличе `onError({ kind: "auth", channel })`.

- [ ] **Step 1:** unit самого фейка (`subscribe`, `join`, `refused`) → FAIL → реалізація → PASS.
- [ ] **Step 2: Commit** — `test(data): фейковий канал сигналів з recovered`.

### Task 10: приймач — розбір, дедуплікація, пачка, кроки §8.4

**Files:**
- Create (після B3-2): `packages/simetra/src/data/runtime/signals.ts`
- Modify: `packages/simetra/src/data/runtime/` — рантайм створює приймач,
  коли в опціях є `signals: SignalTransport`
- Test: `packages/simetra/src/data/runtime/__tests__/signals.test.ts`

**Interfaces:**
- Consumes: `CoreSession` (B3-2: `activeViews`, `commit`, `token`,
  `readEpoch`; `Writer.markStale`, `markViews`, `purge`); `revalidate` з
  хвостом (B5a); `evaluateFilter` (B3-2 Task 5); `requestVersion()`;
  `rightsSnapshot`, `onRightsChange`, `canSubscribe` (Task 4); сталі Global
  Constraints.
- Produces: `createSignalReceiver({ core, transport, catalog, now, setTimer, clearTimer, random, log }): { dispose(): void }`;
  `DataRuntimeOptions.signals?: SignalTransport`.

Правила (§8.1, §8.4):
- розбір — `received*Schema` (`id` — десятковий рядок); сумісність уперед
  §8.1: нерозібране повідомлення каналу змін — `invalidate` пари топіка;
  `payload.object` ≠ об'єкт топіка — `invalidate` об'єкта топіка; невідомий
  канал — ігнор;
- топік, якого немає серед моїх поточних підписок (зокрема скоуп поза
  `scopeSets`), — відкинути без запиту (Review Focus 4);
- дедуплікація за `id`;
- пачка за об'єктом, кроки 1–7 §8.4 у цьому порядку: `delete` першим,
  відлуння, ключі з меншою версією — одне перечитування за ключами (≤ 200),
  очікувана мінімальна версія (≤ 3 дочитування), нові ключі —
  `evaluateFilter` активних виглядів і `hasNewRows` лише відповідним,
  понад 200 ключів — `revalidate(object, { visibleOnly: true })` і
  `needsRefresh` невидимим, `invalidate` — `revalidate` видимих виглядів
  пари й виглядів ТЧ власників, невидимим — `needsRefresh`;
- усі об'єкти пачки — один пакет `read` (одна мікрозадача).

- [ ] **Step 1: failing tests** (рядок «unit T4 (приймач…)» §12; фейковий
  канал, `countingTransport`, фейкові таймери; число запитів — явно):
  - дедуплікація за `id`;
  - відлуння відкидається без запиту — 0;
  - чужий `delete`: перечитування; `removed` лише за порожньою
    відповіддю; `delete` для рядка, який перечитування повернуло, — нічого;
  - власне відлуння `delete` (ключа немає) — 0;
  - пачка: 50 мс тиші й найдовше 2 с; сплеск 1000 сигналів над вікном — ≤ 1
    запит на вікно пачки за ключами вікна;
  - 1000 різних ключів — `revalidate` видимих, 1 запит;
  - сигнали двох об'єктів в одній пачці — рівно 1 запит;
  - очікувана мінімальна версія: перечитування повернуло 6 при `row_ver` 7 —
    `stale` з `minVersion` 7 і до 3 дочитувань;
  - новий ключ, що підходить фільтру лише одного з двох списків, —
    `hasNewRows` лише йому, у сховище не пишеться;
  - нерозібране повідомлення каналу змін — `invalidate`; невідомий канал — 0;
  - топік чужого скоупу — 0 запитів, 0 записів (Review Focus 4);
  - сигнал після `dispose()` і відповідь перечитування після `purge` пари —
    0 записів (Review Focus 2).
- [ ] **Step 2:** `pnpm --filter simetra test signals` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): приймач сигналів змін за кроками §8.4`.

### Task 11: підписки, відмова авторизації, розрив, `schema`

**Files:**
- Modify: `packages/simetra/src/data/runtime/signals.ts`
- Test: `packages/simetra/src/data/runtime/__tests__/signals-subscriptions.test.ts`

**Interfaces:**
- Produces: правила Р7, Р9, Р10 і §8.4 «Відмова авторизації»:
  - `auth` каналу змін → `purge` пари каналу; канал не повторюється до
    заміни знімка;
  - `auth` без каналу → `requestVersion()`; відповідь `session-changed`
    закриває рантайм, інакше порт сам бере новий токен з'єднання один раз;
  - `transport` → `markDisconnected(channel?)`;
  - `command.unavailable` `schema` у відповіді читання → `requestVersion()`
    раз на подію (Р9).

- [ ] **Step 1: failing tests:**
  - підписки = канали змін сигнальних об'єктів з активними виглядами в
    моїх скоупах (Р7); несигнальний об'єкт — без каналу;
  - заміна знімка, де пара зникла, — канал знято, `purge` (Review Focus 1);
    `refreshTokens` після цього не містить каналу;
  - `auth` каналу — `purge`, 0 запитів, повтору до нової заміни знімка немає;
  - `auth` без каналу — 1 запит `version`;
  - `transport` — позначки «розрив» на рядках виглядів каналу;
  - `schema` — 1 запит `version` на подію, не на частину;
  - монтування першого вигляду об'єкта — підписка в тій самій мікрозадачі
    злита з іншими змінами.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): підписки за знімком прав, відмова каналу, розрив`.

### Task 12: приєднання з `recovered` і без

**Files:**
- Modify: `packages/simetra/src/data/runtime/signals.ts`
- Test: `packages/simetra/src/data/runtime/__tests__/signals-rejoin.test.ts`

**Interfaces:**
- Produces (§8.4 «Після приєднання», Р10):
  - `recovered: false` — через джитер 0–2000 мс (`random` з опцій) одним
    запитом: `revalidate` видимих виглядів пари, `requestRights()`,
    `requestVersion()`; невидимим — `needsRefresh`; після успіху —
    `clearDisconnected(channel)`;
  - `recovered: true` — 0 перечитувань; `clearDisconnected` після пачки
    відновлених сигналів; `stale` з `minVersion` лишається до
    підтвердження.

- [ ] **Step 1: failing tests** (Review Focus 5):
  - `recovered: true` + 50 відновлених сигналів — запити лише за ключами
    пачки, 0 перечитувань виглядів; позначка «розрив» знята після пачки, а
    не до неї;
  - `recovered: false` — рівно 1 запит у межах 2000 мс; позначки зняті
    після успіху; збій перечитування — позначки лишаються;
  - 3 канали приєдналися разом без `recovered` — 1 запит;
  - приєднання після `dispose()` — 0.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): перечитування після приєднання без recovered`.

### Task 13: модельний тест — кроки сигналу

**Files:**
- Modify (після B3-2): модельний тест ядра (`packages/simetra/src/data/__tests__/model.test.ts`
  чи файл, що його дав B3-2) — нові кроки

- [ ] **Step 1:** кроки: сигнал (`create`, `update`, `delete`,
  `invalidate`) у будь-якому порядку з дублями; приєднання з `recovered` і
  без; відмова `auth`; заміна знімка з втратою пари. Інваріанти ядра (§11)
  тримаються; після `purge` пари жоден рядок пари не з'являється з
  відповіді, що почалась до неї (Review Focus 2).
- [ ] **Step 2:** повний прогін модельного тесту — зелений; мутація «приймач
  пише без токена» — червоніє.
- [ ] **Step 3: Commit** — `test(data): кроки сигналу в модельному тесті ядра`.

### Task 14: `simetra/data/centrifugo` і стенд

**Files:**
- Create: `packages/simetra/src/data/centrifugo/index.ts`,
  `packages/simetra/src/data/centrifugo/__tests__/centrifugo.test.ts`
- Modify: `packages/simetra/package.json` — обидва блоки `exports`
  (`./data/centrifugo`), `peerDependencies` `centrifuge` `^5.8.0` з
  `peerDependenciesMeta.optional`; `tsdown.config.ts` (`data/centrifugo/index`);
  `eslint.tier-zones.js` — `centrifuge` дозволено лише в
  `src/data/centrifugo/**`; `test/tier-boundary.test.ts`; пак-тест designer
  (імпорт з тарбола)
- Create: `packages/designer/src/__tests__/signal-receiver.support.ts`,
  `signal-receiver.db.test.ts`, `signal-receiver.supabase.db.test.ts`

**Interfaces:**
- Produces: `createCentrifugoTransport({ url, getConnectionToken, getChannelToken, Centrifuge }): SignalTransport`
  — клас `Centrifuge` передається параметром (ін'єкція), щоб T4 не мав
  статичного імпорту поза зоною. Мапінг:
  - `subscribed` → `onSubscribed({ channel, recovered })`; `recovered` —
    лише з події `subscribed` Centrifugo;
  - `unsubscribed` з кодом `unauthorized` → `onError({ kind: "auth", channel })`,
    без автоповтору;
  - розрив з'єднання — `onError({ kind: "transport" })`;
  - `refreshTokens(channels)` — перепідписка названих каналів;
  - відмова токена каналу — `auth`.
  
  Токени: `getConnectionToken`/`getChannelToken` — функції host-а над
  endpoint-ами `SignalTokens` (П4-D).

- [ ] **Step 1: failing tests:**
  - unit над фейковим `Centrifuge` (мапінг подій);
  - стенд (ПГ-4/B2 `startSignalStand`, `createCentrifugoTokens`, тестовий
    JWKS):
    - реалізація порту: розрив дає повторний `onSubscribed`; короткий розрив
      з історією — `recovered: true`; рестарт — `recovered: false`; відмова
      токена — `auth` без автоповтору;
    - «сигнал рівно раз у своєму скоупі й жодного в чужому»: два рантайми
      двох користувачів двох скоупів, команда в першому — рівно 1 оновлення
      рядка в першому рантаймі, 0 запитів у другому;
    - учасник без `read` на пару — `canSubscribe` хибний, токена не просить,
      сигналів немає;
    - вимір Г7 (§14.2): після видалення членства — час до припинення
      сигналів (до кінця строку токена каналу 5 хв або до `purge` за
      порівнянням знімків на `resume()`). Число й метод — у §8.6.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS обох
  стеків; `pnpm build:packages && pnpm test:packaging` — зелені.
- [ ] **Step 5: Commit** — `feat(data): транспорт Centrifugo і доказ приймача на стенді`.

### Task 15: гейти частини B і документація

**Files:**
- Modify: `packages/designer/skills/` — скіл споживача: `signals` в опціях
  рантайму, `simetra/data/centrifugo`, токени через host (англійською)
- Modify: `docs/ROADMAP.md` — статус B5b
- Modify: спека §8.6 — Г7 (задача 14)

- [ ] **Step 0:** зведена таблиця «мутація §12 П4-B → тест плану» у звіті
  для мутацій приймача й знімка: розбирати повідомлення схемою відправки;
  `onSubscribed` лише на першому підключенні; предикат без `scopeSets`;
  `scopeSets` з `rights_scope_set` для виду з членством; предикат, що
  пропускає лише контейнерне право; не перечитувати після приєднання без
  `recovered`; знімати позначку «розрив» до пачки відновлених; відкидати
  нерозібране повідомлення каналу змін замість `invalidate`; дати `removed`
  за сигналом `delete` без перечитування; записати новий ключ за сигналом у
  сховище; позначати `hasNewRows` на всі вигляди; пропустити звірку
  `rightsVersion` після гідратації. Кожну виконавець робить на закомміченому
  дереві, бачить червоний тест і відкочує.
- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  `pnpm metadata:check`; `python3 scripts/check-doc-anchors.py` — зелені.
- [ ] **Step 3:** `pnpm test:db:pg` — зелений; повний `pnpm test:db` — один раз.
- [ ] **Step 4:** модельний тест і браузерний оракул (B3-6) — зелені.
- [ ] **Step 5:** `pnpm build:packages && pnpm test:packaging` — зелені.
- [ ] **Step 6: Commit** — `docs: B5b — скіл споживача, ROADMAP, Г7`.

### Готово — частина B і блок

- Порт `SignalTransport` має форму §8.5. `simetra/data/centrifugo`
  імпортується з тарбола; `centrifuge` — необов'язкова peer.
- Приймач на фейковому каналі тримає всі бюджети Global Constraints; модельний
  тест з кроками сигналу зелений.
- Стенд обох профілів:
  - `recovered` після короткого розриву, нова епоха, відмова токена;
  - сигнал рівно раз у своєму скоупі й жодного в чужому.
- Г7 внесено в §8.6.
