# П4-D. Тонкий зріз М3: D2 — каркас шаблону host-а — план імплементації

> **Виконання:** `agent-kit:execute`, PR ⑧ порядку ①–⑩ спеки П4-B §13
> (#119). Розділ «Спільне» [файла D1](2026-11-08-p4-d-slice.md) — мета,
> порядок, глобальні обмеження, рішення Д-1…Д-12, інтерфейси з T4 — діє й
> тут. Перед стартом — `orient --plan` цього файла.
> **Старт:** після ПГ-3 (#126) у `main`; паралельно з T4 (код T4 D2 не
> потребує). **Лише CI:** рівні `unit`, `db` повністю, пакування; рівень
> `e2e`, `test:build` і DB-тести шаблону — job `host-template`, який створює
> задача 12; локально — `run-tests … --filter` і один прогін `e2e` наприкінці.
> **Спільний ресурс:** стек `postgres` — один на машину; стартує лише
> `pnpm db:pg:start` з основного checkout, не зупиняти його за іншими
> сесіями.

## Мета й межі

Шаблон `packages/create-simetra-app` збирається з tarball-ів на `node-server`,
тримає безпекові кейси D2 спеки П4-D §8.3 на production-збірці й має чисте
дерево й склад збірки. Сторінок списку й картки D2 не дає (D3); маршрут даних
`dataFn`, сесія Better Auth і серверний entry — так. Спека: П4-D §3, §4.1–§4.4,
§4.7, §8.3, §9 (інваріанти 1–4); профіль `postgres` §4.1, §4.2, §4.4.

## Рішення D2

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Д2-1 | Стиснення відповідей у D2 немає (→ #210); entry ставить межу тіла, кеш, заголовки й адресу клієнта | немає (§4.5 уже виправлено) |
| Д2-2 | Фікстура e2e — тегована база прогону з ознакою `simetra.environment = 'development'` рівня бази, `db-setup`, `seed` (Д-9), два користувачі через `dev-user`, сервер `node-server` на `127.0.0.1`, `CommandRuntime` другого користувача для зовнішніх змін; одна збірка — production без аліасу `#instrument` | немає |
| Д2-3 | Обхід #8139, `resolve.dedupe` пакета під `link:` і перевірка версії Rolldown у дереві — за звітом П0 (а); override Rolldown і Vite — у `pnpm-workspace.yaml` | немає |

## Інваріанти безпеки

Кожен — з тестом, що червоніє на названій мутації.

| Інваріант | Мутація | Червоніє |
| --- | --- | --- |
| `inProcess` ніколи не йде з HTTP-шляху (Дх7) | `dataFn` передає `{ inProcess: true }` | `data-fn` unit; лінт задачі 11 |
| | `ssrTransport` через `createServerFn` | `ssr-transport` unit; лінт задачі 11 |
| Походження — перший крок, до будь-якого кроку з сесією | `verifySession` перед `checkRequestOrigin` у `dataFn` чи `session-fn` | `data-fn` і `session-fn` unit («`getSession` не викликано») |
| `expectedOrigin` лише з `SIMETRA_APP_ORIGIN` | `expectedOrigin` з `Host` чи `X-Forwarded-Host` | `data-fn` unit; `security.spec.ts` рядок `X-Forwarded-*` |
| Межа тіла — кожен не-`GET`/`HEAD` запит, за `Content-Length` і потоком | перевірка лише за `Content-Length` чи лише для Server Function | `body-limit` unit (chunked; шлях `/api/auth/sign-in/email`) |
| Реєстрацію вимкнено; анонімний вхід закрито | `disableSignUp` прибрано; `/sign-in/anonymous` відкрито | `auth-config` unit; `security.spec.ts` |
| Сесія без кешу cookie | `session.cookieCache` увімкнено | `auth-config` unit |
| Межа частоти рахує справжню адресу клієнта | entry не перезаписує `x-simetra-client-ip` | `server-entry` unit; `security.spec.ts` (друга адреса сокета) |
| Текст помилки не йде клієнту | `session-fn` повертає текст помилки | `session-fn` unit |
| `defer` бере `waitUntil` поточного запиту | `defer` захоплює перший запит | `runtime` unit |
| HTML і `get-session` не кешуються | HTML без `Vary: Cookie` чи `no-store` | `security.spec.ts` |
| Dev-шлях ідентичності поза production | `dev-user.mjs` імпортовано з `src/` | `build-content.build.test.ts` |
| Запобіжник `dev-user` читає ознаку рівня бази | запобіжник читає `current_setting` (сесійне `options=-c`) | `dev-user.db.test.ts` |
| Шаблон не залежить від тестових входів | `template/package.json` залежить від `test-host` | `template-tree` unit |
| Секрети не потрапляють у клієнтські асети | DSN чи секрет у `src/` клієнтського коду | `build-content.build.test.ts` (сентинели) |

## Задачі

### Задача 7 — пакети, воркспейс, метадані, межа фреймворку, рівні тестів

Файли: `packages/create-simetra-app/package.json` (`create-simetra-app`,
`private`, скрипти `test:build` і `e2e`, без скрипта `test`, щоб кореневий
`pnpm test` не збирав і не брав стек); `template/package.json`
(`create-simetra-app-template`, `private`; скрипт `test` — лише unit без бази
й збірки, тож його бере кореневий `pnpm test` у job `checks`; `test:db` — DB-проєкт; `better-auth` точним піном `1.7.12`
у групі syncpack з тест-залежністю ПГ-2a; поле `imports` для `#instrument`);
`template/{vite.config.ts,tsconfig.json,vitest.config.ts,simetra.config.ts}`
(vitest-проєкти `unit` і `db`; `db` бере той самий `globalSetup`
`stack-guard.postgres.ts`, що й `simetra`); `template/metadata/**` (`Client`:
`description`, `code`, `country: Ref → Country`, ТЧ `contacts` з `name` і
`phone`; `Country`: `description`, `code`); `template/generated/*.json`;
`template/src/instrument.ts` (чотири обробники без дії, Д-7);
`template/src/objects.ts`; `pnpm-workspace.yaml` (глоб `template`,
override за Д2-3); `.prettierignore` (`generated/`, `routeTree.gen.ts`);
межа фреймворку в `packages/simetra/eslint.tier-zones.js` і
`tier-boundary.test.ts`; `.agents/kit.profile.json` (Д-10: пакет `template` у
`tests.packages` і в `levels.unit.packages`, `levels.db.packages`; рівень `e2e`
додає задача 12). `src/objects.ts` з дескрипторами `simetraApp`
лягає в D3 (T6 дає D1).

Готово: `pnpm -r ls --depth -1` бачить обидва пакети; `run-tests unit
--package template` запускає ≥ 1 тест (негативний контроль — навмисно
червоний тест червонить рівень); межа фреймворку — Start у
`packages/create-simetra-app/src/**` відмова, у `template/**` і `e2e/**`
прохід; `pnpm metadata:check` бачить проєкт шаблону; тест свіжості
(`generated-fresh`) — перегенерація в тимчасову теку дорівнює закоміченому;
тест `template-tree` — дерево `template/` і його `package.json` без
`test-host`, `frame-oracle`, `simetra/data/testing`, `simetra/server/testing`,
червоніє на штучному посиланні. `run-tests unit --filter tier-boundary`,
`run-tests unit --package template`.

### Задача 8 — експорт `checkRequestOrigin` (T3)

`packages/simetra/src/server/index.ts`, `src/server/origin.ts` (JSDoc
англійською). Готово: функція доступна з `simetra/server`; ті самі гілки, що
unit B1b-2, через публічний вхід. `run-tests unit --filter origin`.

### Задача 9 — пули, сесія, `dataFn`, Server Function сесії, `ssrTransport`

`template/src/server/` (`config`, `runtime`, `auth-db`, `auth`, `origin`,
`data-fn`, `session-fn`, `ssr-transport`), `template/src/routes/api/auth/$.ts`.
Форми — за П4-D §4.1–§4.3: `appOrigin()` (канонічний `SIMETRA_APP_ORIGIN`,
інакше виняток старту), `authSecret()` (у production без
`BETTER_AUTH_SECRET` — виняток); `getDataHandler()` — пул на рівні модуля,
рантайм ліниво один раз; `verifySession` за §4.4 профілю (`sub` нижнім
регістром, `is_anonymous` завжди булеве); порт бази йде через
`wrapDatabase` з `#instrument` (шов #210, «Шлях до #210 і #206» файла D1); `httpOrigin(request)`; `dataFn` за
кроками §4.2, підсумкова відповідь іде в `onDataResponse` з `#instrument`;
`getSessionClaims` — на HTTP-шляху першим кроком `checkRequestOrigin`
(відмова — `null` без `getSession`, бо `getSession` може продовжити сесію
записом), далі `null` для відсутньої й анонімної сесії і для винятку (запис
у журнал); `ssrTransport(claims)` під `createServerOnlyFn` з
`{ inProcess: true }`.

Готово (unit з фейками `auth.api.getSession` і обробника): неканонічне
походження (`https://a.test/`, `https://a.test/x`) — виняток; production без
секрету — виняток; `verifySession`: `null`, `isAnonymous` `false`/відсутнє/
`true`; конфіг Better Auth — таблиця §4.3 рядок за рядком (`disableSignUp`,
плагін `anonymous`, `disabledPaths` з `/sign-in/anonymous`, без
`cookieCache`, `baseURL` і `trustedOrigins`, `rateLimit` у базі з правилом
`/sign-in/email`, без `database.schemaName` і пул з `search_path=better_auth`,
`generateId: "uuid"`, cookie, `ipAddressHeaders`); `dataFn`: чужий `Origin`
з дійсною сесією — `forbidden` `origin` і `getSession` не викликано; без
сесії й з анонімною — `unauthenticated` без обробника; обробник бачить лише
`httpOrigin(request)`; `Host` і `X-Forwarded-Host` не впливають; виняток поза
обробником — `command.internal` без тексту; `session-fn` при збої з текстом
хоста й ролі — `null` без тексту; `session-fn` з чужим `Origin` чи
`Sec-Fetch-Site: cross-site` — `null` і `getSession` не викликано; `ssrTransport` у клієнтському середовищі
кидає, на сервері — `{ inProcess: true }`; два послідовні запити — `defer`
кожного у `waitUntil` свого. `run-tests unit --package template`.

### Задача 10 — серверний entry

`template/src/server.ts`, `template/src/server/body-limit.ts`. `limitBody(request, maxBytes)`
і сентинел `BodyTooLarge`; межа — стала T0 межі тіла конверта; кеш і
заголовки §4.4; на виході — `Clear-Site-Data: "cache"`; адреса клієнта за
`SIMETRA_CLIENT_IP_SOURCE` (§4.3). Готово: `Content-Length` = межа —
прохід, межа + 1 — відмова без читання тіла; chunked понад межу — відмова,
у межах — тіло без змін; `Content-Encoding: gzip` — відмова; `GET`/`HEAD` —
без перевірки; шлях не впливає; пряме підключення — адреса сокета; проксі —
значення його заголовка; підроблений клієнтом `x-simetra-client-ip` не
доходить до Better Auth за обох джерел; HTML і неасетні відповіді несуть
заголовки кешу й безпеки §4.4, відповідь `sign-out` — `Clear-Site-Data:
"cache"` (мутація «entry не шле `Clear-Site-Data`» червонить кейс). `run-tests unit --filter body-limit`,
`run-tests unit --filter server-entry`.

### Задача 11 — скрипти бази, `dev-user`, лінт споживача

`template/scripts/{db-setup,dev-user,seed}.mjs`, `template/eslint.config.js`.
`db-setup` — порядок §4.2 профілю; `seed` — кількість параметром (Д-9);
`dev-user` — за П4-D §4.3 «Dev-користувач» (запобіжник рівня бази й loopback
на тому самому `Pool`, що й екземпляр Better Auth з реєстрацією; пароль —
`crypto.randomBytes`, друкується один раз; повторний запуск — новий пароль
через внутрішній адаптер за піном ПГ-2a; маркер `simetra-dev-user-script` для
тесту складу — рядкова стала, яку скрипт використовує, а не коментар, щоб
мініфікація її не прибрала). Лінт — правила П4-D §4.7, кожне з негативним тестом.

Готово: `dev-user.db.test.ts` (тегована база) — відмова без ознаки рівня
бази, з `options=-c simetra.environment=development` у DSN, з не-loopback
хостом; після відмови в `better_auth.user` нового рядка немає; повторний
запуск змінює пароль. `lint-rules` — по негативному кейсу на кожне правило
§4.7. `run-tests db --filter dev-user`, `run-tests unit --filter lint-rules`.

### Задача 12 — безпекові e2e, склад збірки, збірка з tarball-ів

`packages/create-simetra-app/e2e/` (`playwright.config.ts` з `globalSetup`
над `setupFor("postgres")` за Д-10, `retries: 0`, `forbidOnly`; `projects`
з таблиці `{ browser, build }` з одним рядком `chromium` × `production` — шов
#210; `fixtures.ts` за Д2-2, збірку бере з проєкту; `security.spec.ts`; `build-content.build.test.ts`;
`tarball-build.build.test.ts`); `.agents/kit.profile.json` — рівень `e2e`
(Д-10); `.github/workflows/ci.yml` — job `host-template` за Д-11
(`strategy.matrix` з однією ногою — шов #210): `pnpm db:pg:start`,
`pnpm build:packages`, `test:db` шаблону, `test:build`, рівень `e2e`, браузер
Chromium точного піна Playwright з системними залежностями; `BETTER_AUTH_SECRET`
і паролі — випадкові на прогін, без секретів репозиторію; червоне на
`skipped`, `flaky` чи нуль тестів (крок над JSON-звітом Playwright).

Готово:
- `security.spec.ts` на production-збірці — рядки D2 таблиці П4-D §8.3,
  кожен з точним кодом і `reason`; кейси походження несуть дійсний cookie;
  позитивний контроль — `run` того самого походження з сесією `ok`;
- `build-content`: збірка з сентинелами `SIMETRA_RUNTIME_DATABASE_URL`,
  `SIMETRA_AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET` — жодного в
  `.output/public`; у `.output` немає маркера `simetra-dev-user-script`,
  `simetra/server/testing`, `simetra/data/testing`, `countingTransport`,
  `__oracle`; негативний контроль —
  сентинел у `src/` червонить тест;
- `tarball-build`: після `pnpm build:packages` копія `template/` у
  тимчасовій теці з `simetra` з tarball-а збирається на `node-server` (Д-6);
- після прогону на стеку немає об'єктів тегу;
- job `host-template` зелений на draft PR; негативний контроль — навмисний
  `test.skip` червонить job (прибрати до мерджу); час job — у П4-D §8.4.

Команди: `run-tests e2e --filter security` (локально один раз наприкінці);
`test:build` — у CI рівня `e2e`.

### Задачі власника

Немає.

## Підсумок аудиту

Заповнює автор після аудиту.
