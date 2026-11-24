# Прототип F0: `oidc-provider` як сервер авторизації агентів у шаблоні host-а

## Про цей документ

- **Питання.** Чи працює `oidc-provider` 9.12.2 у шаблоні host-а як сервер
  авторизації агентів із конфігурацією спеки П4-F §5.4 і яке монтування
  годиться: у сервері Nitro чи окремий слухач Node під тим самим origin.
- **Дата.** 2026-11-24. Версії: `oidc-provider` 9.12.2, `srvx` 1.0.8,
  `better-auth` 1.7.12, `nitro` 3.0.261103-rc, `@tanstack/react-start`
  1.169.5, Postgres 17 (стек `postgres`).
- **Метод.** Прототип у гілці `issue-386-f0-spike` (не зливається): коміти
  `21346bf2` (монтування), `72dbfc87` (міст входу, сховище Postgres, CIMD,
  оновлення), `f621c8fd` і `555aa1fd` (наскрізний тест зібраного сервера,
  тест справжнього транспорту CIMD). Перевірка — curl до зібраного сервера
  (`node .output/server/index.mjs`) і до `vite dev`, unit-тест монтування,
  DB-тести на тегованій базі прогону, зокрема наскрізний тест, що запускає
  зібраний сервер. Код сервера авторизації munin-mcp
  (власник дав його під Apache-2.0) — прецедент і джерело копій.
- **Куди лягли рішення.** Спосіб монтування — [спека
  П4-F](../../superpowers/specs/2026-11-24-p4-f-agents-design.md) §7 OQ-1 і
  §5.4 «Шаблон host-а» (рішення архітектора блоку); вимоги до плану F4 — розділ
  «Що план F4 бере з прототипу» нижче.
- **Статус.** Результат прототипу; рішення про монтування за архітектором блоку (`tooling-architect`).

## Відповідь

Так. `oidc-provider` 9.12.2 працює **всередині сервера шаблону**: entry
Start передає шляхи OAuth обробнику бібліотеки через `toFetchHandler` з
`srvx/node`. Обмеження тіла запиту й заголовки entry лишаються на шляху.
Окремий слухач Node не знадобився. Усі шість критеріїв зелені.

Механізм відрізняється від назви в спеці: не h3 `fromNodeHandler`, а
`toFetchHandler` з `srvx/node` на рівні Fetch-entry. Причина нижче.

## Критерії

