# ПГ-4 і B2 — outbox, споживач Centrifugo, токени каналів і транспорт сигналу: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Об'єднує блок ПГ-4 спеки профілю `postgres` і
> блок B2 спеки П4-B. Три частини, кожна має своє «готово» й окремий PR:
> **A** — outbox і споживач; **B** — сигнал і авторизація каналу в базі;
> **C** — токени, конфіг Centrifugo й гейт доставки на стенді.
> **Залежності** (рішення архітекторки, Ф5): після ПГ-3, B1e (версія рядка
> з послідовності) і B3-4. Частина A від B1e і B3-4 не залежить. Сигнали прав
> (`signal_rights`, `signal_user_rights`, канали `simetra-rights:` і
> `simetra-user:` у режимі підписки) — блок B6. Приймач і
> `simetra/data/centrifugo` — блок B5.
> **Межа з П4-D.** Цей план дає порт `SignalTokens` і
> `runtime.authorizeChannels`. Маршрути токенів і JWKS — у шаблоні host-а
> `packages/create-simetra-app/template` (інша сесія).
> **Спільні стеки.** Виконавець **ніколи** не виконує `pnpm db:stop`,
> `pnpm db:start`, `pnpm db:pg:stop`, `supabase stop`. DB-тести запускає
> лише через `pnpm --filter … test:db*` під замками стеків.
> **Перед стартом кожної частини:** `.agents/skills/codebase-research/scripts/orient --plan <цей файл>`.
> Якорі з позначкою «після ПГ-2», «після B1e» звір з кодом `main`. Якщо
> розходиться ім'я — перейменуй у плані за кодом. Якщо розходиться
> поведінка — звертайся до архітекторки.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** сигнал змін іде одним транспортом в обох профілях:
- команда сигнального об'єкта пише рядок `simetra.signal_outbox` у своїй
  транзакції;
