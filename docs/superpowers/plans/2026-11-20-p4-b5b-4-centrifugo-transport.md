# П4-B5b, частина 4. Транспорт `simetra/data/centrifugo` і стенд — план імплементації

**Статус:** чернетка на приймання архітекторкою М4 (`m4-simetra-milestone`).
Issue #114. Серія — [частина 1](2026-11-20-p4-b5b-1-rights-snapshot-server.md)
§ «Серія B5b»; рішення інших частин — «1-Р<n>», «3-Р<n>».

- **Анкори після частини 3:** порт `SignalTransport` з `close()` і
  `SignalError.final`, опція рантайму `signals`, `CloseReason`
  `"connection-refused"`. Решта — `main`: стенд `packages/simetra/test/db/signal-stand.ts`
  (`startSignalStand`, `startJwksServer`, `connectSignals`), токени
  `server/signals` (`createCentrifugoTokens`, `SignalTokens`, `ChannelGrant`),
  `CommandRuntime.authorizeChannels`, `centrifuge` 5.8.0 — devDependency
  `packages/simetra`.
- **Спільні ресурси.** Стенд піднімає власний контейнер Centrifugo на
  прогін з тегом (профіль `postgres` §10.4); стеки не зупиняти.
- **Межі серії.** Маршрутів токенів і JWKS host-а, сокета в шаблоні й шини
  вкладок частина не робить — це D5 #122 (рішення 2026-11-18). Браузерний
  e2e М4 — #263.
- **Лише CI.** Повні `unit`, `db`, `db-supabase` — CI на draft PR; job
  `packaging` CI рівня `run-tests` не має — локально лише за червоного job.
  Локально — цільові `run-tests … --filter <файл>`.

## Мета, архітектура, спека

**Мета.** Реалізація порту каналу над SDK `centrifuge`, що її імпортує
споживач з тарбола, і доказ приймача на справжньому Centrifugo. Готово
(рядок B5 §13, частина транспорту): стенд обох профілів — `recovered` після
короткого розриву, нова епоха, відмова токена, «сигнал рівно раз у своєму
скоупі й жодного в чужому»; пакування імпортує `simetra/data/centrifugo`;
Г7 для Centrifugo внесено в §8.6.

