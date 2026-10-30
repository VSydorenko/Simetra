# Серверний рантайм: хостинг, профіль провайдера, хуки запису

## Про цей документ

- **Питання.** Як побудувати серверний рантайм T3, щоб він працював на
  кількох хостингах і з різними провайдерами, і яку модель хуків запису
  взяти.
- **Дата.** 2026-10-30. Версії й поведінку бібліотек і платформ перевірено на
  цю дату.
- **Метод.** Документація платформ і бібліотек (context7, офіційні сайти),
  вихідний код (Centrifugo, Frappe, Odoo, Directus), код репо, дослідження
  `1c-model/`. Кожен зовнішній факт має URL.
- **Куди лягли рішення.** [Спека П4](../../superpowers/specs/2026-10-26-p4-runtime-design.md)
  Рт17–Рт21, §6.4, §6.5, §6.9, §6.11, §9; [платформна
  спека](../../superpowers/specs/2026-09-24-simetra-platform-design.md) Р33;
  [спека профілів провайдера](../../superpowers/specs/2026-10-23-provider-profiles-design.md)
  ПП3, ПП7; [хартії П0](../../superpowers/specs/2026-09-26-p0-spike-charters.md) (а).
- **Статус.** Рішення ухвалено власником 2026-10-30.

## 1. Хостинг шляху запиту

| Ціль | Збірка TanStack Start | З'єднання з Postgres |
| --- | --- | --- |
| Контейнер | Nitro, пресет `node-server`, `node .output/server/index.mjs` [1] | пул на рівні модуля |
| Vercel | Nitro, пресет `vercel`, Fluid compute | пул на рівні модуля й `attachDatabasePool(pool)` з `@vercel/functions`; короткий idle-тайм-аут [2][3] |
| Cloudflare Workers | `@cloudflare/vite-plugin`, без Nitro (або пресет Nitro `cloudflare_module`) [1][4][5] | клієнт на запит через Hyperdrive; TCP-сокет не можна ділити між запитами [6][7] |
| Netlify | `@netlify/vite-plugin-tanstack-start`, без Nitro [1] | пул на інстанс |

Факти, від яких залежить контракт T3:

- **Hyperdrive** працює в transaction-режимі. `SET` усередині транзакції діє;
  після транзакції з'єднання скидається `RESET`. Іменовані prepared
  statements `pg` підтримуються [8]. Не підтримуються `LISTEN/NOTIFY`,
  advisory locks, SQL-рівневі `PREPARE`/`DEALLOCATE`, довільний сесійний
  стан [9].
- **Кеш Hyperdrive** кешує read-only запити; ключ кешу — текст запиту.
  Документація не каже, що ключ враховує роль чи claims, і нічого не каже про
  транзакції. Вимикається `--caching-disabled` [10]. Для запиту під RLS це
  ризик: одна й та сама вибірка двох користувачів.
- **Workers** забороняє I/O в глобальній області; `node:fs` — віртуальна ФС
  [11]. Каталог рантайму тому приходить імпортом у збірку, а не читанням
  файлу.
- **Дія після відповіді:** Vercel — `waitUntil` з `@vercel/functions` [2];
  Workers — `ctx.waitUntil` чи `import { waitUntil } from "cloudflare:workers"`
  [12]; h3 — `event.waitUntil` [13]. Без нього serverless-платформа може
  зупинити незавершену дію.
- **Пулери в transaction-режимі** (Supavisor, PgBouncer) не тримають
  сесійного стану й `LISTEN` [14][15]. Контракт `runCommand` (безіменні
  оператори, лише `SET LOCAL` і `set_config(…, true)`) на це розрахований.
- **HTTP-драйвери** (Neon `neon()`) дають лише неінтерактивну транзакцію [16];
  хукам між операторами потрібна інтерактивна, тож другий драйвер не
  потрібен, а для Workers — друга форма адаптера порту («з'єднання на
  команду»).

**Довгоживучі процеси** (сервер сигналів, `LISTEN`, планувальник) на Vercel і
Workers не живуть: це окремі сервіси. Vercel Cron на Hobby — раз на добу
[17]; Workers cron, черги й DO alarm обмежені 15 хв [18].

## 2. Незалежність від Supabase

**Стан коду.** Імена ролей і факти профілю беруться з записів T0 за
провайдером (`packages/simetra/src/model/schemas/project.ts`:
`PROVIDER_API_ROLES`, `LOGIN_ROLE_REQUEST_PURPOSES`, `PROVIDER_IDENTITY_SOURCES`);
мапи мають тип `Record<DatabaseProvider, …>`, тож новий провайдер компілятор
вимагатиме в кожній мапі. Залишки форми Supabase, які зачепить профіль
`postgres`:

