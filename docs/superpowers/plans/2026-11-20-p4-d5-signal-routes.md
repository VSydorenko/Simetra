# План D5 — маршрути сигналів і realtime у шаблоні (#122)

> **Статус:** у аудиті. Приймає архітекторка М4 (сесія `m4-simetra-milestone`).
> **Якорі «після X»:** порт `simetra/data/centrifugo` (`createCentrifugoTransport`,
> `SignalAuthRefused`) — після B5b-4 (`docs/superpowers/plans/2026-11-20-p4-b5b-4-centrifugo-transport.md`);
> опція `DataRuntimeOptions.signals` і `CloseReason` `"connection-refused"` — після
> B5b-3 (`docs/superpowers/plans/2026-11-20-p4-b5b-3-signal-receiver.md`). На `main`
> уже є: `SignalTokens`, `createCentrifugoTokens`, `SIGNALS_JWKS_PATH`,
> `runtime.authorizeChannels`, `ChannelGrant` (`packages/simetra/src/server/signals/`,
> `packages/simetra/src/server/runtime.ts`), `centrifugoConfig`
> (`packages/designer/src/tools/signals-config.ts`).
> **Спільні ресурси:** стек `postgres` спільний; його не зупиняють і не
> перестворюють з гілки. Нові `centrifugo.json` і DSN споживача доходять до
> стека лише після мерджу частини 1 — перестворення робить архітекторка (задача
> власника В1). До того DB- і e2e-перевірки гілки йдуть у CI на власних стеках.
> **Лише CI:** повні рівні `unit`, `db`, `db-supabase`, `packaging`, job
> `host-template` (e2e шаблону). Локально — лише цільові `run-tests … --filter`
> / `--changed`; жодна задача не закінчується повним локальним прогоном.

## Мета

Шаблон host-а видає токени Centrifugo й JWKS за тим самим правилом походження й
сесії, що й `dataFn`; клієнтський рантайм шаблону після гідратації з'єднується з
Centrifugo й отримує сигнали; вихід в одній вкладці закриває ядро інших; `pnpm
demo` отримує сигнал через Centrifugo стека.

## Архітектура

Сервер шаблону — три маршрути під `/simetra/signals/`: JWKS (публічний, для
Centrifugo), токен з'єднання й токени каналів (для браузера). Маршрути токенів
проходять один спільний вартовий запиту — той самий, що й `dataFn` (походження →
сесія), — і лише потім кличуть `runtime.authorizeChannels` на кожному запиті;
порт `createCentrifugoTokens` підписує тільки грант. Ключі підпису — змінна
оточення; без конфігу сигналів шаблон працює як зараз (маршрути 404, рантайм без
`signals`). Клієнт: `createClientRuntime` передає ядру фабрику транспорту
`createCentrifugoTransport` з колбеками до маршрутів; на SSR транспорту немає.
Шина вкладок — `BroadcastChannel` host-а: повідомлення лише закриває ядро.
Стек: Centrifugo стека обслуговує саме `pnpm demo` (origin, аудиторія, база).

## Спека

- П4-D `docs/superpowers/specs/2026-11-08-p4-d-hosts-design.md`: Дх12, §11 рядок D5,
  §8.3 (кейси походження), §9 інваріант 2.
- Профіль `postgres` `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`:
  §6.1–§6.3 (конфіг, токени, ключі й ротація), §10 (Centrifugo стеків).
- П4-B `docs/superpowers/specs/2026-11-05-p4-b-client-data-design.md`: §6.3
  (вкладки), §8.3 (токени), §8.6 (межі).

## Глобальні обмеження

- `centrifuge` — рівно `5.8.0` (пін B5b-4); шаблон — застосунок, тож у нього це
  звичайна залежність у групі syncpack разом із `simetra`.
- Host не прив'язують до `0.0.0.0` (Р17 ПГ-4/B2).
- Жодного приватного ключа в git: ні dev-ключа, ні фікстури (Р3).
- `checkRequestOrigin` і `verifySession` не дублюються: усі маршрути з сесією
  ходять через один вартовий (Р2).
- Наявні e2e (`security`, `ssr`, `write`) і тест дрейфу файлів стека лишаються
  зеленими; ослаблення перевірки заради зеленого — розвилка архітекторці.

## Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Вирівнювання стек ↔ demo (на затвердження).** Centrifugo стека — Centrifugo `pnpm demo`: (а) `DEMO_ORIGIN` → `http://127.0.0.1:3000` (host і так слухає `127.0.0.1`); (б) вхід генератора для обох `centrifugo.json` — `projectName` з файла проєкту шаблону (`TemplateApp`), не з `docker/postgres-stack/project` (той лишається для кроку ролей); (в) DSN споживача стека `simetra-pg` веде на базу `simetra_demo`, не `simetra`. Ціна: одна стала в тесті дрейфу (`STACK_PROJECT_NAME` читає файл шаблону), перегенерація двох `centrifugo.json`, нова адреса демо в браузері, перестворення стека після мерджу (В1); до першого `pnpm demo` споживач логує помилку з'єднання й повторює — як 42P01 на голому стеку. Альтернатива «змінити входи генератора під demo (`localhost`, окремий конфіг на demo)» відкинута: другий конфіг стека — друге джерело правди; «demo пише в базу `simetra`» відкинута: база стека — спільна база ролей і guard-а | профіль §10 (абзац «Centrifugo стеків»: аудиторія з проєкту шаблону, DSN на `simetra_demo`) |
| Р2 | **Один вартовий запиту.** Кроки 1–2 `respond` з `template/src/server/data-request.ts` (походження → `verifySession` → неанонімна сесія) виносяться в модуль вартового сервера шаблону; `dataFn` і обидва маршрути токенів кличуть лише його. Відмова походження — до будь-якого читання сесії (П4-D §9 інв. 2) | none |
| Р3 | **Ключі підпису — оточення, без dev-ключа в git.** `SIMETRA_SIGNALS_KEYS` — JSON-масив `SigningKey` (`kid`, `privateJwk`, `addedAt`, `retiredAt?`, дати ISO-рядками), читає `template/src/server/config.ts` під час виклику. Невалідний масив чи ключ зупиняє сервер на старті: синхронна перевірка форми (JSON, `kty`/`crv`, унікальний `kid`, дати) у `src/server.ts` і `startup-plugin.ts`, а `startup-plugin.ts` ще й одразу створює порт (`createCentrifugoTokens` асинхронна; невідповідні `x`/`d` — `signals.invalid-key`) і зупиняє процес на відмові. `pnpm demo` і фікстура e2e генерують пару Ed25519 і **новий `kid`** на кожен запуск (WebCrypto, `addedAt` = зараз: перший запуск підписує одразу, профіль §6.3; новий `kid` іде шляхом «невідомий `kid` → перечитати JWKS», тож кеш JWKS Centrifugo від попереднього запуску не відкидає нових токенів) — так само, як випадковий `BETTER_AUTH_SECRET` демо. Закомічений dev-ключ відкинуто: публічний репо, ключ потрапив би в production | профіль §6.3 — одне речення «dev- і e2e-ключ генерується на запуск» |
| Р4 | **Сигнали — опційна частина конфігу.** `SIMETRA_SIGNALS_URL` (WebSocket-адреса Centrifugo для браузера) і `SIMETRA_SIGNALS_KEYS` — обидві або жодної; одна без іншої — помилка старту (`server.ts` і `startup-plugin.ts`, як `appOrigin`). Без них: маршрути `/simetra/signals/*` відповідають 404, клієнт без `signals` (свіжість — `resume()` і інтервал #209). Так наявні e2e М3 і розгортання без Centrifugo не змінюються | П4-D Дх12 (речення про вимкнений режим) |
| Р5 | **Шляхи й форми маршрутів.** Файлові маршрути Start (зразок — `template/src/routes/api/auth/$.ts`): `GET SIGNALS_JWKS_PATH` → `tokens.jwks()`, без перевірки походження й сесії (його читає Centrifugo сервер-сервер; лише публічні ключі); `POST /simetra/signals/connection-token` з `{ subject }` → `{ token, expiresAt }`; `POST /simetra/signals/channel-tokens` з `{ subject, channels: string[] }` → `{ tokens: { channel, token, expiresAt }[] }` — рівно канали гранту. Шляхи токенів — сталі шаблону (їх знає лише шаблон), JWKS — стала T3 | П4-D Дх12 (шляхи) |
| Р6 | **Статуси.** Походження → 403 (до сесії, без `Set-Cookie`); без сесії чи аноніму → 401 на обох маршрутах токенів (анонім сигналів не отримує, профіль §6.2; рантайм не кличеться); `signals.no-user` → 401; `command.invalid` (понад 256 каналів, канал понад 255 октетів, не масив рядків) → 400; `signals.no-signing-key` / `signals.no-mature-key` → 503 з журналом; `signals.forged-grant` та інше → 500 без тексту винятку. `subject` запиту ≠ `grant.subject` → 401 з `{ reason: "session-changed" }` (Р12). Канал поза грантом — просто відсутній у `tokens` (200). Відповіді — `no-store` (дає `decorate` у `src/server.ts`) | П4-D Дх12: «аноніму — 401 на обох маршрутах токенів» замість «грант із порожніми каналами» (поведінка та сама: токенів немає) |
| Р7 | **Свіжа авторизація на кожен запит.** Обидва маршрути кличуть `runtime.authorizeChannels(claims, …)` на кожному запиті (з'єднання — з порожнім списком, щоб узяти `current_user_id()`); грант і токени не кешуються ні на сервері, ні в клієнті шаблону (рішення архітекторки 2026-11-19, П4-B §8.3) | none |
| Р8 | **Один рантайм на процес.** `template/src/server/runtime.ts` дає один лінивий `CommandRuntime`; `getDataHandler` і маршрути сигналів беруть його з одного проміса (зараз рантайм схований у `getDataHandler`). Порт токенів — лінивий одиничний на процес над `SIMETRA_SIGNALS_KEYS`; `audience` = `centrifugo:<name>` з `metadata/project.meta.json` шаблону (статичний імпорт; каталог рантайму назви проєкту не несе), `issuer` = `appOrigin()` | none |
| Р9 | **Пакетування токенів каналів у клієнті.** SDK кличе `getToken` на кожну підписку окремо; після перепідключення це N запитів і N транзакцій. Пакувальник створюється на транспорт (на суб'єкта) і зникає з його `close()`; виклики різних суб'єктів в один запит не потрапляють. Колбек `getChannelToken` шаблону збирає виклики одного такту мікрозадач в один `POST channel-tokens` (не більше 256 каналів на запит) і роздає результати; канал без токена → `SignalAuthRefused`; 401/403 → `SignalAuthRefused` для всіх каналів пакета; мережа й 5xx — звичайна помилка (`transport`, повтор SDK) (B5b-4 Р1). Кешу між пакетами немає (Р7) | none |
| Р10 | **Транспорт лише на клієнті після гідратації.** `createClientRuntime` (`template/src/host-session.ts`) передає `signals: (subject) => createCentrifugoTransport({ url, getConnectionToken, getChannelToken })`, лише коли сервер віддав `signalsUrl`; `establishServerSession` (SSR) — ніколи. `signalsUrl` доходить до клієнта в SSR-даних кореня разом із суб'єктом, не через змінну збірки (одна збірка — різні розгортання) | none |
| Р11 | **Шина вкладок.** `BroadcastChannel` host-а з однією подією `{ type: "signed-out", subject }`: успішний `signOut` у вкладці публікує її; вкладка-отримувач, чий `holder.current()?.subject` дорівнює `subject`, робить те саме, що Дх14 на `command.unauthenticated`: `holder.replace(undefined, "signed-out")` і перехід на вхід. Подія лише закриває, ніколи не відкриває й не міняє суб'єкта; інша форма чи інший суб'єкт ігноруються. Без `BroadcastChannel` (старий браузер) шина мовчить, лишається Дх14 | П4-B §6.3 — одне речення: назва й форма події host-а |
| Р12 | **Токен — лише для суб'єкта, якого тримає рантайм.** Як `request.subject` шляху даних (`template/src/data-transport.ts` `clientTransport`): обидва запити токенів несуть `subject` транспорту (фабрика `signals: (subject) => …` замикає його); маршрут порівнює з `grant.subject` (`current_user_id()`), розбіжність → 401 `session-changed`, токена немає. Клієнт: `SignalAuthRefused` і, лише коли `holder.current()?.subject === subject`, та сама заміна тримача, що й на `session-changed` даних. Так вхід іншого користувача в сусідній вкладці (подія шини його не несе) не дає старому ядру з'єднання й підписок нового суб'єкта | none |

## Інтерфейси

| Дає / бере | Що | Від кого / кому |
| --- | --- | --- |
| бере | `createCentrifugoTokens(options) → SignalTokens`, `SignalTokenError`, `SIGNALS_JWKS_PATH` (`simetra/server/signals`) | ПГ-4/B2 частина C, `main` |
| бере | `runtime.authorizeChannels(session, channels) → ChannelGrant` | ПГ-4/B2 частина C, `main` |
| бере | `createCentrifugoTransport({ url, getConnectionToken(): Promise<string>, getChannelToken(channel): Promise<string> })`, `SignalAuthRefused` (`simetra/data/centrifugo`) | B5b-4 (після) |
| бере | `DataRuntimeOptions.signals?: (subject) => SignalTransport`; закриття транспорту рантаймом на всіх шляхах закриття | B5b-3 (після) |
| дає | HTTP: `GET /simetra/signals/jwks`, `POST /simetra/signals/connection-token`, `POST /simetra/signals/channel-tokens` (форми — Р5, статуси — Р6) | Centrifugo, #263, B6 (оновлення токенів на сигналі прав кличе ті самі колбеки через `refreshTokens`) |
| дає | Оточення шаблону `SIMETRA_SIGNALS_URL`, `SIMETRA_SIGNALS_KEYS` (Р3, Р4); `appServerEnv` приймає їх опційно | `pnpm demo`, фікстура e2e, #263 |
| дає | Подія шини `{ type: "signed-out", subject }` (Р11) | вкладки того самого origin |
| дає | Фікстура e2e «Centrifugo під порт прогону» (контейнер з мітками прогону, конфіг з `centrifugoConfig`) | #263 |

## Інваріанти безпеки

| # | Інваріант | Тест, що червоніє на дефекті (мутація словами) |
| --- | --- | --- |
| І1 | Міжсайтовий запит на маршрут токена відхиляється 403 до читання сесії | e2e: чужий `Origin` / `Sec-Fetch-Site: cross-site` з дійсною cookie → 403, немає `Set-Cookie`. Мутація: маршрут кличе `verifySession` до вартового чи пропускає вартового → червоне |
| І2 | Без сесії й для аноніма токенів немає | e2e: без cookie → 401 на обох; анонімна сесія (cookie з `auth.api.signInAnonymous` над `authOptions`, як у `e2e/ssr.spec.ts`, хелпер — у спільні фікстури; HTTP-вхід аноніма закрито) → 401 на обох. Мутація: вартовий перевіряє лише `claims !== null` → червоне |
| І3 | Токен каналу — лише на канали гранту | e2e: Bob просить канал рядка Alice (обсяг `own`) разом зі своїм → у відповіді лише свій. Мутація: маршрут підписує запитаний список замість `grant.channels` → червоне (порт і так відмовляє на підробці, тож мутація — «передати `channels` запиту в другий виклик `authorizeChannels` без перевірки» чи «зібрати власний об'єкт гранту» → 500, теж червоне) |
| І4 | `sub` токена — `current_user_id()`, не сирий `claims.sub` | unit маршруту з фейковим рантаймом, що повертає грант з іншим `subject` → `sub` токена = `subject` гранту. Мутація: підпис з `claims.sub` → червоне |
| І5 | JWKS не віддає приватних членів | e2e: `GET /simetra/signals/jwks` → кожен ключ має рівно `kty crv x kid alg use`. Мутація: маршрут віддає `privateJwk` → червоне |
| І6 | Авторизація свіжа на кожен запит | unit маршруту: два запити → два виклики `authorizeChannels`; unit колбека клієнта: два пакети → два `fetch`. Мутація: кеш гранту чи токена на час TTL → червоне |
| І7 | Шина лише закриває | unit шини: подія з чужим `subject`, без `subject` чи іншого `type` → holder не змінено; подія `signed-out` свого суб'єкта → `replace(undefined, "signed-out")`. Мутація: отримувач замінює holder без перевірки суб'єкта чи приймає `subject` з події як новий → червоне |
| І8 | SSR не має транспорту | unit `host-session`: `establishServerSession` створює рантайм без `signals`; збірка: серверний вихід не містить модуля `centrifuge` (`build-content.build.test.ts`). Мутація: `signals` у серверному рантаймі → червоне |
| І9 | Конфіг стека й demo не розходяться | тест дрейфу файлів стека: `centrifugo.json` = `centrifugoConfig({ projectName: <назва з проєкту шаблону>, origin: DEMO_ORIGIN, issuer: DEMO_ORIGIN, jwksUrl: DEMO_ORIGIN + SIGNALS_JWKS_PATH })`; DSN споживача `simetra-pg` веде на `DEMO_DATABASE`. Мутація: зміна `DEMO_ORIGIN`, назви проєкту чи бази demo без перегенерації → червоне |
| І11 | Токен не видається для іншого суб'єкта | unit маршруту: `subject` запиту ≠ `grant.subject` → 401 `session-changed` на обох маршрутах; e2e: сторінка тримає Alice, cookie підмінено на Bob → запит токена з `subject` Alice відхилено, тримач замінено. Мутація: маршрут не звіряє `subject` чи клієнт не передає його → червоне; пакувальник спільний для двох транспортів → unit пакувальника червоне |
| І10 | Сигнали або повністю налаштовано, або вимкнено | e2e «старт сервера»: лише одна з двох змінних → сервер не стартує (як наявні кейси `SIMETRA_APP_ORIGIN`). Мутація: мовчазне вимкнення → червоне |

## Частини

| Частина | Зміст | Готово, коли |
| --- | --- | --- |
| **1. Сервер і стек** | задачі 0–4 | маршрути й вартовий у шаблоні; конфіг стека й demo вирівняно; e2e І1–І5, І10 зелені в CI; тест дрейфу (І9) зелений |
| **2. Клієнт і шина** | задачі 5–7 | після B5b-3 і B5b-4: транспорт у клієнтському рантаймі, шина вкладок; e2e доставки сигналу й шини зелені в CI; перевірка demo (задача 7) пройдена |

Частина 2 починається лише після мерджу B5b-4 (а з ним B5b-3) і частини 1.

## Задачі

**0. Звірка якорів і поправки спек.** `orient --plan` цього плану; підтвердити
B5b-3/B5b-4 на `main` (для частини 2) і форму `createCentrifugoTransport` та
`DataRuntimeOptions.signals`; розбіжність — розвилка архітекторці. Перевірити, що
роль `simetra_signals` має `CONNECT` на базі `simetra_demo` і доступ до її outbox
(інсталяція платформи, ADR-0095); якщо ні — розвилка. Поправки спек за
рішеннями: П4-D Дх12 і §11 рядок D5 (умовність знято, шляхи, анонім, вимкнений
режим — Р4–Р6), профіль §6.3 і §10 (Р1, Р3), П4-B §6.3 (Р11). Готово:
`doc anchors && doc lint` зелені (команда задачі — саме вона; тестів коду задача не міняє).

**1. Вартовий і один рантайм (Р2, Р8).** Модуль вартового в
`template/src/server/`, `data-request.ts` переходить на нього без зміни
поведінки; `runtime.ts` дає один рантайм і `getDataHandler` над ним. Готово:
наявні unit `data-request` і e2e `security` без змін очікувань зелені. Після 0.
Команда: `run-tests unit --package template --changed`.

**2. Конфіг і порт токенів (Р3, Р4, Р8).** `config.ts`: читання й перевірка
`SIMETRA_SIGNALS_URL` / `SIMETRA_SIGNALS_KEYS` (обидві або жодної, URL —
`ws:`/`wss:`); перевірка на старті в `src/server.ts` і `startup-plugin.ts`;
лінивий порт `createCentrifugoTokens` з `audience` з `metadata/project.meta.json`
і `issuer` = `appOrigin()`. Готово: unit конфігу (одна без іншої, невалідний
JSON, невалідний ключ, дублікат `kid` → помилка старту) і e2e старту (невідповідні `x`/`d` → сервер не стартує). Після 1.
Команда: `run-tests unit --package template --changed`.

**3. Маршрути (Р5–Р7).** Три файлові маршрути, перегенерований `routeTree.gen.ts`;
обробники виділено для unit без рантайму Start (як `handleDataRequest`). Готово:
unit І4, І6 і таблиця статусів Р6 (кожен код `SignalTokenError` і
`CommandFailure` → свій статус); у вимкненому режимі всі три → 404. Після 2.
Команда: `run-tests unit --package template --changed`.

**4. Стек, demo, фікстура e2e і e2e авторизації (Р1, Р3).**
- `DEMO_ORIGIN` (Р1а); `appServerEnv` приймає сигнали опційно; `demoUp`
  генерує ключ і передає `SIMETRA_SIGNALS_URL` = WebSocket-адреса Centrifugo
  `simetra-pg` (`127.0.0.1:8100`).
- `scripts/db-stack.mjs`: DSN споживача `simetra-pg` → база `simetra_demo`
  (стала бази demo — одна, імпортується, не дублюється); `simetra-sb` без змін.
- Обидва `centrifugo.json` перегенеровано інструментом `signals-config`; тест
  дрейфу — І9 (назва з проєкту шаблону, `DEMO_ORIGIN`, база demo).
- Фікстура e2e: опційний Centrifugo прогону — контейнер з `runContainerLabels`,
  конфіг з `centrifugoConfig` під порт і origin прогону, DSN споживача на
  тегову базу прогону. e2e не має globalSetup guard-а з прибиранням контейнерів, тож фікстура сама знімає контейнер за міткою `simetra-run` у teardown, і на збої теж; залишок після SIGKILL називає наступний прогін.
  Зразок — `packages/simetra/test/db/signal-stand.ts`.
- `e2e/signals.spec.ts`: І1, І2, І3, І5, І10 і позитивний контроль (своя сесія
  → токен з'єднання й токен свого каналу); новий spec — у маніфесті id тестів
  `playwright-gate`.

Готово: тест дрейфу зелений локально; e2e — у CI (`host-template`); у тілі PR —
перелік кейсів з мутацією кожного (тимчасовий коміт з червоним CI, потім
revert, як у ПГ-4 частині A). Після 3.
Команди: `run-tests unit --filter stack-files`; e2e — CI.

**5. Клієнтські колбеки токенів (Р9).** Модуль шаблону: `getConnectionToken`,
`getChannelToken` з пакетуванням за такт мікрозадач і межею 256; мапінг
401/403/відсутній канал → `SignalAuthRefused`, мережа/5xx → звичайна помилка.
Готово: unit на фейковому `fetch` (пакет з N викликів = 1 запит; 300 каналів =
2 запити; відсутній канал → відмова лише йому; 401 → відмова всім; І6). Після
мерджу B5b-4 і частини 1. Команда: `run-tests unit --package template --changed`.

**6. Проводка рантайму й шина вкладок (Р10, Р11).** `centrifuge` у залежностях
шаблону (група syncpack); `signalsUrl` у SSR-даних кореня; `createClientRuntime`
з `signals` лише за наявності `signalsUrl`; шина в `session-actions.ts` (публікує)
і в області host-а (отримує, закривається разом з областю). Готово: unit І7, І8;
e2e у `signals.spec.ts`: (а) дві сторінки однієї cookie, вихід у першій → друга
на вході без власного запиту даних; (б) Alice у двох сторінках: команда в
першій → друга отримує кадр публікації на своєму WebSocket (Playwright
`websocket`/`framereceived`) — доставка, без перевірки оновлення екрана (то
#263). Після 5. Команди: `run-tests unit --package template --changed`;
e2e — CI.

**7. Перевірка demo через Centrifugo стека.** Контролер блоку, після задачі
власника В1 (стек з новим конфігом): `pnpm demo`, вхід Alice у двох вкладках,
зміна рядка в одній → у журналі Centrifugo стека з'єднання й підписка
`TemplateApp`, друга вкладка отримує кадр публікації (DevTools / Playwright
проти `127.0.0.1:3000`). Готово: опис перевірки з рядками журналу в тілі PR
частини 2. Після 6.

## Задачі власника (виконуються лише після затвердження)

| # | Що | Коли |
| --- | --- | --- |
| В1 | Перестворити спільний стек `postgres` з новим `centrifugo.json` і DSN споживача (`pnpm db:pg:stop` без томів, `pnpm db:pg:start` з основного checkout); `simetra-sb` — `pnpm db:signals:stop && pnpm db:signals:start`. Робить архітекторка, коли немає активного DB-прогону | після мерджу частини 1 |

## Підсумок аудиту

(заповнює авторка після аудиту)