| # | Критерій | Результат | Як перевірено |
| --- | --- | --- | --- |
| 1 | Монтування | зелений | curl до зібраного сервера й `vite dev`; наскрізний DB-тест зібраного сервера |
| 2 | Обмеження тіла | зелений | `POST /token` у зібраному сервері: `client_id=nope` → 401 `invalid_client`, повний обмін коду; 5 MiB → 413 від обгортки |
| 3 | Міст входу | зелений | DB-тест, 2 випадки |
| 4 | CIMD, три клієнти | зелений | DB-тест, 3 документи + справжній транспорт |
| 5 | Оновлення | зелений | DB-тест, 3 випадки |
| 6 | Незалежність від сесії | зелений | DB-тест |
| 5а | Оновлення після години (з issue #386, «Готово, коли») | зелений | DB-тест з керованим годинником |

## Монтування

**Ланцюг.** `src/server.ts` прототипу:

```ts
fetch: createEntryFetch(withOauth(createStartHandler(defaultStreamHandler)))
```

`withOauth` віддає шляхи `/.well-known/oauth-authorization-server`,
`/authorize`, `/authorize/:uid`, `/token`, `/revoke`, `/jwks` у
`toFetchHandler(provider.callback())`; решта йде в Start.

**Чому не сирі `req/res`.** У Fetch-entry `request.runtime.node.req/res`
доступні і в dev, і в зібраному сервері. Але `createEntryFetch` спершу робить
копію запиту (адреса клієнта, лічильник тіла), і в копії `runtime` немає.
Сирі `req/res` обійшли б обмеження тіла. `toFetchHandler` будує Node-обгортки
над веб-`Request`, тож тіло читається через лічильник обгортки. Маршрут Nitro
чи проміжну ланку прототип не пробував: шлях через entry зелений і тримає
обгортку.

**Маршрути Start.** У маршруті Start `request.runtime.node` немає (entry
замінив запит). Сторінка взаємодії викликає `interactionDetails(req, res)` і
`interactionResult` усередині `toFetchHandler((req, res) => …)`.
`interactionDetails` перевірено curl у dev і в зібраному сервері;
`interactionResult` через маршрут Start — наскрізним тестом зібраного сервера
нижче. Без cookie взаємодії бібліотека кидає
`SessionNotFound`; його треба ловити.

**curl, зібраний сервер, коміт `21346bf2`** (сховище в пам'яті, статичний
клієнт `probe` за змінною `SIMETRA_OAUTH_PROBE_CLIENT=1`, бо CIMD потребує
https-документа; вивід виконавця прототипу, cookie — `<redacted>`):

```text
GET  /.well-known/oauth-authorization-server   → 200 JSON, issuer http://localhost:3100
GET  /authorize?client_id=probe&…&resource=…/mcp → 303 location: /oauth-probe/<uid>, 4× set-cookie _interaction*
POST /token  code=bogus (form)                 → 400 {"error":"invalid_grant","error_description":"grant request is invalid"}
POST /token  без client_id                     → 400 invalid_request "no client authentication mechanism provided"
POST /revoke client_id=probe&token=bogus       → 200, порожнє тіло
GET  /jwks                                     → 200
GET  /clients (не OAuth)                       → 307 від Start
POST /token  5 MiB                             → 413 {"ok":false,"error":{"code":"command.invalid","reason":"payload-too-large"},…}
```

`vite dev` (той самий коміт): discovery 200, authorize 303, token
`invalid_grant`, revoke 200, jwks 200, 5 MiB → 413.

**Наскрізний тест зібраного сервера, коміт `555aa1fd`**
(`test/oauth-built.db.test.ts`): тест запускає `node .output/server/index.mjs`
на тегованій базі прогону зі сховищем Postgres і клієнтом `probe`; кроки —
справжній HTTP з cookie. Користувача створює окремий екземпляр Better Auth
(реєстрація в зібраному сервері вимкнена); вхід — через HTTP. Вивід кроків
виконавця прототипу:

```text
sign-in: 200
authorize: 303 -> /oauth-probe/<uid>
approve (Start route POST): 200 OK {"redirectTo":".../authorize/<uid>","grantId":"..."}
resume: 303 -> http://127.0.0.1:9/cb
token (code): 200, keys=access_token,expires_in,refresh_token,scope,token_type
token (refresh): 200
revoke: 200
token (refresh after revoke): 400 {"error":"invalid_grant","error_description":"grant request is invalid"}
agent_grants.revoked_at: set
token (client_id=nope): 401 {"error":"invalid_client","error_description":"client authentication failed"}
token (5 MiB): 413
```

Отже, `interactionResult` через маршрут Start завершує взаємодію в зібраному
сервері, а форма `/token` доходить до бібліотеки повз обгортку (401
`invalid_client` на невідомого клієнта відрізняє розібране тіло від
порожнього).

**Заголовки `/token`** (зібраний сервер): `cache-control: no-store`,
`content-security-policy: frame-ancestors 'none'`, `referrer-policy:
same-origin`, `x-content-type-options: nosniff` — від entry;
`access-control-allow-origin: *`, `vary: Origin`,
`access-control-expose-headers: WWW-Authenticate` — від бібліотеки.
Кілька `set-cookie` проходять.

## Критерії 3–6

DB-тести `test/oauth-flows.db.test.ts` і `test/oauth-built.db.test.ts`,
повторний прогін виконавиці блоку на `555aa1fd` після `pnpm build`:

```text
DB run o5a3oo on postgres stack at 555aa1fd, clean tree
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

Тести `oauth-flows` кличуть справжній `withOauth` з веб-`Request`, без
сокета. Сховище — Postgres у схемі
`agent_oauth` тегованої бази прогону; `afterAll` видаляє базу.

- **C3, міст входу.** Анонімна сесія Better Auth (плагін `anonymous`,
  `signInAnonymous`) і запит без сесії: 403 `access_denied`, коду немає,
  рядків `Grant` і `agent_grants` не додано. Справжній користувач:
  `Grant.accountId` і `AccessToken.accountId` дорівнюють id користувача
  Better Auth. Сесія `oidc-provider` знищується після `resume`: тест рахує
  записи моделі `Session`. Мутація (знищення — no-op) валить тест з
  `expected 1 to be 0`.
- **C4, CIMD.** Документи Claude Code, claude.ai і ChatGPT (збережені копії з
  munin-mcp) реєструються як публічні клієнти: код + PKCE S256 → непрозорий
  токен (без крапок), `AccessToken.find().aud` містить ресурс MCP. ChatGPT
  має `jwks_uri` і `private_key_jwt`: лічильник звернень до `jwks.json` — 0.
  Claude Code — `http://localhost:53123/callback` при `http://localhost/callback`
  у документі. Справжній транспорт: `https://127.0.0.1:<port>/cimd.json` і
  `https://localhost:<port>/cimd.json`, де на порту слухає TCP-сервер тесту:
  кожна помилка транспорту — `ForbiddenAddressError`, слухач не прийняв
  жодного з'єднання. Мутація (перевірку адреси вимкнено) червонить тест:
  `expected Set{ 'Error' } to deeply equal Set{ 'ForbiddenAddressError' }`.
  Перша версія тесту (порт 443, де ніхто не слухає) під тією самою мутацією
  лишалась зеленою, тому її переписано.
- **C5, оновлення.** Без `offline_access` (`scope=mcp`) токен оновлення
  видано, оновлення — 200. Два паралельні оновлення одним токеном, бар'єр у
  `beforeConsume` пропускає обидва повз `find` до `consume`
  (`arrived.length === 2`):
  `400 {"error":"invalid_grant",…} | 200 {…}` — рівно одне 200 (21 повтор
  тесту: щоразу одне 200 й одне `invalid_grant`, 14 разів 200/400 і 7 разів
  400/200), `Grant`
  знищено, `agent_grants.revoked_at` задано, токен оновлення переможця —
  `invalid_grant`. Оновлення після години: строк рахує JS (`Date.now()` в
  адаптері), тест зсуває `Date` на 2 год — старий токен доступу зник,
  оновлення 200.
- **C6, незалежність.** `auth.api.signOut` → `getSession` дає `null`;
  оновлення далі 200, `Grant` живий, `revoked_at` порожній.

## Знахідки

1. **Сирітський токен доступу переможця гонки.** Переможець зберігає нові
   токени після того, як переможений відкликав грант. `AccessToken.find`
   знаходить токен переможця далі (`orphan records for grant: 1`). Токен
   мертвий лише тому, що перевірка шукає `Grant` і рядок `agent_grants` — як
   і вимагає порт `VerifyAgentToken` (§5.4). Перевірка гранту в порту —
   обов'язкова, не оптимізація; тест F4 має це закріпити.
2. **Модель `Client` при вимкненій DCR.** Бібліотека кличе адаптер з моделлю
   `Client`; `find` мусить давати `undefined`, інакше `/authorize` — 500.
3. **Кеш CIMD у пам'яті.** Бібліотека кешує клієнта CIMD у процесі: другий
   `/authorize` того самого `client_id` документ не перезавантажує. Тести
   CIMD беруть свіжий провайдер на кожен випадок.
4. **CIMD у 9.12.2** — `features.clientIdMetadataDocument` з
   `ack: "draft-02"`, експериментальна, типово вимкнена; гачки
   `allowFetch` і `allowClient`.
5. **Знищення сесії `oidc-provider`** — проміжна ланка `provider.use`: після
   `next()` на маршруті `resume` кличе `ctx.oidc.session.destroy()`.
6. **Роль бази для `agent_oauth`.** Ролі немає: тест працює під
   суперкористувачем тегованої бази. F4 потребує ролі з доступом лише до
   `agent_oauth` (поряд із `simetra_auth` для `better_auth`).
7. **Вага entry.** `oidc-provider` і `pg` у графі імпорту entry: unit-тест
   `server-startup.test.ts` («imports with a valid environment», межа 5 с)
   на `72dbfc87` і `555aa1fd` падає за тайм-аутом у повному прогоні (1–3 падіння з 3
   прогонів), файл окремо зелений (прогін 6,05 с; на `main` — 4,62 с). F4 має
   вантажити сервер авторизації ліниво або це прийняти явно.
8. **`renderError`.** Типова сторінка помилки бібліотеки пише NOTICE у журнал;
   F4 дає свою.

## Що план F4 бере з прототипу

| Що | Звідки в прототипі | Джерело в munin-mcp |
| --- | --- | --- |
| монтування `withOauth` у Fetch-entry через `toFetchHandler` (`srvx` 1.0.8 точно, прямою залежністю) | `src/server/oauth/mount.ts`, `src/server.ts` | — (munin-mcp монтує на `node:http`) |
| конфігурація провайдера §5.4, політика взаємодії «сторінка на кожен `/authorize`», `loadExistingGrant` лише для щойно завершеної згоди, знищення сесії після `resume` | `src/server/oauth/provider.ts` | `gateway/src/oauth/provider.ts` |
| ключ Ed25519 і kid за RFC 7638 | `src/server/oauth/provider.ts` | `gateway/src/oauth/keys.ts` |
| адаптер Postgres з атомарним `consume`, відкликання гранту однією транзакцією, `agent_grants` | `src/server/oauth/store.ts` | `gateway/src/oauth/adapter.ts`, `revoke.ts` (Kysely → `pg`; рядок позначається, а не видаляється) |
| транспорт CIMD і нормалізація документа (`none`, без `jwks_uri`/`jwks`, `native` для loopback) | `src/server/oauth/safe-fetch.ts` | `gateway/src/oauth/safe-fetch.ts`, `provider.ts` |
| міст входу Better Auth (`getSession` з заголовків Node-запиту, відмова анонімній сесії, `login.accountId`) | `src/server/oauth/interaction.ts`, `src/routes/oauth-probe.$uid.ts` | `gateway/src/oauth/login.ts`, `grants.ts` без пари |
| форми тестів: бар'єр паралельного оновлення, керований годинник, лічильник звернень документа, справжній транспорт на приватну адресу | `test/oauth-flows.db.test.ts` | `gateway/test/oauth-tokens.test.ts`, `oauth-cimd.test.ts` |
| наскрізний тест зібраного сервера (дочірній процес `.output`, тегована база, cookie-jar) | `test/oauth-built.db.test.ts` | — |
| три збережені документи CIMD | `test/fixtures/cimd/*.json` | `gateway/test/fixtures/cimd/*.json` |

Скопійовані файли несуть заголовок джерела й ліцензії за CONTRIBUTING.md;
у munin-mcp немає файлу `LICENSE`, тож заголовок посилається на дозвіл
власника. F4 додає запис у `THIRD_PARTY_NOTICES`.

Поза прототипом лишилось (обсяг F4/F5): закріплення тенанта в токені
(`extraTokenClaims`; тенант у прототипі порожній), зовнішній ключ
`agent_grants.user_id` на користувача Better Auth, POST згоди через маршрут
Start наскрізно, CSRF, порт `VerifyAgentToken` і 401 старих токенів через
нього.