**Архітектура.** Вхід `simetra/data/centrifugo` (`src/data/centrifugo/index.ts`)
— єдине місце в `src/data`, що імпортує `centrifuge` (необов'язкова peer).
Фабрика `createCentrifugoTransport(options)` повертає `SignalTransport`;
токени дає host функціями, що звертаються до його endpoint-ів над
`SignalTokens` і `runtime.authorizeChannels` (§8.3): host викликає
`authorizeChannels` заново на кожне поновлення токена (рішення архітекторки
2026-11-19), тож кожне `getToken` SDK і кожне `refreshTokens` проходять
перевірку бази.

**Спека.** П4-B §8.3 «Токени», §8.5, §8.6, §12 (рядок «стенд сигналу»,
пакування), §14.2 Г7; профіль `postgres` §6.1, §6.2, §7, §10.4.

## Глобальні обмеження

- `centrifuge` — `peerDependencies` `^5.8.0` з `peerDependenciesMeta.optional`
  і devDependency `5.8.0`; група syncpack тримає їх разом, як `react`.
- Поведінку SDK (`subscribed` з `recovered`/`wasRecovering`,
  `unsubscribed` з кодом `unauthorized`, `UnauthorizedError` у `getToken`,
  події з'єднання) виконавець бере з опублікованого коду 5.8.0 (`pkg-src`) з
  цитатою файлу й символу в тілі PR, не з пам'яті.
- Наявні `signal-stand.*`, `signal-delivery.*`, `authorize-channels.*` і
  тест пакування лишаються зеленими; зміна очікувань пакування — лише
  додавання нового входу й peer, рядком у тілі PR.

## Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1 | **Опції фабрики**: `{ url, getConnectionToken(): Promise<string>, getChannelToken(channel): Promise<string> }`. Відмову host повідомляє класом `SignalAuthRefused` (експорт входу): з `getChannelToken` — `onError({ kind: "auth", channel })`, без автоповтору; з `getConnectionToken` — `onError({ kind: "auth" })` і один явний `connect()`; друга поспіль без події з'єднання між ними — `onError({ kind: "auth", final: true })` без `connect()`. Лічильник скидає лише подія успішного з'єднання клієнта, не `subscribed` каналу (3-Р1). Будь-який інший збій токена (мережа, 5xx) — `transport`, повтор — backoff SDK | §8.5 — опції реалізації (задача 0) |
| Р2 | **Мапінг подій**: `subscribed` → `onSubscribed({ channel, recovered })`, `recovered` = `true` лише коли SDK відновив з позиції (`wasRecovering && recovered`), інакше `false` (§8.5); `unsubscribed` з кодом `unauthorized` → `auth` каналу; розрив з'єднання → `transport` без каналу, помилка однієї підписки → `transport` з каналом. Відновлені публікації SDK віддає після `subscribed` — приймач (3-Р11) знімає «розрив» після них | немає (§8.5 уже так) |
| Р3 | **`refreshTokens(channels?)`** — перепідписка названих (типово всіх) каналів: у SDK немає примусового поновлення токена підписки (§8.5); кожен дає `onSubscribed` (часто без `recovered`), відмовлений — `auth` і закритий | немає |
| Р4 | **Одна підписка SDK на канал**; `Unsubscribe` знімає лише її; `close()` — `disconnect()` клієнта й зняття всіх підписок; після `close()` жодної події | немає |
| Р5 | **Лінт-зона**: окремий блок `src/data/centrifugo/**` в `eslint.tier-zones.js` дозволяє `centrifuge`; решта `src/data/**` — ні; T5 не імпортує `simetra/data/centrifugo`. Негативні тести — `test/tier-boundary.test.ts` | немає |
| Р6 | **Г7 (§14.2) — вимір на стенді**: токен каналу з годинником порту токенів (`now` у `createCentrifugoTokens`), що спливає через ≈ 5 с; після видалення членства поновлення токена відмовляє (`authorizeChannels` не дає каналу), а підписка без поновлення закривається не пізніше `exp` + `expired_sub_close_delay` (25 с) + `presence_update_interval` (5 с). Тест триває ≈ 40 с — лише в одному кейсі. Конфіг стенду (`signalStandConfig`) нині не має ключів `client.presence_update_interval` і `client.expired_sub_close_delay` — стенд бере їх із тих самих сталих, що генератор `packages/designer/src/tools/signals-config.ts` (одне джерело, без копії чисел). Число й метод — у §8.6 (межа там уже записана як 5 хв 30 с; вимір її підтверджує), рядок Г7 §14.2 закрито | §8.6, §14.2 (задача 0 — текст, задача 4 — число) |
| Р7 | **Стенд приймача — у designer** (`src/__tests__/signal-receiver.*`), бо потрібні розгорнутий проєкт, `runtime.run`, `authorizeChannels` і два рантайми даних двох користувачів; помічники стенду — з `simetra` (як у `signal-delivery.support.ts`) | немає |

## Інтерфейси

| Що | Хто дає | Хто бере |
| --- | --- | --- |
| `simetra/data/centrifugo`: `createCentrifugoTransport`, `SignalAuthRefused` | 4 | host (D5 #122), e2e #263 |
| exports `./data/centrifugo` (обидва блоки), запис `tsdown`, peer `centrifuge` | 4 | пакування, споживач |

## Інваріанти безпеки

| Інваріант | Тест, що червоніє | Мутація словами |
| --- | --- | --- |
| Відмова токена каналу не повторюється | unit над фейковим SDK і стенд: `auth`, жодного нового `getChannelToken` для каналу до наступного `subscribe` від приймача | автоповтор підписки на відмову |
| Підписка без права неможлива | стенд: учасник без `read` на пару — приймач каналу не просить; прямий запит токена — `authorizeChannels` не дає каналу | `getChannelToken` над токеном без `authorizeChannels` |
| Відкликання закриває підписку | стенд: після видалення членства `refreshTokens` — `auth`, дані пари прибрано (`purge`); без поновлення — закриття в межі Р6 | `refreshTokens` без перепідписки |
| Сигнал лише своєму скоупу | стенд: два користувачі двох скоупів, команда в першому — рівно 1 оновлення рядка в першому, 0 запитів у другому | канал без скоупу (будь-який скоуп `scopeSets` іншого користувача) |
| `centrifuge` лише у своєму вході | `tier-boundary.test.ts`: імпорт `centrifuge` з `src/data/store` і з решти `src/data`, `simetra/data/centrifugo` з `src/ui` — лінт червоний | зона без обмеження |
| Друга відмова з'єднання закриває | unit: дві відмови поспіль — `final`, 0 `connect()`; приймач — `connection-refused` | безкінечний `connect()` |

## Задачі

### Задача 0. Анкори й поправки спеки

`orient --plan` на цей файл; поправки П4-B §8.5 (Р1), §8.6/§14.2 — метод
Г7 (Р6, число — задача 4).
Готово: `doc anchors && doc lint` зелені.
Перевірка: `doc anchors && doc lint`, `run-tests unit --changed`.

### Задача 1. Реалізація порту над SDK (Р1–Р4)

Файли: `src/data/centrifugo/index.ts` (нове), unit
`src/data/centrifugo/__tests__/centrifugo.test.ts` над фейковим `Centrifuge`.
Готово: мапінг Р2 подія за подією; 5xx токена — `transport`;
`SignalAuthRefused` — `auth`; `Unsubscribe` одного каналу не чіпає інших;
відмова з'єднання: перша — `auth` і 1 `connect()`, друга поспіль — `final`,
0 `connect()`, подія з'єднання між ними скидає лічильник, `subscribed`
каналу — ні; `refreshTokens` перепідписує й закриває відмовлений; після
`close()` — жодної події.
Після: задача 0. Перевірка: `run-tests unit --filter centrifugo.test.ts`.

### Задача 2. Вхід, пакування, лінт-зона (Р5)

Файли: `packages/simetra/package.json` (обидва блоки `exports`, peer,
`peerDependenciesMeta`), `tsdown.config.ts` (запис `data/centrifugo/index`),
`.syncpackrc.json` (група peer/dev `centrifuge`), `eslint.tier-zones.js`,
`test/tier-boundary.test.ts`,
`packages/designer/test/packaging/published-packages.pack.test.ts`
(перелік exports і peers; імпорт `simetra/data/centrifugo` з тарбола в
споживачі зі встановленим `centrifuge`).
Готово: негативні тести зони червоніють на кожен заборонений імпорт;
`pnpm deps:check` зелений; пак-тест імпортує вхід.
Після: задача 1. Перевірка: `run-tests unit --filter tier-boundary.test.ts`,
`pnpm deps:check`; пакування — job `packaging` CI (рівня в `run-tests`
немає); локально `pnpm build:packages && pnpm test:packaging` лише коли
job червоний.

### Задача 3. Стенд транспорту й приймача (Р7)

Файли: `packages/designer/src/__tests__/signal-receiver.support.ts` (нове),
`signal-receiver.db.test.ts`, `signal-receiver.supabase.db.test.ts`.
`getChannelToken` стенду — `authorizeChannels` + `channelTokens` на кожен
виклик (як host), `getConnectionToken` — `connectionToken` того самого
гранту.
Готово (рядок §12 «стенд сигналу», частина B5): розрив — повторний
`onSubscribed`; короткий розрив з історією — `recovered: true` і пропущені
публікації доходять до приймача; рестарт Centrifugo — `recovered: false` і
перечитування дає правильні значення; відмова токена — `auth` без
автоповтору; рядки 2–4 інваріантів безпеки. Контейнери з тегом прибрано
й на падінні.
Після: задача 2. Перевірка: `run-tests db --filter signal-receiver.db.test.ts`,
`run-tests db-supabase --filter signal-receiver.supabase.db.test.ts`.

### Задача 4. Г7: вимір і число в спеці (Р6)

Файли: кейс у `signal-receiver.support.ts` (з задачі 3); `packages/simetra/test/db/signal-stand.ts`
(`signalStandConfig` — ключі Р6); спека П4-B §8.6, §14.2.
Готово: виміряний час від `exp` до закриття підписки ≤ 30 с на обох
стеках; число й метод записано в §8.6, рядок Г7 §14.2 закрито.
Мутація: конфіг стенду без `presence_update_interval` (типові 27 с) —
кейс червоний.
Після: задача 3. Перевірка: `run-tests db --filter signal-receiver.db.test.ts`.

## Задачі власника

немає

## Підсумок аудиту

(пише авторка після аудиту)
