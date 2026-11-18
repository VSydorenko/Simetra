# ПГ-4 і B2 — outbox, споживач Centrifugo, токени каналів і транспорт сигналу: план реалізації

> **Статус:** план-ескіз, написано 2026-11-08, актуалізовано 2026-11-18 під
> стан після М3; приймає архітекторка М4 (`simetra-75`). Об'єднує блок ПГ-4
> спеки профілю `postgres` (#127) і блок B2 спеки П4-B (#113). Три частини,
> кожна — свій PR і своє «готово», `main` зелений між ними:
> **A** — ролі, outbox і споживач (ПГ-4); **B** — функції сигналу, виклик у
> ядрі, авторизація каналу й злиття (B2); **C** — токени,
> `authorizeChannels`, конфіг Centrifugo й гейт доставки (ПГ-4).
> **Порядок A → B → C; якорі «після #173».** Частина B стартує лише після
> мерджу #173 (Правило 1 для таблиць `simetra`, сесія `simetra-aa`): до того
> `packages/simetra/src/compiler/sql/**` належить їй. Частина A від #173 не
> залежить. У частині C задачі 10 і 12 від B не залежать і можуть іти
> паралельно з нею; задачі 11 і 13 беруть `signal_topic_allowed` і сигнал ядра
> з B, тож PR частини C — після мерджу B.
> **Поза планом:** маршрути токенів, JWKS, сокет і шина вкладок у шаблоні —
> D5 (#122); приймач — B5b (#114); сигнали й канали прав — B6 (#115).
> **Спільні стеки.** Виконавець не зупиняє й не перестворює стеків; DB-тести —
> лише `run-tests db|db-supabase --filter …`; ролі на запущених стеках — кроком
> ролей (Р11).
> **Лише CI:** повні рівні `unit`, `db`, `db-supabase`, `e2e`, job `packaging`,
> базовий стан pgTAP обох провайдерів на свіжому стеку. Жодна задача не
> закінчується повним локальним прогоном. CI дивитись після кожного push.
> **Перед кожною частиною:** `orient --plan <цей файл>`; розбіжність імені —
> виправити в плані за кодом, розбіжність поведінки — до архітекторки.

**Goal.** Команда сигнального об'єкта пише рядок `simetra.signal_outbox` у
своїй транзакції; споживач Centrifugo публікує його в канал (скоуп, об'єкт);
підписка — лише з токеном каналу за `signal_topic_allowed`. Однаково в обох
профілях.

**Architecture.** Outbox, тригери, гранти й `prune` — платформний шар
(`compiler/platform/`), у кожному проєкті. Функції сигналу й політика
`INSERT` — новий генератор `compiler/signal/` за умовою ядра команд
(`hasRightsFunctions`). Злиття рахує T3. Токени — T3 `simetra/server/signals`
(WebCrypto Ed25519). Конфіг Centrifugo генерує designer; конфіги стеків — його
вихід. Стенд — власний Centrifugo на прогін з тегом.

**Spec.** Профіль `postgres` (`docs/superpowers/specs/2026-11-08-postgres-profile-design.md`)
§3.1, §5–§7, §10.1, §10.4, §11, §12 рядок ПГ-4. П4-B
(`docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`) §8.1–§8.3,
§8.6, §12 (рядки «unit T1», «DB `simetra`», «стенд сигналу», мутації), §13
рядок B2, §14.1–§14.3 рядки B2. ADR-0083, ADR-0088. Еталон стенду (заморожено):
`docs/superpowers/specs/2026-11-08-t4-realtime-spike-report.md`,
`git show spike/t4-realtime:packages/simetra/test/realtime/stand.ts`. Правила
тестів — скіл `writing-tests`.

## Global constraints

- Імена ролей, таблиці, каналу `NOTIFY`, налаштування режиму, шляху JWKS —
  константи T0/T1, ніколи літерал у споживачі: `PLATFORM_ROLES.signalConsumer`,
  `PLATFORM_LOGIN_ROLES.signals`, `SIGNAL_OUTBOX`, `SIGNAL_NOTIFY_CHANNEL`,
  `SIGNAL_MODE_SETTING`/`SIGNAL_MERGE_MODE`, `SIGNALS_JWKS_PATH`.
- Форма outbox — дослівно §5.1 профілю; параметри споживача — таблиця §5.3;
  простори — §6.1 (`force_recovery`, `recovery_max_publication_limit: 300`,
  `http_api.disabled`, жодного `allow_*_for_*`, `insecure`, `admin`,
  анонімного з'єднання). Ім'я споживача — `simetra_outbox`.
- Токени: EdDSA (Ed25519, `kty: OKP`), кожен з `kid`; з'єднання 15 хв, канал
  5 хв; `aud` = `centrifugo:<project.name>`, `iss` — origin host-а.
- `simetra` не залежить від `centrifuge` і `pg` у `src/server/signals`; зона
  T3 (`eslint.tier-zones.js`) не послаблюється.
- Кейс «на обох стеках» — спільне тіло в `*.support.ts` і два тонкі файли
  `<ім'я>.db.test.ts` і `<ім'я>.supabase.db.test.ts`. Ролі, бази й
  контейнери — з тегом прогону (`connection.ts`, `runContainerLabels` у
  `test/db/external.ts`).
- Без shims: статичні конфіги Centrifugo стеків замінює вихід генератора в
  тій самій зміні.
- Мутація — лише на закоміченому дереві; червоний тест показати
  (`run-tests … --filter <файл> --at <rev>` для нових тестів).

## Рішення

Р1–Р15 — з редакції 2026-11-08 (Р1, Р2 уточнено станом); Р16–Р23 закривають
дельти ревізії М4 (#127, #113).

| № | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | Залежності: ПГ-3, B1e, B3-4 (у `main`); частина B — ще #173. Сигнали прав і канали прав у підписці — B6; у B2 канали `simetra-rights:`/`simetra-user:` в обох режимах — `false` | профіль §5.3, §12 |
| Р2 | Бенчмарк ТЧ — у B1d (закрито); інваріант номера рядка ТЧ і версії власника — B3-5 (#111); поновлення токенів за сигналом прав — клієнт (#114, #115) | П4-B §13 B2, B3-5 |
| Р3 | `aud` = `centrifugo:<project.name>`: окремого id застосунку немає | профіль §6.1, §6.3 |
| Р4 | Верхній `id` сигналу — десятковий рядок id рядка outbox (= `idempotency_key`); ставить тригер `BEFORE INSERT` з `NEW.id`, бо `simetra_command` свого `id` не бачить. `received*Schema.id`: `z.guid()` → десятковий рядок (`bigint` понад 2^53 губить точність у JS). Формат — автору B5b | П4-B §8.1 |
| Р5 | `authorizeChannels(session, channels)` → `{ user \| null, channels }` — одна транзакція `READ ONLY` під роллю запиту; `sessionKind` ≠ `"user"` — без запиту | немає |
| Р6 | Стенд: Centrifugo з `--network host`, HTTP на `127.0.0.1` і вільному порту; JWKS — тестовий сервер на `127.0.0.1` | профіль §10.4 |
| Р7 | У частині A стенд бачить публікацію через історію HTTP API (лише конфіг стенду, з ключем); з частини C — конфіг генератора і клієнт `centrifuge` з токенами | немає |
| Р8 | Створення кореня шле сигнал лише за `rootCreator`: у моделі оператора політика відхилила б рядок | немає |
| Р9 | Пара (скоуп, об'єкт) для `signal_invalidate` — з результату ядра й каталогу: носій скоупу; корінь — його `id`; нескоуплений — `ZERO_UUID` | немає |
| Р10 | 🔴 `EXECUTE` на `signal_topic_allowed` — лише `simetra_command` і роль `user` профілю, не `PUBLIC`: політика `INSERT` — `TO simetra_command`, а `PUBLIC` дав би ролі з `USAGE` на `simetra` оракул прав. Залишок: роль `user` з довільним SQL підробила б claims — роль запиту довільного SQL не має | П4-B §8.3, Рд9 |
| Р11 | Ролі сигналів на запущених стеках — ідемпотентний адитивний крок ролей (`db:pg:start`, `db:roles`). `simetra_signals` — член лише `simetra_signal_consumer`, та — нічий член і нічий батько | немає |
| Р12 | `sub` токена з'єднання = `user` з `authorizeChannels` (`current_user_id()`), не сирий `claims.sub` | профіль §6.2, П4-B §8.3 |
| Р13 | `CHECK` прив'язує `idempotency_key` і `data.id` до `id`: вимкнений тригер — `23514` | немає |
| Р14 | Режим злиття скидається в тому самому операторі, що ставить claims команди: `ALTER ROLE … SET` не гасить сигналів | немає |
| Р15 | 🔴 Політика `INSERT` outbox — `WITH CHECK (signal_payload_allowed(payload))`: канал за `signal_topic_allowed(…, true)`, точна форма `data` за `op`, `object` = об'єкт топіка, рівно один ключ з ім'ям колонки ключа й UUID. Правило форми — лише там. `signal_payload_allowed` — `STABLE SECURITY INVOKER SET search_path = ''` (імена колонок ключа — константи компілятора, прав власника не треба), `REVOKE … FROM PUBLIC`, `EXECUTE` лише `simetra_command`: інакше вона — другий вхід в оракул Р10 | П4-B §8.2, §8.3 |
| Р16 | **DSN `simetra_signals` до Centrifugo стеків** — середовищем процесу compose: пароль у `login-secrets.env` читає лише `scripts/db-stack.mjs`, будує DSN і передає через `composeEnv()`; compose-файл має тільки інтерполяцію в `environment:` Centrifugo (змінні `CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_*` перевизначають споживача, оголошеного в конфігу, — Centrifugo v6.10.2 `internal/config/config.go`). Пароль не в `env_file` і не в argv. Centrifugo стартує після ролей і паролів; зміна пароля перестворює лише його (стану не тримає). Деталі — задача 12 | профіль §10.1, §10.2 |
| Р17 | **`jwksUrl` — вхід, не шаблон; JWKS лише на loopback.** `centrifugoConfig` бере `jwksUrl`; шлях — `SIGNALS_JWKS_PATH`, за ним D5 монтує маршрут. Host-и (`pnpm demo`, e2e) слухають лише `127.0.0.1`, а `host-gateway` на Linux їх не бачить, тож Centrifugo стеків — `network_mode: host` з HTTP на `127.0.0.1:8100`/`8101`, як стенд (Р6); JWKS стеків — `http://127.0.0.1:3000` (порт `pnpm demo`). Host на `0.0.0.0` не прив'язують. E2e (#263) і D5 генерують конфіг під свій порт — рішення D5. **На погодження:** тест файлів стека дозволяє `network_mode` лише `centrifugo` (задача 12) | профіль §10.1 |
| Р18 | Межа відкликання = TTL токена + `client.expired_sub_close_delay` (типово 25 с; з'єднання — `expired_close_delay`). Типові значення лишаються, у білий список ключі не входять | профіль §6.2, П4-B §8.6 |
| Р19 | Метрики транспорту §11 відкладено в #268: приймача метрик ще немає; `recovered: false` — B5b; журнал Centrifugo — `info` | профіль §11 |
| Р20 | `prune` за розкладом шаблон не кличе (Р27): оператор — `pg_cron` чи зовнішній cron від власника; рецепт — у скілі `simetra-metadata`. Демо й e2e спорожнює сам споживач | немає |
| Р21 | Борг #127: брак `ADMIN` на батьку однієї ролі входу (`adminRefusal`, `ensurePlatformRoles`) зупиняє лише її. Борг `idle_in_transaction_session_timeout` закрито кодом (`CLUSTER_TRANSACTION_PRELUDE`, `postgres-cluster.ts`) | немає |
| Р22 | Запис повз ядро команд сигналу не шле, зокрема заповнення NOT NULL у промоції (рішення архітекторки) | спека промоції |
| Р23 | Поріг злиття обмежено зверху історією каналу: типовий поріг + 1 (`invalidate`) ≤ `history_size` простору `simetra`; метод порогу — задача 9 | П4-B §8.2, профіль §6.1 (числа — задача 9) |

## Інтерфейси

| Що | Хто дає | Хто бере |
| --- | --- | --- |
| `PLATFORM_ROLES.signalConsumer`, `PLATFORM_LOGIN_ROLES.signals`, `LOGIN_ROLE_PARENTS.signals` | A, задача 1 | `roles`, гейт ролей |
| `simetra.signal_outbox` (§5.1), `SIGNAL_OUTBOX`, `SIGNAL_NOTIFY_CHANNEL`, `simetra.signal_outbox_prune(interval)` | A, задача 3 | споживач Centrifugo, B, оператор |
| `startSignalStand({ databaseUrl, notifyUrl?, config? })` | A, задача 4 | B, C, B5b |
| `received*Schema.id` — десятковий рядок | B, задача 6 | B5b (#114) |
| `simetra.signal`, `signal_invalidate`, `signal_topic_allowed(text, boolean)`, `signal_payload_allowed(jsonb)` | B, задачі 7–8 | ядро команд, `authorizeChannels`, B6 |
| `CommandRuntimeOptions.signalMergeThreshold` | B, задача 9 | host |
| `SignalTokens`, `createCentrifugoTokens`, `SIGNALS_JWKS_PATH` з `simetra/server/signals` | C, задача 10 | D5 (#122) |
| `runtime.authorizeChannels` | C, задача 11 | D5 (#122) |
| `centrifugoConfig`, `centrifugoConfigRefusals`, інструмент `signals-config` | C, задача 12 | стеки, D5, e2e #263 |

## Інваріанти безпеки

Кожен має тест, що червоніє на дефекті (мутація словами).

1. **Ключ ідемпотентності не підробити.** `simetra_command` пише лише
   `method` і `payload` (грант колонок): власний `idempotency_key` — `42501`;
   підроблений `data.id` тригер переписує; вимкнений тригер — `23514` (Р13);
   зайвий ключ запиту публікації (`skip_history`, `b64data`, `tags`) і
   `payload` понад 1024 байти — `23514`. Мутації: тригер не переписує
   `data.id`; `CHECK` без прив'язки до `id`. Задача 3 — від власника таблиці
   (політики `INSERT` ще немає); шлях `simetra_command` — задача 7.
2. **Споживач бачить лише outbox.** Роль входу без налаштування `role` —
   `42501`; член `simetra_command` чи ролі запиту — відмова гейта ролей;
   `SELECT` з `simetra.ledger`, таблиці виду — `42501`; `has_function_privilege`
   на будь-яку функцію схеми `simetra` — `false`. Членство всередину (`GRANT simetra_signals TO
   authenticated`) — відмова гейта. Мутація: зайвий грант споживачу. Задачі 2–3.
3. **Канал у транзакції.** Дозволений, потім недозволений канал — другий
   рядок відхилено разом із транзакцією. Задача 7.
4. **Оракул прав закрито (Р10, Р15).** Виклик `signal_topic_allowed` і
   `signal_payload_allowed` від `simetra_signals` з підробленими claims
   справжнього учасника і від ролі `anonymous` — `42501` (не `false`);
   `signal_payload_allowed` — `SECURITY INVOKER`. Мутації окремо: `GRANT
   EXECUTE … TO PUBLIC` на кожну з двох функцій. Задача 7.
5. **Довільні дані в сигналі (Р15).** Прямий `INSERT` в outbox і прямий
   виклик `signal()` від `simetra_command`: зайве поле в `data`, `op:
   "rights"`, чужий `object`, вигадане ім'я ключа, два ключі, версія 0 —
   `42501` обом шляхам. Мутації окремо: без `WITH CHECK`; пропуск другого
   ключа; без звірки імені ключа. Задачі 7–8.
6. **`EXECUTE` на `simetra.signal` — лише `simetra_command`** (П4-B §14.3).
   Задача 8.
7. **SQL застосунку не пише сигналів.** Тіло застосунку з `INSERT INTO
   simetra.signal_outbox` — відмова Правила 1 (#173); виклик `simetra.signal`
   — відмова `checkPlatformCalls` (`compiler/sql/function-body.ts`). Задача 7
   звіряє обидва фактом, після #173.
8. **Підписка лише за правом.** Гілка підписки без умови права (лише скоуп)
   червоніє; контейнерного обсягу в підписці немає. Задача 7.
9. **Анонім і недійсний користувач** токенів не отримують (`user: null`,
   жодного каналу). Задача 11.
10. **Ротація ключа (§6.3).** Новий ключ не підписує раніше 65 хв; старий
    лишається в JWKS 20 хв після останнього підпису; відставлений ключ
    ніколи не підписує; публічний JWK — лише білий список полів. Підробки
    `alg: none` і HS256 з байтами публічного ключа — відмова Centrifugo.
    Задачі 10 і 13.
11. **Конфіг Centrifugo — білий список** ключів кожного рівня (задача 12):
    `allow_*_for_*`, `insecure`, `http_api.disabled: false`, `hmac_secret_key`,
    `audience_regex`, `allowed_origins: ["*"]`, анонімне з'єднання,
    `grpc_api`, `admin`, ключ у `without_namespace`, `http_server`, `jwksUrl`
    `http:` на зовнішній хост — кожен червоніє.

## Частина A — ролі, outbox і споживач (ПГ-4)

### Задача 0. Якорі й поправки спек

Одним комітом `docs(spec)` — кожна поправка з колонки «Вплив на спеку»
Р1–Р22 (для Р19 — посилання на #268), а ще:
`2026-10-23-provider-profiles-design.md` — «блок B8» → «B2 П4-B» (outbox,
токен) і «B6» (сигнали прав); П4-B §13 рядок B2 — «Після»: B1b-1, B1e, B3-4,
ПГ-3, #173; рядок B3-5 — інваріант суцільного номера рядка ТЧ і підвищення
версії власника; спека промоції — рядок про сигнал заповнення (Р22).

**Готово:** `doc anchors && doc lint` і `pnpm format:check` зелені; кожна
поправка має рядок Р.

### Задача 1. Дані T0 ролей сигналів

`packages/simetra/src/model/schemas/project.ts`: `PLATFORM_ROLES.signalConsumer
= "simetra_signal_consumer"`, `PLATFORM_LOGIN_ROLES.signals =
"simetra_signals"`, `LOGIN_ROLE_PARENTS.signals` — лише
`signalConsumer` в обох профілях (тип токенів батьків дістає
`"signalConsumer"`, `loginRoleParentNames` — його гілку), налаштування
ролі входу `{ role: simetra_signal_consumer }` для `signals`.
`PlatformRolePurpose` звужується без `signalConsumer`: роль споживача не стає
призначенням гранту (`GrantPurpose`, `executeGrants`).

**Готово:** unit-тести значень і type-тест «`signalConsumer` не
`GrantPurpose`» зелені. `run-tests unit --changed`.

### Задача 2. Гейт і створення ролей сигналів; борг `adminRefusal`

`schema/apply/platform-roles.ts` (`PlatformLoginRole` дістає `settings`,
`platformRoleSet`, `platformRoleRefusals`, `ensurePlatformRoles`, перелік
обов'язкових ролей), `schema/apply/postgres-cluster.ts`, `designer`
`tools/roles-tool.ts`; `supabase/roles.sql` (ідемпотентно, кожне членство під
своєю перевіркою `pg_auth_members`: `simetra_signal_consumer NOLOGIN
NOINHERIT`; `simetra_signals LOGIN NOINHERIT`, член споживача `WITH INHERIT
FALSE, SET TRUE`, `ALTER ROLE … SET role`); базовий стан обох провайдерів
(`supabase/tests/provider-base-state.test.sql` і набір `postgres`). Гейт
читає `pg_db_role_setting`; розбіжність — `plan.platform-role-shape`
`setting:role`. Р21: відмова `ADMIN` — на свою роль входу.

**Готово:** unit гейта — кожна форма інваріанта 2 (чужий батько,
без налаштування, `INHERIT TRUE`, членство всередину) дає свою відмову; брак
`ADMIN` на `simetra_signal_consumer` не зупиняє `simetra_runtime` (Р21). DB
обох стеків на тегованих ролях: стан за §3.1, повтор нічого не змінює, нова
сесія ролі входу має `current_user` = споживач, на `postgres` чужий `CONNECT`
— `roles.shared-cluster`. `run-tests unit --changed`;
`run-tests db --filter roles-tool`; `run-tests db-supabase --filter roles-tool`.
Пароль `simetra_signals` і файли `docker/postgres-stack/**` — у задачі 12, не
тут: хеш файлів стека тоді змінюється один раз.

### Задача 3. Таблиця outbox, тригери, гранти, `prune`

Нова одиниця `compiler/platform/` (`outboxUnits`), підключена в
`buildPlatformUnits` до ранніх `return` (є в кожному проєкті, навіть без
«Користувачів»); константи — `model/runtime/signal.ts`. Склад: таблиця §5.1
плюс `CHECK` форми `payload` (рівно три ключі, канал за шаблоном, `data` —
об'єкт, прив'язка до `id` за Р13, ≤ 1024 байти); тригер штампа `BEFORE
INSERT` (Р4); `NOTIFY` `AFTER INSERT FOR EACH STATEMENT`; RLS без `FORCE`;
гранти за §5.2 (`simetra_command` — `INSERT (method, payload)` і `USAGE` на
послідовність; споживач — `USAGE` на схему, `SELECT`, `DELETE` і дві
політики; решті — нічого); `prune` з `EXECUTE` лише власнику. Функції
тригерів — без `EXECUTE` для `PUBLIC`. Ребра `requires` — явні. Політику
`INSERT` для `simetra_command` дає задача 7: до неї RLS відхиляє вставку, і це
очікувано.

**Готово:** unit дерева SQL (колонки, `CHECK`, рівні тригерів, гранти над
`DATABASE_PROVIDERS`, наявність без «Користувачів»); DB обох стеків —
інваріанти 1–2, `NOTIFY` (одне сповіщення на транзакцію з трьома вставками,
`ROLLBACK` — ні рядка, ні сповіщення), найбільший законний сигнал (канал
найдовшого `channelTopic`, ім'я колонки ключа 63 байти) проходить `CHECK` —
межа рахує октети, `prune` прибирає лише старші рядки, від
`simetra_command` — `42501`. `run-tests unit --changed`;
`run-tests db --filter signal-outbox`; `run-tests db-supabase --filter signal-outbox`;
`pnpm metadata:check`.

### Задача 4. Стенд сигналу

Create: `packages/simetra/test/db/signal-stand.ts` (+ `.support.ts` і два тонкі
файли). Контейнер: образ і тег читаються з `docker/postgres-stack/compose.yaml`;
`--network host`, HTTP на `127.0.0.1` і вільному порту змінними контейнера
(Р6); ім'я з тегом і номером інстансу; мітки `runContainerLabels`; конфіг —
у тимчасовому каталозі `:ro`; готовність — `/health`. DSN споживача стенд ставить
змінними контейнера `CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_*` (Р16;
їх імена вводить ця задача, задача 12 бере ті самі) і несе `application_name`
тегу. `down()` іде до drop бази й ролей. Стенд не імпортує
designer: конфіг дає виклик; у частині A — власний конфіг стенду з `http_api`
(Р7). Еталон — стенд спайку realtime.

Метод виміру затримки (і в задачі 13): 20 перших вставок — прогрів, не
рахуються; вставки послідовні, наступна — після доставки попередньої; мітка
«коміт» — після повернення `COMMIT`; опитування історії з кроком ≤ 5 мс.

**Готово:** DB обох стеків: публікація доходить, рядок outbox видалено,
`data.id` = id рядка; p95 «коміт → історія» з `LISTEN` ≤ 50 мс на 200
вставках; без `LISTEN` — p95 ≤ 600 мс і p50 > 100 мс (доказ, що `LISTEN`
справді вимкнено); справжній логін `simetra_signals` з
грантами задачі 3 працює; два інстанси з `use_try_lock` — кожен рядок рівно
раз; `restart()` — рядки, вставлені під час рестарту, доходять; на `0.0.0.0`
зовнішнього інтерфейсу нічого не слухає; журнал контейнера не містить пароля
DSN; після `down()` і після `throw` у
тесті — `docker ps -a --filter label=simetra-run=<тег>` порожньо.
`run-tests db --filter signal-stand`; `run-tests db-supabase --filter signal-stand`.

### Задача 5. `realtime` у стеку `supabase` вимкнено

`supabase/config.toml` `[realtime] enabled = false`; базовий стан без
`has_schema('realtime')`; тести, що спираються на схему `realtime`
(`grep -rn "realtime" packages/*/src packages/*/test --include=*.ts`),
переводяться на факт, що лишився, без втрати змісту.

**Готово:** зачеплені файли зелені на `db-supabase`; кожна зміна тесту — з
причиною в звіті. Стек не перезапускати: старт із новим `config.toml`
перевіряє CI.

### Готово — частина A

Задачі 0–5 і 14 готові; CI PR зелений.

## Частина B — сигнал і авторизація каналу (B2), після #173

### Задача 6. T0 — `id` сигналу, режим, Г10

`model/runtime/signal.ts`: `received*Schema.id` — десятковий рядок
`^[1-9][0-9]{0,18}$` (Р4); `SIGNAL_MODE_SETTING`, `SIGNAL_MERGE_MODE`;
`CENTRIFUGO_CHANNEL_MAX = 255` і тест Г10 (найдовший `channelTopic` у межі,
символи — дозволені). Споживачі `id` у T4 — за типом.

**Готово:** `"17"` проходить; UUID, `"0"`, `"01"`, число — ні; Г10 зелений.
`run-tests unit --changed`.

### Задача 7. `signal_topic_allowed`, `signal_payload_allowed`, політика `INSERT`

Новий генератор `compiler/signal/` (`buildSignalUnits`), підключений у
`compiler/pipeline.ts` поруч із `buildCatalogCommandUnits` за тією самою
умовою; `UnitGenerator` і `FIXED_BODY` (`compiler/sql/units.ts`) дістають
`"signal"`. Безрядкова форма предиката права `read` — грантова частина
`rightsPredicates` (`scopeSet` для `any`, `own`, виміру; без `mine`, без
носіїв рядка, без контейнера; нескоуплений — `has_right` за тими самими
обсягами). Входи: `isSignalObject`, `readBoundaries`, `scopeSetCall`
(`access-units.ts`).

- `signal_topic_allowed(p_topic, p_send)` — `STABLE SECURITY DEFINER SET
  search_path = ''`, `EXECUTE` за Р10. Тіло: без користувача — `false`;
  суворий розбір топіка тим самим шаблоном, що `parseTopic`; канали прав —
  `false` (Р1); гілка `CASE` за UUID об'єкта лише для сигнальних об'єктів.
  Відправка: скоуп у `scopeSetCall` (корінь — його `id`; нескоуплений —
  `true`), права читання писаря не судить. Підписка: скоуп у `scopeSetCall`
  **і** безрядковий `read`; `publicRead` — `true`; нескоуплений — `has_right`.
- `signal_payload_allowed(p_payload)` — Р15; ім'я колонки ключа — з каталогу
  компілятора.
- політика `signal_outbox_command_insert` — `FOR INSERT TO simetra_command WITH
  CHECK (simetra.signal_payload_allowed(payload))`.

**Готово:** unit дерева SQL — `EXECUTE` за Р10, `SECURITY DEFINER`, гілки лише
сигнальних об'єктів («Користувачі» без гілки), умова права в підписці,
контейнера немає; інваріант 7 фактом на компіляторі (після #173). DB обох
стеків — кейси `signal_topic_allowed` рядка «DB `simetra`» §12 П4-B в обох
режимах (зокрема лише контейнер: підписка `false`, відправка в свій скоуп
`true`) та інваріанти 3, 4, 5, 8 з мутаціями; фікстури прав — спільні
будівники `test/db`. `run-tests unit --changed`;
`run-tests db --filter signal-topic-allowed`;
`run-tests db-supabase --filter signal-topic-allowed`.

### Задача 8. `signal`, `signal_invalidate` і виклики в ядрі

`compiler/signal/` — `simetra.signal(p_object, p_scope_kind, p_scope, p_keys,
p_version, p_operation)` і `signal_invalidate(p_object, p_scope_kind,
p_scope)`: `SECURITY INVOKER`, `SET search_path = ''`, `EXECUTE` лише
`simetra_command`; форму не перевіряють (Р15); `signal` повертається без
вставки лише при точному `SIGNAL_MERGE_MODE`. `compiler/catalog-command/units.ts`
(`saveFunction`, `markDeletionFunction`, `deleteFunction`,
`createRootFunction`): `PERFORM simetra.signal(…)` у сигнальному об'єкті —
`save` після DML шапки й ТЧ з версією «після»; `mark_deletion` після
`UPDATE`; `delete` перед `RETURN` з версією й скоупом з `v_old`; `createRoot`
— останнім кроком, після функції гранту, лише за `rootCreator` (Р8), версія —
з `ROW_VERSION_SETTING` таблиці. Ознака `signal` каталогу й виклик — з одного
джерела, `isSignalObject`. Ребра `requires` — через `bodyRequires`.

**Готово:** unit: виклик після DML (мутація «сигнал до DML» червоніє),
«Користувачі» й не-UUID ключ без виклику, корінь — канал за `id`, модель
оператора без виклику, ознака `signal` = наявність виклику (над об'єктами
моделі-прикладу), гасіння лише точним `"merge"`. DB обох стеків: рядок
outbox після команди з правильним каналом і `data` рівно `{ id, object, op,
keys, row_ver }`; жодного після `ROLLBACK` і після `40001`; зміна й створення
кореня; писар лише з контейнером; `delete` з версією «до»; видалення й
повторне створення ключа — більша версія; інваріанти 5 (шлях `signal()`) і
6. Якщо `scopeSetCall` не бачить нового кореня в тій самій транзакції —
факт до архітекторки, без обходу. `run-tests unit --changed`;
`run-tests db --filter signal-core`; `run-tests db-supabase --filter signal-core`;
`pnpm metadata:check`.

### Задача 9. Режим злиття в T3 і бенчмарк порогу

`server/transaction.ts` (лічильник сигнальних фаз у стані транзакції;
скидання режиму в `COMMAND_CLAIMS_TEXT`, Р14), `server/phase.ts` (лік фаз,
зокрема `ctx.run`), `server/runtime.ts`
(`CommandRuntimeOptions.signalMergeThreshold`, ціле ≥ 1, типово — з
бенчмарку). Сигнальна фаза — фаза над об'єктом з `catalog.objects[…].signal`.
Щойно лік досягає порогу — `set_config(SIGNAL_MODE_SETTING, SIGNAL_MERGE_MODE,
true)` перед наступною фазою, без зворотного перемикання; повтор `40001`
починає лік з нуля; у режимі злиття після сигнальної фази нова пара (Р9) дає
один `signal_invalidate` одразу в тій самій транзакції. Бенчмарк — скрипт
`bench:signals` за зразком `bench:tabular`: ціна пакета з 500 фаз з outbox і
без (медіана 5 прогонів) дає ціну сигналу `c` і фази `f` на фазу. Поріг `T` —
найбільше кратне 10, для якого `T·c ≤ 0,1 · 500·f`, але не більше
`history_size` простору `simetra` − 1 (§6.1 профілю): до порогу всі сигнали
транзакції в одну пару лягають в історію, тож короткий розрив дає
`recovered: true` (Р23).

**Готово:** unit на фейковій базі з явним порогом 50 (49 фаз — без
`set_config`, 50-та — з ним, `ctx.run` рахується, несигнальні — ні, одна пара —
один `invalidate`, повтор скидає лік). DB обох стеків: сигнал на фазу до
порогу й жодного після, один `invalidate` на пару; до порогу — без
`invalidate`; пізніша фаза, що виводить писаря зі скоупу, не губить
надісланого; інше значення режиму не гасить; `ALTER ROLE … SET
simetra.signal_mode = 'merge'` на тегованій ролі не гасить (Р14). Числа
бенчмарку внесено в §8.2 П4-B і в типове значення опції тим самим комітом.
`run-tests unit --changed`; `run-tests db --filter signal-merge`;
`run-tests db-supabase --filter signal-merge`.

### Готово — частина B

Задачі 6–9 і 14 готові; поріг і ціну 500 фаз внесено в §8.2 П4-B; CI PR
зелений.

## Частина C — токени, `authorizeChannels`, конфіг, гейт доставки (ПГ-4)

### Задача 10. `simetra/server/signals` — порт і адаптер Centrifugo

Create: `packages/simetra/src/server/signals/index.ts` (вхід `./server/signals` в обох блоках
`exports` `package.json`, `tsdown.config.ts`, зона T3 в
`eslint.tier-zones.js`, `test/tier-boundary.test.ts`, перелік підшляхів у
тестах пакування).

```text
interface SignalTokens {
  connectionToken(subject): Promise<{ token; expiresAt }>
  channelToken(subject, channel): Promise<{ token; expiresAt }>
  jwks(): { keys: JsonWebKey[] }
}
SigningKey { kid; privateJwk; addedAt; retiredAt? }
createCentrifugoTokens({ keys, audience, issuer, now? }): Promise<SignalTokens>
SIGNALS_JWKS_PATH = "/simetra/signals/jwks"
```

Правила: підписує найновіший невідставлений ключ з `addedAt ≤ now − 65 хв`,
інакше найстаріший невідставлений (перший запуск); невідставленого немає —
`Error`. `jwks()` — невідставлені й відставлені менше 20 хв тому. Публічний
JWK — білий список `{ kty, crv, x, kid, alg: "EdDSA", use: "sig" }`; повтор
`kid`, ключ не `OKP`/`Ed25519` — `Error` на створенні. Claims з'єднання —
`sub`, `aud`, `iss`, `exp`; каналу — ще `channel`. Порт не кличе бази.

**Готово:** unit за фіксованим `now` — claims і `exp`, підпис перевіряється
ключем з `jwks()`, `kid` у заголовку, межі інваріанта 10 з обох боків (64/66
хв, 19/21 хв), RSA і повтор `kid` — `Error`. `run-tests unit --changed`;
`pnpm --filter simetra lint`. Імпорт з тарбола перевіряє CI (`packaging`).

### Задача 11. `runtime.authorizeChannels`

`server/runtime.ts` (`CommandRuntime`), `server/index.ts`. Шлях читання —
наявний: `readRoleFor`, `BEGIN_READ`, `readSetupStatement` /
`READ_SETUP_TEXT` (`server/transaction.ts`). Р5: `sessionKind` ≠ `"user"` —
без бази; інакше одна транзакція `READ ONLY` під роллю запиту:
`current_user_id()` і канали, для яких `signal_topic_allowed(c, false)`;
`user` `NULL` — `channels: []`; понад 256 каналів чи канал довший за
`CENTRIFUGO_CHANNEL_MAX` — `command.invalid` до бази; вихід відсортований і
без повторів. Для D5: endpoint з'єднання — `user !== null` →
`connectionToken(user)`, інакше 401; endpoint каналів — `channelToken(user, c)`
на кожен дозволений (Р12).

**Готово:** unit — анонім без запиту, ліміти, дедуплікація. DB (designer,
обидва стеки): свій канал є, чужий скоуп відсіяно, `invalid` — `user: null`,
анонім — порожньо (інваріант 9), вихід = `signal_topic_allowed(c, false)` на
кожному каналі фікстури задачі 7. `run-tests unit --changed`;
`run-tests db --filter authorize-channels`;
`run-tests db-supabase --filter authorize-channels`.

### Задача 12. Генератор конфігу Centrifugo, конфіги й DSN стеків

Create: `packages/designer/src/tools/signals-config.ts` (+ `catalog.ts`, `types.ts`,
`cli/render.ts`): `centrifugoConfig({ projectName, origin, issuer, jwksUrl })`
— чиста функція; простори, споживач `simetra_outbox` з DSN-заглушкою, `health`,
`log: info`, без `http_server`. `centrifugoConfigRefusals(config)` — білий
список ключів кожного рівня (інваріант 11; `jwksUrl` — `https:` або `http:`
на loopback чи однослівне ім'я сервісу). Інструмент `signals-config` (`files: "read"`, `database: "none"`)
називає обидві змінні DSN; секрет у файл не пишеться.

Стеки (Р16, Р17): `docker/postgres-stack/centrifugo.json` і
`docker/supabase-signals/centrifugo.json` — вихід генератора з базою
`http://127.0.0.1:3000`; `compose.yaml` обох — `network_mode: host`, HTTP
Centrifugo на `127.0.0.1` змінними (замість `ports`), інтерполяція DSN;
`login-secrets.env` —
`SIMETRA_SIGNALS_DEV_PASSWORD`; `scripts/db-stack.mjs` — DSN у `composeEnv()`,
порядок старту, пароль `simetra_signals` у `db:pg:start` і `db:roles`, DSN
у `db:signals:start` (`postgres` — `127.0.0.1:54422`, база `simetra`;
`supabase` — `127.0.0.1:54322`, база `postgres`). Тест файлів стека
(послаблення гейта — на погодження архітекторки, Р17): заборона
`network_mode` лишається для кожного сервісу, крім `centrifugo`, якому
дозволено лише `host`; у `centrifugo` — жодного `ports:`, а в `environment:`
обов'язково адреса `127.0.0.1` і порт `8100`/`8101`; healthcheck — на цей
порт; решта сервісів тримає правило `127.0.0.1:` для `ports`. Інших
слухачів Centrifugo (internal, gRPC, admin) немає — білий список інваріанта
11. Мутації: `network_mode: host` у `postgres`; адреса `0.0.0.0` у
Centrifugo — тест червоніє.
`packages/simetra/test/db/stack-files.test.ts` — тест дрейфу (файл стека =
вихід генератора) замість тесту «no outbox consumer», правила секретів
розширено на новий пароль (не в `env_file`, не в argv, не в
`dev-secrets.env`). Скіл споживача `packages/designer/skills/simetra-metadata/`
— розділ про сигнали англійською: генерація конфігу, DSN середовищем, один
інстанс, `prune` за розкладом оператора (Р20).

**Готово:** unit генератора (порожні відмови на власному виході; кожна
мутація інваріанта 11 червоніє; `audience` = `centrifugo:<projectName>`;
перевірка Р23 — типовий `signalMergeThreshold` + 1 ≤ `history_size` простору
`simetra` — у PR частини C, коли поріг задачі 9 уже в `main`),
тест дрейфу й правила секретів зелені. `run-tests unit --changed`. Старт
стеків з новим конфігом (`/health` 200, споживач з'єднався) — CI і задача
власника 2: зміна `docker/postgres-stack/**` міняє хеш файлів стека.

### Задача 13. Гейт доставки на стенді

`test/db/signal-stand.ts` — тестовий JWKS-сервер на `127.0.0.1` і клієнт
`centrifuge`; `packages/simetra/package.json` — devDependency `centrifuge`
5.8.0 (точний пін; ліцензія — з `LICENSE` репозиторію, CONTRIBUTING.md),
рядок у `docs/dependency-monitoring.md`. `packages/designer/src/__tests__/signal-delivery.*`
— модель з рантаймом і правами; тест сам кличе `centrifugoConfig` і передає
його стенду.

**Готово:** обидва стеки, два прогони поспіль — рядок «стенд сигналу» §12
П4-B без рядків B5/B6 (кожна форма ядра й писар лише з контейнером доходять;
рівно раз у своєму скоупі й жодного в чужому; учасник без `read` токена не
має; клієнт не публікує); відмови токенів інваріанту 10 і чужого каналу,
прострочення, чужого `aud`, невідомого `kid`; `OKP` приймається; ротація без
розриву з годинником порту; межа відкликання Р18 — токен каналу з `exp`
за кілька секунд, поновлення відмовлено: підписку закрито не пізніше `exp` +
25 с + запас; `recovered: true` після короткого розриву,
`false` після `restart()`; p95 «коміт → подія клієнта» ≤ 50 мс на 200
командах; падіння тесту не лишає контейнерів. `run-tests db --filter signal-delivery`;
`run-tests db-supabase --filter signal-delivery`.

### Задача 14. Мутації й закриття частини (кожна частина)

Таблиця «мутація §12 П4-B і інваріант плану → тест» у тілі PR: кожна
мутація зроблена на закоміченому дереві, червоний тест показано, мутацію
відкочено; мутація без червоного тесту — дефект плану, до архітекторки.
`git merge origin/main` (без rebase); `run-tests unit --changed`;
`pnpm metadata:check`; `doc anchors && doc lint`; повні рівні — у CI PR.

### Готово — частина C і блок

Задачі 10–14 готові; «Готово» рядка ПГ-4 §12 профілю й рядка B2 §13 П4-B (у
редакції задачі 0) доведено фактом; CI PR зелений. Мердж частини C — умова
D5 (#122).

## Задачі власника

Виконуються лише після погодження.

1. Після мерджу частини A: `pnpm db:roles` на стеку `supabase` і повторний
   `pnpm db:pg:start` на стеку `postgres` (Р11, адитивно) — щоб локальний
   базовий стан і DB-тести знали нові ролі.
2. Після мерджу частини C: перестворити стек `postgres` і `simetra-sb`
   (`pnpm db:pg:stop && pnpm db:pg:start`, `pnpm db:signals:stop &&
   pnpm db:signals:start`) — хеш файлів стека змінився; `pnpm db:roles` —
   пароль `simetra_signals` на стеку `supabase`; `pnpm db:start` — `realtime`
   вимкнено.

## Аудит

Раунд 1: Sonnet «план проти коду» — 1 major (C залежить від B; виправлено
порядком A → B → C); Sonnet «бюджети» — 3 major (метод порогу, межа історії
Р23, метод виміру затримки; виправлено); Opus «безпека» — 2 security major
(`signal_payload_allowed` як другий вхід в оракул; JWKS недосяжний з
`host-gateway` і штовхав до `0.0.0.0`) і minor (межа відкликання без тесту) —
виправлено. Раунд 2 (Opus на diff): закрито; нова major — послаблення заборони
`network_mode` у тесті файлів стека звужено до `centrifugo` (на погодження
архітекторки). Codex: 5 знахідок, усі спростовано (довірений логін
`simetra_runtime`; сигнал без даних лише дає перечитування; `iss` = origin
розгортання; межа довіри машини розробника; навмисні dev-паролі стека).
Підсумок: 0 blocker, 0 security major. Деталі — у тілі PR.
