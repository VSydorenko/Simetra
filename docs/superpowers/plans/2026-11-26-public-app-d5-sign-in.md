# План D5 М5d: способи входу й самореєстрація

> **Статус:** план на приймання архітекторкою М5d (`SimplyCMS-architect`).
> Блок — #443. Анкери — на `main` (`bc3b2678`); незмерджених залежностей немає.
> Профіль — лише `postgres` (ADR-0117): жодного `*.supabase.db.test.ts`.
> Спільний ресурс — стенди пулу `postgres`: не зупиняти й не перезапускати чужий
> стек; прогін `db` — по одному на стек. Рівні `unit`, `db` і `e2e` CI запускає на
> кожен push чорнового PR; гейт складу збірки (`test:build` пакета
> `create-simetra-app`) і e2e Playwright — лише в job `host-template` CI. Локально
> — лише цільові форми задач; жодна задача не закінчується повним рівнем.
> **Паралельні гілки.** F4 (#426, пауза) змінює адитивно `template/src/server/config.ts`,
> `template/src/server.ts`, `template/src/server/startup-plugin.ts`,
> `template/scripts/db-setup-steps.mjs` і `packages/create-simetra-app/scripts/lib/app-database.mts`. B2 М5c
> (#448) згодом змінить `model/schemas/project.ts`, `compiler/diagnostics.ts`,
> `compiler/messages.ts`, `compiler/pipeline.ts`. Правки D5 у цих файлах —
> адитивні; конфлікт — один рядок архітекторці.

## 1. Мета, архітектура, спека

**Мета.** Застосунок обирає способи входу й режим реєстрації налаштуванням host-а:
пароль, код з email, OAuth. Самореєстрація — лише кодом чи OAuth з перевіреним
email, лише коли метадані проєкту оголошують `selfSignUp`. Клієнт застосунку —
роль рівня `everyUser` з обсягом `own`, без призначень.

**Архітектура.** Платформа (T0, T1) дає лише прапорець `selfSignUp`, його копію в
каталозі рантайму й попередження компілятора. Усе про вхід — у шаблоні host-а:
налаштування з env у `config.ts`, таблиця опцій у `authOptions`
(`template/src/server/auth.ts`), штатний плагін `emailOTP` `better-auth@1.7.12`, один
власний шматок — слот надсилання в `hooks.before`. Пошта — порт `MailTransport`
з одним швом застосунку (`appMailTransport`). Власного плагіна входу немає.

**Спека.** [публічна частина](../specs/2026-11-25-public-app-part-design.md) §3
(рядок D5), §4 (рядки D5), §5.5, §6 («Самореєстрація», «Код з email»,
«Секрети»), §8 (рядки П2 і П4-D для D5). ADR-0122, ADR-0118, ADR-0047.
[П4-D](../specs/2026-11-08-p4-d-hosts-design.md) Дх4, §4.3, §8.3.

## 2. Глобальні обмеження

- Пін `better-auth@1.7.12` не змінюється. Поведінку бібліотеки, на яку спирається
  задача, цитуємо файлом і символом опублікованого коду (`pkg-src`), а не
  документацією.
- Штатна функція бібліотеки не замінюється власним кодом. Власний код — лише слот
  надсилання (Р-D5-6) і перелік шляхів (Р-D5-7). Повторні major у зоні входу —
  спершу перелік НАШИХ вимог, що їх дають, і розвилка архітекторці.
- Кожен новий код правила компілятора — у `COMPILER_RULES` і `WARNING_RULES`
  (`compiler/diagnostics.ts`) з повідомленням `uk`/`en` у `compiler/messages.ts`.
- Секрети OAuth і транспорту — лише з env на сервері (`requiredEnv`); жодного
  значення секрету в повідомленні помилки.
- DB-тест лишає стенд чистим: база прогону з тегом (`test/db/connection.ts`).
- Наявні тести лишаються зеленими; `PUBLIC_PATHS` і публічні маршрути — D3, не D5.

## 3. Рішення

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р-D5-1 | **Налаштування host-а — env, розбирає `config.ts`** (функція на кшталт `authSettings()`, читається під час виклику, як `signalsConfig`). `SIMETRA_SIGN_UP`: `closed` (типово) чи `open`. `SIMETRA_SIGN_IN_METHODS`: перелік через кому з `password`, `email-code` і ідентифікаторів провайдерів OAuth; типово `password`. Провайдер `<id>` бере `SIMETRA_OAUTH_<ID>_CLIENT_ID` і `SIMETRA_OAUTH_<ID>_CLIENT_SECRET` через `requiredEnv`. Перелік провайдерів шаблону — стала в `config.ts` (`google`, `github`); застосунок розширює її. Невідоме значення, порожній перелік чи провайдер без пари змінних — відмова старту. | П4-D §4.3 — рядки таблиці (задача 0) |
| Р-D5-2 | **Відмови старту** — у `startupPlugin` і на верхньому рівні `src/server.ts`, як `appOrigin`/`authSecret` (обидва місця потрібні: коментар `startup-plugin.ts`). (а) `signUp: "open"`, а `runtimeCatalog.selfSignUp` немає; (б) `email-code` увімкнено, `NODE_ENV=production`, а `appMailTransport()` дає `undefined`; (в) хибне значення Р-D5-1. | П4-D §4.1 (задача 0) |
| Р-D5-3 | **Таблиця опцій `authOptions`.** `emailAndPassword: { enabled: <password>, disableSignUp: true, requireEmailVerification: true }` за будь-якого `signUp`; `emailVerification.sendVerificationEmail` не задається, тож вхід паролем на запис з `emailVerified: false` — `403` (`signInEmail`, `api/routes/sign-in.mjs`). Інакше вхід старим паролем, що прочитав запис до `revokeUnprovenAccountAccess`, відкрив би сесію після її очищення (знахідка Codex); усі записи D5 перевірені (Р-D5-11), тож законного входу це не забирає. `emailOTP` — лише з `email-code`: `disableSignUp: signUp === "closed"`, `allowedAttempts: 5`, `expiresIn: 600`, `storeOTP: { hash }` (Р-D5-4), `rateLimit: { window: 60, max: 3 }` (за IP, `createRateLimitKey` — `${ip}\|${path}`), `sendVerificationOTP` — через порт пошти. Кожен провайдер: `{ clientId, clientSecret, disableSignUp: signUp === "closed" }` у самих опціях провайдера — колбек читає лише `provider.options?.disableSignUp` (`api/routes/callback.mjs`); `disableImplicitSignUp` не вживається: його знімає `requestSignUp` клієнта (`api/routes/sign-in.mjs`). `account.accountLinking` не задається: `requireLocalEmailVerified` типово `true` (`oauth2/link-account.mjs`), `trustedProviders` немає. `user.validateUserInfo` відмовляє створенню запису з `emailVerified !== true` для будь-якого способу (виклик у `createUser`, `db/internal-adapter.mjs`; `utils/validate-user-info.mjs`): серед шляхів екземпляра застосунку лише вхід кодом і OAuth створюють запис, а анонімний і `/sign-up/email` закрито. `advanced.backgroundTasks.handler` — `defer` шаблону (`template/src/server/runtime.ts`; споживач `runInBackgroundOrAwait`, `context/create-context.mjs`). Решта рядків наявної таблиці — без змін. | П4-D §4.3 (задача 0) |
| Р-D5-4 | **Код у сховищі — ключований хеш** (розвилка прийнята архітекторкою): штатна опція `storeOTP: { hash }` (`plugins/email-otp/otp-token.mjs` `storeOTP`, `verifyStoredOTP`) з HMAC-SHA-256 коду з префіксом призначення (`email-otp:`; той самий секрет підписує cookie) на секреті auth, що вже приходить в `authOptions`; без солі, порівняння — штатне `constantTimeEqual`. Без секрету (лише поза production: `authSecret`) ключ — стала розробки в `auth.ts`. Причина: `"hashed"` — несолений SHA-256 (`defaultKeyHasher`), 6 цифр відновлюються з дампу перебором 10^6. Зміна секрету анулює активні коди (строк 600 с). | спека §5.5, §6; ADR-0122 п. 8 — рядок `Amended 2026-11-26: …` (задача 0) |
| Р-D5-5 | **Порт пошти й шов** (розвилка прийнята). `MailTransport { send(message: { to, subject, text }): Promise<void> }` і `appMailTransport(): MailTransport \| undefined` — модуль застосунку `template/src/server/mail.ts`; у шаблоні повертає `undefined`. Транспорт розробки (лист у журнал процесу) — окремий модуль, вживається лише поза production. У `src/**` шаблону немає гілки за `NODE_ENV` чи прапорцем тесту, що вмикає захоплювач. Захоплювач e2e — `e2e/mail-capture.ts` (лист у файл прогону, маркер-стала, як `DEV_USER_MARKER`); збірка D7 — копія шаблону (`copyTemplate`, `e2e/template-copy.ts`) з `src/server/mail.ts`, заміненим модулем, що повертає захоплювач. Демо й e2e D5 ідуть без `email-code`. | спека §5.5 — речення про шов (задача 0) |
| Р-D5-6 | **Слот надсилання** — `hooks.before` (`createAuthMiddleware`) лише для `ctx.path === "/email-otp/send-verification-otp"`. Хук бачить тіло до валідації (`runBeforeHooks` до `endpoint(...)`, `api/dispatch.mjs`), тож до транзакції сам відмовляє `400` на `email` не рядком, на адресу, яку не приймає та сама перевірка маршруту (`z.email()` після `toLowerCase()`, `routes.mjs` `sendVerificationOTP`), на адресу довшу за межу (254 символи), і на `type !== "sign-in"`: інакше сміттєва адреса лишала б денний маркер на 24 год, а надмірний ключ — `500` замість однакової відмови. Ключ — `toOTPIdentifier("sign-in", email.toLowerCase())` (`plugins/email-otp/utils.mjs`; маршрут теж знижує регістр, `routes.mjs` `sendVerificationOTP`). Транзакція — власна, на тому самому `Pool`, що й `database` Better Auth: адаптер транзакції Better Auth не дає сирого SQL (`@better-auth/kysely-adapter`, обгортка `transaction`). У ній `pg_advisory_xact_lock(hashtext(<ключ>))`, читання й запис маркерів `otp-slot:<ключ>` і `otp-day:<ключ>` у `better_auth.verification` (§5.5), `COMMIT` до виходу з хука: слот береться до ротації коду. Відмова — `APIError` `429`, однакова для будь-якої адреси; користувача хук не шукає. Час — з годинника, переданого в налаштування (`now`, типово `() => new Date()`): термін коду плагін теж рахує годинником JS. | none (§5.5 це вимагає) |
| Р-D5-7 | **Перелік шляхів.** Стала відкритих шляхів §5.5 і стала `:`-шляхів (`/callback/:id`, `/reset-password/:token`) — в `auth.ts`. `disabledPaths` = шляхи пробного екземпляра `betterAuth(<ті самі опції без disabledPaths>).api` (`api[key].path`, `api/to-auth-endpoints.mjs`; серверні без `path` відкидаються) мінус відкриті й `:`-шляхи. Порівняння — точний рядок нормалізованого шляху (`router.onRequest`, `api/index.mjs`; `normalizePathname` у `@better-auth/core` `utils/url.mjs` знімає кінцевий `/`; маршрутизатор `rou3` регістрочутливий), тож закритий шлях іншим написанням не відкривається; `:`-шляхи порівнянням не закриваються (§5.5). | none |
| Р-D5-8 | **`selfSignUp`** — `z.boolean()` з типовим `false` у `projectSchema` (`model/schemas/project.ts`); у каталог рантайму — `selfSignUp: z.literal(true).optional()` (`runtimeCatalogSchema`, `model/runtime/catalog.ts`), копіює `buildRuntimeCatalog` (`compiler/runtime-catalog.ts`), як `rightsSnapshot`. JSON Schema `packages/simetra/schemas/project.schema.json` — перегенерувати (`compiler/json-schema.ts`). | П2 §3 «Файли» (задача 0) |
| Р-D5-9 | **Попередження `project.self-sign-up`** (рішення архітекторки за розвилкою). Лише при `selfSignUp: true`; файл `project.meta.json`, покажчик `/selfSignUp`; параметри — об'єкти з `publicRead` ролі `authenticated` і ролі рівня `everyUser` з їхніми грантами. Роль `publicRead` читає одна функція над скомпільованим `Contracts.access[].publicRead` (`compiler/contracts.ts`), а не рядкова форма метаданих: призначення зберігаються як `RequestRolePurpose[]` (`PUBLIC_READ_PURPOSES`, `model/schemas/public-read.ts`), і `anon` дає `["anonymous", "user"]` (`publicReadPurposes`, `compiler/access-units.ts`), тож роль `authenticated` — рівно `["user"]`, а не «містить `user`». Та сама функція вже потрібна каталогу рантайму (`publicReadOf`, `compiler/runtime-catalog.ts`) — одна спільна, а не друга копія. Рівень — `RoleContract.assignedOn.level === "everyUser"` (`CompiledRoleLevel`). Місце — у `compiler/pipeline.ts` після `accessContracts(...)` (контракту доступу на місці `scopeKindUnreadWarnings` ще немає), на шляху, що доходить до результату без раннього повернення. Попередження компіляції не зупиняє (`formatDiagnostics` рахує лише `error`). | П2 — діагностика (задача 0) |
| Р-D5-10 | **Шаблон:** `ClientOwner` — `assignedOn: "everyUser"`, грант `Client` `read`/`create`/`update` `own` лишається, грант `Country` `read` `any` прибирається (`levelAllowsExtent`, `compiler/rights/expand.ts`, його не дозволяє); `Country` — `publicRead: "authenticated"`; `project.meta.json` шаблону — `selfSignUp: true` (на приймання: шаблон — застосунок з клієнтами, і D7 вмикає `open`; host типово `closed`). `assignClientOwner` прибирається разом з викликами в `createDemo` (`packages/create-simetra-app/scripts/lib/demo.mts`) і `bringUp` (`e2e/fixtures.ts`) — інших викликів немає (`orient assignClientOwner`). | none (§5.5) |
| Р-D5-11 | **Записи скриптів** — `createDevUser` (`template/scripts/dev-user.mjs`) ставить `emailVerified: true` на обох гілках (новий запис і зміна пароля) через `internalAdapter.updateUser`: `signUpEmail` завжди пише `false` (`api/routes/sign-up.mjs`). Гілка зміни пароля ще й видаляє сесії користувача (`internalAdapter.deleteUserSessions`): після позначки перевіреним вхід кодом уже не кличе `revokeUnprovenAccountAccess`, тож старий доступ відкликає сам скрипт. Демо й e2e створюють користувачів лише цим скриптом. Конфіг скрипта (`authSchemaOptions`, `template/scripts/auth-options.mjs`) і тестовий (`packages/simetra/test/db/better-auth.ts`) несуть той самий набір плагінів, що `authOptions` (`anonymous`, `emailOTP`); `validateUserInfo` у скрипт не йде. `emailOTP` таблиць не додає, тож тест форми схеми рівності не ловить — окремий тест порівнює ідентифікатори плагінів. | none |
| Р-D5-12 | **Екран входу.** Маршрут `/login` бере способи з серверної функції, що повертає лише `{ password, emailCode, providers: id[] }` (без секретів). Вигляд: форма пароля, код у два кроки (адреса, код), кнопки провайдерів. Дії — у `template/src/session-actions.ts`: запит коду, вхід кодом, вхід провайдером; успіх коду — той самий шлях заміни рантайму, що й пароль (`signIn`). | none |

## 4. Інтерфейси

| Інтерфейс | Дає / бере | Споживач |
| --- | --- | --- |
| `selfSignUp` у `projectSchema` і каталозі рантайму; попередження `project.self-sign-up` | дає | D7 |
| env Р-D5-1, відмови старту Р-D5-2 | дає | D7 |
| `MailTransport`, `appMailTransport`, захоплювач `e2e/mail-capture.ts` і спосіб збірки з ним (Р-D5-5) | дає | D7 |
| `ClientOwner` рівня `everyUser`, `Country` з `publicRead: "authenticated"` | дає | D7 |
| вміст сторінки `/login`; оголошення маршруту публічним | дає вміст / бере оголошення | D3 |
| **Для D1:** умовна форма `publicRead` лягає в те саме поле `Contracts.access[].publicRead`; тоді попередження Р-D5-9 перелічує її без зміни коду D5. Рядок тесту «умовна форма в переліку» — у done-when блоку, що злиється другим | бере | D1 |

## 5. Безпекові інваріанти

Кожен — з тестом, що червоніє на мутації (слова, не код).

| # | Інваріант | Мутація → червоний тест |
| --- | --- | --- |
| І-1 | Пароль ніколи не реєструє; код і кожен провайдер беруть `disableSignUp` зі `signUp` | прапорець прибрано на одному способі (кожен окремо) → таблиця опцій |
| І-2 | Слот береться до ротації коду й без пошуку користувача | слот у `hooks.after`; слот лише для наявної адреси → DB-тест слота (код першого листа чинний; однакова відповідь) |
| І-3 | Слот рахує лише власний маркер; прибирання Better Auth (`findVerificationValue` видаляє всі прострочені рядки `verification`, `db/internal-adapter.mjs`) денної стелі не стирає | денний лічильник у маркері слота → 21-й код проходить. Тест ставить годинник у минуле реального часу, щоб маркери слота справді прострочилися й прибирання їх стерло |
| І-4 | Замок `hashtext` лише впорядковує: колізія не зливає двох адрес, бо маркери ключовані повним ідентифікатором | маркер ключовано хешем → дві адреси з одним `hashtext` ділять слот (тест підбирає пару з тим самим `hashtext` запитом до бази) |
| І-5 | Паралельні запити коду на адресу — рівно одне надсилання | замок прибрано → більше одного листа |
| І-6 | Код у сховищі — ключований хеш | `"hashed"` замість `{ hash }` → рядок `verification` містить несолений SHA-256 коду |
| І-7 | Кожен шлях поза переліком — 404; відкриті й `:`-шляхи збігаються із закріпленими | шлях додано у відкриті без тесту; `disabledPaths` лише зі сталих → новий шлях пробного екземпляра відкритий |
| І-8 | Запис з `emailVerified: false` не створюється жодним способом екземпляра застосунку й не входить паролем | `validateUserInfo` прибрано → OAuth з `emailVerified: false` створює запис; `requireEmailVerification` прибрано → неперевірений запис входить паролем |
| І-9 | Відкрита реєстрація — лише з `selfSignUp` | перевірку старту прибрано → `open` без оголошення стартує |
| І-10 | У стандартній збірці немає захоплювача пошти | захоплювач імпортовано в шаблон → гейт складу збірки |
| І-11 | Клієнт застосунку бачить і змінює лише свої рядки | предикат `own` без умови власника → чужий рядок видно |

## 6. Частини

| Частина | Задачі | Готово, коли |
| --- | --- | --- |
| А. Платформа (T0, T1) | 1, 2 | unit-тести задач 1–2 зелені; `pnpm metadata:check` шаблону зелений з попередженням |
| Б. Вхід host-а | 3–7 | unit- і DB-тести задач 3–7 зелені, мутації І-1…І-9 червоні |
| В. Метадані шаблону, демо, e2e, екран | 8–10 | `e2e/signals.spec.ts` і гейт складу збірки зелені в CI; I-10, I-11 червоні на мутаціях |

**Відповідність рядку D5 §3** (кожна фраза done-when → задача → тест):

| Фраза §3 | Задача | Тест (рівень) |
| --- | --- | --- |
| тест таблиці опцій, мутація «прапорець прибрано на одному способі» | 4 | `template/test/auth-config.test.ts` (unit) |
| старт з `open` без `selfSignUp` — відмова | 3 | `startup-plugin.test.ts`, `server-startup.test.ts` (unit) |
| компілятор при `selfSignUp` перелічує `publicRead` `authenticated`, зокрема умовні, і гранти `everyUser` | 2 | тест попередження (unit); умовна форма — блок, що злиється другим (§4) |
| вхід кодом нової адреси при `open` — користувач, провізія й права `everyUser` в одній транзакції | 6 | `template/test/self-sign-up.db.test.ts` (db) |
| при `closed` нова адреса — ні запису, ні листа | 6 | те саме |
| відповідь на запит коду однакова для наявної й невідомої | 5 | `template/test/sign-in-code.db.test.ts` (db) |
| код у сховищі — лише хеш | 5 | те саме, І-6 |
| шоста спроба — відмова | 5 | те саме |
| ліміт на адресу з різних IP | 5 | те саме |
| з паралельних запитів — рівно один | 5 | те саме, І-5 |
| повтор раніше 60 с, інший регістр — відмова; код першого листа чинний; мутація «слот після ротації» | 5 | те саме, І-2 |
| `email` не рядком — відмова | 5 | те саме |
| 21-й код за добу — відмова; денна стеля після чужого входу кодом | 5 | те саме, І-3 |
| `type` не `sign-in` — відмова | 5 | те саме |
| відкриті й `:`-шляхи збігаються з переліком, решта — 404 | 4 | `auth-config.test.ts` (unit) або DB-файл задачі 5, якщо пробному екземпляру потрібна база |
| запис скрипта після входу кодом зберігає пароль | 6, 7 | `self-sign-up.db.test.ts`; `dev-user.db.test.ts` |
| вхід кодом на неперевірений запис прибирає облікові записи й сесії | 6 | `self-sign-up.db.test.ts` |
| OAuth з `emailVerified: false` запису не створює; провайдер `false` і неперевірений запис не зв'язуються | 6 | те саме |
| клієнт читає й змінює свої рядки й не бачить чужих, мутація «`own` без умови власника» | 6 | те саме, І-11 |
| у production-збірці немає тестового транспорту; без продакшн-транспорту — відмова старту | 3, 9 | `startup-plugin.test.ts` (unit); `e2e/build-content.build.test.ts` (CI) |
| `e2e/signals.spec.ts` зелений | 8 | e2e (CI) |

## 7. Задачі

### Задача 0. Анкери й правки спек

`orient --plan` і `doc anchors` цього плану; розбіжності — виправити в плані.
Правки (кожна — з рішенням, що її вимагає):
- спека публічної частини §5.5 — ключований хеш замість `hashed` (Р-D5-4), речення
  про шов `appMailTransport` і збірку D7 з підміненим модулем (Р-D5-5); §6 —
  «ключований хеш (HMAC на секреті auth)», рядок «зміна секрету анулює активні
  коди»; межа перебору — «≤ 100 спроб у вікні 24 год від першого коду; будь-які
  24 год — ≤ 200» (вікно денного маркера прив'язане до першого коду, §5.5);
- ADR-0122 п. 8 — правка на місці й рядок `Amended 2026-11-26: keyed hash
  (HMAC-SHA-256 on the auth secret) instead of plain SHA-256 — reason: …`, без
  нового ADR;
- П4-D Дх4 (реєстрація — за `signUp`, пароль ніколи; записи скрипта з
  `emailVerified: true`), §4.1 (відмови Р-D5-2), §4.3 (рядки таблиці Р-D5-1, Р-D5-3,
  Р-D5-6, Р-D5-7), §8.3 (рядок захоплювача в гейті складу збірки);
- П2 §3 «Файли» — `selfSignUp` у `project.meta.json` і попередження
  `project.self-sign-up` (Р-D5-8, Р-D5-9).

Готово, коли: `doc anchors` і `doc lint` чисті для змінених файлів.

### Задача 1. `selfSignUp` у T0 і каталозі рантайму (Р-D5-8)

Файли: `model/schemas/project.ts`, `model/runtime/catalog.ts`,
`compiler/runtime-catalog.ts`, `packages/simetra/schemas/project.schema.json`, тест
схеми проєкту, `test/field-ratchet.test.ts` (поле має споживача — каталог).
Готово, коли: одна таблична перевірка схеми приймає `true`/`false`/відсутнє й
відмовляє не-булевому; каталог рантайму несе `selfSignUp: true` лише при `true`;
ратчет полів зелений. Після: задача 0.
Перевірка: `run-tests unit --changed`.

### Задача 2. Попередження самореєстрації (Р-D5-9)

Файли: новий модуль у `compiler/rights/` поруч зі `scope-kind-warnings.ts`,
`compiler/pipeline.ts`, `compiler/diagnostics.ts`, `compiler/messages.ts`.
Готово, коли: unit-тест на фікстурі з об'єктом `publicRead: "authenticated"`, об'єктом
`publicRead: "anon"` і роллю `everyUser`: при `selfSignUp` попередження перелічує
перший об'єкт і роль з грантами, не перелічує `anon`-об'єкта; без `selfSignUp` —
жодного. Мутації «гранти `everyUser` пропущено» і «роль `publicRead` з рядкової
форми, а не з контракту» червоні (друга — фікстура, де форма метаданих і контракт
різняться, якщо компілятор таку дає; інакше мутацію не вимагати й сказати чому).
Після: 1. Перевірка: `run-tests unit --changed`.

### Задача 3. Налаштування, порт пошти, відмови старту (Р-D5-1, Р-D5-2, Р-D5-5)

Файли: `template/src/server/config.ts`, `template/src/server/mail.ts`, модуль
транспорту розробки, `template/src/server/startup-plugin.ts`, `template/src/server.ts`;
тести `config.test.ts`, `startup-plugin.test.ts`, `server-startup.test.ts`.
Готово, коли: таблична перевірка розбору env (типові значення, кожне хибне —
відмова з ім'ям змінної, без значення секрету); відмови Р-D5-2 (а), (б) — в обох
місцях старту, мутація «перевірку прибрано» червона для кожної (І-9); транспорт
розробки поза production пише лист у журнал. Після: задача 0.
Перевірка: `run-tests unit --changed`.

### Задача 4. Таблиця опцій і перелік шляхів (Р-D5-3, Р-D5-4, Р-D5-7, Р-D5-11)

Файли: `template/src/server/auth.ts` (сигнатура `authOptions` бере налаштування
Р-D5-1, транспорт і годинник), `template/scripts/auth-options.mjs`,
`packages/simetra/test/db/better-auth.ts`; тести `auth-config.test.ts`,
`auth-options.test.ts`.
Готово, коли: таблиця опцій покриває пароль за `closed`/`open`, `emailOTP`, кожен
провайдер сталої, `validateUserInfo`, відсутність `trustedProviders` і
`accountLinking`, `storeOTP` — об'єкт з `hash`, `backgroundTasks`; мутації І-1
червоні по одній на спосіб. Відкриті шляхи й `:`-шляхи дорівнюють закріпленим
літералам тесту; кожен шлях пробного екземпляра поза ними відповідає 404 через
`auth.handler(new Request(...))` (І-7). Ідентифікатори плагінів трьох конфігів
рівні; тест форми схеми зелений. Після: 3.
Перевірка: `run-tests unit --changed`.

### Задача 5. Слот надсилання (Р-D5-6)

Файли: модуль слота в `template/src/server/`, підключення в `authOptions`; DB-тест
`template/test/sign-in-code.db.test.ts` (рівень БД: замок, транзакція й рядки
`verification` — лише справжній Postgres; Better Auth на тегованій базі зі схемою
`better_auth`, як `dev-user.db.test.ts`; транспорт — захоплення в пам'яті тесту).
Готово, коли: зелені всі рядки задачі 5 таблиці §6; невалідна чи задовга адреса —
`400` без рядків маркерів; мутації І-2…І-6 червоні;
годинник тесту — керований (Р-D5-6), без реального очікування.
Після: 4. Перевірка: `run-tests db --filter sign-in-code`.

### Задача 6. Самореєстрація й права клієнта (сценарій)

Файл: `template/test/self-sign-up.db.test.ts` — один сценарій на базі застосунку,
підготовленій тим самим шляхом, що фікстура e2e (`prepareDatabase`,
`packages/create-simetra-app/scripts/lib/app-database.mts`): провізія — тригер бази (ADR-0047), права —
справжні політики. OAuth — потік id-token `/sign-in/social` з перевизначеннями
опцій провайдера `verifyIdToken` (`verifyProviderIdToken`, `@better-auth/core`
`oauth2/verify-id-token.mjs`) і `getUserInfo` (`social-providers/google.mjs`), без
мережі.
Готово, коли: зелені рядки задачі 6 таблиці §6: нова адреса при `open` — запис
Better Auth, рядок «Користувачів» і `create`/`read` `Client` під її claims одразу
після відповіді входу; при `closed` — ні запису, ні листа; запис скрипта зберігає
пароль після входу кодом; неперевірений запис втрачає облікові записи й сесії
(`revokeUnprovenAccountAccess`, `db/revoke-unproven-account-access.mjs`); OAuth з
`emailVerified: false` — ні запису, ні зв'язування з неперевіреним; два клієнти не
бачать рядків одне одного (І-8, І-11 червоні на мутаціях).
Після: 5, 7, 8. Перевірка: `run-tests db --filter self-sign-up`.

### Задача 7. Записи скриптів (Р-D5-11)

Файли: `template/scripts/dev-user.mjs`, `template/test/dev-user.db.test.ts`.
Готово, коли: обидві гілки `createDevUser` лишають `emailVerified: true` (мутація
«лише нова гілка» червона); зміна пароля видаляє сесії користувача. Після: задача 0;
задача 4 (`requireEmailVerification`) без цієї задачі ламає вхід користувачів e2e.
Перевірка: `run-tests db --filter dev-user`.

### Задача 8. Метадані шаблону, демо, e2e (Р-D5-10)

Файли: `template/metadata/roles/ClientOwner/ClientOwner.meta.json`,
`template/metadata/catalogs/Country/Country.meta.json`, `template/metadata/project.meta.json`,
згенеровані артефакти шаблону, `packages/create-simetra-app/scripts/lib/app-database.mts`, `packages/create-simetra-app/scripts/lib/demo.mts`,
`e2e/fixtures.ts`, `e2e/signals.spec.ts` (коментарі й очікування — права з
`everyUser`).
Готово, коли: `assignClientOwner` немає в репо (`git grep`); свіжість
згенерованого зелена; `pnpm metadata:check` — без помилок, з попередженням
Р-D5-9; `e2e/signals.spec.ts` і `e2e/database-isolation.spec.ts` зелені в CI.
Після: 2. Перевірка: `run-tests unit --changed`; e2e — CI.

### Задача 9. Захоплювач пошти й гейт складу збірки (Р-D5-5)

Файли: `e2e/mail-capture.ts`, `e2e/build-content.build.test.ts` (і помічник
збірки копії з підміненим `mail.ts` у `e2e/template-copy.ts`).
Готово, коли: стандартна збірка не містить маркера захоплювача; збірка копії з
підміненим модулем його містить (негативний контроль, І-10). Після: 3.
Перевірка: CI (`test:build` у job `host-template`); локального рівня немає.

### Задача 10. Екран входу (Р-D5-12)

Файли: `template/src/routes/login.tsx`, `template/src/login-view.tsx`,
`template/src/session-actions.ts`, серверна функція способів; тести
`session-actions.test.ts` і тест вигляду.
Готово, коли: вигляд показує лише ввімкнені способи; код — два кроки; відповідь
серверної функції не несе секретів (тест на ключі); помилки `429` дають
`command.rate-limited`, як у пароля. Після: 4.
Перевірка: `run-tests unit --changed`.

## 8. Задачі власника

Немає.

## 9. Підсумок аудиту

Заповнює авторка після аудиту.
