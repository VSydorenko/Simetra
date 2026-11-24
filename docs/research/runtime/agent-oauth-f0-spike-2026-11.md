# Прототип F0: `oidc-provider` як сервер авторизації агентів у шаблоні host-а

## Про цей документ

- **Питання.** Чи працює `oidc-provider` 9.12.2 у шаблоні host-а як сервер
  авторизації агентів із конфігурацією спеки П4-F §5.4 і яке монтування
  годиться: у сервері Nitro чи окремий слухач Node під тим самим origin.
- **Дата.** 2026-11-24. Версії: `oidc-provider` 9.12.2, `srvx` 1.0.8,
  `better-auth` 1.7.12, `nitro` 3.0.261103-rc, `@tanstack/react-start`
  1.169.5, Postgres 17 (стек `postgres`).
- **Метод.** Прототип у гілці `issue-386-f0-spike` (не зливається): коміти
  `21346bf2` (монтування) і `72dbfc87` (міст входу, сховище Postgres, CIMD,
  оновлення). Перевірка — curl до зібраного сервера (`node
  .output/server/index.mjs`) і до `vite dev`, unit-тест монтування, DB-тести
  критеріїв 3–6 на тегованій базі прогону. Код сервера авторизації munin-mcp
  (власник дав його під Apache-2.0) — прецедент і джерело копій.
- **Куди лягли рішення.** Спосіб монтування — [спека
  П4-F](../../superpowers/specs/2026-11-24-p4-f-agents-design.md) §7 OQ-1 і
  §5.4 «Шаблон host-а» (рішення архітектора); вимоги до плану F4 — розділ
  «Що план F4 бере з прототипу» нижче.
- **Статус.** Результат прототипу; рішення про монтування за архітектором.

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
| 1 | Монтування | зелений | curl до зібраного сервера й `vite dev` |
| 2 | Обмеження тіла | зелений | curl `POST /token`: форма доходить до бібліотеки; 5 MiB → 413 від обгортки |
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
`interactionResult` усередині `toFetchHandler((req, res) => …)` — працює в
dev і в зібраному сервері. Без cookie взаємодії бібліотека кидає
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

**curl, зібраний сервер, коміт `72dbfc87`** (повтор архітектора; сховище
Postgres із недосяжною адресою бази — ті запити, що йдуть у сховище, дають
500, це очікувано):

```text
$ GET /.well-known/oauth-authorization-server
HTTP/1.1 200 OK
{"authorization_endpoint":"http://localhost:3110/authorize",…,"code_challenge_methods_supported":["S256"],"grant_types_supported":["authorization_code","refresh_token"],"issuer":"http://localhost:3110",…}

$ POST /token without client_id (body reaches the library)
{"error":"invalid_request","error_description":"no client authentication mechanism provided"}

$ POST /token, 5 MiB form body (control: wrapper in path)
HTTP/1.1 413
{"ok":false,"error":{"code":"command.invalid","reason":"payload-too-large"},…}
```

Шлях через сховище Postgres перевіряють DB-тести нижче: вони кличуть той
самий `withOauth` з веб-`Request`, без сокета.

**Заголовки `/token`** (зібраний сервер): `cache-control: no-store`,
`content-security-policy: frame-ancestors 'none'`, `referrer-policy:
same-origin`, `x-content-type-options: nosniff` — від entry;
`access-control-allow-origin: *`, `vary: Origin`,
`access-control-expose-headers: WWW-Authenticate` — від бібліотеки.
Кілька `set-cookie` проходять.

## Критерії 3–6

DB-тест `test/oauth-flows.db.test.ts`, прогін архітектора на `72dbfc87`:

```text
DB run xkjn99 on postgres stack at 72dbfc87, clean tree
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Кожен тест іде через справжній `withOauth`. Сховище — Postgres у схемі
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
  у документі. Справжній транспорт: `https://127.0.0.1/cimd.json` і
  `https://localhost/cimd.json` — відмова до взаємодії, 0 звернень.
- **C5, оновлення.** Без `offline_access` (`scope=mcp`) токен оновлення
  видано, оновлення — 200. Два паралельні оновлення одним токеном, бар'єр у
  `beforeConsume` пропускає обидва повз `find` до `consume`
  (`arrived.length === 2`):
  `400 {"error":"invalid_grant",…} | 200 {…}` — рівно одне 200, `Grant`
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
   на `72dbfc87` падає за тайм-аутом у повному прогоні (1–3 падіння з 3
   прогонів), окремо зелений за 6,05 с; на `main` окремо — 4,62 с. F4 має
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
| три збережені документи CIMD | `test/fixtures/cimd/*.json` | `gateway/test/fixtures/cimd/*.json` |

Скопійовані файли несуть заголовок джерела й ліцензії за CONTRIBUTING.md;
у munin-mcp немає файлу `LICENSE`, тож заголовок посилається на дозвіл
власника. F4 додає запис у `THIRD_PARTY_NOTICES`.

Поза прототипом лишилось (обсяг F4/F5): закріплення тенанта в токені
(`extraTokenClaims`; тенант у прототипі порожній), зовнішній ключ
`agent_grants.user_id` на користувача Better Auth, POST згоди через маршрут
Start наскрізно, CSRF, порт `VerifyAgentToken` і 401 старих токенів через
нього.
