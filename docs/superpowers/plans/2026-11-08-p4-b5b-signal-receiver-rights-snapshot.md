# П4-B5b — знімок прав клієнта, приймач сигналів і транспорт Centrifugo: план реалізації

> **Статус:** проєкт плану, 2026-11-08; приймає архітекторка
> `runtime-client-data`. Блок B5b спеки П4-B. Межі B5a/B5b задає план B5a
> (задача 0: поділ рядка B5 у §13). Дві частини, кожна має своє «готово» й
> окремий PR (рішення архітекторки):
> - **A** — знімок прав клієнта;
> - **B** — приймач сигналів і транспорт.
>
> **Залежності.** B3-2 і B3-3 — у `main` до старту. Частина A — після B1c,
> B3-2, B3-3, B3-4, B3-6, B5a і ПГ-3 (`sessionKind`). Частина B — ще й після ПГ-4/B2 частин B і C. Якорі на
> незмерджене позначено «після X». На `main` зараз немає ядра T4
> (`createCore`, `CoreSession`), частин пакета `read`, функцій сигналу й
> `SignalTokens`: їх дають плани [B3-2](2026-11-08-p4-b3-2-core.md),
> [B3-3](2026-11-08-p4-b3-3-window-public-api.md),
> [B3-4/B3-5](2026-11-08-p4-b3-4-b3-5-write-receipts.md),
> [B3-6](2026-11-08-p4-b3-6-oracle-host-ssr.md),
> [B1c](2026-11-08-p4-b1c-conditional-batched-reads.md), B5a,
> [ПГ-3](2026-11-08-pg-3-identity-better-auth.md) і
> [ПГ-4/B2](2026-11-08-pg-4-b2-signal-transport.md).
> **Межа з B6** (рішення архітекторки). Функції сигналів прав, підписка на
> `simetra-rights:` і `simetra-user:`, реакція на їхні сигнали, контракт прав
> дій у каталозі, обчислювач і `useCan` — B6. B5b дає `refreshTokens` як
> метод порту й підписується лише на канали змін. **B6 розширює
> `rightsSnapshot`, не дублює:** знімок прав клієнта — одне сховище; B6 додає
> до нього права дій поряд зі `scopeSets` і другого кешу прав не заводить.
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
- втрата доступу прибирає дані (`purge`) незалежно від каналу й токена.

**Architecture:**
- **A.** `simetra.rights_client_snapshot()` — генерований SQL T1
  (`STABLE SECURITY INVOKER`). Читає його `runtime.rightsSnapshot(session)`
  T3 частиною `rights` пакета `read`. Сховище знімка, правило втрати
  доступу й предикат підписки живуть у T4 (`src/data/rights/`).
- **A.** Втрату доступу ядро рахує від **вмісту сховища** проти нового
  знімка (Р5). Порівняння двох знімків потрібне лише для звуження.
- **B.** Порт `SignalTransport` T0 — форма §8.5. Реалізація —
  `simetra/data/centrifugo` над необов'язковою peer `centrifuge`.
- **B.** Приймач — модуль рантайму T4 над портом і ядром. Читає через новий
  `CoreSession.readKeys` і `revalidate`, а в сховище пише лише через `commit`
  з токеном (§6.1).

**Tech Stack:** TypeScript 7, Zod, Vitest 5 (фейкові таймери), fast-check,
Playwright (`page.clock`), `pg` 8.23.1, Postgres 17, Centrifugo v6 (стенд
ПГ-4/B2), `centrifuge` 5.8.0.

**Spec:** [П4-B](../specs/2026-11-05-p4-b-client-data-design.md):
- §3 (клієнтський каталог), §4.5 (частина `rights`), §6.1, §6.2 правило 4,
  §6.3, §6.5, §6.6, §6.7 (бюджети);
- §8.1, §8.3–§8.6, §9.1, §9.3, §10, §11;
- §12 (рядки «unit T4 (приймач…)», «DB `simetra`» — кейси знімка й
  еквівалентності, «стенд сигналу», браузерні бюджети, «лінт і типи»,
  мутації), §13 рядок B5b;
- платформна Р39, Р42; рішення T4 §3.6;
- [звіт спайку realtime](../specs/2026-11-08-t4-realtime-spike-report.md).

Правила тестів — скіл `writing-tests`.

## Global Constraints

- Мова: коментарі — українською й пояснюють «чому». JSDoc експортованого API
  — англійською.
- Коміти: Conventional Commits, опис українською, без трейлерів. Push і PR
  робить архітекторка.
- 🔴 Без `--` перед шаблоном vitest у `pnpm --filter` (`AGENTS.md`). Шаблон —
  шлях теки, коли ім'я файлу збігається з файлами інших ярусів
  (наприклад, `src/data/rights`, а не `rights-snapshot`).
- Команди DB-тестів: стек `postgres` — `pnpm --filter <пакет> test:db <шаблон>`,
  стек `supabase` — `pnpm --filter <пакет> test:db:supabase <шаблон>` (лише
  `*.supabase.db.test.ts`). Кейс «на обох стеках» — спільне тіло в
  `*.support.ts` і два тонкі файли.
- Приймач і знімок пишуть у сховище лише через `core.commit(fn, token)`;
  `commit` зі старим токеном нічого не пише (§6.1). Сигнал, відповідь чи
  таймер після `dispose()` чи закриття — 0 записів і 0 запитів.
- Одна подія — один синхронний прохід; частини йдуть у збирач B3-3 в одній
  мікрозадачі. Перечитування несуть `known` (B1c).
- **Бюджети Р42.** Кожен сценарій у тесті називає число запитів явно
  (`countingTransport` B3-3), а де §12 задає байти — і байти:
  - пачка сигналів одного об'єкта на N ≤ 200 ключів — рівно 1 запит;
  - пачка на кількох об'єктах — `⌈частин / READ_BATCH_MAX⌉` запитів (≤ 16
    частин — 1); тіло й відповідь ≤ 1,1 × корисних + 2 КіБ;
  - 201+ ключ одного об'єкта — `revalidate` видимих виглядів, 1 запит;
  - власне відлуння — 0;
  - `delete` для ключа поза сховищем — 0;
  - `invalidate` — 1 запит на пачку для видимих виглядів пари й ТЧ
    власників; невидимим — 0 і `needsRefresh`;
  - приєднання з `recovered: true` — 0 перечитувань виглядів;
  - приєднання без `recovered` (зокрема перше, після монтування чи заміни
    знімка) — рівно 1 умовний запит на хвилю приєднань (Р11): «нічого не
    змінилось» — тіло ≤ 64 Б × ключів `known` + 2 КіБ, а відповідь ще й
    + `jsonBytes` знімка прав (коли в хвилі є `rights`) + 128 Б × об'єктів
    каталогу (коли є `version`); інакше ≤ 1,1 × корисних + 2 КіБ; хвилі — не
    частіше разу на `REJOIN_JITTER_MS`;
  - `auth` каналу — 0 запитів, лише `purge`;
  - `transport` — 0 запитів, лише позначки «розрив».
- Сталі T4 (`src/data/runtime/signals.ts`): пачка — тиша `QUIET_MS = 50`,
  найдовше `MAX_BATCH_MS = 2000`; межа ключів — `CoreLimits.keysPerRequest`
  ядра (200), власної сталої немає; дочитування
  очікуваної мінімальної версії — `MIN_VERSION_RETRIES = 3` з паузою
  `MIN_VERSION_RETRY_MS = 500 × 2^(n−1)`; вікно джитера приєднання —
  `REJOIN_JITTER_MS = 2000`; тиша зняття позначки після `recovered: true` —
  `RECOVERED_SETTLE_MS = 50`; дедуплікація — `SEEN_SIGNALS_MAX = 4096`
  останніх `id`.
- `id` повідомлення — десятковий рядок id рядка outbox (Р4 плану ПГ-4/B2).
- «Вигляди пари» — усі активні вигляди об'єкта пари: `ViewSpec` скоупу не
  несе, тож канали різних скоупів одного об'єкта перечитують ті самі вигляди
  (один запит на хвилю однаково).