| Місце | Що | Де закривається |
| --- | --- | --- |
| `packages/simetra/src/schema/engine/desired.ts`, `packages/designer/src/schema-engine/pg-delta/policy.ts` | рушій схеми бере списки Supabase напряму, а не за профілем | детальна спека профілю |
| `ProviderApiRoles` | вимагає роль `service`, що обходить RLS | детальна спека профілю |
| `maintenanceSql` (`packages/simetra/src/compiler/rights/guard-units.ts`) | заборонний список логінів | [борг прав](../../superpowers/plans/2026-10-26-rights-residual-debt.md) §1 |
| ролі запиту | провайдер створює їх сам; у `postgres` їх створює платформа | детальна спека профілю |
| `simetra.identities.provider` | значення провайдера в даних — зміна профілю вимагає переприв'язки ідентичностей | спайк переїзду |

**Better Auth** (1.6.x):

- `database.schemaName` разом із `type: "postgres"` ставить власну схему;
  з голим `pg.Pool` працює лише `search_path` [19].
- `advanced.database.generateId: "uuid"` дає колонку `uuid` з
  `gen_random_uuid()` [20].
- Хуки бази «after» з 1.5 виконуються після коміту [21] — атомарну провізію
  «Користувачів» дає лише тригер (спека системної схеми С3).
- У TanStack Start сесію дає `auth.api.getSession({ headers })` у серверній
  функції; плагін `tanstackStartCookies()` — останній [22].
- JWT-плагін — «не заміна сесії» [23]; claims для бази ставить `set_config`.
- Плагін `organization` додає власні таблиці членства й активний тенант у
  сесії [24]: друга модель тенанта поза RLS. Не використовувати.

**Centrifugo** (v6):

- Має вбудованого споживача outbox `postgresql`: фіксована таблиця (`id`,
  `method`, `payload jsonb`, `partition`, `created_at`), опитування й
  необов'язковий `LISTEN/NOTIFY`; для `LISTEN` за PgBouncer — окремий прямий
  DSN (`partition_notification_dsn`); порядок — у межах партиції [25].
- Тимчасові помилки повторюються; інші — у журнал, рядок позначається
  обробленим [25]. Сигнал може загубитися: клієнт перечитує дані після
  перепідключення.
- Токени підключення й каналу — JWT (HMAC, RSA, JWKS) [26]; альтернатива —
  subscribe proxy [27]; серверна публікація — `POST /api/publish` [28].

**Garage:** політик бакета й ACL немає, права — на ключ і бакет; підписані URL
є [29]. Підтримку `If-None-Match` сторінка сумісності не згадує.

**PostgREST** працює без Supabase з `jwt-secret` і роллю з claim [30]; у
`postgres` — лише перехідний адаптер.

## 3. Хуки запису

### 3.1 1С

У модулі об'єкта події запису: `ОбработкаПроверкиЗаполнения` (поза
транзакцією), `ПередЗаписью`, запис, `ПриЗаписи`, для документа
`ОбработкаПроведения` (у транзакції). **`ПослеЗаписи` в модулі об'єкта
немає**: `ПослеЗаписиНаСервере` і `ПослеЗаписи` — лише у формі [31][32].
`Объект.Записать()` з коду подій форми не викликає. Позначка видалення — це
зміна `ПометкаУдаления` і запис об'єкта [33]. Обробники й підписки при
`ОбменДанными.Загрузка` виходять одразу [34]. Підписки виконуються після
обробника модуля об'єкта.

Англійські назви подій 1С: `FillCheckProcessing`, `BeforeWrite`, `OnWrite`,
`Posting`, `UndoPosting`, `BeforeDelete`, `Filling`, `OnCopy`,
`OnSetNewCode`, `OnSetNewNumber`; `AdditionalProperties`,
`DataExchange.Load`, `Cancel` [35]. XML-вивантаження конфігурації пише подію
підписки англійською (`<Event>OnSetNewNumber</Event>`) [36].

Частоту використання в живому продукті — [platform-in-practice-2026-10.md](../1c-model/platform-in-practice-2026-10.md)
§6–§7.

### 3.2 Подібні платформи

