# План: F4 — MCP-вхід (#390)

## 1. Заголовок

- **Статус:** на приймання; приймає архітекторка `tooling-architect`. Виконує
  авторка плану після приймання (`agent-kit:execute`) у гілці
  `issue-390-f4-exec`. PR виконання — draft до появи F1 (#387) у `main`; тоді
  `git merge origin/main`, CI, приймання, land (ADR-0105).
- **Опори:** `main` після F1a (#417, поле `pin` у `sessionClaimsSchema`) і F3
  (`AgentToolCatalog`). Джерело копіювання сервера авторизації — коміт
  `555aa1fd` гілки `issue-386-f0-spike` (worktree
  `.worktrees/386-f0-spike`, лише читати; гілка в `main` не зливається) і
  `munin-mcp` `gateway/src/oauth` (`/home/vsydorenko/munin-mcp`, Apache-2.0,
  `LICENSE` на `origin/main`). Розвилки 1–3 вирішила архітекторка 2026-11-25
  (Р-F4-1, Р-F4-2, Р-F4-3).
- **Межі з М4:** не змінювати `packages/simetra/src/data/**`,
  `src/server/runtime.ts`, `src/server/signals/**`; жоден код T4 не читає
  `pin`. `packages/create-simetra-app/template/src/server.ts` — наш. Будь-яка
  зміна `src/server/signals/**` чи `model/runtime/catalog.ts` — розвилка до
  архітекторки до старту. Не чіпати `.github/**`, `AGENTS.md`, `CLAUDE.md`.
- **Спільні ресурси:** стек `postgres` спільний з М4 і М5c. Перед першим
  локальним DB-прогоном — один рядок архітекторці й чекати «ok»; далі лише
  `run-tests db --filter <файл>`. Чужих об'єктів стека не чіпати.
- **Лише CI:** повні рівні `unit`, `db`, `db-supabase`, `e2e`, `packaging`
  (`ci: true` у `.agents/kit.profile.json`). Жодна задача не закінчується
  повним локальним прогоном.

## 2. Мета / Архітектура / Спека

**Мета.** ШІ-клієнт користувача (Claude Code, claude.ai, ChatGPT) підключається
до застосунку з шаблону host-а через OAuth 2.1 і кличе інструменти каталогу
агента F3 через MCP від імені користувача: з claims `{ sub, act.sub, pin }`,
відмовою за замовчуванням і подією виклику на кожен виклик.

**Архітектура.** Дві частини з різною ціною помилки.
*Частина A — платформа.* T0 дає типи портів `VerifyAgentToken` і
`OnAgentCall`. T6 `simetra/shell/mcp` — адаптер над `AgentToolCatalog` і
`createMcpHandler` SDK: `Request` → `Response`, PRM, 401 з `WWW-Authenticate`,
claims агента, подія виклику; стану між запитами немає. SDK імпортує лише
`src/shell/mcp`. Платформа створює схему `agent_oauth` поряд із `better_auth`
(Р-F4-3).
*Частина B — шаблон host-а.* `oidc-provider` у Fetch-entry за способом F0
(лінивий імпорт), сховище Postgres у `agent_oauth`, транспорт CIMD без SSRF,
міст входу Better Auth і API взаємодії для F5, реалізація порту в тому самому
процесі, маршрут `/mcp` і PRM, приймач події.

**Спека.** П4-F §3 (рядки F4, F1a, F5), §4, §5.1, §5.3, §5.4, §6; ADR-0103,
0104, 0105, 0106, 0108; звіт F0
`docs/research/runtime/agent-oauth-f0-spike-2026-11.md`.

## 3. Глобальні обмеження

- Точні піни: `@modelcontextprotocol/server` 2.4.0 (dev-залежність `simetra`,
  залежність шаблону), `@modelcontextprotocol/client` 2.4.0 (dev шаблону),
  `oidc-provider` 9.12.2, `srvx` 1.0.8 (залежності шаблону). Peer `simetra` —
  `@modelcontextprotocol/server` `2.4.0`, `optional: true` (Р-F4-8).
  Оновлення `oidc-provider` — окрема зміна з тестами F4 (CIMD
  експериментальний); запис у `docs/dependency-monitoring.md`.
- Скопійований код — із заголовком CONTRIBUTING.md § «Copying code from other
  projects» (джерело `munin-mcp`, шлях, Apache-2.0, що змінено) і записом у
  `THIRD_PARTY_NOTICES` у тій самій зміні. Заголовок прототипу F0 «the source
  repository has no LICENSE file» застарів — не копіювати.
- Сесійний верифікатор людини, `request-guard`, маршрут сигналів і Server
  Function даних не змінюються (§5.4).
- Повідомлення CLI, HTTP і MCP — англійською; коментарі — українською, «чому».
- Наявні тести зелені без зміни очікувань, зокрема
  `template/test/server-startup.test.ts` з межею 5 с (знахідка 7 F0).

## 4. Рішення

| # | Рішення | Spec impact |
| --- | --- | --- |
| Р-F4-1 | Ключі сервера авторизації (cookie, ключ підпису) — зі змінних середовища; при `NODE_ENV=production` без них шаблон не стартує з діагностикою (навіть коли інші змінні — dev-значення); у dev — ефемерні ключі процесу з `console.warn` (після рестарту клієнт перепідключається). Перевірка — у легкому `config.ts` і `startup-plugin`, а не в модулі сервера авторизації. Рішення архітекторки 2026-11-25. | §5.4, рядок F4 §3 — задача 0 |
| Р-F4-2 | MCP 2026-07-28 плюс stateless-фолбек SDK для ери 2025-11-25 (`createMcpHandler` з `legacy: "stateless"`: без `Mcp-Session-Id`, GET/DELETE — 405); перевірка токена й кожна відмова 401 — на кожному запиті обох ер, тести відмов ганяються на обох. `responseMode: "json"`. Наявність опції — з коду SDK 2.4.0 (`createMcpHandler-*.d.mts`, `legacy?: 'stateless' \| 'reject'`), виконавиця перевіряє її в `index.mjs` піненої версії. Рішення архітекторки 2026-11-25. | §5.4 «Протокол» — задача 0 |
| Р-F4-3 | Схема `agent_oauth` — платформна, як `better_auth`: T2 додає її до `PROVIDER_ASSUMED_SCHEMAS.postgres` (`schema/apply/provider-trigger-boundary.ts`), кластер (`postgres-cluster.ts`) створює її з власником `simetra_auth`, політика рушія designer виключає її (без цього план рушія бачив би схему як дрейф), pgTAP базового стану `postgres` знає її. Профіль `supabase` не змінюється (заморожено, ADR-0117; вхід агентів там відмовляє). Таблиці (`models`, `agent_grants`) створює крок db-setup шаблону від `simetra_auth`. Нової ролі платформи немає. `agent_grants.user_id` — FK на `better_auth."user"` `ON DELETE CASCADE`. Рішення архітекторки 2026-11-25. | §5.4 (хто створює схему); спека профілю `postgres` (таблиця ролей: `simetra_auth` — власник схем `better_auth` і `agent_oauth`) — задача 0 |
| Р-F4-4 | «Застосунок має види скоупу» — `catalog.objects.some(o => o.root !== undefined)` над каталогом рантайму; зміни `model/runtime/catalog.ts` немає. Адаптер вимагає `pin` за цим правилом; сервер авторизації бере той самий прапорець від шаблону (`requiresTenant`), тож тести шаблону з тенантами задають його явно — шаблон видів скоупу не має. Членство в тенанті F4 не перевіряє: закріплення поза скоупами користувача дає порожньо (F1, §5.1), список тенантів — F5. | none |
| Р-F4-5 | Маршрути `/mcp` і PRM (`/.well-known/oauth-protected-resource/mcp`) монтуються у Fetch-entry поряд із сервером авторизації (обидва всередині `createEntryFetch`: межа тіла, адреса клієнта, заголовки), а не маршрутом Start: даних по HTTP шаблон не має (Server Function `dataFn`), а entry не тягне Start на шлях агента. Модулі адаптера й сервера авторизації імпортуються через `await import()` на першому запиті свого шляху. | §5.4 «Маршрут MCP — поряд із наявним маршрутом даних» — уточнення, задача 0 |
| Р-F4-6 | Нормалізація CIMD — як у F0 і `munin-mcp`: метод `none` і видалення `jwks_uri`/`jwks`/`token_endpoint_auth_signing_alg` для кожного прийнятого документа; `application_type: "native"` — лише документу без `application_type`, усі `redirect_uri` якого loopback. Вебклієнт (claude.ai, ChatGPT) native не стає: інакше бібліотека послаблює перевірку `redirect_uri` для https. Документ, що не оголошує `none` і не має його в `token_endpoint_auth_methods_supported`, відхиляється. | §5.4 (рядок про `application_type`) — задача 0 |
| Р-F4-7 | Перевірки `/token` до вживання токена оновлення — у шарі монтування над клоном тіла (після межі тіла entry): `grant_type=refresh_token` з `resource`, відмінним від канонічної адреси MCP, — `invalid_target` без виклику бібліотеки. Приватних внутрішностей бібліотеки (`grantTypeHandlers`, як `tokenGate` у `munin-mcp`) не вживати. | none |
| Р-F4-8 | Peer `@modelcontextprotocol/server` — точна версія `2.4.0`, як у шаблоні: адаптер покладається на опції `createMcpHandler` і ери протоколу конкретної версії; оновлення — разом із тестами адаптера. Для приймання архітекторкою. | none |
| Р-F4-9 | Подія виклику — одна на кожен `tools/call`, що пройшов перевірку токена (успіх, помилка каталогу, виняток → `catalog`-помилка `internal`). Запити з 401 і службові методи (`tools/list`, `initialize`, `server/discover`) події не дають: без особи немає `sub`, а відмови видно в журналі HTTP. Хеш входу — SHA-256 hex канонічного JSON входу (Web Crypto, без Node API в T6). Шаблон без налаштувань пише подію JSON-рядком у stdout за моделлю даних логів OpenTelemetry; зі змінною `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (або `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/logs`) шле OTLP/HTTP JSON через `fetch` без SDK OpenTelemetry; збій експорту не ламає виклику. Для приймання архітекторкою. | none |
| Р-F4-10 | Захист від DNS rebinding (транспорт MCP): запит на `/mcp` із заголовком `Origin`, що не дорівнює origin застосунку, — 403 до перевірки токена. Запит без `Origin` (серверні клієнти) проходить. | none |
| Р-F4-11 | Порт шаблону на кожен запит: `AccessToken.find`, відмова токену з `jkt`/`cnf` (DPoP) і простроченому за тим самим годинником, `Grant.find` з тим самим `clientId` і `accountId`, рядок `agent_grants` гранту не відкликаний і не прострочений, `tenant` рядка дорівнює закріпленню токена, користувач Better Auth є; потім `last_used_at`. Усі строки — один годинник JS (`Date.now()`), тож керований годинник тестів діє на бібліотеку, адаптер сховища й `agent_grants.expires_at` однаково. | none |
| Р-F4-12 | API взаємодії — функції сервера шаблону над `Request` (не екрани): `interactionDetails` (клієнт, хост `client_id`, хост `redirect_uri`, ім'я клієнта з позначкою «вказано клієнтом», `requiresTenant`, токен CSRF), `submitConsent` (тенант, CSRF), `abortInteraction`, `listAgentGrants(userId)`, `revokeAgentGrant(userId, grantId)`. Кожна знаходить взаємодію лише через `interactionDetails(req, res)` (cookie браузера). Токен CSRF — HMAC ключем cookie від `uid` і `jti` взаємодії. URL сторінки взаємодії — `/agent/connect/$uid`; маршрут сторінки й екрани — F5; F4 має лише функції й тестовий помічник `connectAgent`. | none |

## 5. Інтерфейси

| Дає / бере | Що | Форма |
| --- | --- | --- |
| дає (T0, `simetra/model`) | `VerifyAgentToken` | `(token: string, resource: string) => Promise<AgentTokenInfo \| null>`; `AgentTokenInfo` — zod-схема `{ sub, isAnonymous, clientId, aud: string[], pin?: guid }`; адаптер розбирає вихід порту схемою, хибна форма — 401 |
| дає (T0) | `OnAgentCall`, `AgentCallEvent` | `{ time, durationMs, tool, inputHash, status: "ok" \| "error", errorCode?, rows?, sub, actor, pin? }`; значень даних, тексту входу й токенів немає |
| дає (T6, `simetra/shell/mcp`) | `createMcpEntry(options)` | вхід: `catalog: AgentToolCatalog`, `runtimeCatalog`, `resource` (канонічна адреса MCP), `authorizationServer`, `verifyAgentToken`, `onAgentCall`, `appOrigin`; вихід: `{ fetch(request): Promise<Response>, paths }`; профіль `supabase` — виняток на створенні з назвою профілю |
| дає (шаблон) | маршрути сервера авторизації | `/authorize`, `/token`, `/revoke`, `/jwks`, `/.well-known/oauth-authorization-server` (issuer — origin застосунку) |
| дає (шаблон, для F5) | API взаємодії, `agent_grants`, відкликання гранту | Р-F4-12; одна функція відкликання гранту (§5.4) |
| бере (F3) | `AgentToolCatalog` | `tools`, `call(session, name, input)`; `agentResultToMcp`; виняток `call` адаптер ловить сам |
| бере (F1a) | `pin` у `sessionClaimsSchema` | адаптер ставить `pin` лише з порту |

## 6. Інваріанти безпеки

Кожен — тест, що червоніє на дефекті; мутація названа словами.

1. Порт без перевірки `Grant` → сирітський токен переможця гонки оновлень
   (знахідка 1 F0) дає 200 замість 401.
2. Порт без перевірки відкликання `agent_grants` → токен доступу гранту,
   відкликаного екранною функцією чи повторною авторизацією трійки, дає 200.
3. Адаптер без перевірки `aud` → токен іншого ресурсу проходить; без перевірки
   анонімності → анонімний користувач проходить; без вимоги `pin` у застосунку
   з видами скоупу → токен без закріплення проходить. Кожен — на обох ерах
   (Р-F4-2).
4. Порт приймає токен оновлення чи токен із `jkt` як bearer → 200 замість 401.
5. `consume` читанням до запису замість умовного `UPDATE … WHERE consumed_at IS
   NULL` → два паралельні оновлення за бар'єром дають два 200.
6. Відкликання за повторного вживання за (клієнт, користувач) замість гранту →
   грант іншого тенанта того самого клієнта гине.
7. Транспорт CIMD без закріпленого `lookup` чи без відмови RFC 6890 →
   `client_id` з приватною адресою з'єднується (справжній сокет на
   `127.0.0.1`); нормалізація без видалення `jwks_uri` → лічильник звернень
   документа ChatGPT > 0.
8. API взаємодії бере взаємодію за `uid` із запиту, а не за cookie → згода з
   cookie іншого браузера дає грант; POST згоди без токена CSRF чи з токеном
   іншої взаємодії → грант.
9. Без знищення сесії `oidc-provider` після `resume` → другий вхід у тому
   самому браузері дає грант попередньому `accountId`.
10. Анонімна сесія Better Auth на `submitConsent` → грант створено.
11. Перевірка ресурсу на `/token` після бібліотеки (без Р-F4-7) → оновлення з
    чужим `resource` спалює токен, і наступне правильне оновлення — `invalid_grant`.
12. Подія виклику містить значення: вхід із рядком-сторожем → сторож є в
    JSON події.
13. Production без ключів сервера авторизації стартує.
14. Токен агента на маршруті токенів сигналів шаблону дає токен каналу (лише
    тест над `verifySession`, без зміни коду сигналів).
15. `Origin` чужого сайту на `/mcp` проходить до перевірки токена.

## 7. Частини

| Частина | Задачі | Готово, коли |
| --- | --- | --- |
| A. Платформа | 1, 2, 3 | unit адаптера з рядка F4 (401 порту, `aud`, анонімний, без закріплення; `clientId` → `act.sub`; `supabase` на старті); лінт-зона SDK з негативним тестом; DB-тести кластера й плану рушія зелені зі схемою `agent_oauth` |
| B. Шаблон host-а | 4, 5, 6, 7 | тести шаблону з рядка F4; e2e і demo стартують у production із ключами |

Частину A приймають окремо до старту задачі 6: адаптер — межа, якою шаблон
лише користується.

## 8. Задачі

### Задача 1. Порти в T0
`packages/simetra/src/model/runtime/` (новий модуль поряд із `session.ts`),
експорт із `simetra/model`. `AgentTokenInfo`, `VerifyAgentToken`,
`AgentCallEvent`, `OnAgentCall`; JSDoc англійською.
**Готово:** unit схеми `AgentTokenInfo` (порожній `sub`, `aud` не масив, `pin`
не UUID — відмова; зайві поля відкидаються, щоб порт не протягнув claims).
**Команда:** `run-tests unit --changed`.

### Задача 2. Адаптер `simetra/shell/mcp`
`packages/simetra/src/shell/mcp/`; `package.json` (`exports`,
`publishConfig.exports`, peer + `peerDependenciesMeta`, dev-залежність),
`tsdown.config.ts` (entry `shell/mcp/index`), `eslint.tier-zones.js`
(заборона `@modelcontextprotocol/server` у `src/**`, окремий блок дозволу
для `src/shell/mcp/**` за зразком `dataPurity("centrifugo")`),
`test/tier-boundary.test.ts`. Р-F4-2, 4, 5, 8, 9, 10.
**Готово:** unit адаптера на обох ерах: порт `null`, чужий `aud`,
анонімний, без закріплення за наявності видів скоупу — 401 з
`WWW-Authenticate: Bearer resource_metadata="…", scope="mcp"` і без виклику
каталогу; хибна форма виходу порту — 401; `clientId` → `act.sub`, `pin` —
лише з порту, `is_anonymous: false`; `supabase` — виняток на створенні з
назвою профілю; PRM з адресою сервера авторизації; `tools/list` дає
інструменти каталогу з позначками без змін; успіх і помилка — через
`agentResultToMcp`, виняток `call` — помилка з кодом, не 500; одна подія на
`tools/call` з полями §5.4 і без сторожа входу; чужий `Origin` — 403;
лінт-зона: імпорт SDK поза `src/shell/mcp` червоний, усередині — чистий;
`outputSchema` не оголошується, якщо SDK тоді вимагає `structuredContent` і в
`isError` (виконавиця перевіряє в коді 2.4.0, `mcp-*.mjs`).
**Команда:** `run-tests unit --changed`.

### Задача 3. Схема `agent_oauth` у платформі (Р-F4-3)
`packages/simetra/src/schema/apply/provider-trigger-boundary.ts`
(`PROVIDER_ASSUMED_SCHEMAS`), `packages/simetra/src/schema/apply/postgres-cluster.ts`,
`packages/simetra/test/db/pgtap/postgres/stack-base-state.pgtap.sql`,
`packages/designer/src/schema-engine/pg-delta/policy.ts`, їхні тести.
Шлях перевірки: схема з'являється на тегованих базах DB-тестів під час
їхнього прогону; нових ролей немає. Базова база спільного локального стека
отримує схему лише з наступним налаштуванням стека, тож base-state pgTAP
перевіряє CI (кожен шард стартує свій стек); локально його не ганяти, а
архітекторці сказати, що локальний стек після мерджу потребує повторного
налаштування.
**Готово:** DB-тест кластера: схема створена з власником `simetra_auth`,
повторний прогін ідемпотентний; DB-тест плану рушія: таблиця в
`agent_oauth` не дає дрейфу й `DROP`; base-state pgTAP зелений.
**Команда:** `run-tests db --filter <файл тесту кластера>`, `run-tests db
--filter <файл тесту політики>`; повний `db` — CI.

### Задача 4. Сервер авторизації в шаблоні
`packages/create-simetra-app/template/src/server/agent-oauth/` (провайдер,
сховище, транспорт CIMD, ключі), `src/server/config.ts`,
`src/server/startup-plugin.ts`, `src/server.ts`, `template/scripts/db-setup-steps.mjs`
(крок DDL), `package.json`, `eslint.config.js` (`GRANTS` для `pg`),
`THIRD_PARTY_NOTICES`, `docs/dependency-monitoring.md`. Копія з F0 `555aa1fd`
і `munin-mcp` із заголовками; викинути статичний клієнт `probe`,
`/oauth-probe`, похідні від `authSecret()` ключі. Конфіг §5.4 повністю, плюс
`extraTokenClaims` (тенант гранту → `pin`), власний `renderError`,
`interactions.url` Р-F4-12. Р-F4-1, 5, 6, 7, 11.
**Готово:** DB-тести шаблону: три документи CIMD реєструються публічними
клієнтами, `jwks_uri` не завантажується; приватна адреса `client_id`
відхилена справжнім транспортом; `/authorize` без PKCE S256 чи з
`redirect_uri` поза документом — відмова; токен оновлення без
`offline_access`; паралельні оновлення — рівно одне успішне, грант і рядок
`agent_grants` відкликано, кожен токен гранту далі — 401 через порт;
повторне вживання відкликає лише свій грант; після `/revoke` токена доступу
оновлення — `invalid_grant`, рядок відкликано; оновлення на 29-й день
простою працює, на 31-й — `invalid_grant` (керований годинник); оновлення з
чужим `resource` не спалює токена; production без ключів не стартує;
`server-startup.test.ts` зелений без зміни межі.
**Команда:** `run-tests db --filter template/test/agent-oauth-*.db.test.ts`
(після «ok» архітекторки), `run-tests unit --changed`.

### Задача 5. Міст входу й API взаємодії
`template/src/server/agent-oauth/interaction.ts`, тестовий помічник
`template/test/agent-oauth-helpers.ts`. Р-F4-12.
**Готово:** DB-тести: анонімна сесія гранту не отримує; `submitConsent` без
тенанта за `requiresTenant` — гранту немає, з тенантом без `requiresTenant` —
відмова; повторна авторизація трійки відкликає попередній грант, старий токен
доступу — 401; `revokeAgentGrant` відкликає грант пари, інші живуть, старий
токен — 401; згода з cookie іншого браузера чи без CSRF — гранту немає;
вихід із сесії Better Auth не обриває підключення, оновлення працює; сесія
`oidc-provider` знищена після `resume`.
**Команда:** `run-tests db --filter template/test/agent-oauth-interaction.db.test.ts`.

### Задача 6. Порт, маршрут MCP і приймач події
`template/src/server/agent-oauth/verify-token.ts`, `src/server/agent-entry.ts`
(монтування `createMcpEntry` лінивим імпортом), приймач події поряд з
`src/instrument.ts`. Р-F4-5, 9, 10, 11. Після приймання частини A.
**Готово:** DB-тести на обох ерах: токен оновлення, токен іншого ресурсу,
токен з `jkt` як bearer — 401; виклик MCP оновлює `last_used_at`; виклик
`describe` клієнтом MCP SDK (`StreamableHTTPClientTransport` з `fetch` на
entry в процесі) з грантом від `connectAgent`; кожен виклик дає одну подію
§5.4 без значень даних і тексту входу (stdout JSON; OTLP — unit над
локальним HTTP-сервером); токен агента на маршруті токенів сигналів шаблону —
відмова.
**Команда:** `run-tests db --filter template/test/agent-entry.db.test.ts`,
`run-tests unit --changed`.

### Задача 7. Ключі на стендах production
`packages/create-simetra-app/e2e/fixtures.ts`, `packages/create-simetra-app/scripts/lib/demo.mts`,
`packages/create-simetra-app/scripts/lib/app-database.mts`, `packages/create-simetra-app/e2e/build-content.build.test.ts` (сторожі
секретів збірки: ключі сервера авторизації не потрапляють у збірку), DDL
`agent_oauth` на базах стендів.
**Готово:** e2e і demo стартують у production з ключами; тест вмісту збірки
знає нові змінні; `run-tests unit --changed` зелений; повний `e2e` — CI.
**Команда:** `run-tests unit --changed`; `run-tests e2e` — лише CI.

## 9. Задача 0

- `orient --plan` і `doc anchors` плану; дельти — сюди.
- Поправки спеки П4-F: §5.4 — ключі в production (Р-F4-1), «Протокол»
  (Р-F4-2), хто створює схему (Р-F4-3), маршрут MCP у Fetch-entry (Р-F4-5),
  `application_type` лише для loopback (Р-F4-6); §3 рядок F4 — «у
  production» в пункті про ключі.

**Після F1.** Жоден пункт «Готово» рядка F4 не залежить від SQL F1: адаптер
лише кладе `pin` у claims, а звуження перевіряють F1 і F6. F1 — умова
мерджу PR виконання (ADR-0105), не тесту.

## 10. Задачі власника

none

## 11. Підсумок аудиту

(після аудиту)