- Об'єкт у рядках знімка — мітка виду (`kindLabel`); T4 мапить її на ім'я
  об'єкта (`ObjectName`) клієнтським каталогом. Невідома мітка — рядок
  пропускається й пишеться в журнал.
- `centrifuge` — лише необов'язкова peer (`^5.8.0`) і devDependency
  (`5.8.0`); імпорт значення — лише в `src/data/centrifugo/**`.
- Без shims (`AGENTS.md`, принцип 5): стара форма порту `SignalTransport`
  (`SignalErrorKind`, `onSubscribed` без аргументів) прибирається в тій самій
  зміні.

## Рішення

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Поділ на A і B, межа з B6 і правило «B6 розширює `rightsSnapshot`, не дублює» — рішення архітекторки | §13 рядки B5b і B6 (задача 0) |
| Р2 | **Межа B5b для втрати доступу без сигналу прав** (рішення архітекторки). До B6 втрату доступу ловлять: правило Р5 на кожній заміні знімка — перший пакет рантайму, гідратація, `resume()`, приєднання без `recovered`, зміна `serverHash`, `command.unavailable` на `create` кореня; а також `command.forbidden` чи відсутній рядок (Р36). Затримку обмежує інтервал свіжості `revalidateIntervalMs`. B6 посилює цю межу сигналами прав | §8.4 — абзац межі B5b (задача 0) |
| Р3 | Форма знімка T0 — `rightsSnapshotSchema`: `{ userId: uuid \| null; projectionVersion?: string; versions?: { scopeKind, scope, version: string }[]; scopeSets: { scopeKind, scope }[]; rights: { level: string; levelId: uuid \| null; scope: uuid \| null; container: uuid \| null; object: string; action: string; extent: string; dimensionId: uuid \| null }[] }`. `rights` — рядки `rights_mine()` у camelCase (`MINE_COLUMNS`), зокрема рівень `everyUser`; `level` і `extent` — рядки без переліку, щоб новий рівень не валив схему. Поля `scopes`, `dimensionValues`, `containers` §9.1 додає B6 | §9.1 — поля за блоками (задача 0) |
| Р4 | `rightsVersion` — hex sha-256 канонічного JSON власних фактів: `userId`, `scopeSets` і рядки `rights` з `action = 'read'`, кожен рядок — масив-кортеж полів у порядку Р3, масиви відсортовані. `versions` і `projectionVersion` у хеш **не входять**: вони змінюються від чужих змін прав у скоупі й дали б зайвий `purge` SSR, а дрібну втрату доступу однаково ловить Р5. Рахується під час запису знімка в сховище (WebCrypto); `CoreSession.rightsReady(): Promise<void>` осідає, коли хеш поточного знімка готовий; SSR `preload` чекає його до `dehydrate()` | §6.6 — значення `rightsVersion` (задача 0) |
| Р5 | **Втрата доступу — від сховища.** На кожній заміні знімка (зокрема першій) ядро перебирає пари (збережений скоуп, об'єкт), що є в сховищі, знімках показу вікна, цілях `include`, `SectionStore` і чернетках `card`. Для кожної пари `readAllowed(snapshot, pair)` хибний → `purge` пари. `readAllowed` — будь-який обсяг `read`, зокрема контейнер, або `publicRead`, або несигнальний об'єкт без скоупу з будь-яким рядком `read`. **Звуження** — порівняння повних кортежів рядків `read` пари (`level`, `levelId`, `scope`, `container`, `extent`, `dimensionId`): зник кортеж, а `readAllowed` лишився істинним → `revalidate` усіх виглядів об'єкта, зокрема невидимих і підмножин `include` (§6.2 правило 4; до B6). Зміна `userId` — шлях `session-changed` рантайму (`onSessionChanged`, `RuntimeHolder`). Доповнення: рядки об'єкта без збереженого скоупу (частковий запис, П14 B3-2) прибираються, коли об'єкт втратив `read` у будь-якому скоупі; зміна `scopeSets` → `revalidate` виглядів об'єктів з межею `users` («Користувачі», спека прав §5.2); на звуженні рядки лише слабких власників об'єкта знімаються, а чернетки `card` перечитуються | немає |
| Р6 | Предикат підписки `canSubscribe(snapshot, channel, catalog)` — дзеркало режиму підписки `signal_topic_allowed` для каналу змін (§8.3): `userId` `null` → `false`; невідомий чи несигнальний об'єкт → `false`; вид у топіку ≠ вид скоупу об'єкта → `false`; `publicRead` → `true`; скоуплений — скоуп у `scopeSets` виду **і** рядок з `action = 'read'`, мітка об'єкта, `extent` ∈ `any`, `own`, вимір, `level = 'scope'` і `scope` = скоуп каналу (так рахують `rights_any/own/dim`); нескоуплений — такий рядок з `level` ≠ `container` (так рахує `has_right`), зокрема `everyUser`; канали прав — `false` | немає |
| Р7 | Канали підписки — для кожного сигнального об'єкта з **активними** виглядами (§8.4), для скоупів `scopeSets` виду з `canSubscribe` істинним; `publicRead` — ще скоупи активних виглядів; нескоуплений — `ZERO_UUID`. Перерахунок — на заміні знімка й на зміні множини об'єктів з активними виглядами, злитий в одну мікрозадачу. Підписка — **дельтою, по каналу**: `subscribe([channel], …)` для нового, його `Unsubscribe` для знятого; незмінні канали не перепідписуються. Канал, відхилений `auth`, не повторюється до наступної заміни знімка | немає |
| Р8 | Порт T0 (§8.5): `subscribe(channels, onSignal, onError({ kind, channel? }))`, `onSubscribed(({ channel, recovered }) => void)`, `refreshTokens(channels?): Promise<void>`, `close(): void`. `kind: "auth"` каналу — лише 403 чи «канал не дозволено» (`authorizeChannels` його не повернув); 401 (сесія скінчилась) — `auth` без каналу (шлях сесії); мережевий збій і 5xx — `transport` | §8.5 — уточнення `auth`, `close()` (задача 0) |
| Р9 | Сигнал `schema` (`command.unavailable` з `reason: "schema"`) дають лише коди PostgREST (§5.3, §7.3) — у B5b джерела немає. Обробка переходить у B4 разом із `reason` (рішення архітекторки) | §13 рядок B4; плани B3-4 і B5a (задача 0) |
| Р10 | `CoreSession.readKeys(object, keys): Promise<ReadKeysResult>` — тонка обгортка ядра (рішення архітекторки), **без другого читача**: над наявним `readKeys` з `store/source.ts` B3-2 (200 ключів на запит, поділ навпіл на `response-too-large`) і над тим самим шляхом запису, що й хвостове перечитування `stale-inserted` (епоха старту, `commit` з токеном, правило версії, надгробки). Іде через збирач B3-3. `ReadKeysResult = { returned: Key[]; missing: Key[]; versions: Map<Key, number> }` | немає |
| Р11 | **Приєднання без `recovered` перечитує те, що старше за приєднання.** Опорна мить — `joinedAt` = час **кожної** події `onSubscribed` каналу (перша підписка, авто-перепідписка клієнта після розриву, перепідписка `refreshTokens`). Перечитуються вигляди об'єкта пари з `refreshedAt < joinedAt` (вигляд у польоті отримує хвіст `revalidate` B5a Р5); `rights` — коли `lastRightsAt < joinedAt`; `version` — коли `lastVersionAt < joinedAt`. Отже перше приєднання теж дає 1 умовний запит з `known` — як вимагає §8.4. Хвиля — одне вікно джитера: перший `onSubscribed` без `recovered` ставить таймер `random() × REJOIN_JITTER_MS`, решта входить у нього; наступна хвиля — не раніше ніж через `REJOIN_JITTER_MS` після спрацювання попередньої. Прихована вкладка: виглядам хвилі — `needsRefresh` і позначка `rejoinPending`, яку `resume()` (B5a) бере поза межею `resumeMinIntervalMs`. **Прийнятий ризик:** зміна між активацією підписки на сервері й `onSubscribed` на клієнті (≈ RTT) дійде лише перечитуванням хвилі — воно й закриває вікно | §8.4 — опорна мить приєднання, прийнятий ризик (задача 0) |
| Р12 | Позначка «розрив»: `transport` → `markDisconnected(channel?)`. Знімає `clearDisconnected(channel)`: `recovered: true` — після `RECOVERED_SETTLE_MS` тиші після `onSubscribed` (і після пачки відновлених, якщо вони є); `recovered: false` — коли всі вигляди об'єкта пари мають `refreshedAt ≥ joinedAt` (`freshnessOf`, B5a). Збій перечитування лишає позначку | немає |
| Р13 | Відмова токена з'єднання (`auth` без каналу): перша — `requestVersion()` і один новий токен з'єднання (`connect()` клієнта); друга поспіль без успішного `onSubscribed` між ними — `core.close("connection-refused")` через шлях рантайму. Лічильник скидає кожен успішний `onSubscribed`. `CloseReason` дістає `"connection-refused"` | §6.1 — причина закриття (задача 0) |
| Р15 | **Життєвий цикл транспорту.** `DataRuntimeOptions.signals` — фабрика `(subject: string) => SignalTransport`: транспорт створюється на суб'єкта рантайму й закривається разом із ним. `dispose()` і `session-changed` знімають кожну підписку й кличуть `close()`; перевикористати транспорт іншого суб'єкта не можна | §8.5 (задача 0) |
| Р16 | **Збій частини `rights`.** `command.unauthenticated` чи `session-changed` — шлях сесії. Інші збої: старий знімок лишається, повтор з паузою 1, 2, 4 с (до `revalidateIntervalMs`); після трьох збоїв поспіль — `revalidate` усіх активних виглядів і метрика `rights-failed` (без даних) | немає |
| Р14 | Знімок прав — частина першого пакета рантайму (перше читання після створення чи гідратації) і першої частини SSR `preload`, до даних тієї самої транзакції | §6.6 — порядок на сервері (задача 0) |

## Review Focus

1. **Токен каналу після втрати доступу.** Знімок без права `read` на пару:
   `purge` рядків пари в усіх сховищах, канал знято дельтою, незакрита пачка
   ключів і таймер джитера пари скинуті. Тест — задачі 5 і 12.
2. **Grant → дані → revoke між двома знімками.** Право дали й забрали між
   двома читаннями знімка: рядки, завантажені в проміжку, прибирає `purge`
   за сховищем. Тест — задача 5.
3. **Сигнал від старого покоління.** Сигнал чи відповідь перечитування після
   `purge`, `session-changed` чи `dispose()` нічого не пишуть. Тест —
   задачі 11 і 14.
4. **Знімок SSR іншого суб'єкта чи прав.** Гідратація знімка, чий
   `rightsVersion` чи `userId` гідратованого знімка прав розходиться з
   першою відповіддю `rights`, — `purge` усіх ключів знімка (права) чи
   `session-changed` (суб'єкт); анонім і деактивований (`userId: null` з
   обох боків) — без `session-changed`. Тест — задача 7.
5. **Перепідписка після розриву.** Канал підписано давно, вигляд прочитано
   після підписки, далі розрив і `recovered: false` (авто-перепідписка
   клієнта): 1 запит з перечитуванням, `rights` і `version`; позначка
   «розрив» лишається до осідання. Флапання з `random = 0` — запити не
   частіше разу на `REJOIN_JITTER_MS`. Тест — задача 13.
6. **Вихід на спільному пристрої.** Після `session-changed` чи `dispose()`
   транспорт закрито, підписок немає (Р15). Тест — задача 12.

---

## Частина A — знімок прав клієнта

### Task 0: поправки спеки й плану B3-4

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`:
  - §8.4 — абзац «Межа B5b» (Р2) з межею «Користувачів» і значень вимірів
    (до B6 — `revalidate` за зміною `scopeSets` та інтервал), опорна мить
    приєднання й прийнятий ризик RTT (Р11);
  - §8.5 — значення `auth`, `close()` порту, транспорт на суб'єкта (Р8, Р15);
  - §9.1 — поля знімка за блоками (Р3);
  - §6.6 — значення `rightsVersion`, порядок на сервері (Р4, Р14);
  - §6.1 — причина закриття `connection-refused` (Р13);
  - §13 рядок B5b — частини A і B, межа з B6, рядок «B6 розширює
    `rightsSnapshot`, не дублює»; рядок B6 — «розширює знімок B5b»; рядок
    B4 дістає «`reason: "schema"` у T0 і `requestVersion()` на ньому» (Р9).
  
  Звір із поділом, який вносить B5a.
- Modify: `docs/superpowers/plans/2026-11-08-p4-b3-4-b3-5-write-receipts.md` —
  таблиця «подія → `version`»: `schema` → B4 (Р9).
- Modify (після мерджу PR #77 з планом B5a): `docs/superpowers/plans/2026-11-08-p4-b5a-resume-interval.md`
  — той самий розподіл: `schema` → B4. Цей рядок править лише гілка B5b.

- [ ] **Step 1:** правки. Без лічильників і наративу фаз.
- [ ] **Step 2:** `python3 scripts/check-doc-anchors.py` і `pnpm format:check` — зелені.
- [ ] **Step 3: Commit** — `docs(spec): B5b — знімок прав, межа з B6, rightsVersion, приєднання`.

### Task 1: `publicRead` у клієнтському каталозі

**Files:**
- Modify: `packages/simetra/src/model/runtime/catalog.ts` (`catalogEntrySchema`),
  `packages/simetra/src/compiler/runtime-catalog.ts`, `compiler/client-catalog.ts`
- Test: `packages/simetra/src/compiler/__tests__/client-catalog.test.ts`,
  `runtime-catalog.test.ts`

**Interfaces:**
- Produces: `CatalogEntry.publicRead?: "anon" | "authenticated"` — з
  метаданих об'єкта (`object.data.publicRead`, тип `PublicReadRole`), тим
  самим джерелом, з якого `access-units.ts` будує `publicReadPurposes` і
  політику `<t>_public_read`. Відсутнє — об'єкт без `publicRead`.

- [ ] **Step 1: failing tests:** об'єкт з `publicRead: anon` і
  `authenticated` — поле в обох каталогах; без — поля немає; `snapshotHash`
  змінюється разом із ним; `kernelHash` — ні.
- [ ] **Step 2:** `pnpm --filter simetra test client-catalog runtime-catalog` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS; `pnpm metadata:check`.
- [ ] **Step 5: Commit** — `feat(compiler): publicRead у клієнтському каталозі`.

### Task 2: T0 — схема знімка, `rightsVersion`, частина `rights`

**Files:**
- Create: `packages/simetra/src/model/runtime/rights-snapshot.ts`
- Modify: `packages/simetra/src/model/runtime/envelope.ts` (після B1c: частина
  `{ type: "rights" }`), `model/runtime/index.ts`
- Test: `packages/simetra/src/model/runtime/__tests__/rights-snapshot.test.ts`,
  тест конверта (B1c)

**Interfaces:**
- Produces:
  - `rightsSnapshotSchema`, `type RightsSnapshot` (Р3, strict);
  - `function rightsVersionOf(s: RightsSnapshot): Promise<string>` (Р4);
  - частина `{ type: "rights" }`; відповідь `{ ok: true, value: RightsSnapshot }`;
    не більше однієї частини `rights` на пакет.

- [ ] **Step 1: failing tests:**
  - схема приймає вихід з усіма полями, з рівнем `everyUser`, без
    `versions`; зайве поле — відмова;
  - `rightsVersionOf` однаковий для переставлених масивів; інший за зміни
    `userId`, `scopeSets`, рядка `read` чи версії; рядок не-`read` його не
    змінює;
  - пакет з двома частинами `rights` — відмова.
- [ ] **Step 2:** `pnpm --filter simetra test src/model/runtime` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(model): знімок прав клієнта й частина rights пакета read`.

### Task 3: T1 — `simetra.rights_client_snapshot()`

**Files:**
- Create: `packages/simetra/src/compiler/rights/client-snapshot.ts`
- Modify: `packages/simetra/src/compiler/rights/functions.ts` — одиниця там,
  де генеруються функції фактів, за умовою «є функції прав»
- Test: `packages/simetra/src/compiler/__tests__/rights-client-snapshot.test.ts`,
  `packages/simetra/test/db/rights-client-snapshot.support.ts`,
  `rights-client-snapshot.db.test.ts`, `rights-client-snapshot.supabase.db.test.ts`

**Interfaces:**
- Produces: `simetra.rights_client_snapshot() RETURNS jsonb` — `STABLE SECURITY INVOKER SET search_path = ''`.
  `EXECUTE` — роль запиту `user` профілю (`PROVIDER_API_ROLES`) і
  `simetra_command`; `REVOKE … FROM PUBLIC`. Тіло:
  - кличе лише `current_user_id()`, `rights_mine()`, `scopeSetCall` кожного
    виду скоупу (один раз на `scopeKindId`), а з довідниками прав — ще
    `rights_versions()` і `rights_projection_version()`. Нової
    definer-поверхні немає (§9.1);
  - проєкт без `current_user_id()` — функція не генерується;
  - `userId` `NULL` → `{ "userId": null, "scopeSets": [], "rights": [] }`;
  - числа версій — рядками.

- [ ] **Step 1: failing unit tests** (дерево SQL): `SECURITY INVOKER`,
  `search_path = ''`, `EXECUTE` за переліком; `scopeSets` — той самий
  `scopeSetCall`, що й `<t>_scope_read` (мутація «`rights_scope_set` для всіх
  видів» червоніє); без довідників прав немає `rights_versions()`.
- [ ] **Step 2: failing DB tests** (обидва стеки):
  - лише власні факти, `userId` = `current_user_id()`;
  - `scopeSets` = вихід `scopeSetCall` на кожен вид: вид із членством —
    непорожній, вид з дослівною функцією — її вихід;
  - проєкт без довідників прав — працює без `versions`;
  - `READ ONLY` — без запису;
  - анонім і недійсний — `userId: null`, порожні масиви;
  - вихід проходить `rightsSnapshotSchema`.
- [ ] **Step 3:** `pnpm --filter simetra test:db rights-client-snapshot` і
  `pnpm --filter simetra test:db:supabase rights-client-snapshot` — FAIL.
- [ ] **Step 4:** реалізація → **Step 5:** PASS обох.
- [ ] **Step 6: Commit** — `feat(compiler): rights_client_snapshot — знімок прав користувача`.

### Task 4: T3 — `runtime.rightsSnapshot` і частина `rights`

**Files:**
- Modify: `packages/simetra/src/server/runtime.ts` (`CommandRuntime.rightsSnapshot`,
  `readParts` після B1c: `ReadPart` і `ReadPartsResult` дістають `rights`),
  `packages/simetra/src/server/data-handler.ts` (маршрут частини `rights` у
  групі Server Function, як `version` у B3-4; `inProcess`)
- Modify (після B3-6): `packages/simetra/src/server/testing/` — фейковий
  рантайм тестового хоста відповідає на частину `rights`
- Test: `packages/simetra/src/server/__tests__/rights-snapshot.test.ts`,
  `packages/designer/src/__tests__/rights-snapshot.db.test.ts`

**Interfaces:**
- Produces:
  - `rightsSnapshot(session: SessionClaims): Promise<RightsSnapshot>`:
    `sessionKind` (ПГ-3) ≠ `"user"` → `{ userId: null, scopeSets: [], rights: [] }`
    без бази; інакше `SELECT simetra.rights_client_snapshot()` під роллю
    `user`, вихід через `rightsSnapshotSchema` (розбіжність —
    `command.internal` і журнал);
  - частина `rights` — **першою** в транзакції пакета, до частин `query`
    (Р14); `inProcess` теж дає частину `rights`.

- [ ] **Step 1: failing tests:**
  - unit (фейкова база): анонім — без запиту; невалідна відповідь —
    `command.internal`; пакет `[query, rights]` — рівно один
    `BEGIN … READ ONLY`, `rights_client_snapshot()` перед першим оператором
    читання, один `COMMIT`;
  - DB: `rights.userId` = id користувача сесії; `inProcess` = конверт.
- [ ] **Step 2:** `pnpm --filter simetra test src/server` і
  `pnpm --filter @simetrajs/designer test:db rights-snapshot` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(server): rightsSnapshot і частина rights пакета read`.

### Task 5: T4 — сховище знімка, правило втрати доступу, предикат

**Files:**
- Create: `packages/simetra/src/data/rights/snapshot-store.ts`,
  `packages/simetra/src/data/rights/access.ts`,
  `packages/simetra/src/data/rights/subscribe.ts`
- Modify (після B3-2/B3-3/B3-4): `packages/simetra/src/data/store/` — `createCore`
  тримає сховище знімка; `CorePart` дістає `rights`; `CloseReason` дістає
  `"connection-refused"` (для Р13); частина `rights` — там само, де B3-4
  провів `version`: `store/source.ts`, збирач B3-3, `src/data/adapter.ts`,
  `store/testing/fake-source.ts`
- Test: `packages/simetra/src/data/rights/__tests__/snapshot-store.test.ts`,
  `access.test.ts`, `subscribe.test.ts`

**Interfaces:**
- Produces:
  - `canSubscribe` і `readAllowed` — експорт `simetra/data/testing` (для
    DB-тесту designer);
  - `CoreSession.rightsSnapshot(): { snapshot: RightsSnapshot; rightsVersion: string } | undefined`
    — **єдине** джерело знімка й `scopeSets` у T4 (Р1);
  - `CoreSession.requestRights(): void` — частина `rights` у збирачі поточної
    мікрозадачі, single-flight з одним хвостом, як `requestVersion()`;
    `lastRightsAt` — старт останнього запиту `rights`;
  - перший пакет рантайму (`load()` першого вигляду чи звірка гідратації)
    несе частину `rights` (Р14);
  - на кожну відповідь `rights` — запис знімка й `rightsVersion` (Р4), далі
    одним `commit`: `purge` пар за Р5 (`accessLoss(store, snapshot, catalog): PairRef[]`),
    потім `revalidate` об'єктів звуження (`narrowed(prev, next, catalog): ObjectName[]`),
    зміна `userId` — шлях `session-changed` рантайму;
  - `readAllowed(snapshot, pair, catalog): boolean` і
    `canSubscribe(snapshot, channel, catalog): boolean` (Р5, Р6);
  - `onRightsChange(listener)` — для приймача (Task 11);
  - `rightsReady(): Promise<void>` (Р4); повтор і метрика збою (Р16).
- Відповідь `rights` з помилкою — старий знімок лишається, запис у журнал,
  `purge` не робиться (fail-safe: дані не відкриваються, а лише не
  прибираються до наступного знімка).

- [ ] **Step 1: failing tests:**
  - `canSubscribe` — `it.each` за кейсами режиму підписки §12: свій скоуп з
    правом; учасник без `read`; чужий скоуп; лише `own`; лише контейнер;
    нескоуплений з `own`; роль рівня скоупу на нескоупленому; `everyUser`;
    глобальна роль на нескоупленому; `publicRead`; «Користувачі»; корінь
    свій і чужий; вид у топіку ≠ вид об'єкта; `userId: null`; канали прав;
  - `accessLoss`:
    - перший знімок (база порожня) прибирає рядки пари без права
      (Review Focus 2);
    - grant → рядки → revoke між двома знімками → `purge`;
    - зник скоуп зі `scopeSets` — `purge` усіх пар скоупу, крім об'єктів з
      `publicRead`;
    - лишився лише контейнер — без `purge`; зник і він — `purge`;
    - рядок, утриманий лише слабким власником (знімок показу вікна B3-3) у
      скоупі без `read`, теж очищається;
    - `purge` доходить до знімків показу вікна, цілей `include` у чужих
      виглядах, `SectionStore` і чернетки `card` (стан `purged`);
  - `narrowed`: втрата контейнера C2 при C1, виміру D1 при D2, `own` однієї
    ролі при `own` іншої, `any` → `own` — `revalidate` без `purge`;
    невидимі вигляди й підмножини `include` теж перечитуються;
  - перше `load()` рантайму — 1 запит, частина `rights` перша (Р14);
  - рядки без збереженого скоупу об'єкта, що втратив `read`, — прибрані;
    зміна `scopeSets` — `revalidate` виглядів «Користувачів»; звуження
    знімає рядки лише слабких власників і перечитує чернетку `card`;
  - сховище: заміна зі старим токеном — нічого (Review Focus 3); збій
    частини `rights` — старий знімок, повтори 1/2/4 с, після трьох —
    `revalidate` активних і `rights-failed`; `unauthenticated` — шлях сесії;
  - єдине джерело: у `src/data/**` лише `rights/snapshot-store.ts` тримає
    знімок; інші модулі читають `scopeSets` через `CoreSession.rightsSnapshot()`
    (тест-інваріант над джерелами: `scopeSets:` як поле стану — лише в
    `snapshot-store.ts`).
- [ ] **Step 2:** `pnpm --filter simetra test src/data/rights` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): знімок прав клієнта, втрата доступу від сховища, предикат підписки`.

### Task 6: DB-еквівалентність предиката з `signal_topic_allowed`

**Files:**
- Create: `packages/designer/src/__tests__/subscribe-equivalence.support.ts`,
  `subscribe-equivalence.db.test.ts`, `subscribe-equivalence.supabase.db.test.ts`

**Interfaces:**
- Consumes: Task 3–5; `signal_topic_allowed` (ПГ-4/B2 Task 7). Фікстури
  прав — помічники designer (`rights-admin-commands.support.ts` і сусідні),
  `canSubscribe` — з `simetra/data/testing`.

- [ ] **Step 1: DB test.** Фікстури прав — кожна пара «користувач, скоуп,
  сигнальний об'єкт» над моїми й чужими скоупами, зокрема:
  - лише контейнерне право; роль рівня скоупу на нескоупленому;
  - `everyUser` і глобальна роль на нескоупленому **і на скоупленому**
    (`readAllowed` — так, `canSubscribe` — ні, бо `level = 'scope'`);
  - `deny`, що звужує обсяг (`deny read@any` при `own`);
  - замикання графа вимог, `fullAccess`, вимір;
  - вид з дослівною функцією множини;
  - топіки з чужим видом, у верхньому регістрі, неправильної форми.
  
  Для кожної пари `canSubscribe(знімок користувача, канал)` дорівнює
  `signal_topic_allowed(канал, false)` під claims того самого користувача.
  Вибір скоупів для `publicRead` — поза еквівалентністю (§12).
- [ ] **Step 2:** `pnpm --filter @simetrajs/designer test:db subscribe-equivalence` і
  `pnpm --filter @simetrajs/designer test:db:supabase subscribe-equivalence` —
  PASS; мутація «`canSubscribe` бере `level` будь-який» — червоніє.
- [ ] **Step 3: Commit** — `test(db): предикат підписки T4 еквівалентний signal_topic_allowed`.

### Task 7: тригери знімка й SSR `rightsVersion`

**Files:**
- Modify (після B3-6): `packages/simetra/src/data/runtime/ssr.ts`
  (`dehydrate`: `meta.rightsVersion` з `CoreSession.rightsSnapshot()`;
  `verifyAfterHydration`: частини `version` і `rights`); гідратований знімок
  прав кладеться в ядро як база
- Modify (після B5a): `packages/simetra/src/data/runtime/freshness.ts` —
  `resume()` кладе `requestRights()` поряд із `requestVersion()`
- Modify (після B3-4): `command.unavailable` на `create` кореня виду скоупу —
  `requestRights()`; зміна `serverHash` — `requestRights()` **разом** із
  `requestVersion()` в одній мікрозадачі
- Modify (після B3-6): серверний `preload` SSR — частина `rights` першою в
  пакеті (Р14)
- Test: `packages/simetra/src/data/runtime/__tests__/ssr.test.ts`,
  `freshness.test.ts`, тест запису B3-4

**Interfaces:**
- Produces: SSR `preload` чекає `core.rightsReady()` до `dehydrate()` (Р4).
  Звірка після гідратації — один запит `version` + `rights`:
  - `userId` першої відповіді ≠ `userId` гідратованого знімка прав → шлях
    `session-changed` (`subject` уже звіряє конверт, B3-6);
  - `rightsVersion` нової відповіді ≠ `meta.rightsVersion` → `purge` усіх
    ключів знімка й причина `access-changed` (§6.5), далі правило Р5;
  - `meta.rightsVersion` відсутній (проєкт без функцій прав чи хеш ще не
    готовий на мить `dehydrate`) — шлях «звірка з перечитуванням» B3-6:
    одразу `revalidate` видимих виглядів знімка тим самим запитом, а втрату
    доступу прибирає Р5 за частиною `rights` звірки. `dehydrate` не чекає
    хешу (рішення автора; архітекторка дала вибір).

- [ ] **Step 1: failing tests:**
  - гідратація: той самий `rightsVersion` — рівно 1 запит, без `purge`;
    тіло й відповідь ≤ 2 КіБ + 128 Б × об'єктів каталогу + `jsonBytes`
    знімка;
  - інший `rightsVersion` — `purge` усіх ключів, причина в UI;
  - `dehydrate` до готовності хешу — знімок без `rightsVersion`; звірка —
    1 запит з `version`, `rights` і перечитуваннями; пара без права в
    сховищі — `purge` за Р5;
  - `userId` відповіді ≠ гідратованому — `session-changed`; анонім і
    деактивований (`null` з обох боків) — без `session-changed`;
  - SSR `preload` → `dehydrate()`: `rightsVersion` присутній (чекання
    `rightsReady()`);
  - серверний `preload`: частина `rights` перша в пакеті;
  - `resume()` — рівно 1 запит з `version`, `rights` і перечитуваннями;
  - `create` кореня з `command.unavailable` — рівно 1 запит `rights`;
    п'ять таких відповідей в одній мікрозадачі — теж 1;
  - зміна `serverHash` — `version` і `rights` одним запитом; транспорт
    чергує два хеші — без пінг-понгу (відповідь з частиною `version`
    нового запиту не запускає, §10);
  - гідратація, `resume()` і зміна `serverHash` в одній мікрозадачі —
    1 запит.
- [ ] **Step 2:** `pnpm --filter simetra test src/data/runtime` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): знімок прав на гідратації, resume(), serverHash і create кореня`.

### Task 8: гейти частини A

- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  `pnpm metadata:check` — зелені.
- [ ] **Step 3:** scoped DB-файли частини A на обох стеках — зелені; повний
  `pnpm test:db:pg` і `pnpm test:db` — один раз на блок, у задачі 16
  (правило власника); між ними — CI.
- [ ] **Step 4:** модельний тест ядра (B3-2) і браузерний оракул (B3-6) —
  повні прогони, зелені (тестовий хост знає частину `rights`).
- [ ] **Step 5:** `docs/ROADMAP.md` — статус B5b-A; commit
  `docs: ROADMAP — B5b частина A`.

### Готово — частина A

- `publicRead` є в клієнтському каталозі.
- `rights_client_snapshot` дає лише власні факти; `scopeSets` — вихід
  `scopeSetCall` кожного виду. Частина `rights` іде першою в транзакції
  пакета `read`.
- Знімок у T4 — одне сховище. Кожна заміна, зокрема перша, прибирає пари
  без права `read` за вмістом сховища. Звуження за кортежами дає
  `revalidate`.
- `canSubscribe` еквівалентний `signal_topic_allowed` на фікстурах обох
  стеків.
- Знімок SSR з іншим `rightsVersion` — `purge`, з іншим суб'єктом —
  `session-changed`.

## Частина B — приймач сигналів і транспорт

### Task 9: порт `SignalTransport` T0 за §8.5

**Files:**
- Modify: `packages/simetra/src/model/runtime/ports.ts`,
  `packages/simetra/src/model/runtime/__tests__/ports.test.ts`
- Modify: споживачі старої форми — `grep -rn "SignalTransport\|SignalErrorKind\|onSubscribed" packages/*/src packages/*/test`

**Interfaces:**
- Produces (Р8):
  ```text
  type SignalError = { kind: "auth" | "transport"; channel?: string }
  interface SignalTransport {
    subscribe(channels: readonly string[], onSignal: (topic: string, payload: unknown) => void,
              onError: (e: SignalError) => void): Unsubscribe
    onSubscribed(handler: (e: { channel: string; recovered: boolean }) => void): Unsubscribe
    refreshTokens(channels?: readonly string[]): Promise<void>
    close(): void
  }
  ```
  `SignalErrorKind` прибирається.

- [ ] **Step 1:** type-тест форми (`expectTypeOf`) → FAIL.
- [ ] **Step 2:** реалізація; стара форма прибрана → PASS; `pnpm typecheck`.
- [ ] **Step 3: Commit** — `feat(model): порт каналу сигналів за §8.5`.

### Task 10: `CoreSession.readKeys` і фейковий канал

**Files:**
- Modify (після B3-2/B3-3): `packages/simetra/src/data/store/` — `readKeys`
- Create (після B3-6 Р6): `packages/simetra/src/data/testing/fake-signal-transport.ts`
  (вхід `simetra/data/testing`)
- Test: `packages/simetra/src/data/store/__tests__/read-keys.test.ts`,
  `packages/simetra/src/data/testing/__tests__/fake-signal-transport.test.ts`

**Interfaces:**
- Produces:
  - `CoreSession.readKeys(object: ObjectName, keys: readonly Key[]): Promise<ReadKeysResult>` (Р10)
    — частини `keys` по ≤ `CoreLimits.keysPerRequest` у збирач поточної мікрозадачі, з
    `known`; запис — `commit` з токеном старту: повернуті — `patch` за
    правилом версії, відсутні — `remove` (`removed` на місці);
    `ReadKeysResult = { returned: readonly Key[]; missing: readonly Key[]; versions: ReadonlyMap<Key, number> }`;
  - `fakeSignalTransport(): SignalTransport & { emit(topic, payload): void; join(channel, recovered: boolean): void; fail(e: SignalError): void; refused: Set<string>; subscribed(): readonly string[]; subscribeCalls(): number; refreshCalls(): readonly (readonly string[] | undefined)[]; closed(): boolean }`.
    `refreshTokens` закриває канали з `refused` і кличе
    `onError({ kind: "auth", channel })`.

- [ ] **Step 1: failing tests:**
  - `readKeys` ставить `readAt` повернутих рядків = старт перечитування
    (B5a Р2);
  - `readKeys` двох об'єктів в одній мікрозадачі — 1 запит; 200 ключів — 1
    пакет, 201 — 2 пакети (поділ `store/source.ts`); жодного запиту поза
    збирачем (`countingTransport` бачить лише виклики збирача); відповідь
    після `purge` пари — нічого не пише;
  - фейк: `subscribe`, `join`, `refused`, `subscribeCalls`.
- [ ] **Step 2:** `pnpm --filter simetra test src/data/store src/data/testing` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): readKeys ядра й фейковий канал сигналів`.

### Task 11: приймач — підписки, розбір, пачка, кроки §8.4

**Files:**
- Create: `packages/simetra/src/data/runtime/signals.ts`
- Modify: `packages/simetra/src/data/runtime/` — рантайм створює приймач, коли
  в опціях є фабрика `signals` (Р15)
- Modify (після B5a): `packages/simetra/src/data/runtime/freshness.ts` —
  контракт для приймача: `isVisible(): boolean`,
  `markRejoinPending(object: ObjectName): void`; `resume()` перечитує
  видимі вигляди об'єктів з `rejoinPending` поза межею `resumeMinIntervalMs`
  і знімає позначку; тести — `freshness.test.ts`
- Test: `packages/simetra/src/data/runtime/__tests__/signals.test.ts`

**Interfaces:**
- Consumes: `CoreSession` (B3-2: `activeViews`, `commit`, `token`,
  `readEpoch`; `Writer.markStale`, `markViews`, `markDisconnected`,
  `clearDisconnected`, `purge`); `revalidate` з хвостом і `freshnessOf`
  (B5a); `readKeys` (Task 10); `evaluateFilter` (B3-2 Task 5);
  `requestVersion()`, `requestRights()`, `rightsSnapshot()`, `onRightsChange`,
  `canSubscribe` (Task 5); сталі Global Constraints.
- Produces: `createSignalReceiver({ core, transport, catalog, freshness, now, setTimer, clearTimer, random, log }): { dispose(): void }`
  — `freshness` — планувальник B5a з контрактом вище; `DataRuntimeOptions.signals?: (subject: string) => SignalTransport` (Р15).
  Пачка сигналів у прихованій вкладці: збирається й закривається як
  звичайно, але замість запиту — `needsRefresh` виглядам об'єкта й
  `rejoinPending`; 0 запитів до `resume()`.

Правила:
- **підписки** — Р7, дельтою по каналу; `joinedAt` — на кожен `onSubscribed` каналу (Р11);
- **розбір** — `received*Schema`; сумісність уперед §8.1: невідомий `op` чи
  зайве поле каналу змін — `invalidate` пари; `payload.object` ≠ об'єкт
  топіка — `invalidate` об'єкта топіка; невідомий `object` (немає в збірці)
  — відкинути; невідомий канал — ігнор;
- топік, якого немає серед моїх поточних підписок, — відкинути без запиту;
- дедуплікація за `id`;
- **пачка** за об'єктом; кроки 1–7 §8.4 у цьому порядку:
  1. `delete` — першим, до перевірки версії: ключа немає — нічого; є —
     ключ у `readKeys` кроку 3; не повернувся — `removed`;
  2. відлуння — ключ з підтвердженою версією ≥ `row_ver` — відкинути;
  3. ключі з меншою версією — `readKeys`; нова версія шапки з видимою ТЧ —
     перечитування ТЧ (§6.2 правило 2);
  4. повернута версія < `row_ver` — `markStale(minVersion = row_ver)` і до
     `MIN_VERSION_RETRIES` дочитувань з паузою; новий сигнал того самого
     ключа лічильника не скидає; ключі однієї спроби — однією частиною;
  5. нові ключі — той самий `readKeys`; рядок у сховище не пишеться,
     `evaluateFilter` активних виглядів → `markViews(…, { hasNewRows }, spec)`
     лише відповідним;
  6. понад 200 ключів об'єкта — збір ключів зупиняється, `revalidate(object, { visibleOnly: true })`,
     невидимим — `needsRefresh`;
  7. `invalidate` — `revalidate` видимих виглядів пари й ТЧ власників,
     невидимим — `needsRefresh`;
- усі об'єкти пачки — одна мікрозадача (`⌈частин / READ_BATCH_MAX⌉`
  пакетів);
- **зворотний тиск:** читання пачки — single-flight; пачка, що закрилась під
  час читання попередньої, чекає її осідання;
- `purge` пари (Task 5) скидає її незакриту пачку й дочитування;
- метрики в `log` без ключів і значень: `stale-age`, `revalidate-burst`
  (§8.4).

- [ ] **Step 1: failing tests** (рядок «unit T4 (приймач…)» §12; фейковий
  канал, `countingTransport`, фейкові таймери; число запитів і байти —
  явно):
  - підписки: канали змін сигнальних об'єктів з активними виглядами в моїх
    скоупах; несигнальний — без каналу; нескоуплений — `ZERO_UUID`; скоуп
    поза `scopeSets` — без каналу; заміна знімка, що додає скоуп, —
    `subscribeCalls` +1, незмінні канали не перепідписано;
  - дедуплікація за `id`; дубль після витіснення з `SEEN_SIGNALS_MAX` — не
    більше 1 зайвого запиту;
  - відлуння — 0; власне відлуння `delete` — 0;
  - чужий `delete`: перечитування; `removed` лише за порожньою відповіддю;
    `delete` для рядка, який перечитування повернуло, — нічого;
  - пачка 50 мс тиші й найдовше 2 с; сплеск 1000 сигналів над вікном — 1
    запит на вікно пачки; байти — ≤ 1,1 × корисних + 2 КіБ;
  - межі: 200 ключів — 1 запит за ключами; 201 — `revalidate` видимих,
    1 запит; 16 об'єктів — 1 запит, 17 — 2;
  - `minVersion`: повернуто 6 при `row_ver` 7 — `stale` і рівно 1 + 3
    запити з паузами 500, 1000, 2000 мс; далі 0;
  - новий ключ, що підходить лише одному з двох списків, — `hasNewRows`
    лише йому, у сховищі ключа немає;
  - нова версія шапки з видимою ТЧ — ТЧ у тому самому пакеті;
  - `invalidate`: видимі вигляди пари й ТЧ власників — 1 запит; невидимі — 0
    і `needsRefresh`; три `invalidate` у пачці — 1 запит;
  - невідомий `op` і зайве поле — `invalidate`; `object` ≠ топік —
    `invalidate` об'єкта топіка; невідомий `object` — 0;
  - топік поза підписками — 0 запитів, 0 записів;
  - зворотний тиск: відповідь пачки 5 с, за цей час три нові пачки — після
    осідання рівно 1 запит;
  - сигнал після `dispose()`, після `session-changed` і відповідь після
    `purge` пари — 0 записів;
  - звичайне перечитування за сигналом `stale` не ставить (лише
    `minVersion`-гілка);
  - прихована вкладка: пачка — 0 запитів, `needsRefresh`; `resume()` — 1 запит;
  - заміна знімка без права на пару, поки її пачка відкрита й таймер
    джитера стоїть: `Unsubscribe` лише цього каналу, 0 запитів, пізніше —
    жодного запису (Review Focus 1); grant → канал → revoke → канал знято;
  - `minVersion` під потоком сигналів: дочитування йдуть тим самим
    single-flight пачки й обмежувачем чотирьох читань — за 10 с ≤ 1 запит
    на вікно пачки плюс 3 дочитування;
  - байти пачки чужих сигналів до 16 об'єктів і 200 ключів — ≤ 1,1 ×
    корисних + 2 КіБ.
- [ ] **Step 2:** `pnpm --filter simetra test src/data/runtime` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): приймач сигналів змін за кроками §8.4`.

### Task 12: відмова авторизації, розрив, токен з'єднання

**Files:**
- Modify: `packages/simetra/src/data/runtime/signals.ts`
- Test: `packages/simetra/src/data/runtime/__tests__/signals-errors.test.ts`

**Interfaces:**
- Produces (§8.4 «Відмова авторизації», «Розрив», Р12, Р13):
  - `auth` каналу змін → `purge` пари; канал знято; не повторюється до заміни
    знімка; незакрита пачка й джитер пари скинуті;
  - `auth` без каналу → перша: `requestVersion()` і новий токен з'єднання
    один раз; друга поспіль — `core.close("connection-refused")` через шлях
    рантайму;
  - `transport` → `markDisconnected(channel?)`, 0 запитів.

- [ ] **Step 1: failing tests:**
  - `auth` каналу — `purge`, 0 запитів, повтору до нової заміни знімка немає;
    `refreshTokens` після заміни знімка без пари не просить її токена;
  - `auth` без каналу: перша — 1 запит `version`; друга поспіль — закриття
    з причиною; успішний `onSubscribed` між ними скидає лічильник; N поспіль
    в одній мікрозадачі — 1 запит;
  - 401 від `getChannelToken` — `auth` без каналу, без `purge`; 403 —
    `auth` каналу;
  - `session-changed` і `dispose()` — `subscribed()` порожній, `closed()` —
    `true` (Review Focus 6);
  - `transport` — позначки «розрив» на рядках виглядів каналу, 0 запитів.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): відмова каналу, розрив і токен з'єднання`.

### Task 13: приєднання з `recovered` і без

**Files:**
- Modify: `packages/simetra/src/data/runtime/signals.ts`
- Test: `packages/simetra/src/data/runtime/__tests__/signals-rejoin.test.ts`

**Interfaces:**
- Produces (Р11, Р12):
  - `recovered: false` — одне вікно джитера на хвилю, хвилі не частіше разу
    на `REJOIN_JITTER_MS`; на спрацюванні одним запитом, для кожного об'єкта
    хвилі: якщо в нього є вигляд у польоті чи без `refreshedAt` зі стартом
    (`attemptAt`) до `joinedAt` — `revalidate(object, { visibleOnly: true })`
    **без** `select` (хвіст B5a Р5 для вигляду в польоті й перечитування
    решти); інакше — `revalidate(object, { visibleOnly: true, select: v => v.refreshedAt < joinedAt })`; `requestRights()`
    лише коли `lastRightsAt < joinedAt`, `requestVersion()` лише коли
    `lastVersionAt < joinedAt`; невидимим — `needsRefresh`; прихована
    вкладка — `needsRefresh` і `rejoinPending`, 0 запитів до `resume()`;
  - `recovered: true` — 0 перечитувань; `clearDisconnected` через
    `RECOVERED_SETTLE_MS` тиші після приєднання й після пачки відновлених;
    `stale` з `minVersion` лишається до підтвердження.

- [ ] **Step 1: failing tests** (Review Focus 5; монотонний годинник з
  дробовими мітками, не рівними):
  - монтування першого вигляду: `load()` стартує в T0, підписка, `onSubscribed`
    без `recovered` у T1 > T0 — рівно 1 умовний запит після джитера; «нічого
    не змінилось» — ≤ 64 Б × ключів `known` + 2 КіБ;
  - перепідписка після розриву: підписка T0, читання T1, розрив T2,
    `onSubscribed(false)` T3 — перечитано вигляд з T1, `rights` і `version`;
    позначка знята лише після осідання;
  - перепідписка `refreshTokens` — той самий шлях;
  - вигляд у польоті під час хвилі (старт до `joinedAt`) — після осідання
    хвіст, ще 1 запит;
  - `recovered: true` + 50 відновлених — запити лише за ключами пачки;
    позначка знята після пачки; без відновлених — через 50 мс;
  - до таймера — 0; `random = 0` і `random → 1` — у межах вікна;
  - 20 каналів з різним `random()` — 1 запит;
  - флапання: `random = 0`, 20 флапів по 300 мс, годинник просунуто до
    6000 мс включно — рівно 4 запити (хвилі о 0, 2000, 4000, 6000 мс);
  - байти хвилі з `rights` і `version` — у межах Global Constraints;
  - збій перечитування — позначки лишаються;
  - прихована вкладка — 0 до `resume()`; `resume()` перечитує вигляди хвилі
    навіть свіжіші за `resumeMinIntervalMs` (`rejoinPending`);
  - `dispose()` скасовує таймер — 0.
- [ ] **Step 2:** FAIL → **Step 3:** реалізація → **Step 4:** PASS.
- [ ] **Step 5: Commit** — `feat(data): перечитування після кожного приєднання без recovered`.

### Task 14: модельний тест — кроки сигналу

**Files:**
- Modify (після B3-2): `packages/simetra/src/data/store/__tests__/model.test.ts`

- [ ] **Step 1:** кроки: сигнал (`create`, `update`, `delete`, `invalidate`)
  у будь-якому порядку з дублями; приєднання з `recovered` і без; відмова
  `auth`; заміна знімка з втратою пари й зі звуженням. Інваріанти ядра (§11)
  тримаються; після `purge` пари жоден рядок пари не з'являється з
  відповіді, що почалась до неї (Review Focus 3).
- [ ] **Step 2:** повний прогін — зелений; мутація «приймач пише без
  токена» — червоніє.
- [ ] **Step 3: Commit** — `test(data): кроки сигналу й знімка в модельному тесті ядра`.

### Task 15: `simetra/data/centrifugo` і стенд

**Files:**
- Create: `packages/simetra/src/data/centrifugo/index.ts`,
  `packages/simetra/src/data/centrifugo/__tests__/centrifugo.test.ts`
- Modify: `packages/simetra/package.json` — обидва блоки `exports`
  (`./data/centrifugo`), `peerDependencies` `centrifuge` `^5.8.0` з
  `peerDependenciesMeta.optional`; `tsdown.config.ts` (`data/centrifugo/index`);
  `.syncpackrc.json` — група для `centrifuge` (peer `^5.8.0` і dev `5.8.0`
  разом, як `react`)
- Modify: `packages/simetra/eslint.tier-zones.js` — окремий блок
  `src/data/centrifugo/**` (зразок `facade`): дозволено `centrifuge`;
  решта `src/data/**` — заборонено; T5 не імпортує `simetra/data/centrifugo`
- Modify: `packages/simetra/test/tier-boundary.test.ts` — негативні тести:
  `centrifuge` у `src/data/store`, `./centrifugo/…` з решти `src/data`,
  `simetra/data/centrifugo` з `src/ui`; пак-тест designer — імпорт з тарбола
- Create: `packages/designer/src/__tests__/signal-receiver.support.ts`,
  `signal-receiver.db.test.ts`, `signal-receiver.supabase.db.test.ts`

**Interfaces:**
- Produces:
  - `class SignalAuthRefused extends Error { readonly status: 401 | 403 }` —
    експорт `simetra/data/centrifugo`; host кидає її з `getChannelToken` /
    `getConnectionToken` на відповідь endpoint-а 401/403;
  - `createCentrifugoTransport({ url, getConnectionToken, getChannelToken }): SignalTransport`
  (імпорт значення `Centrifuge` з `centrifuge` у цьому модулі). Мапінг:
  - `subscribed` → `onSubscribed({ channel, recovered })` — лише з події
    `subscribed`;
  - `getChannelToken` кинув `SignalAuthRefused` зі `status: 403` (host:
    канал не дозволено) чи `unsubscribed` з кодом `unauthorized` →
    `onError({ kind: "auth", channel })` без автоповтору; `status: 401` →
    `onError({ kind: "auth" })` без каналу (шлях сесії);
  - `close()` — `disconnect()` клієнта й зняття всіх підписок;
  - інший збій `getChannelToken` чи `getConnectionToken` (мережа, 5xx) —
    `transport`, повтор — backoff клієнта;
  - відмова токена з'єднання — `onError({ kind: "auth" })`; повторне
    з'єднання — явний `connect()` (після `UnauthorizedError` клієнт сам не
    перепідключається);
  - розрив — `onError({ kind: "transport" })`;
  - `refreshTokens(channels)` — перепідписка названих каналів; канал з
    відмовою — закрито й `auth`;
  - `subscribe` кожного каналу — окрема підписка клієнта; `Unsubscribe` знімає
    лише її.

- [ ] **Step 1: failing tests:**
  - unit над фейковим `Centrifuge`: мапінг подій; 5xx токена — `transport`;
    явна відмова — `auth`; `Unsubscribe` одного каналу не чіпає інших;
    `refreshTokens` закриває відмовлений канал;
  - стенд (ПГ-4/B2 `startSignalStand`, `createCentrifugoTokens`, тестовий
    JWKS; `getChannelToken` — над `runtime.authorizeChannels`):
    - розрив — повторний `onSubscribed`; короткий розрив з історією —
      `recovered: true`; рестарт — `recovered: false`; відмова токена —
      `auth` без автоповтору;
    - «сигнал рівно раз у своєму скоупі й жодного в чужому»: два рантайми
      двох користувачів двох скоупів, команда в першому — рівно 1 оновлення
      рядка в першому, 0 запитів у другому;
    - учасник без `read` на пару — `canSubscribe` хибний, токена не просить;
    - вимір Г7 (§14.2): з годинником порту токенів (`now` у
      `createCentrifugoTokens`) — після видалення членства токен каналу на
      оновленні не видається; час до припинення сигналів = залишок строку
      токена каналу (≤ 5 хв), а з `resume()` — до першої звірки знімка.
      Числа — у §8.6.
- [ ] **Step 2:** `pnpm --filter simetra test src/data/centrifugo` і
  `pnpm --filter @simetrajs/designer test:db signal-receiver`,
  `pnpm --filter @simetrajs/designer test:db:supabase signal-receiver` — FAIL.
- [ ] **Step 3:** реалізація → **Step 4:** PASS; `pnpm deps:check`,
  `pnpm build:packages && pnpm test:packaging` — зелені.
- [ ] **Step 5: Commit** — `feat(data): транспорт Centrifugo і доказ приймача на стенді`.

### Task 16: метрики, браузерні бюджети, документація й гейти

**Files:**
- Modify: `packages/simetra/src/data/runtime/signals.ts` і ядро — метрики
  `unknown-age`, `stale-age`, `revalidate-burst`, `queue-stalled` у `log`
  без ключів і значень (§8.4), якщо B3-2…B3-4 їх ще не дали (звір)
- Modify (після B3-6): тестовий хост `packages/test-host/`:
  - `src/` клієнтський entry дає `signals`-фабрику з фейковим транспортом
    під прапорцем оракула; `packages/simetra/src/server/testing/control.ts`
    дістає команди `emit`, `join`, `fail` фейкового каналу й `revokeRead`
    (зміна прав між SSR і гідратацією) фейкового рантайму;
  - Create: `packages/test-host/e2e/signals.spec.ts` — сценарії р1–р9 звіту
    спайку («Сценарії для оракула спайку 2»): сигнал власної команди раніше
    `run`, чужа зміна під `pending`, сплеск 1000 сигналів над вікном, розрив і
    50 змін, чуже видалення відкритої картки, власне видалення, дубль і
    перестановка, відставання репліки, втрачена відповідь `run`; кожен —
    `expectClean` і кінцева умова оракула B3-6;
  - Modify: `e2e/ssr.spec.ts` — `rightsVersion`: збіг (1 запит), розбіжність
    (`purge` і причина), інший `userId` (`session-changed`);
  - Modify: `e2e/budgets.spec.ts` — приєднання без `recovered` (рівно 1
    запит), `resume()` і звірка гідратації з частиною `rights` (байти §12);
  - Modify: маніфести `manifest.<project>.<build>.json` (B3-6 Р8) — нові id
    тестів, інакше гейт червоніє.
- Modify: `packages/designer/skills/simetra-metadata/` — розділ про
  рантайм даних: `signals` в опціях, `simetra/data/centrifugo`, токени через
  host (англійською)
- Modify: `docs/ROADMAP.md`; спека §8.6 — Г7 (задача 15). Бюджети
  рахуються на рантайм (вкладку): кооперації вкладок немає; масовий рестарт
  сервера сигналів дає N вкладок × 1 запит, розмазаних джитером — рядок у
  §8.6

- [ ] **Step 0:** зведена таблиця «мутація §12 П4-B → тест плану» у звіті
  для мутацій приймача й знімка:
  - розбирати повідомлення схемою відправки;
  - `onSubscribed` лише на першому підключенні;
  - предикат без `scopeSets`; `scopeSets` з `rights_scope_set` для виду з
    членством; предикат, що пропускає лише контейнерне право;
  - не перечитувати після приєднання без `recovered`; перечитувати після
    `recovered: true`; знімати позначку «розрив» до пачки відновлених;
  - перевірка версії перед гілкою `delete`; прибрати перевірку версії
    відлуння; ставити `stale` на кожне перечитування;
  - відкидати нерозібране повідомлення каналу змін замість `invalidate`;
    `removed` за сигналом `delete` без перечитування; записати новий ключ за
    сигналом у сховище; `hasNewRows` на всі вигляди;
  - пропустити звірку `rightsVersion` після гідратації; `purge` лише за
    різницею знімків (без сховища).
  
  Кожну виконавець робить на закомміченому дереві, бачить червоний тест і
  відкочує. Мутація без червоного тесту — дефект плану, до архітекторки.
- [ ] **Step 1:** `git merge origin/main` (без rebase).
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`;
  `pnpm metadata:check`; `python3 scripts/check-doc-anchors.py` — зелені.
- [ ] **Step 3:** повні `pnpm test:db:pg` і `pnpm test:db` — один раз на блок
  (тут), зелені.
- [ ] **Step 4:** модельний тест і браузерний оракул у Chromium і WebKit —
  зелені.
- [ ] **Step 5:** `pnpm build:packages && pnpm test:packaging` — зелені.
- [ ] **Step 6: Commit** — `docs: B5b — метрики, бюджети, скіл споживача, ROADMAP, Г7`.

### Готово — частина B і блок

- Порт `SignalTransport` має форму §8.5. `simetra/data/centrifugo`
  імпортується з тарбола; `centrifuge` — необов'язкова peer; лінт-зона тримає
  імпорт лише там.
- Приймач на фейковому каналі тримає всі бюджети Global Constraints; модельний
  тест з кроками сигналу й знімка зелений; браузерні бюджети з частиною
  `rights` зелені.
- Стенд обох профілів:
  - `recovered` після короткого розриву, нова епоха, відмова токена;
  - сигнал рівно раз у своєму скоупі й жодного в чужому.
- Г7 внесено в §8.6.