| Можливість | Frappe | Odoo | Salesforce | Payload | PocketBase | Convex |
| --- | --- | --- | --- | --- | --- | --- |
| Зміна до запису | `validate`, `before_save` | перевизначення `create`/`write` | before-тригер | `beforeChange` | `onRecordCreate` до `e.next()` | код мутації |
| Після запису в транзакції | `after_insert`, `on_update` | код після `super()` | after-тригер | `afterChange` | код після `e.next()` | тригери |
| Після коміту | `enqueue_after_commit` | `cr.postcommit` | Queueable, Publish After Commit | jobs queue | `…AfterCreateSuccess` | `ctx.scheduler` |
| Перевірка без запису | — | `@api.onchange` (лише форма) | — | `operation: 'validate'` | `$app.validate()` | — |
| Спільний стан на збереження | `doc.flags` | `with_context` | статичні змінні | `context` | — | — |
| Обхід для імпорту | `in_import`, `ignore_*`, `db_set` | ключі контексту | — | — | `saveNoValidate` | імпорт без тригерів |

Джерела: [37]–[44].

**Патерни.** Три зони: до запису, після запису в транзакції, після коміту.
Надійна асинхронність — постановка в чергу в транзакції (Convex scheduler,
Salesforce Queueable). Спільний стан на одне збереження з'являється рано чи
пізно. Перевірка без запису — режим тієї самої операції (Payload,
PocketBase).

**Антипатерни.** Розкол логіки форми й інваріантів (Odoo `onchange` проти
`constrains`). Прапорці обходу, що вимикають і поведінку, і цілісність
(Frappe `ignore_*`, `db_set`). Побічні дії до коміту (Payload: успішна
відповідь на відкочену транзакцію). Вибух імен подій за станами (Frappe
`before_update_after_submit` та інші).

### 3.3 Висновок для Simetra

Модель «до — після в транзакції — після коміту» спеки П4 збігається з
платформами вище. Інваріанти в базі (платформна спека Р23) знімають
антипатерн прапорців обходу: імпорт обходить поведінку, а не цілісність
(генерацію `simetra.write_mode` заплановано на П3, на дату документа її
немає).
Повтор транзакції на `40001`/`40P01` виконує хуки наново, тож зовнішній I/O
у хуках заборонено. Назви — події 1С (рішення власника), бо вид
`EventSubscription` уже має `beforeWrite`, `onWrite`, `beforeDelete`.

## Джерела

1. https://tanstack.com/start/latest/docs/framework/react/guide/hosting
2. https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
3. https://vercel.com/kb/guide/connection-pooling-with-functions
4. https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
5. https://nitro.build/deploy/providers/cloudflare
6. https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
7. https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
8. https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/
9. https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
10. https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
11. https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
12. https://developers.cloudflare.com/changelog/post/2025-08-08-add-waituntil-cloudflare-workers
13. https://h3.dev/guide/api/h3event
14. https://supabase.com/docs/guides/database/connecting-to-postgres
15. https://www.pgbouncer.org/features.html
16. https://neon.com/docs/serverless/serverless-driver
17. https://vercel.com/docs/cron-jobs/usage-and-pricing
18. https://developers.cloudflare.com/workers/platform/limits/
19. https://www.better-auth.com/docs/adapters/postgresql
20. https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/concepts/database.mdx
21. https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/blogs/1-5.mdx
22. https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/integrations/tanstack.mdx
23. https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/jwt.mdx
24. https://github.com/better-auth/better-auth/blob/v1.6.23/docs/content/docs/plugins/organization.mdx
25. https://centrifugal.dev/docs/server/consumers
26. https://centrifugal.dev/docs/server/channel_token_auth
27. https://centrifugal.dev/docs/server/proxy
28. https://centrifugal.dev/docs/server/server_api
29. https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/
30. https://docs.postgrest.org/en/v14/references/auth.html
31. https://1c-dn.com/library/tutorials/practical_developer_guide_event_sequence_for_writing_catalogs_items/
32. https://1c-dn.com/library/tutorials/practical_developer_guide_event_sequence_for_writing_documents/
33. https://its.1c.ru/db/content/metod8dev/src/developers/platform/metod/applied/i8102711.htm
34. https://its.1c.ru/db/content/v8std/src/200/400/i8100773.htm
35. https://github.com/comol/1chelp (дзеркало синтакс-помічника 8.3 з двомовними заголовками)
36. https://github.com/infostart-hub/infostart-erp-community
37. https://raw.githubusercontent.com/frappe/frappe/develop/frappe/model/document.py
38. https://www.odoo.com/documentation/18.0/developer/reference/backend/orm.html
39. https://raw.githubusercontent.com/odoo/odoo/18.0/odoo/sql_db.py
40. https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/platform_events_publish_apex.htm
41. https://payloadcms.com/docs/hooks/context
42. https://payloadcms.com/docs/database/transactions
43. https://pocketbase.io/docs/js-event-hooks/
44. https://stack.convex.dev/triggers