- вбудований споживач Centrifugo публікує його в канал (скоуп, об'єкт);
- підписатися можна лише з токеном каналу, а токен видається за
  `signal_topic_allowed`.

**Architecture:**
- Outbox, його гранти, тригери й `prune` — одиниці платформного шару
  (`compiler/platform/units.ts`); вони є в кожному проєкті.
- `signal`, `signal_invalidate`, `signal_topic_allowed` і політика `INSERT`
  на outbox — новий генератор `compiler/signal/`. Він видає їх разом із
  функціями ядра команд, за тією самою умовою `hasRightsFunctions`.
- Режим злиття рахує T3 (`server/phase.ts`, `server/transaction.ts`).
- Токени — T3 `simetra/server/signals`: WebCrypto Ed25519, без залежностей.
- Конфіг Centrifugo генерує інструмент designer. Конфіги обох стеків
  розробки — його вихід.
- Стенд сигналу — власний контейнер Centrifugo на прогін, з тегом прогону;
  частина DB-проєкту.

**Tech Stack:** TypeScript 7, Zod, Vitest 5, `pg` 8.23.1, Postgres 17,
Centrifugo v6 (образ, закріплений у `docker/postgres-stack/compose.yaml`),
`centrifuge` 5.8.0 (лише devDependency тестів стенду), WebCrypto.

**Spec:**
- [спека профілю `postgres`](../specs/2026-11-08-postgres-profile-design.md)
  §3.1 (ролі сигналів), §5–§7, §10.1, §10.4, §11, §12 рядок ПГ-4;
- [спека П4-B](../specs/2026-11-05-p4-b-client-data-design.md) §8.1–§8.3,
  §8.5 (лише формат токенів), §12 (рядки «unit T1», «DB `simetra`», «стенд
  сигналу», мутації), §13 рядок B2;
- [звіт спайку realtime](../specs/2026-11-08-t4-realtime-spike-report.md);
- правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською й пояснюють «чому». Діагностики,
  повідомлення CLI й опис інструмента — англійською. JSDoc експортованого
  API — англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів. Push і PR
  робить архітекторка.
- Імена ролей, схеми, таблиці, каналу `NOTIFY` і налаштувань — константи
  T0/T1, ніколи літерал у споживачі:
  - `PLATFORM_ROLES.signalConsumer = "simetra_signal_consumer"`;
  - `PLATFORM_LOGIN_ROLES.signals = "simetra_signals"`;
  - `SIGNAL_OUTBOX = { schema: "simetra", name: "signal_outbox" }`;
  - `SIGNAL_NOTIFY_CHANNEL = "simetra_signal_outbox"`;
  - `SIGNAL_MODE_SETTING = "simetra.signal_mode"`, значення злиття — `"merge"`.
- Форма outbox — дослівно §5.1 спеки профілю: колонки `id bigserial`,
  `method`, `payload`, `partition`, `created_at`. `CHECK` на `method` і
  `partition` — як там.
- Регулярний вираз каналу в `CHECK` — `^simetra(-rights|-user)?:[0-9a-f:-]+$`.
- Токени: EdDSA (Ed25519, `kty: OKP`), кожен з `kid`. З'єднання — 15 хв,
  канал — 5 хв. `aud` = `centrifugo:<project.name>`, `iss` — origin host-а.
- Простори Centrifugo — дослівно §6.1: `simetra` (100 / 300s / 24h),
  `simetra-rights` і `simetra-user` (20 / 300s / 24h), `force_recovery: true`;
  `recovery_max_publication_limit: 300`; `http_api.disabled: true`; жодного
  `allow_*_for_*`, `insecure`, `admin`, анонімного з'єднання.
- Параметри споживача — дослівно таблиця §5.3: `num_partitions: 1`,
  `partition_select_limit: 100`, `partition_poll_interval: "300ms"`,
  `use_try_lock: true`, `partition_notification_channel` = `SIGNAL_NOTIFY_CHANNEL`.
- Пакет `simetra` не залежить від `centrifuge` і `pg` у `src/server/signals`.
  Зона чистоти T3 (`eslint.tier-zones.js`) не послаблюється.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`).
- Команди DB-тестів — за станом після ПГ-2b: стек `postgres` —
  `pnpm --filter <пакет> test:db <шаблон>`; стек `supabase` —
  `pnpm --filter <пакет> test:db:supabase <шаблон>` (лише
  `*.supabase.db.test.ts`). Кейс «на обох стеках» — спільне тіло в
  `*.support.ts` і два тонкі файли: `<ім'я>.db.test.ts` і
  `<ім'я>.supabase.db.test.ts`.
- **Кластерні ролі на спільних стеках.** Нові ролі (`simetra_signal_consumer`,
  `simetra_signals`) з'являються на стеку лише кроком ролей:
  - `postgres` — повторний `pnpm db:pg:start` (ідемпотентний, кличе
    `simetra roles`, Р2 ПГ-2b);
  - `supabase` — `pnpm db:roles` (вводить ПГ-3, задача 4a): виконує
    ідемпотентний `supabase/roles.sql` на запущеному стеку під замком.
  
  Обидва кроки адитивні (Р11, дозволено архітекторкою): лише `CREATE`
  відсутнього і членства, які додає сам крок, жодного `ALTER`/`DROP`.
- Контейнери стенду мають мітки `runContainerLabels(tag, provider)`
  (`packages/simetra/test/db/external.ts`). Після кожного прогону
  `docker ps -a --filter label=simetra-run` — порожньо.
- Без shims (`AGENTS.md`, принцип 5): статичні конфіги Centrifugo стеків
  замінює вихід генератора в тій самій зміні.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Залежності ПГ-4/B2: ПГ-3, B1e, B3-4; не B6. Сигнали прав і канали прав у режимі підписки — B6; у B2 обидва режими для `simetra-rights:` і `simetra-user:` дають `false` (рішення архітекторки, Ф5) | спека профілю §5.3 і §12: «B8» → «B2», «B6 П4-B» → «B1e, B3-4 П4-B» (задача 0) |
| Р2 | Бенчмарк ТЧ на 1/1 000/5 000 рядках — у B1d. Інваріант суцільного номера рядка ТЧ і підвищення версії власника — у B3-5 (рішення архітекторки, Ф6) | П4-B §13 рядок B2 (задача 0) |
| Р3 | `aud` = `centrifugo:<project.name>`: окремого id застосунку в проєкті немає (рішення архітекторки, Ф8) | спека профілю §6.1, §6.3 (задача 0) |
| Р4 | Верхній `id` повідомлення — десятковий рядок id рядка outbox, рівний `idempotency_key`. Його ставить тригер `BEFORE INSERT` outbox з `NEW.id`, а не функція сигналу. Причина: `simetra_command` має `INSERT` лише на `(method, payload)` і не бачить свого `id`; без тригера вона могла б підставити чужий ключ ідемпотентності. Тригер переписує обидва поля завжди. T0 `received*Schema` змінює `id` з UUID на десятковий рядок | П4-B §8.1 (задача 0) |
| Р5 | `runtime.authorizeChannels(claims, channels): Promise<{ user: string \| null; channels: string[] }>` — одна транзакція `READ ONLY` під роллю запиту. `user` = `current_user_id()`. Сесія, для якої `sessionKind` (ПГ-3) — не `"user"` (анонім чи без валідного claim аноніма), — `{ user: null, channels: [] }` без запиту. Обидва endpoint-и host-а — з'єднання й каналів — ідуть одним викликом (рішення архітекторки, Ф9) | немає |
| Р6 | Стенд запускає Centrifugo з `--network host` і `http_server.address = "127.0.0.1"` на вільному порту. Споживач тоді бачить теговану базу спільного стека за тим самим `127.0.0.1:<порт стека>`, що й тест. JWKS віддає тестовий HTTP-сервер на `127.0.0.1` | §10.4 — уточнення (задача 0) |
| Р7 | У частині A стенд спостерігає публікацію через історію каналу HTTP API Centrifugo. API вмикає лише конфіг стенду, з ключем, на `127.0.0.1`. З частини C стенд бере конфіг генератора (API вимкнено), а доставку спостерігає клієнт `centrifuge` з токенами | немає |
| Р8 | Функція створення кореня кличе `signal` лише в моделі з роллю `rootCreator`. У моделі оператора політика відхилила б рядок, а відмова `INSERT` валить команду (§8.2 П4-B) | немає |
| Р9 | Пара (скоуп, об'єкт) фази для `signal_invalidate` T3 виводить з результату ядра та каталогу рантайму: колонка-носій скоупу рядка, у кореня — його `id`, у нескоупленого — `ZERO_UUID` | немає |
| Р10 | **`EXECUTE` на `signal_topic_allowed` — лише `simetra_command` і ролі запиту `user`, а не `PUBLIC`.** Політика `INSERT` outbox — `TO simetra_command`, тож Postgres не перевіряє функцію для інших ролей. Власник, що пише сигнали прав (B6), обходить RLS. З `PUBLIC` роль споживача (`USAGE` на `simetra`) могла б поставити claims і питати права будь-якого користувача — оракул прав. Рішення архітекторки. **Залишковий ризик:** роль `user` з довільним SQL могла б підробити claims; межа — роль запиту не отримує довільного SQL (PostgREST не виставляє `pg_catalog`) | П4-B §8.3, Рд9 (задача 0) |
| Р11 | Кластерні ролі сигналів на спільних стеках створює ідемпотентний крок ролей (Global Constraints), а не перезапуск (дозвіл архітекторки). **Інваріант для інших гілок:** нова роль не стає членом ролей, які перевіряють гейти форми (`LOGIN_ROLE_PARENTS`, власник), і не дістає серед них членів. `simetra_signals` — член лише `simetra_signal_consumer`; та — нічий член. Гейти гілок без цих ролей не червоніють | немає |
| Р12 | `sub` токена з'єднання = `user` з `authorizeChannels` (`current_user_id()`), а не сирий `claims.sub`. Для обох пресетів вони рівні (`subjectIsUserId`). Але `user` — id «Користувачів», і так само Centrifugo знає користувача для майбутнього `disconnect` (§6.2) | спека профілю §6.2 таблиця токенів (задача 0) |
| Р13 | Тригер штампа — не єдиний захист `id`. `CHECK` прив'язує обидва поля до колонки: `payload->>'idempotency_key' = id::text AND payload->'data'->>'id' = id::text`. Вимкнений тригер дає `23514`, а не тихо чужий ключ | немає |
| Р14 | T3 скидає `simetra.signal_mode` у тому самому операторі, що ставить claims команди (`set_config(SIGNAL_MODE_SETTING, '', true)`). Значення, задане ролі чи базі (`ALTER ROLE … SET`), не гасить сигналів | немає |

## Review Focus

1. **Підробка ключа ідемпотентності.** `simetra_command` вставляє `payload`
   з власним `idempotency_key` чи `data.id`. Тригер переписує обидва з
   `NEW.id`. Зайвий ключ запиту публікації (`skip_history`, `b64data`,
   `tags`) — `CHECK` відмовляє. Тест — задача 3.
2. **Споживач без налаштування ролі** чи з членством у `simetra_command`.
   Без `ALTER ROLE … SET role` споживач падає `permission denied`. Член
   `simetra_command` — гейт ролей відмовляє. Тест — задачі 2 і 3.
3. **Дозволений, потім недозволений канал в одній транзакції.** Другий
   рядок відхилено, а з ним і вся транзакція. Тест — задача 7.
4. **Сесія без дійсного користувача.** Анонім чи користувач з `invalid`
   просить токени — `user: null`, жодного каналу. Тест — задача 11.
5. **Ротація ключа.** Токен, підписаний новим ключем раніше за правило
   перекриття, не видається. Старий ключ лишається в JWKS 20 хв після
   останнього підпису. Відставлений ключ ніколи не підписує. Підписка,
   взята старим токеном, не рветься. Тест — задачі 10 і 13.
6. **Довільні дані в сигналі.** Прямий виклик `simetra.signal` сирим SQL від
   `simetra_command` з ключами-значеннями полів, невідомою операцією чи
   мегабайтним `jsonb`. Функція відмовляє, `CHECK` розміру тримає межу.
   Тест — задачі 3 і 8.

---

## Частина A — outbox і споживач

### Task 0: поправки спек

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`:
  - §5.3 «Вплив на код»: «блок B8 П4-B» → «блок B2 П4-B»;
  - §12 рядок ПГ-4: «разом із B8» → «разом із B2»; «Залежить від»:
    «ПГ-3; B1e, B3-4 П4-B» (Р1);
  - §6.1 і §6.3: `<id застосунку>` → `<project.name>` (Р3);
  - §10.4: Р6;
  - §5.3 «Вплив на код»: тіла `signal_rights`, `signal_user_rights` для
    outbox — «блок B6 П4-B» (не ПГ-4, рішення архітекторки); тіла
    `signal`, `signal_invalidate` — «блок B2 П4-B»;
  - таблиця §13, рядок «спека П4-B (редакція 3)»: «B2, B8» → «B2, B6»;
  - §6.2 таблиця токенів: `sub` = `user` з `authorizeChannels` (Р12).
- Modify: `docs/superpowers/specs/2026-10-23-provider-profiles-design.md` —
  рядок про outbox і токен каналу: «блок B8» → «блок B2 П4-B» (outbox, токен)
  і «B6» (сигнали прав).
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
  - §8.1: `id` — десятковий рядок id рядка outbox; його ставить тригер
    outbox (Р4);
  - §13 рядок B2: бенчмарк ТЧ → B1d, інваріант номера рядка ТЧ і версії
    власника → B3-5 (Р2); «Після»: B1b-1, B1e, B3-4, ПГ-3;
  - рядок B1d — додати бенчмарк ТЧ на 1/1 000/5 000 рядках;
  - рядок B3-5 — додати інваріант суцільного номера рядка ТЧ і підвищення
    версії власника на зміні змісту ТЧ (рішення архітекторки);
  - §8.3 і Рд9: Р10. Нова причина: «політика `INSERT` — `TO simetra_command`,
    іншим ролям її не застосовують; `PUBLIC` дає оракул прав ролі з `USAGE`
    на `simetra`». Плюс рядок залишкового ризику Р10.

- [ ] **Step 1:** правки. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py`, `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): ПГ-4 і B2 — залежності, aud, id сигналу`.

### Task 1: дані T0 ролей сигналів

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts` (`PLATFORM_ROLES`,
  `PLATFORM_LOGIN_ROLES`, `LOGIN_ROLE_PARENTS` — після ПГ-2)
- Test: `packages/simetra/src/model/__tests__/` — тест мап проєкту (той
  самий файл, що тестує `LOGIN_ROLE_PARENTS` у ПГ-2a)

**Interfaces:**
- Produces:
  - `PLATFORM_ROLES = { command: "simetra_command", signalConsumer: "simetra_signal_consumer" }`;
  - `PLATFORM_LOGIN_ROLES = { runtime: "simetra_runtime", signals: "simetra_signals" }`;
  - `LOGIN_ROLE_PARENTS.signals` — лише `PLATFORM_ROLES.signalConsumer`, в
    обох профілях;
  - `export const LOGIN_ROLE_SETTINGS: Readonly<Partial<Record<keyof typeof PLATFORM_LOGIN_ROLES, { role: string }>>> = { signals: { role: PLATFORM_ROLES.signalConsumer } }`
    — налаштування `role` ролі входу.
- `PlatformRolePurpose = keyof typeof PLATFORM_ROLES` автоматично зробив би
  `signalConsumer` призначенням гранту (`GrantPurpose`, `grantRole`,
  `isPlatformPurpose` у `compiler/sql/execute-grants.ts`). Звузь тип:
  `PlatformRolePurpose = Exclude<keyof typeof PLATFORM_ROLES, "signalConsumer">`.
  Гранти outbox видає задача 3 адресно.
- `PLATFORM_ROLE_NAMES` (`schema/apply/platform-roles.ts`) дістає й
  `simetra_signal_consumer`: гейт вимагає її існування в обох профілях.
- Тип батьків `LOGIN_ROLE_PARENTS` (ПГ-2a: `"command" | "request"`) дістає
  токен `"signalConsumer"`.

- [ ] **Step 1: failing tests:** значення вище; `loginRoleParentNames("signals", p)`
  для обох `p` — `["simetra_signal_consumer"]`; type-тест
  (`expectTypeOf`): `"signalConsumer"` не є `GrantPurpose`.
- [ ] **Step 2:** `pnpm --filter simetra test project` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(model): ролі споживача сигналів у даних T0`.

### Task 2: гейт і створення ролей сигналів

**Files:**
- Modify: `packages/simetra/src/schema/apply/platform-roles.ts`
  (`platformRoleSet`, `platformRoleRefusals`, `checkPlatformRoles`,
  `ensurePlatformRoles`), `packages/simetra/src/schema/apply/postgres-cluster.ts`
  (після ПГ-2), `packages/designer/src/tools/roles-tool.ts`
- Modify: `supabase/roles.sql` — за правилом ідемпотентності задачі 4a ПГ-3
  (кожне членство під власною перевіркою `pg_auth_members`):
  `simetra_signal_consumer` (`NOLOGIN NOINHERIT`),
  `simetra_signals` (`LOGIN NOINHERIT`, член `simetra_signal_consumer`
  `WITH INHERIT FALSE, SET TRUE`, `ALTER ROLE simetra_signals SET role = 'simetra_signal_consumer'`);
  dev-пароль — за тим самим правилом, що й `simetra_runtime` у файлі
- Modify: `supabase/tests/provider-base-state.test.sql` — атрибути обох
  ролей, членство й налаштування; `plan(…)` відповідно
- Modify (після ПГ-2): набір базового стану стека `postgres` — ті самі
  перевірки; dev-пароль `simetra_signals` у `docker/postgres-stack/dev-secrets.env`
  і в кроці паролів `pnpm db:pg:start` (Р2 плану ПГ-2b)
- Test: `packages/simetra/src/schema/apply/__tests__/platform-roles.test.ts`,
  `packages/designer/src/__tests__/roles-tool.test.ts`,
  `roles-tool.postgres.db.test.ts`, `roles-tool.supabase.db.test.ts` (або
  наявний файл `roles-tool` стека Supabase — звір)

**Interfaces:**
- Consumes: задача 1.
- Produces:
  - `PlatformLoginRole` дістає `settings?: Readonly<Record<string, string>>`;
    для `signals` — `{ role: "simetra_signal_consumer" }`;
  - `platformRoleSet(provider).login` містить обидві ролі входу в обох
    профілях;
  - гейт читає `pg_db_role_setting` (`setdatabase = 0`). Розбіжність
    налаштування — `plan.platform-role-shape` з `setting:role`;
  - `ensurePlatformRoles` і `ensurePostgresCluster` створюють обидві ролі,
    членство й `ALTER ROLE … SET role`. Наявну роль лише звіряють.

- [ ] **Step 1: failing unit tests:**
  - `simetra_signals` з батьком `simetra_command` — `plan.platform-role-shape`
    `member-of:simetra_command` (Review Focus 2);
  - без налаштування `role` — `setting:role`;
  - з `INHERIT TRUE` — відмова за наявним правилом пари;
  - `simetra_runtime` член `simetra_signal_consumer` — `member-of:simetra_signal_consumer`
    (дозволені батьки — свої для кожної ролі входу, ПГ-2a);
  - `simetra_signal_consumer` член `simetra_command` чи ролі запиту — відмова.
- [ ] **Step 2: failing DB tests** (обидва стеки, теговані імена):
  - після `roles` атрибути, `pg_auth_members` і `pg_db_role_setting` — за
    §3.1;
  - повтор нічого не змінює;
  - тегована роль входу з налаштуванням: `SELECT current_user` у новій сесії
    — `simetra_signal_consumer`. Кейс «без налаштування — `42501` на
    outbox» — у задачі 3, бо таблиці ще немає;
  - `postgres`: `simetra_signals` має адресний `CONNECT` на цільову базу, а
    явний `CONNECT` на іншу базу дає `roles.shared-cluster` (§3.1).
- [ ] **Step 3:** `pnpm --filter simetra test platform-roles` і
  `pnpm --filter @simetrajs/designer test roles-tool` — FAIL.
- [ ] **Step 4:** реалізація; `supabase test db` і базовий стан `postgres` — зелені.
- [ ] **Step 5:** ролі на спільних стеках — повторний `pnpm db:pg:start` і
  `pnpm db:roles` (Р11); PASS:
  `pnpm --filter @simetrajs/designer test:db roles-tool` і
  `pnpm --filter @simetrajs/designer test:db:supabase roles-tool` — зелені.
- [ ] **Step 6: Commit** — `feat(schema): ролі споживача сигналів в обох профілях`.

### Task 3: таблиця outbox, тригери, гранти, `prune`

**Files:**
- Create: `packages/simetra/src/compiler/platform/outbox.ts`
- Modify: `packages/simetra/src/compiler/platform/units.ts` (`buildPlatformUnits` додає одиниці outbox)
- Modify: `packages/simetra/src/model/runtime/signal.ts` — константи
  `SIGNAL_OUTBOX`, `SIGNAL_NOTIFY_CHANNEL`, `SIGNAL_TOPIC_PATTERN`
- Test: `packages/simetra/src/compiler/__tests__/signal-outbox.test.ts`,
  `packages/simetra/test/db/signal-outbox.support.ts`,
  `signal-outbox.db.test.ts`, `signal-outbox.supabase.db.test.ts`

**Interfaces:**
- Produces `function outboxUnits(provider: DatabaseProvider, parse: SqlParser): SqlUnit[]` — одиниці
  `generator: "platformLayer"`:
  1. таблиця §5.1 дослівно плюс `CHECK` форми `payload`:
     - ключі рівно `channel`, `data`, `idempotency_key`, без підзапиту:
       `payload ?& ARRAY['channel','data','idempotency_key'] AND (payload - 'channel' - 'data' - 'idempotency_key') = '{}'::jsonb`;
     - `payload->>'channel' ~ SIGNAL_TOPIC_PATTERN`;
     - `jsonb_typeof(payload->'data') = 'object'`;
     - `payload->>'idempotency_key' = id::text AND payload->'data'->>'id' = id::text` (Р13);
     - `octet_length(payload::text) <= 1024` — сигнал без даних короткий
       (Review Focus 6);
  2. `simetra.signal_outbox_stamp()` + тригер `BEFORE INSERT … FOR EACH ROW`:
     `NEW.payload := jsonb_set(jsonb_set(NEW.payload, '{data,id}', to_jsonb(NEW.id::text)), '{idempotency_key}', to_jsonb(NEW.id::text))`
     (Р4). Функція `SECURITY INVOKER`, `SET search_path = ''`, без `EXECUTE`
     для `PUBLIC`;
  3. `simetra.signal_outbox_notify()` + тригер `AFTER INSERT … FOR EACH STATEMENT`:
     `pg_notify(SIGNAL_NOTIFY_CHANNEL, '0')`;
  4. `ENABLE ROW LEVEL SECURITY` без `FORCE`;
  5. гранти:
     - `REVOKE ALL` на таблицю й послідовність від `PUBLIC` і ролей API
       провайдера;
     - `simetra_command`: `INSERT (method, payload)` і `USAGE` на
       послідовність (без `SELECT`);
     - `simetra_signal_consumer`: `USAGE` на схему `simetra`, `SELECT`,
       `DELETE`, політики `signal_outbox_consumer_select` і
       `signal_outbox_consumer_delete` (`USING (true)`,
       `TO simetra_signal_consumer`);
  6. `simetra.signal_outbox_prune(p_older_than interval) RETURNS bigint` —
     `DELETE … WHERE created_at < now() - p_older_than`, повертає число рядків.
     `EXECUTE` лише власнику (`REVOKE … FROM PUBLIC`).
- Політику `INSERT` для `simetra_command` дає частина B (задача 7). До неї
  RLS відхиляє вставку `simetra_command`, і це очікувано.
- `buildPlatformUnits` завершується раніше, коли немає «Користувачів» і
  сесійного користувача. Одиниці outbox додаються до цих ранніх `return`,
  щоб бути в кожному проєкті.
- `SqlUnit.generator` — наявне `"platformLayer"`; ребра `requires` між
  таблицею, послідовністю, функціями й тригерами — явні, як `bodyRequires`
  у `catalog-command/units.ts`.

- [ ] **Step 1: failing unit tests** (`signal-outbox.test.ts`, дерево SQL):
  - колонки, типи й `CHECK` §5.1;
  - тригер `NOTIFY` — `FOR EACH STATEMENT`;
  - тригер штампа — `BEFORE INSERT`;
  - гранти рівно за переліком, `it.each` над `DATABASE_PROVIDERS`;
  - одиниці є в моделі без «Користувачів» і без прав.
- [ ] **Step 2: failing DB tests** (`signal-outbox.db.test.ts`, стек профілю;
  кожен кейс у транзакції з `ROLLBACK`, крім `NOTIFY`):
  - власник вставляє `{ channel, data }` → рядок має `data.id` і
    `idempotency_key` = `id::text`;
  - вставка з власним `idempotency_key` і `data.id` → обидва переписано
    (Review Focus 1);
  - тригер штампа вимкнено (`ALTER TABLE … DISABLE TRIGGER` у транзакції
    тесту, від власника) і вставлено рівну пару, відмінну від `id`, —
    `23514` (Р13);
  - `payload` понад 1024 байти — `23514`;
  - `payload` з `skip_history` чи `channel` поза шаблоном — `23514`;
  - роль споживача (тегована роль входу з налаштуванням задачі 2) робить
    `SELECT` і `DELETE`; `INSERT` і `UPDATE` — `42501`; `SELECT` з
    `simetra.ledger` і з таблиці виду — `42501`;
    `has_function_privilege` на жодну функцію схеми `simetra` — `false`
    (запит до `pg_proc` схеми);
  - роль входу споживача без налаштування — `42501` на `SELECT` outbox
    (з задачі 2);
  - ролі запиту: `SELECT`, `INSERT` — `42501`;
  - `simetra_command`: `SELECT`, `DELETE` — `42501`;
  - `NOTIFY`: слухач на окремому з'єднанні. Транзакція з трьома вставками
    дає одне сповіщення після `COMMIT`; `ROLLBACK` — ні рядка, ні
    сповіщення;
  - `prune('1 hour')` прибирає лише старші рядки; `EXECUTE` від
    `simetra_command` — `42501`.
- [ ] **Step 3:** `pnpm --filter simetra test signal-outbox` — FAIL.
- [ ] **Step 4:** реалізація.
- [ ] **Step 5:** PASS: `pnpm --filter simetra test:db signal-outbox` і
  `pnpm --filter simetra test:db:supabase signal-outbox` (тіло — у
  `signal-outbox.support.ts`); `pnpm metadata:check` — зелений.
- [ ] **Step 6: Commit** — `feat(compiler): outbox сигналів у форматі споживача Centrifugo`.

### Task 4: стенд сигналу в тест-інфрі

**Files:**
- Create: `packages/simetra/test/db/signal-stand.ts`,
  `packages/simetra/test/db/signal-stand.support.ts`,
  `signal-stand.db.test.ts`, `signal-stand.supabase.db.test.ts`
- Modify: `packages/simetra/test/db/stack-guard.ts` — прибирання контейнерів
  свого тегу вже є з ПГ-1; звір, що стенд ним покритий
- Reference: `git show spike/t4-realtime:packages/simetra/test/realtime/stand.ts`

**Interfaces:**
- Produces:
  ```text
  interface SignalStandOptions {
    databaseUrl: string             // DSN тегованої ролі входу споживача до тегованої бази
    notifyUrl?: string              // типово = databaseUrl; "none" — без LISTEN
    config?: unknown                // з частини C — вихід генератора; у A — конфіг стенду
  }
  interface SignalStand { httpUrl: string; wsUrl: string; apiKey?: string; restart(): Promise<void>; down(): Promise<void> }
  function startSignalStand(o: SignalStandOptions): Promise<SignalStand>
  function standHistory(stand: SignalStand, channel: string): Promise<unknown[]>   // лише з apiKey (Р7)
  ```
- Контейнер: образ і тег — з `docker/postgres-stack/compose.yaml` (читати
  файл, не дублювати рядок); `--network host` (Р6); ім'я
  `simetra-signals-<tag>`; мітки `runContainerLabels(runTag(), testProvider())`;
  конфіг — у тимчасовому каталозі, змонтованому `:ro`. Очікування готовності
  — `GET /health` (`health.enabled: true` у конфігу).
- DSN споживача несе `application_name` тегу прогону (`runApplicationName`
  з `connection.ts`): guard тоді завершує його бекенди.
- Адресу HTTP стенд накладає сам на будь-який `config`: змінні контейнера
  `CENTRIFUGO_HTTP_SERVER_ADDRESS=127.0.0.1` і `CENTRIFUGO_HTTP_SERVER_PORT=<вільний порт>`.
  Тест стенду перевіряє, що на `0.0.0.0:<порт>` зовнішнього інтерфейсу
  нічого не слухає (`ss -ltn` чи спроба з'єднання з не-loopback адреси).
- Порядок прибирання: `down()` стенду, потім drop бази й ролей. Інакше
  `DROP DATABASE` чекає на живі з'єднання споживача.
- Стенд не імпортує designer: конфіг дає виклик (`config`). У частині A —
  власний конфіг стенду, з частини C — `centrifugoConfig`, який передає тест
  designer.
- Конфіг стенду в частині A: простори §6.1, споживач §5.3 на `databaseUrl`,
  `http_api` з випадковим ключем, `http_server.address: "127.0.0.1"`,
  вільний порт.

- [ ] **Step 1: failing DB tests** (`signal-stand.db.test.ts`; тегована
  база з моделлю, де є outbox; тегована роль входу споживача):
  - власник вставляє рядок у канал `simetra:<z>:<z>:<uuid>` → публікація
    з'являється в історії каналу; `data.id` = id рядка; рядок outbox
    видалено;
  - p95 «коміт → історія» з `LISTEN` ≤ 50 мс на 200 вставках (опитування
    історії кожні 5 мс; крок опитування в межі не рахувати);
  - `notifyUrl: "none"` → публікація доходить за ≤ 600 мс (такт 300 мс із
    запасом);
  - споживач зі справжнім логіном тегованої ролі з грантами лише задачі 3
    працює (доказ «лише `SELECT` і `DELETE`»);
  - `use_try_lock`: два контейнери на тому самому outbox — кожен рядок
    опубліковано рівно раз (історія каналу без дублів за `data.id`);
  - `restart()` (рушій у пам'яті) — нова епоха; рядки outbox, вставлені під
    час рестарту, публікуються після старту;
  - після `down()` і після падіння тесту (кейс з `throw` усередині
    `try/finally` стенду) — `docker ps -a --filter label=simetra-run=<tag>`
    порожньо.
- [ ] **Step 2:** `pnpm --filter simetra test:db signal-stand` — FAIL.
- [ ] **Step 3:** реалізація.
- [ ] **Step 4:** PASS: `pnpm --filter simetra test:db signal-stand` і
  `pnpm --filter simetra test:db:supabase signal-stand`. На `supabase`
  споживач дивиться на теговану базу стека Supabase.
- [ ] **Step 5: Commit** — `test(db): стенд сигналу з Centrifugo й тегом прогону`.

### Task 5: `realtime` у стеку `supabase` вимкнено

**Files:**
- Modify: `supabase/config.toml` — `[realtime] enabled = false`
- Modify: `supabase/tests/provider-base-state.test.sql` — без `has_schema('realtime')`; `plan(…)` − 1
- Modify: тести, що спираються на Realtime чи схему `realtime`. Перелік:
  `grep -rn "realtime" packages/*/src packages/*/test --include=*.ts`.
  Наприклад, `packages/designer/src/schema-engine/__tests__/execute-plan.supabase.db.test.ts`:
  кейс з `to_regclass('realtime.messages')` переводиться на факт, що лишився
  на стеку. Його змісту не втрачай.

- [ ] **Step 1:** правки; кожна зміна тесту — у звіті з причиною.
- [ ] **Step 2:** `supabase test db` і scoped `db-supabase` зачеплених
  файлів — зелені. Стек не перезапускати: зміна `config.toml` діє на
  наступному `pnpm db:start`. Тест базового стану перевір на тегованій
  базі, а запуск стека — у CI.
- [ ] **Step 3: Commit** — `build(db): Supabase Realtime вимкнено — сигнал іде через outbox`.

### Готово — частина A

- Обидва профілі мають outbox §5.1 з `CHECK`, штампом `id`, `NOTIFY` рівня
  оператора, грантами й політиками споживача і `prune`.
- `simetra roles`, `supabase/roles.sql` і набори базового стану знають
  `simetra_signal_consumer` і `simetra_signals` з налаштуванням ролі.
- На стенді обох профілів споживач з логіном `simetra_signals`:
  - публікує рядок за ≤ 50 мс p95 з `LISTEN`, за такт опитування без нього;
  - не чіпає нічого поза outbox.
- `realtime` у стеку `supabase` вимкнено.
- Гейти задачі 14 для частини A зелені.

## Частина B — сигнал і авторизація каналу в базі

### Task 6: T0 — формат прийнятого сигналу й налаштування режиму

**Files:**
- Modify: `packages/simetra/src/model/runtime/signal.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/signal.test.ts`

**Interfaces:**
- Produces:
  - `received*Schema.id` — `z.string().regex(/^[1-9][0-9]{0,18}$/)` (Р4);
  - `SIGNAL_MODE_SETTING = "simetra.signal_mode"`, `SIGNAL_MERGE_MODE = "merge"`;
  - `CENTRIFUGO_CHANNEL_MAX = 255` і тест Г10: найдовший канал
    `channelTopic` (три UUID) ≤ межі, символи — з дозволених простору.

- [ ] **Step 1: failing tests:**
  - `id: "17"` проходить; UUID, `"0"`, `"01"`, число — ні;
  - Г10.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація; споживачі `id` у T4
  (`grep -rn "received.*Schema" packages/simetra/src`) — за типом.
- [ ] **Step 4:** PASS. **Step 5: Commit** — `feat(model): id сигналу — id рядка outbox`.

### Task 7: `signal_topic_allowed` і політика `INSERT` на outbox

**Files:**
- Create: `packages/simetra/src/compiler/signal/topic-allowed.ts`,
  `packages/simetra/src/compiler/signal/units.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts` — підключити
  `buildSignalUnits` поруч із `buildCatalogCommandUnits`, з тією самою умовою
  `hasRightsFunctions`
- Modify: `packages/simetra/src/compiler/access-units.ts` або
  `compiler/rights/predicates.ts` — безрядкова форма предиката права
  `read` (нижче)
- Test: `packages/simetra/src/compiler/__tests__/signal-topic-allowed.test.ts`,
  `packages/simetra/test/db/signal-topic-allowed.support.ts`,
  `signal-topic-allowed.db.test.ts`, `signal-topic-allowed.supabase.db.test.ts`

**Interfaces:**
- Consumes: `isSignalObject`, `readBoundaries`, `scopeSetCall`
  (`access-units.ts`), `RIGHTS_FUNCTIONS.hasRight`, `CURRENT_USER_FUNCTION`.
- Produces:
  - `simetra.signal_topic_allowed(p_topic text, p_send boolean) RETURNS boolean`
    — `STABLE SECURITY DEFINER SET search_path = ''`, власник — роль
    застосування. `REVOKE EXECUTE … FROM PUBLIC`; `EXECUTE` — `simetra_command`
    і роль запиту `user` профілю (`PROVIDER_API_ROLES[provider].user`, не
    літерал) (Р10). Тіло:
    1. `current_user_id()` `NULL` → `false`;
    2. суворий розбір топіка тим самим шаблоном, що `parseTopic` T0
       (рівно три UUID у нижньому регістрі для каналу змін). Інша форма →
       `false`;
    3. `simetra-rights:` і `simetra-user:` → `false` в обох режимах (Р1, до
       B6);
    4. гілка `CASE` за UUID об'єкта, лише для сигнальних об'єктів; невідомий
       чи несигнальний → `false`. Вид у топіку = вид скоупу об'єкта, у
       нескоупленого — `ZERO_UUID` для виду й скоупу;
    5. відправка (`p_send`): скоуплений — скоуп у `scopeSetCall`; корінь —
       `id` кореня в `scopeSetCall` того самого виду; нескоуплений —
       `true`. Права читання писаря не судить;
    6. підписка: скоуплений — скоуп у `scopeSetCall` **і** безрядковий
       предикат `read` з обсягами `any`, `own` чи вимір, без контейнера;
       корінь — те саме над правом `read` кореня; `publicRead` (скоуплений
       чи ні) — `true`; нескоуплений — `has_right` за обсягами `any`, `own`
       чи вимір.
  - `function rowlessReadPredicate(contract: AccessContract, scope: string): string`
    — грантова частина наявних предикатів `rightsPredicates`
    (`compiler/rights/predicates.ts`): `scopeSet(extent, head)` для `any`,
    `own` і виміру, без умов `mine` і без носіїв рядка. Нескоуплений об'єкт —
    `has_right` за тими самими обсягами. Контейнерні рядки не
    враховуються.
  - `SqlUnit.generator` дістає `"signal"`; ребра `requires`: функція → функції
    прав і `current_user_id`; політика → таблиця outbox і функція.
  - політика `signal_outbox_command_insert` на outbox: `FOR INSERT TO simetra_command WITH CHECK (simetra.signal_topic_allowed(payload ->> 'channel', true))`.

- [ ] **Step 1: failing unit tests** (дерево SQL):
  - функція не має `EXECUTE` для `PUBLIC`; `EXECUTE` — лише `simetra_command` і роль `user` профілю; `SECURITY DEFINER`, `search_path = ''`;
  - гілки є лише для сигнальних об'єктів; «Користувачі» гілки не мають;
  - у гілці підписки є умова права, а не лише скоуп (мутація «лише скоуп»
    червоніє);
  - контейнерний обсяг у безрядковому предикаті відсутній;
  - політика `INSERT` — над `payload ->> 'channel'`.
- [ ] **Step 2: failing DB tests** — рядок «DB `simetra`» §12 П4-B, кейси
  `signal_topic_allowed` і outbox. Фікстури прав — спільні
  будівники з `test/db`.
  
  Режим підписки:
  - свій скоуп з правом — `true`;
  - учасник без права `read` — `false`;
  - чужий скоуп — `false`;
  - лише `own` — `true`;
  - лише контейнер — `false`, для скоупленого й нескоупленого;
  - нескоуплений з `own` — `true`;
  - нескоуплений з роллю рівня скоупу — `true`;
  - дослівна функція множини, що відсікає скоуп, — `false`;
  - скоуплений `publicRead` — `true`;
  - «Користувачі» — `false`;
  - корінь: свій — `true`, чужий — `false`;
  - без користувача — `false`;
  - `simetra-rights:` і `simetra-user:` — `false`.
  
  Режим відправки:
  - писар лише з контейнером у своєму скоупі — `true`, у чужому — `false`;
  - дослівна функція множини, що відсікає скоуп писаря, — `false`:
    `simetra_command` у такий канал — `42501`;
  - нескоуплений — `true`;
  - канали прав — `false`.
  
  Права функції:
  - Р10: виклик від `simetra_signals` (тегована роль входу з налаштуванням) і
    від ролі `anonymous` профілю — `42501`; `simetra_command` і роль `user` —
    виклик іде;
  - мутація: `GRANT EXECUTE … TO PUBLIC` у генераторі — кейс червоніє.
  
  Outbox:
  - `INSERT` від ролей запиту — `42501`;
  - `simetra_command` у недозволений канал — `42501`, зокрема після
    дозволеного в тій самій транзакції (Review Focus 3).
- [ ] **Step 3:** FAIL → **Step 4:** реалізація → **Step 5:** PASS:
  `pnpm --filter simetra test:db signal-topic-allowed` і
  `pnpm --filter simetra test:db:supabase signal-topic-allowed` (спільне тіло).
- [ ] **Step 6: Commit** — `feat(compiler): авторизація каналу сигналу в базі`.

### Task 8: `signal`, `signal_invalidate` і виклики в ядрі

**Files:**
- Modify: `packages/simetra/src/compiler/signal/units.ts`
- Modify: `packages/simetra/src/compiler/catalog-command/units.ts`
  (`saveFunction`, `markDeletionFunction`, `deleteFunction`,
  `createRootFunction`)
- Test: `packages/simetra/src/compiler/__tests__/catalog-command-signal.test.ts`,
  `packages/simetra/test/db/signal-core.support.ts`,
  `signal-core.db.test.ts`, `signal-core.supabase.db.test.ts`

**Interfaces:**
- Consumes (після B1e): версія з `v_row.<versionColumn>` після DML; у
  невидимого кореня — налаштування `ROW_VERSION_SETTING` таблиці (Р9 плану
  B1e). Тільки так версія монотонна через повторне створення ключа.
- Produces:
  - `simetra.signal(p_object uuid, p_scope_kind uuid, p_scope uuid, p_keys jsonb, p_version bigint, p_operation text) RETURNS void`
    — `SECURITY INVOKER`, `SET search_path = ''`, `EXECUTE` лише
    `simetra_command`. Тіло:
    1. перевірка аргументів (Review Focus 6): `p_operation` ∈
       `create`, `update`, `markDeletion`, `delete`; `p_keys` — об'єкт рівно з
       одним ключем і значенням UUID; `p_version > 0`. Інакше —
       `RAISE EXCEPTION` з `ERRCODE = '22023'`;
    2. `current_setting(SIGNAL_MODE_SETTING, true) = SIGNAL_MERGE_MODE` →
       `RETURN`. Будь-яке інше значення сигналу не гасить;
    3. `INSERT INTO simetra.signal_outbox (method, payload)` з
       `{ channel: 'simetra:<kind>:<scope>:<object>', data: { object, op, keys, row_ver } }`.
       `id` і `idempotency_key` ставить тригер (Р4);
  - `simetra.signal_invalidate(p_object uuid, p_scope_kind uuid, p_scope uuid) RETURNS void`
    — те саме оформлення, `data: { object, op: "invalidate" }`. Режиму
    злиття не перевіряє: його кличе T3 лише в цьому режимі;
  - у функціях ядра сигнального об'єкта (`isSignalObject`) — `PERFORM simetra.signal(…)`:
    - `save` — після DML шапки й ТЧ, перед результатом; `op` `create` чи
      `update`; версія «після»;
    - `mark_deletion` — після `UPDATE`; `op` `markDeletion`;
    - `delete` — перед `RETURN`; `op` `delete`; версія й скоуп з `v_old`;
    - `createRoot` — останнім кроком, після функції гранту, лише за
      `rootCreator` (Р8); канал кореня — за його `id`.
    
    Несигнальний об'єкт виклику не має. Ознака `signal` каталогу й виклик
    беруться з одного джерела — `isSignalObject`.

- [ ] **Step 1: failing unit tests** (рядок «unit T1» §12 П4-B):
  - виклик після DML з версією «після», у `delete` — «до»;
  - «Користувачі» й не-UUID ключ виклику не мають;
  - корінь — канал за `id`; модель оператора — без виклику;
  - ознака `signal` = наявність виклику (`it.each` над об'єктами
    модель-прикладу);
  - тіло `signal` гасить відправку лише точним `"merge"`;
  - мутація «сигнал до DML» червоніє.
- [ ] **Step 2: failing DB tests** (`signal-core.*`, рядок «DB `simetra`»
  §12, кейси сигналу):
  - рядок outbox після команди з правильним каналом;
  - `data` рівно `{ id, object, op, keys, row_ver }`;
  - жодного рядка після `ROLLBACK` і після невдалої спроби `40001`;
  - зміна кореня — рядок у його канал;
  - створення кореня з `rootCreator` — рядок (версія з прочитаного рядка);
    у моделі оператора — рядка немає й команда успішна;
  - писар лише з контейнерною роллю — рядок є;
  - `delete` з версією «до»;
  - видалення й повторне створення ключа — більша версія;
  - прямий виклик `signal` від `simetra_command` з ключем-рядком,
    двома ключами, операцією `rights` чи версією 0 — `22023`.
- [ ] **Step 3:** FAIL → **Step 4:** реалізація → **Step 5:** PASS:
  `pnpm --filter simetra test:db signal-core` і
  `pnpm --filter simetra test:db:supabase signal-core` (спільне тіло);
  `pnpm metadata:check` — зелений.
- [ ] **Step 6: Commit** — `feat(compiler): ядро команд шле сигнал рядком outbox`.

### Task 9: режим злиття в T3 і бенчмарк порогу

**Files:**
- Modify: `packages/simetra/src/server/phase.ts`, `packages/simetra/src/server/transaction.ts`,
  `packages/simetra/src/server/runtime.ts` (`CommandRuntimeOptions.signalMergeThreshold`)
- Create: `packages/simetra/test/db/signal-merge.support.ts`,
  `signal-merge.db.test.ts`, `signal-merge.supabase.db.test.ts`,
  `packages/simetra/test/db/signal-bench.db.test.ts` (бенчмарк, `describe.skipIf(!process.env.SIMETRA_BENCH)`)
- Test: `packages/simetra/src/server/__tests__/signal-merge.test.ts`

**Interfaces:**
- Produces:
  - `signalMergeThreshold?: number` (ціле ≥ 1; типово — число з бенчмарку,
    до нього 50);
  - у тому самому операторі, що ставить claims команди (`COMMAND_CLAIMS_TEXT`
    у `server/transaction.ts`), — `set_config(SIGNAL_MODE_SETTING, '', true)` (Р14);
  - лічильник сигнальних фаз у стані транзакції. Сигнальна фаза — фаза над
    об'єктом з `catalog.objects[…].signal`, зокрема фаза `ctx.run`;
  - щойно лік досягає порогу, перед наступною фазою —
    `SELECT set_config(SIGNAL_MODE_SETTING, SIGNAL_MERGE_MODE, true)`.
    Зворотного перемикання немає. Повтор транзакції (`40001`) починає лік
    з нуля;
  - у режимі злиття після кожної сигнальної фази — пара
    `phaseSignalPair(object, result): { kind: string; scope: string }` (Р9).
    Для нової пари транзакції — `SELECT simetra.signal_invalidate($1, $2, $3)`
    у тій самій транзакції, одразу після фази.

- [ ] **Step 1: failing unit tests** (фейкова база; поріг передається явно,
  `signalMergeThreshold: 50`, щоб крок 6 не міняв тестів):
  - 49 сигнальних фаз — без `set_config` і без `invalidate`;
  - 50-та — після неї `set_config`;
  - фази `ctx.run` рахуються;
  - несигнальні фази не рахуються;
  - пара на першій фазі після вмикання — один `invalidate`, повтор пари —
    жодного;
  - повтор транзакції скидає лік.
- [ ] **Step 2: failing DB tests** (рядок «DB `simetra`» §12, кейси злиття;
  рантайм з явним `signalMergeThreshold: 50`; тіло — `signal-merge.support.ts`):
  - транзакція через поріг (зокрема фазами `ctx.run`) — сигнал на кожну фазу
    до порогу, жодного після, один `invalidate` на пару на першій фазі пари
    після вмикання;
  - транзакція до порогу — без `invalidate`;
  - пізніша фаза, що виводить писаря зі скоупу, не губить надісланого
    `invalidate`;
  - значення `simetra.signal_mode`, відмінне від `"merge"`, сигналів не гасить;
  - тегована роль входу з `ALTER ROLE … SET simetra.signal_mode = 'merge'`:
    команда до порогу шле сигнал на фазу (Р14).
- [ ] **Step 3:** FAIL → **Step 4:** реалізація → **Step 5:** PASS.
- [ ] **Step 6: бенчмарк.** `SIMETRA_BENCH=1 pnpm --filter simetra test:db signal-bench`:
  - ціна пакета з 500 фаз сигнального об'єкта з outbox і без нього (медіана
    з 5 прогонів);
  - поріг злиття — найменший лік, після якого надлишок outbox > 10 % часу
    пакета, округлений до 10.
  
  Числа й метод — у §8.2 П4-B (поріг) і в типове значення опції.
- [ ] **Step 7: Commit** — `feat(server): режим злиття сигналів за ліком сигнальних фаз`
  (разом із правкою §8.2 П4-B числом порогу).

### Готово — частина B

- Ядро сигнального об'єкта пише рядок outbox у своїй транзакції; відкат
  його прибирає. Несигнальний об'єкт не пише.
- `signal_topic_allowed` в обох режимах дає відповіді переліку DB-кейсів;
  політика `INSERT` тримає режим відправки.
- Режим злиття гасить сигнал на фазу після порогу й шле один `invalidate`
  на пару.
- Поріг і ціну 500 фаз внесено в §8.2 П4-B.
- Гейти задачі 14 для частини B зелені.

## Частина C — токени, конфіг Centrifugo, гейт доставки

### Task 10: `simetra/server/signals` — порт і адаптер Centrifugo

**Files:**
- Create: `packages/simetra/src/server/signals/index.ts`,
  `packages/simetra/src/server/signals/centrifugo.ts`,
  `packages/simetra/src/server/signals/__tests__/centrifugo.test.ts`
- Modify: `packages/simetra/package.json` (обидва блоки `exports`:
  `./server/signals`), `packages/simetra/tsdown.config.ts` (`entry`),
  `packages/simetra/eslint.tier-zones.js` (зона T3 покриває
  `src/server/signals/**` тим самим правилом чистоти),
  `packages/simetra/test/tier-boundary.test.ts`, `test/server-sources.test.ts`
  (якщо перелічують підшляхи), пак-тест designer (новий вхід імпортується з
  тарбола)

**Interfaces:**
- Produces:
  ```text
  interface SignalTokens {
    connectionToken(subject: string): Promise<{ token: string; expiresAt: number }>
    channelToken(subject: string, channel: string): Promise<{ token: string; expiresAt: number }>
    jwks(): { keys: JsonWebKey[] }
  }
  interface SigningKey { kid: string; privateJwk: JsonWebKey; addedAt: number; retiredAt?: number }
  function createCentrifugoTokens(o: { keys: readonly SigningKey[]; audience: string; issuer: string; now?: () => number }): Promise<SignalTokens>
  ```
- Правила:
  - Підписує лише ключ без `retiredAt` (чи з `retiredAt` > `now`) —
    найновіший з `addedAt` ≤ `now − 65 хв`. Якщо такого немає — найстаріший
    з невідставлених (перший запуск). Невідставленого ключа немає —
    `Error` на створенні й на підписі.
  - `jwks()` дає публічні частини ключів без `retiredAt` і тих, де
    `retiredAt` > `now − 20 хв` (§6.3).
  - Публічний JWK будується з білого списку
    `{ kty, crv, x, kid, alg: "EdDSA", use: "sig" }`. Повтор `kid` — `Error`.
  - Claims з'єднання — `sub`, `aud`, `iss`, `exp` = `now + 15 хв`. Claims
    каналу — ще й `channel`, `exp` = `now + 5 хв`.
  - Заголовок — `{ alg: "EdDSA", typ: "JWT", kid }`.
  - Ключ — `crypto.subtle.importKey("jwk", …, { name: "Ed25519" }, …)`.
    Приватний JWK з `kty` ≠ `OKP` чи `crv` ≠ `Ed25519` — `Error` на
    створенні.
  - Порт не викликає бази. Право на канал судить
    `runtime.authorizeChannels` (задача 11).

- [ ] **Step 1: failing unit tests:**
  - claims і `exp` обох токенів за фіксованим `now`;
  - підпис перевіряється публічним ключем з `jwks()`;
  - `kid` у заголовку;
  - правило ротації (Review Focus 5), два ключі — старий (доданий давно) і
    новий: новий, доданий 64 хв тому, не
    підписує, а 66 хв тому — підписує. Відставлений ключ є в JWKS 19 хв і
    зникає на 21-й;
  - відставлений ключ не підписує ніколи, навіть як «найстаріший»;
    `retiredAt` раніше за придатність наступника — `Error`;
  - ключ RSA — `Error`; повтор `kid` — `Error`;
  - кожен JWK у `jwks()` має рівно ключі білого списку.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS;
  `pnpm --filter simetra lint` (зона T3) і `pnpm build:packages && pnpm test:packaging` — зелені.
- [ ] **Step 5: Commit** — `feat(server): токени Centrifugo EdDSA з JWKS і ротацією`.

### Task 11: `runtime.authorizeChannels`

**Files:**
- Modify: `packages/simetra/src/server/runtime.ts` (`CommandRuntime`), `server/index.ts`
- Test: `packages/simetra/src/server/__tests__/authorize-channels.test.ts`,
  `packages/designer/src/__tests__/authorize-channels.db.test.ts`

**Interfaces:**
- Consumes: `sessionKind` (ПГ-3), шлях читання (`claimsStatement`,
  роль запиту).
- Produces: `authorizeChannels(session: SessionClaims, channels: readonly string[]): Promise<{ user: string | null; channels: string[] }>`
  (Р5):
  - `sessionKind !== "user"` → `{ user: null, channels: [] }` без бази;
  - інакше одна транзакція `READ ONLY` під роллю `user`:
    `SELECT simetra.current_user_id() AS user, ARRAY(SELECT c FROM unnest($1::text[]) c WHERE simetra.signal_topic_allowed(c, false)) AS channels`;
  - `user` `NULL` → `channels: []`;
  - понад 256 каналів чи канал довший за `CENTRIFUGO_CHANNEL_MAX` —
    `command.invalid` до запиту в базу;
  - порядок і дублікати входу не зберігаються: вихід відсортований і без
    повторів.
  
  Використання в host-і (для `simetra-fd`): endpoint з'єднання —
  `user !== null` → `connectionToken(user)`, інакше 401; endpoint каналів —
  `channelToken(user, c)` на кожен дозволений.

- [ ] **Step 1: failing tests:**
  - unit: анонім без запиту; обидва ліміти; дедуплікація;
  - DB (Review Focus 4): користувач з правом — свій канал; чужий скоуп
    відсіяно; `invalid` — `user: null`; анонім — порожньо; вихід
    дорівнює `signal_topic_allowed(c, false)` на кожному каналі фікстури
    задачі 7.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(server): runtime.authorizeChannels для токенів каналів`.

### Task 12: генератор конфігу Centrifugo і конфіги стеків

**Files:**
- Create: `packages/designer/src/tools/signals-config.ts`,
  `packages/designer/src/tools/__tests__/signals-config.test.ts`
- Modify: `packages/designer/src/tools/catalog.ts` (`TOOLS`), `tools/types.ts`
  (`TOOL_NAMES`), `src/cli/render.ts` (вивід JSON)
- Modify: `docker/postgres-stack/centrifugo.json`, `docker/supabase-signals/centrifugo.json`
  — вихід генератора з адресами стека (Global Constraints, без shims)
- Modify: `packages/simetra/test/db/stack-files.test.ts` — тест «no outbox
  consumer and no client token yet» замінює тест дрейфу. Файл стека
  дорівнює виходу генератора з адресами стека; заборони §6.1 перевіряє
  спільний помічник генератора
- Modify: `packages/designer/skills/simetra-metadata/` — розділ про сигнали:
  генерація конфігу, секрети середовищем, один інстанс (англійською)

**Interfaces:**
- Produces:
  - `function centrifugoConfig(o: { projectName: string; origin: string; issuer: string; jwksUrl: string; consumerDsn: string; notifyDsn: string }): CentrifugoConfig`
    — чиста функція. Простори, споживач і заборони — за Global
    Constraints;
  - `function centrifugoConfigRefusals(config: unknown): string[]` —
    **білий список**, а не перелік заборон. Точний набір ключів верхнього
    рівня (`client`, `channel`, `consumers`, `http_api`, `health`, `log`) і
    `client.token` (`jwks_public_endpoint`, `audience`, `issuer`). Змінні —
    лише origin, issuer, `jwksUrl` і DSN. `allowed_origins` без `*`.
    `jwksUrl` — `https:`, або `http:` на хост `127.0.0.1`, `localhost`,
    `host.docker.internal` чи однослівне ім'я сервісу compose (без крапки)
    (§6.3). Споживач — `name: "simetra_outbox"` (від нього імена змінних
    середовища). Для тесту
    генератора й тесту файлів стека;
  - у конфігу також `health: { enabled: true }` і `log: { level: "info" }`
    (§11: без debug у проді);
  - інструмент `signals-config`: `files: "read"`, `database: "none"`, вхід
    `{ origin, issuer, jwksUrl }`. DSN у файлі — заглушка
    `postgresql://override-by-env`. Оператор ставить справжні змінними
    середовища Centrifugo v6 `CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_DSN`
    і `CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_PARTITION_NOTIFICATION_DSN`
    (факт документації). Опис інструмента називає обидві змінні. Секрет у
    файлі конфігу не пишеться.
- Стеки: compose ставить обидві змінні з dev-значень
  (`docker/postgres-stack/dev-secrets.env`). DSN `postgres` — до сервісу
  `postgres` мережі compose, база `simetra`. DSN `supabase` — до
  `host.docker.internal:54322` з `extra_hosts: host.docker.internal:host-gateway`
  у `docker/supabase-signals/compose.yaml`, база `postgres`. `jwksUrl` —
  `http://host.docker.internal:<порт host-а>/simetra/signals/jwks`; той самий
  `extra_hosts` — і в `docker/postgres-stack/compose.yaml`. Вхід генератора
  для файлів стеків — константа тесту дрейфу: `projectName: "simetra-dev"`,
  `origin: "http://localhost:3000"`, `issuer: "http://localhost:3000"`,
  порт host-а `3000`.

- [ ] **Step 1: failing tests:**
  - `centrifugoConfigRefusals(centrifugoConfig(…))` — порожньо;
  - білий список ловить кожну мутацію (`it.each`): `allow_subscribe_for_client`,
    `insecure`, `http_api.disabled: false`, без `audience`,
    `client.subscription_token`, `client.token.hmac_secret_key`,
    `audience_regex`, `allowed_origins: ["*"]`,
    `allow_anonymous_connect_without_token`, `grpc_api`, `admin`, `jwksUrl`
    `http://` на зовнішній хост;
  - `audience` = `centrifugo:<projectName>`;
  - тест дрейфу файлів стека.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS;
  `pnpm db:signals:start` і `pnpm db:pg:start` піднімаються з новим конфігом
  (`/health` — 200). Стек не перезапускати, якщо ним користується інша
  сесія: перевірку старту робить CI.
- [ ] **Step 5: Commit** — `feat(designer): генератор конфігу Centrifugo; конфіги стеків з нього`.

### Task 13: гейт доставки на стенді

**Files:**
- Modify: `packages/simetra/test/db/signal-stand.ts` — тестовий JWKS-сервер
  `startJwksServer(tokens: SignalTokens): Promise<{ url; close() }>` на
  `127.0.0.1`; клієнт `standClient(stand, getToken)` над `centrifuge`
- Modify: `packages/simetra/package.json` — devDependency `centrifuge` 5.8.0
  (точний пін; ліцензію перевір у `LICENSE` репозиторію за CONTRIBUTING.md);
  `docs/dependency-monitoring.md` — рядок
- Create: `packages/designer/src/__tests__/signal-delivery.support.ts`,
  `signal-delivery.db.test.ts`, `signal-delivery.supabase.db.test.ts` —
  модель з рантаймом і правами з наявних помічників designer. Тест сам
  кличе `centrifugoConfig` і передає результат у `startSignalStand({ config })`
  (Р7; `simetra` не імпортує designer)

**Interfaces:**
- Consumes: задачі 4, 8, 10, 11, 12.

- [ ] **Step 1: failing stand tests** (рядок «стенд сигналу» §12 П4-B; без
  рядків B5/B6):
  - гейт доставки: кожна форма ядра доходить до авторизованого
    підписника — `save` створення й зміни, `mark_deletion`, `delete`
    призначення, зміна кореня; також писар лише з контейнерною роллю —
    до читача з `any`;
  - два клієнти двох скоупів — сигнал рівно раз у першому й жодного в
    другому;
  - учасник без права `read` — токена каналу немає;
  - клієнт не публікує в простір `simetra` (відмова Centrifugo);
  - токен каналу з чужим каналом, прострочений, з чужим `aud`, з
    невідомим `kid` — відмова підписки;
  - підроблені токени: `alg: none` і HS256, підписаний байтами публічного
    ключа, — відмова;
  - JWKS з ключем `OKP` приймається;
  - ротація за §6.3 без розриву (Review Focus 5) з годинником порту, а не
    з чеканням:
    - новий ключ доданий — старі підписки живі;
    - підпис новим ключем — нові підписки йдуть;
    - старий ключ знято з JWKS після рестарту кешу Centrifugo — підписки,
      взяті новим ключем, живі;
  - короткий розрив з історією — пропущені публікації й `recovered: true`;
  - `restart()` — `recovered: false`;
  - вимір «відповідь `run`» і «сигнал до клієнта» без мережі, 200 команд:
    p95 «коміт → подія клієнта» ≤ 50 мс;
  - падіння й переривання тесту не лишають контейнерів.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація стенду й клієнта → **Step 4:** PASS
  два прогони поспіль: `pnpm --filter @simetrajs/designer test:db signal-delivery`
  і `pnpm --filter @simetrajs/designer test:db:supabase signal-delivery`.
- [ ] **Step 5: Commit** — `test(db): гейт доставки сигналу з токенами на стенді Centrifugo`.

### Task 14: документація й гейти (кожна частина)

**Files:**
- Modify: `docs/ROADMAP.md` — статус ПГ-4 і B2
- Modify: спека профілю §13 і Додаток А П4-B — позначки внесених правок, якщо
  таблиці їх ведуть

- [ ] **Step 0 (частина C):** зведена таблиця у звіті «мутація §12 П4-B →
  тест плану». Береться кожна мутація переліку §12, що стосується B2.
  Кожну виконавець робить на закомміченому дереві, бачить червоний тест і
  відкочує. Мутація без червоного тесту — дефект плану, до архітекторки.
- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — зелені.
- [ ] **Step 3:** `pnpm metadata:check`; `python3 scripts/check-doc-anchors.py` — зелені.
- [ ] **Step 4:** повний DB-набір стека `postgres` (`pnpm test:db:pg`) — зелений;
  `docker ps -a --filter label=simetra-run` — порожньо.
- [ ] **Step 5:** повний `pnpm test:db` (регресія Supabase) — **один раз** на
  частину, після всіх її задач.
- [ ] **Step 6 (частина C):** `pnpm build:packages && pnpm test:packaging` —
  зелені; `simetra/server/signals` імпортується з тарбола.
- [ ] **Step 7: Commit** — `docs: ROADMAP — ПГ-4 і B2 (частина <A|B|C>)`.

### Готово — частина C і блок

Рядок ПГ-4 §12 спеки профілю й рядок B2 §13 П4-B (без пунктів Р2).
**Частина C дає `SignalTokens` і `runtime.authorizeChannels`: її мердж —
умова D5 тонкого зрізу П4-D.**
- `simetra/server/signals` видає токени EdDSA з `kid` і JWKS з ротацією §6.3.
- `runtime.authorizeChannels` дає рівно канали, для яких режим підписки
  `signal_topic_allowed` істинний, і лише дійсному користувачу.
- Конфіг Centrifugo генерує designer. Конфіги обох стеків — його вихід,
  тест дрейфу зелений.
- На стенді обох профілів доведено:
  - `simetra.signal_outbox` у `outbox_table_name`;
  - `partition_notification_dsn` і `use_try_lock`;
  - вхід `simetra_signals` з налаштуванням ролі;
  - сигнал команди доходить, чужий канал, прострочений токен і токен з
    чужим `aud` відхилено;
  - JWKS з `OKP` приймається; ротація без розриву.
