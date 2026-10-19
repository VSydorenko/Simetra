# Спайк pg-delta під контракт порту `SchemaEngine`

## Про цей документ

- **Питання дослідження:** чи має закріплена версія pg-delta публічні засоби,
  на яких тримається контракт порту `SchemaEngine` плану E2a: засів тіні
  базовим станом провайдера, межа керування за §6.9, представність фактів у
  моделі каталогу та перепис класів поза двигуном.
- **Дата:** 2026-10-02. Версії: `@supabase/pg-delta` `1.0.0-alpha.56`,
  `pg` `8.23.1`, локальний стек Supabase (PostgreSQL 17.6), роль `postgres`
  без прав суперкористувача, але з CREATEDB.
- **Метод:** прочитано публічну поверхню пакета (`exports` у
  `package.json`, `src/index.ts`, типи в `dist/`), а скрипти виконано проти
  локального стеку зі scratch-теки поза репо. Ціль — база `postgres`
  стеку, яку скрипти лише читають. Scratch-бази створює тільки
  `provisionCoLocatedShadow`. Кількість баз `pgdelta_shadow_%` до і після
  кожного прогону — 0.
- **Куди лягли рішення:** план E2a, задачі 3–6
  ([план](../../superpowers/plans/2026-10-02-p2e2a-schema-engine.md)). Межа
  керування описана в [платформній спеці](../../superpowers/specs/2026-09-24-simetra-platform-design.md)
  §6.9, модель каталогу — у [спеці П2](../../superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md)
  §8.3 і §9.
- **Статус:** розвідку завершено. Розвилку засіву вирішив архітектор
  (варіант 1, див. нижче). Відкриті питання до плану зібрано в останньому
  розділі.

## Крок 1. Засів тіні базовим станом провайдера

### Факт: публічного засобу засіву немає

Засів виконує `deriveAssumedSchemaSeed` у
`src/frontends/seed-assumed-schemas.ts`. Цей модуль імпортує тільки
`src/frontends/schema-plan.ts`, а викликається він усередині
`planSchemaFiles`, коли передано `seedAssumedSchemas: true`. Ні корінь
пакета, ні жоден підшлях `exports` його не реекспортують:

```js
for (const s of ["", "/extract", "/plan", "/apply", "/proof", "/frontends", "/core", "/policy", "/integrations"]) {
  const m = await import("@supabase/pg-delta" + s)
  console.log(s || ".", Object.keys(m).filter((k) => /seed/i.test(k)))
}
```

```text
. []            /extract []     /plan []        /apply []
/proof [ 'composeAutoSeedBaseline', 'detectAutoSeedSideEffects', 'reconcileSeedOutcomes' ]
/frontends []   /core []        /policy []      /integrations []
```

Три імена з `/proof` засівають **дані** для доказу плану, а не базовий стан
схеми.

Без засіву FK на `auth.users` у тінь не завантажується, бо тінь створюється
з `template0` і схеми `auth` у ній немає:

```text
loadSqlFiles(...) → ShadowLoadError, details: [{"code":"stuck_statement",
  "message":"app.sql: schema \"auth\" does not exist — at line 2: ..."}]
```

Наївний власний засів (публічний `resolveView` з `/policy`, потім
`buildFactBase` і `plan` з порожньої бази до reference-only фактів) дає
377 дій, і їх replay падає з `permission denied for language c`. Робочий
засів має відкинути члени розширень, функції з SUSET-параметрами, типові
привілеї й замикання залежностей від керованих об'єктів. Це близько 150
рядків внутрішньої логіки двигуна.

### Рішення архітектора: варіант 1

Тінь отримує вхід лише через `planSchemaFiles`. Порт сам створює тінь
через `provisionCoLocatedShadow` і передає її пул у
`planSchemaFiles(targetPool, shadowPool, [бажаний SQL як файл],
{ seedAssumedSchemas: true, … })`. Після повернення тінню й далі володіє
порт: він робить extract тіні, перепис і порівняння моделей, а cleanup
виконує у `finally`. Контракт `withShadow` замінено на
`withDesiredShadow(target, desiredSql, scope, fn: (shadow, plan) => …)`,
що повертає `loaded | shadow-failed`. Тут `plan` — це план «ціль → тінь»
від `planSchemaFiles`, приведений до форми порту. Варіант 2 (файл-заглушка
`select 1;` лише заради засіву) і варіант 3 (власний засів) відхилено.
Варіант 4 (попросити апстрім про публічний засів) роботу не блокує, і зараз
його не подаємо.

### Доказ: засіяна тінь, файли й cleanup

FK на `auth.users` розгортається, тінь прибирається і після успіху, і після
збою:

```js
const sh = await provisionCoLocatedShadow(STACK)
try {
  const r = await planSchemaFiles(target, shadow, [{ name: "app.sql", sql }], { profile, seedAssumedSchemas: true })
  const desired = await r.extract(shadow)
} finally { await target.end(); await shadow.end(); await sh.cleanup() }
```

```text
B: shadow FK facts: [ 'constraint:app.profile.profile_id_fkey def=FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE', ... ]
B: relations in shadow by schema: [ { app: 2 }, { auth: 135 }, { storage: 35 } ]
C (load failure): ShadowLoadError - shadow load stuck after 2 round(s): 1 file(s) cannot apply
after C: 0
```

**(а) Після повернення в тіні є і засів, і файли; extract і перепис по ній
працюють.** Прогін на багатій фікстурі: таблиці всіх видів обмежень,
індекс із виразом, identity, generated, домен, енам, композитний тип,
в'юха, незаповнене матеріалізоване подання, функції, процедура, агрегат,
тригери, політики, publication, гранти, типові привілеї, а також cast,
text search configuration і statistics. Після повернення
`planSchemaFiles` виконано extract тіні й запит перепису (крок 4):

```text
(а) shadow extract facts: 1289 diagnostics: [ 'dangling_edge', 'unmodeled_kind' ]
(а) unmodeled: [ '1 unmodeled "cast" object ... (e.g. app.pair AS text)',
                 '1 unmodeled "text search configuration" object ... (e.g. simple_ua)',
                 '1 unmodeled "statistics object" object ... (e.g. doc_stats)' ]
(а) census on shadow: [aggregate 1, cast 1, constraint.exclusion 1, defaultPrivilege 1, domain 1,
    extension 1, function 2, index 1, materializedView 1, materializedView.unpopulated 1, policy 2,
    procedure 1, publicationRel 1, sequence 1, statistics 1, table 4, textSearchConfiguration 1,
    trigger 2, type.composite 1, type.enum 1, view 1]
```

**(б) Одна істина плану.** План, який повертає `planSchemaFiles`,
дорівнює `plan(extract(ціль), extract(тінь), r.planOptions)`: збігаються
і дії, і `planId`.

```js
const p = plan((await r.extract(target)).factBase, (await r.extract(shadow)).factBase, r.planOptions)
JSON.stringify(p.actions) === JSON.stringify(r.plan.actions); p.planId === r.plan.planId
```

```text
(б) actions equal: true planId equal: true 52 52
```

**(в) Збій завантаження дає типізовану помилку з текстом Postgres.**
Помилка — `ShadowLoadError` з `details: Diagnostic[]`. Текст Postgres
вбудовано в `message` у форматі `<файл>: <текст Postgres> — at line N:
<фрагмент> (<пояснення двигуна>)`. Окремого поля SQLSTATE немає.

```text
instanceof ShadowLoadError: true  name: ShadowLoadError
[{ "code": "stuck_statement", "severity": "error",
   "message": "desired.sql: relation \"app.missing\" does not exist — at line 1: create table app.t (...) (failed identically in 3 round(s) — ...)" }]
[{ "code": "stuck_statement", "severity": "error",
   "message": "desired.sql: syntax error at or near \";\" — at line 1: create table app.t (id int; (...)" }]
```

Помилки до завантаження надходять як `SchemaFrontendError`: порожній
бажаний SQL дає `no executable SQL found…`, збій засіву — `Failed to seed
the co-located shadow…`. Порт має відображати в `shadow-failed` обидва
класи помилок.

## Контракт `plan`

**(a) `plan` чистий.** Сигнатура `plan(rawSource: FactBase, rawDesired:
FactBase, options?: PlanOptions): Plan`, функція синхронна й без пулу. План
із десеріалізованих знімків (`serializeSnapshot` / `deserializeSnapshot`),
обчислений уже після закриття пулів і прибирання тіні, дав ті самі 19 дій;
план тіні проти самої себе — 0 дій. `PlanOptions` (політику, `capability`,
`assumedRoles` з ролей цілі) розв'язує `resolveProfile(pool, profile)` з
базою. Тому `EngineCatalog` несе FactBase разом із розв'язаними опціями
(рішення архітектора).

**(b) Поля дії.** Їх дає `Action` (`src/plan/plan.ts`):

| Поле порту              | Поле `Action`           | Форма                                                                                                             |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `sql`                   | `sql`                   | рядок; `;` у кінці не уніфіковано (дія в'юхи несе `;` з `pg_get_viewdef`, решта — ні)                                                                                                     |
| `verb`                  | `verb`                  | `create` / `alter` / `drop`                                                                                       |
| `produces` / `destroys` | `produces` / `destroys` | `StableId[]`; рядкова форма — `encodeId(id)`, напр. `constraint:app.doc.doc_pkey`                                 |
| `transactional`         | `transactionality`      | `transactional` / `nonTransactional` / `commitBoundaryAfter`                                                      |
| `lockClass`             | `lockClass`             | `none` / `share` / `shareRowExclusive` / `shareUpdateExclusive` / `accessExclusive` — задокументований клас, не сертифікований |
| `dataLoss`              | `dataLoss`              | `none` / `destructive`                                                                                            |
| `rewriteRisk`           | `rewriteRisk`           | булеве                                                                                                            |

Поза контрактом порту лишаються `consumes`, `releases` і
`newSegmentBefore`. Частина дій має **порожні `produces` і `destroys`**:
GRANT, `ENABLE/FORCE ROW LEVEL SECURITY`, `REPLICA IDENTITY`,
`ALTER SEQUENCE … OWNED BY`, `DISABLE TRIGGER`, а також REVOKE за
`assumedDefaultGrants`. Ціль таких дій видно тільки в `consumes`:

```text
EMPTY: {"sql":"GRANT USAGE ON SCHEMA \"app\" TO \"authenticated\"","consumes":["schema:app","role:authenticated"]}
```

Без компактування (`compact: false`) ACL-факт розкладається на дві дії:
`REVOKE ALL … FROM r` з `produces: [acl:(…).r]` і `GRANT …` з порожнім
`produces`. Компактування (типове, `planSchemaFiles` його не вимикає)
прибирає REVOKE, і `GRANT` лишається без цілі. Тому перевірка межі за
`produces`/`destroys` пропускає такі дії, і їй потрібні ще й `consumes`
(питання 2 нижче).

**(c) Перейменування.** `PlanOptions.renames` приймає `"auto" | "prompt" |
"off"`, типове значення — `"off"`. `planSchemaFiles` теж підставляє
`renames ?? "off"`. Порт передає `renames: "off"` явно.

## Крок 2. Межа керування за §6.9

### Форма політики

Профіль — це `{ ...supabaseProfile, id: "simetra-supabase", policy }`.
Політика розширює `supabasePolicy` власними правилами. Правила фільтра
працюють за принципом «перше збігле правило виграє», і власні правила
стоять **перед** успадкованими (`flattenPolicy`: own, потім extends). Тому
власні правила звужують межу, а правила пресета Supabase додають об'єкти
застосунку в схемах провайдера. `managed` — керовані схеми з
`EngineScope.schemas`, `PROVIDER_SCHEMAS` —
`flattenPolicy(supabasePolicy).assumedSchemas`.

```js
const inside = [...managed, ...PROVIDER_SCHEMAS]
const policy = {
  id: "simetra-scope",
  extends: [supabasePolicy],
  filter: [
    // 1. розширення базового стану провайдера — не застосунку
    { match: { all: [{ kind: "extension" }, { name: providerExtensions }] }, action: "exclude" },
    // 2. об'єкти в некерованих схемах поза пресетом провайдера (зокрема public, коли вона не керована)
    { match: { all: [{ schema: "*" }, { not: { schema: inside } }] }, action: "exclude" },
    // 3. сама некерована схема і сателіти (гранти, коментарі) на її об'єктах і на ній
    { match: { all: [{ kind: "schema" }, { not: { name: inside } }] }, action: "exclude" },
    { match: { all: [{ kind: ["acl", "comment", "securityLabel"] }, { any: [
        { all: [{ target: { schema: "*" } }, { not: { target: { schema: inside } } }] },
        { all: [{ target: { kind: "schema" } }, { not: { target: { kind: "schema", name: inside } } }] },
      ] }] }, action: "exclude" },
    // 4. базовий стан провайдера на public: гранти схеми й типові привілеї для його ролей
    { match: { all: [{ kind: "acl" }, { target: { kind: "schema", name: "public" } },
        { idField: { field: "grantee", glob: providerRoles } }] }, action: "exclude" },
    { match: { all: [{ kind: "defaultPrivilege" }, { schema: "public" },
        { idField: { field: "grantee", glob: [...providerRoles, "PUBLIC"] } }] }, action: "exclude" },
    // 5. глобальні типові привілеї (без схеми) — поза межею
    { match: { all: [{ kind: "defaultPrivilege" }, { not: { schema: "*" } }] }, action: "exclude" },
  ],
}
```

На стеку: `providerExtensions` = `plpgsql`, `pgcrypto`, `uuid-ossp`,
`pg_stat_statements`, `supabase_vault`, `pg_graphql`; `providerRoles` =
`postgres`, `anon`, `authenticated`, `service_role`. Обидва списки — дані
пресета провайдера (§6.9: «перелік для конкретного провайдера — пресет»).
`validatePolicy` цю політику приймає. Предикат `schema` не спрацьовує на
факті без поля `schema` (розширення, publication, ACL), тому в правилі 2
стоїть `{ schema: "*" }`.

### Що таке «об'єкт застосунку в чужій схемі»

Це визначають правила `supabasePolicy` після наших:

- тригер у схемі провайдера, функція якого лежить **не** в схемі провайдера
  (`edgeTo function` поза `SUPABASE_SYSTEM_SCHEMAS`);
- політика на поверхнях користувача: `storage.objects`, `storage.buckets*`,
  `storage.s3_multipart_uploads*`, `realtime.messages`,
  `realtime.subscription` і будь-яка таблиця в `auth`;
- членство таблиці в `supabase_realtime` (`publicationRel`): сама
  publication залишається reference-only, членство керується. Схема
  `publicationRel` — це схема таблиці, тож правило 2 відсікає членство
  некерованих таблиць;
- розширення, якого немає в списку провайдера;
- ACL, коментар і типовий привілей на керованих цілях. ACL на об'єктах
  провайдера (`grant … on storage.objects`) пресет виключає.

### Доказ на цілі стеку

Бажаний стан: схема `app`, `citext`, таблиця з FK на `auth.users`, тригер
на `auth.users`, політика на `storage.objects`, членство в
`supabase_realtime`, гранти й ADP у `app`.

| Профіль                          | Дій | Поза межею                                                                                       |
| -------------------------------- | --- | ------------------------------------------------------------------------------------------------ |
| `supabaseProfile` без фільтра    | 30  | 10 drop ADP у `public`, 4 `REVOKE ALL ON SCHEMA public`, `DROP EXTENSION pgcrypto`, `uuid-ossp` |
| межа `[app]`                     | 14  | немає                                                                                            |
| межа `[app, public]` + `public.note` | 16 | немає; `public.note` створюється                                                                 |

Дії межі `[app]` (скорочено):

```text
create +[schema:app]                              CREATE SCHEMA "app"
create +[extension:citext]                        CREATE EXTENSION "citext" SCHEMA "extensions"
create +[table:app.doc column:… constraint:…]     CREATE TABLE "app"."doc" (...)
create +[function:app.on_user()]                  CREATE OR REPLACE FUNCTION app.on_user() ...
create +[constraint:app.doc.doc_id_fkey]          ALTER TABLE "app"."doc" ADD CONSTRAINT ... REFERENCES auth.users(id) ...
create +[trigger:auth.users.app_on_user]          CREATE TRIGGER app_on_user AFTER INSERT ON auth.users ...
create +[policy:storage.objects.app_read]         CREATE POLICY "app_read" ON "storage"."objects" ...
create +[publicationRel:supabase_realtime.app.doc] ALTER PUBLICATION "supabase_realtime" ADD TABLE "app"."doc"
create +[comment:(extension:citext)]              COMMENT ON EXTENSION "citext" IS ...
create +[]                                        GRANT USAGE ON SCHEMA "app" TO "authenticated"
create +[]                                        GRANT SELECT ON TABLE "app"."doc" TO "authenticated"
create +[defaultPrivilege:postgres.app.r.authenticated] ALTER DEFAULT PRIVILEGES ... IN SCHEMA "app" GRANT SELECT ON TABLES ...
```

Некеровані схеми. Ціль — тінь A зі схемою `other` (таблиця й функція),
`public.legacy` і `app.old`; бажаний стан — тільки `app.doc`:

```text
== target A -> desired, scope [app]: 2 actions
  drop   -[table:app.old …]          DROP TABLE "app"."old"
  create +[table:app.doc …]          CREATE TABLE "app"."doc" (...)
== target A -> desired, scope [app, public]: 3 actions
  drop   -[table:app.old …]          DROP TABLE "app"."old"
  drop   -[table:public.legacy …]    DROP TABLE "public"."legacy"
  create +[table:app.doc …]          CREATE TABLE "app"."doc" (...)
```

Об'єкти схеми `other` не потрапляють у план за жодної межі, а `public` стає
керованою тільки тоді, коли її названо в межі.

Наслідок для `public` як керованої схеми: таблицю, створену в `public`,
платформа на цілі отримує з грантами `anon`, `authenticated` і
`service_role` через ADP ролі `postgres`. Двигун це враховує
(`assumedDefaultGrants`) і планує
`REVOKE ALL ON TABLE "public"."note" FROM "anon", "authenticated", "service_role"`
(`alter`, порожній `produces`). Отже бажаний стан таблиці в `public` без
явних грантів означає «без грантів ролям провайдера».

## Крок 3. Таблиця властивостей

Факти, які зустрічаються в межі на фікстурах кроків 1–2 (розподіл за
видами в `resolveView` тіні): `schema`, `extension`, `table`, `column`,
`default`, `constraint`, `index`, `sequence`, `view`, `materializedView`,
`function`, `procedure`, `aggregate`, `trigger`, `policy`, `domain`, `type`,
`typeAttribute`, `publicationRel`, `comment`, `acl`, `defaultPrivilege`.
Власник — не властивість payload, а ребро `owner`, яке модель не виражає.
Власник за замовчуванням (`postgres`) проєкція прибирає. Інший власник —
«не виражається».

Позначення: **поле** — поле моделі каталогу (форма знімка без `origin`);
**одиниця** — `CatalogUnit` з класом `readSqlUnits`; **✗** — діагностика
`engine.unrepresentable`. Ключі з `_` двигун не хешує; вони службові.

### Класи моделі

| Вид факту          | Властивість payload                                     | Куди                                                                                                                                               |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table`            | id `schema`, `name`                                     | поле `schema`, `name`                                                                                                                              |
|                    | `rowSecurity`, `forceRowSecurity`                       | поле `rowLevelSecurity`: `off` / `enabled` / `forced`                                                                                              |
|                    | `persistence`                                           | `p` → —; `u`, `t` → ✗                                                                                                                              |
|                    | `replicaIdentity`, `replicaIdentityIndex`               | `d` → —; інакше одиниця `replicaIdentity:<s>.<t>` (див. питання 3)                                                                                 |
|                    | `partitionKey`, `partitionBound`, `parentTable`         | `null` → —; інакше ✗                                                                                                                               |
|                    | `reloptions`                                            | `null` → —; інакше ✗                                                                                                                               |
| `column`           | id `name`                                               | поле `name`                                                                                                                                        |
|                    | `_position`                                             | порядок у `columns` (двигун його не хешує, тому перестановку бачить лише модель)                                                                   |
|                    | `type`                                                  | поле `type` (`format_type`: `integer`, `app.status`, `extensions.citext`)                                                                          |
|                    | `notNull`                                               | поле `notNull`                                                                                                                                     |
|                    | `collation`                                             | поле `collation` (`pg_catalog."C"` → `{ name: "C" }`)                                                                                              |
|                    | `identity.generation`, `identity.sequence`              | поле `identity` (`d` → `byDefault`, `a` → `always`)                                                                                                |
|                    | `identity.options`                                      | типові для типу → —; інакше ✗                                                                                                                      |
|                    | `generatedExpr`                                         | поле `generated.expression`                                                                                                                        |
|                    | `_partitionKey`                                         | `false` → —; інакше ✗ (разом із `table.partitionKey`)                                                                                              |
| `default`          | `expr` (дочірній факт колонки)                          | поле колонки `default`                                                                                                                             |
| `constraint` `p`   | `def`, `_keyColumns`                                    | поле `primaryKey` (розбір `def` через libpg-query)                                                                                                 |
| `constraint` `u`   | `def`                                                   | поле `uniques[]` (`NULLS NOT DISTINCT`, `DEFERRABLE` з `def`)                                                                                      |
| `constraint` `c`   | `def`                                                   | поле `checks[]` (вираз без обгортки `CHECK (...)`)                                                                                                 |
| `constraint` `f`   | `def`                                                   | поле `foreignKeys[]` (дії, `deferrable`, зовнішня ціль)                                                                                            |
| `constraint` `x`   | `def`                                                   | ✗ (форма EXCLUDE — рішення власника)                                                                                                               |
| `constraint` (усі) | `validated`                                             | `true` → —; `false` → ✗ (`def` закінчується на `NOT VALID`)                                                                                        |
| `constraint` домену | `def`                                                  | частина одиниці `domain`                                                                                                                           |
| `index`            | `def` (повний `CREATE INDEX`)                           | поле `indexes[]` (розбір libpg-query); індекси PK/UNIQUE окремих фактів не мають                                                                   |
|                    | `valid`                                                 | `true` → —; `false` → ✗                                                                                                                            |
|                    | `attachedTo`                                            | `null` → —; інакше ✗ (індекс секції)                                                                                                               |
| `type` `enum`      | `variant`, `values`                                     | поле `enumTypes[]` (`values` упорядковано)                                                                                                         |
| `type` інший       | `variant` (`composite`, `range`) + `typeAttribute`      | ✗ (модель їх не має, класу одиниці теж немає)                                                                                                      |
| `comment`          | `text` на `table` / `column`                            | поле `comment` таблиці або колонки                                                                                                                 |

### Класи-одиниці

Джерело тексту — дія плану «порожньо → факт», згрупована за `produces`.
Перевірено на фікстурі: одна дія на факт, а дочірні факти (колонки,
обмеження домену, атрибути) входять у `produces` цієї дії. Винятки —
дії з порожнім `produces`; для них текст будується з payload.

| Вид факту                    | Ідентичність одиниці (`readSqlUnits`)                       | Текст                                                                                 | Одна дія на факт                                                         |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `function`, `procedure`      | `function:<s>.<n>(<типи>)`                                  | дія `CREATE OR REPLACE …`; `def` = `pg_get_functiondef` — той самий текст             | так; `ALTER FUNCTION … SET` згорнуто в `def` (питання 4)                 |
| `aggregate`                  | `aggregate:<s>.<n>(<типи>)`                                 | дія `CREATE AGGREGATE …` (`def` немає)                                                | так                                                                      |
| `trigger`                    | `trigger:<s>.<таблиця>.<n>`                                 | дія = `def` (`CREATE TRIGGER …`)                                                      | так; `enabled` ≠ `O` дає окрему дію `DISABLE TRIGGER` без цілі → ✗       |
| `policy`                     | `policy:<s>.<таблиця>.<n>`                                  | дія `CREATE POLICY …` (`def` немає: `cmd`, `permissive`, `roles`, `usingExpr`, `checkExpr`) | так                                                                 |
| `view`                       | `view:<s>.<n>`                                              | дія `CREATE VIEW … WITH (security_invoker=true) AS …` (`def` містить лише `SELECT`)                | так                                                                      |
| `materializedView`           | `materializedView:<s>.<n>`                                  | дія `CREATE MATERIALIZED VIEW … AS …` без `WITH NO DATA`                              | так; стан заповнення двигун не бачить (крок 4)                           |
| `sequence`                   | `sequence:<s>.<n>`                                          | дія `CREATE SEQUENCE …`                                                               | так                                                                      |
| `sequence.ownedBy`           | `sequenceOwnedBy:<s>.<n>`                                   | з payload: `ALTER SEQUENCE … OWNED BY …` (дія без цілі)                               | ні — будувати з payload                                                  |
| `domain`                     | `domain:<s>.<n>`                                            | дія `CREATE DOMAIN … CONSTRAINT …` (`produces`: домен + його обмеження)               | так                                                                      |
| `extension`                  | `extension:<n>`                                             | дія `CREATE EXTENSION "<n>" SCHEMA "<s>"`                                             | так; разом з нею двигун додає `comment:(extension:…)` — шум розширення   |
| `publicationRel`             | `publication:<pub>:add:<s>.<t>`                             | дія `ALTER PUBLICATION … ADD TABLE …`                                                 | так, але один факт — одна таблиця (питання 5)                            |
| `comment` на інших цілях     | `comment:<тип>:<ціль>`                                      | дія `COMMENT ON …`                                                                    | так                                                                      |
| `acl`                        | `grant:grant:<тип>:<об'єкт>:<роль>:<привілеї>`              | з payload (`privileges`, `grantable`): дія `GRANT` не має цілі                        | ні — будувати з payload; ACL власника з `privileges` = `_ownerDefault` пропускати |
| `defaultPrivilege`           | `defaultPrivileges:<роль>:<схема>:<тип>:grant:<роль>:<привілеї>` | дія `ALTER DEFAULT PRIVILEGES …`                                                  | так                                                                      |
| `table.rowSecurity`          | —                                                           | поле моделі; дії `ENABLE/FORCE ROW LEVEL SECURITY` без цілі                           | —                                                                        |

## Крок 4. Перепис

Запит рахує об'єкти за класами в межі керування з тими самими
виключеннями, що й фільтр: члени розширень, послідовності identity,
масиви типів і індекси обмежень. Параметри: `$1` — керовані схеми, `$2` —
схеми пресета провайдера, `$3` — розширення провайдера, `$4` — LIKE-шаблони
тригерів подій провайдера (`issue_%`, `pgrst_%`, `graphql_watch_%`).

```sql
with managed as (
  select oid from pg_namespace where nspname = any($1::text[])
), provider as (
  select oid from pg_namespace where nspname = any($2::text[])
), ext as (
  select classid, objid from pg_depend where deptype = 'e'
), rel as (
  select c.* from pg_class c
  where c.relnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_class'::regclass and objid = c.oid)
), typ as (
  select t.* from pg_type t
  where t.typnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_type'::regclass and objid = t.oid)
), objects(class) as (
  select case c.relkind
           when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
           when 'm' then 'materializedView' when 'S' then 'sequence'
           when 'f' then 'foreignTable' else 'index' end
  from rel c
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
     -- послідовність identity-колонки — частина колонки, не окремий об'єкт
     or (c.relkind = 'S' and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                                           and d.objid = c.oid and d.deptype = 'i'))
     or (c.relkind in ('i', 'I') and not exists (select 1 from pg_constraint k where k.conindid = c.oid))
  union all select 'materializedView.unpopulated' from rel where relkind = 'm' and not relispopulated
  union all select case t.typtype when 'e' then 'type.enum' when 'd' then 'domain'
                                  when 'r' then 'type.range' when 'b' then 'type.base'
                                  else 'type.composite' end
  from typ t
  where t.typtype in ('e', 'd', 'r')
     -- базовий тип без масивів, які Postgres створює сам до кожного типу
     or (t.typtype = 'b' and not exists (select 1 from pg_type a where a.typarray = t.oid))
     or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c')
  union all select case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end
  from pg_proc p
  where p.pronamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_proc'::regclass and objid = p.oid)
  union all select case k.contype when 'x' then 'constraint.exclusion' when 't' then 'constraint.trigger' end
  from pg_constraint k join rel c on c.oid = k.conrelid
  where k.contype in ('x', 't')
  -- тригери: на таблицях застосунку і на таблицях провайдера з функцією поза провайдером (§6.9)
  union all select 'trigger'
  from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_proc f on f.oid = g.tgfoid
  where not g.tgisinternal
    and (c.relnamespace in (select oid from managed)
         or (c.relnamespace in (select oid from provider) and f.pronamespace not in (select oid from provider)))
  -- політики: на таблицях застосунку і на таблицях провайдера
  union all select 'policy'
  from pg_policy y join pg_class c on c.oid = y.polrelid
  where c.relnamespace in (select oid from managed) or c.relnamespace in (select oid from provider)
  union all select 'rule' from pg_rewrite w join rel c on c.oid = w.ev_class where w.rulename <> '_RETURN'
  union all select 'collation' from pg_collation x where x.collnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_collation'::regclass and objid = x.oid)
  union all select 'conversion' from pg_conversion x where x.connamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_conversion'::regclass and objid = x.oid)
  union all select 'operator' from pg_operator x where x.oprnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_operator'::regclass and objid = x.oid)
  union all select 'operatorClass' from pg_opclass x where x.opcnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_opclass'::regclass and objid = x.oid)
  union all select 'operatorFamily' from pg_opfamily x where x.opfnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_opfamily'::regclass and objid = x.oid)
  union all select 'cast' from pg_cast x
  where (x.castsource in (select oid from typ) or x.casttarget in (select oid from typ)
         or x.castfunc in (select oid from pg_proc where pronamespace in (select oid from managed)))
    and not exists (select 1 from ext where classid = 'pg_cast'::regclass and objid = x.oid)
  union all select 'textSearchConfiguration' from pg_ts_config x where x.cfgnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_ts_config'::regclass and objid = x.oid)
  union all select 'textSearchDictionary' from pg_ts_dict x where x.dictnamespace in (select oid from managed)
    and not exists (select 1 from ext where classid = 'pg_ts_dict'::regclass and objid = x.oid)
  union all select 'textSearchParser' from pg_ts_parser x where x.prsnamespace in (select oid from managed)
  union all select 'textSearchTemplate' from pg_ts_template x where x.tmplnamespace in (select oid from managed)
  union all select 'statistics' from pg_statistic_ext x where x.stxnamespace in (select oid from managed)
  union all select 'transform' from pg_transform x where x.trftype in (select oid from typ)
  union all select 'publicationRel' from pg_publication_rel x join rel c on c.oid = x.prrelid
  union all select 'publicationSchema' from pg_publication_namespace x where x.pnnspid in (select oid from managed)
  union all select 'defaultPrivilege' from pg_default_acl x where x.defaclnamespace in (select oid from managed)
  -- глобальні класи бази (без схеми)
  union all select 'extension' from pg_extension x where not (x.extname = any($3::text[]))
  union all select 'language' from pg_language x where x.lanispl and x.lanname <> 'plpgsql'
    and not exists (select 1 from ext where classid = 'pg_language'::regclass and objid = x.oid)
  union all select 'accessMethod' from pg_am x where x.oid >= 16384
    and not exists (select 1 from ext where classid = 'pg_am'::regclass and objid = x.oid)
  union all select 'eventTrigger' from pg_event_trigger x where not (x.evtname like any($4::text[]))
    and not exists (select 1 from ext where classid = 'pg_event_trigger'::regclass and objid = x.oid)
  union all select 'foreignDataWrapper' from pg_foreign_data_wrapper x
    where not exists (select 1 from ext where classid = 'pg_foreign_data_wrapper'::regclass and objid = x.oid)
  union all select 'server' from pg_foreign_server x
  union all select 'subscription' from pg_subscription x where x.subdbid = (select oid from pg_database where datname = current_database())
)
select class, count(*)::int as count from objects group by class order by class
```

Прогін на засіяній тіні з багатою фікстурою (`$1 = {app}`) див. у кроці 1,
пункт (а). Лічильники класів, які покриває двигун, збіглися з кількістю
фактів у межі: `table` 4, `function` 2, `procedure`, `aggregate`, `domain`,
`sequence`, `index`, `view`, `materializedView` — по 1, `trigger` 2,
`policy` 2, `type` 2 (`type.enum` + `type.composite`). На чистій базі
стеку з `$1 = {app, public}` перепис дає тільки
`defaultPrivilege: 6` — це ADP провайдера в `public`. Лічильники
покритих класів лише інформують: діагностики дають тільки непокриті класи
й `materializedView.unpopulated`, тому тонкі правила фільтра (правило 4)
перепис не повторює.

### Відповідність класів перепису фактам двигуна

| Клас перепису                                                                   | Факт двигуна                             | Покриття                                                             |
| ------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `table`, `view`, `materializedView`, `sequence`, `index`, `foreignTable`        | однойменні                               | модельовано                                                          |
| `type.enum`, `type.composite`, `type.range`                                     | `type` (`variant`) + `typeAttribute`     | модельовано двигуном; модель Simetra — тільки enum                   |
| `type.base`                                                                     | —                                        | немає факту                                                          |
| `domain`, `function`, `procedure`, `aggregate`, `trigger`, `policy`, `rule`, `collation` | однойменні                       | модельовано                                                          |
| `constraint.exclusion`, `constraint.trigger`                                    | `constraint` (`type` `x` / `t`)          | модельовано двигуном; модель Simetra — ✗                             |
| `publicationRel`, `publicationSchema`, `defaultPrivilege`, `extension`, `eventTrigger`, `foreignDataWrapper` (`fdw`), `server`, `subscription` | однойменні | модельовано                                            |
| `cast`, `operator`, `operatorClass`, `operatorFamily`, `textSearch*`, `statistics`, `transform`, `language` | — | `unmodeled_kind` двигуна (діагностика, не факт)                  |
| `conversion`, `accessMethod`                                                    | —                                        | **немає ні факту, ні проби `unmodeled_kind`** — тиху втрату ловить лише перепис |
| `materializedView.unpopulated`                                                  | — (`materializedView` без стану)         | двигун не бачить: дія створення не містить `WITH NO DATA`            |

## Питання до плану E2a

Узгодження цих питань — справа архітектора; до коду задач 3–5 вони
впливають на контракт.

1. **Сирота-тінь після вбивства процесу.** `finally` не виконується, коли
   процес гине від сигналу. Так сталося з прогоном спайку, який обірвав
   `| head` (SIGPIPE): лишилася база `pgdelta_shadow_<ts>_<rand>`, і її
   прибрано вручну. Тест «тіні не лишаються» має рахувати бази до й після
   прогону, а не покладатися на ім'я.
2. **Перевірка межі за цілями дій.** GRANT, `ENABLE/FORCE RLS`,
   `REPLICA IDENTITY`, `OWNED BY`, `DISABLE TRIGGER` і REVOKE за
   `assumedDefaultGrants` мають порожні `produces` і `destroys`. Тест
   Review Focus 2 має перевіряти й `consumes`, інакше ці дії проходять без
   перевірки.
3. **`replicaIdentity` — одиниця, не ✗.** Класифікатор компілятора
   (`readSqlUnits`) приймає `ALTER TABLE … REPLICA IDENTITY` як одиницю
   класу `replicaIdentity`. Рішення плану 5 і Review Focus 4 вимагають ✗
   для `REPLICA IDENTITY FULL`. Якщо одиниця дозволена, extract має
   віддавати одиницю `replicaIdentity:<s>.<t>` з payload, а негативний тест
   треба замінити на інший (наприклад, `UNLOGGED`).
4. **`functionSettings` нерозрізненний.** `ALTER FUNCTION … SET` двигун
   згортає в `def` функції. Тому одиниці `function` + `functionSettings`
   компілятора відповідає одна одиниця `function` бази з іншим текстом.
   Задачі 4 це потрібно в переліку «класи, які база тримає інакше».
5. **Зернистість `grant`, `defaultPrivileges` і `publication`.** Факт
   двигуна — це пара (об'єкт, роль) або (publication, таблиця). Одиниця
   компілятора — це оператор, який може охоплювати кілька ролей чи таблиць.
   Щоб рівність множин `identity` трималась, потрібна нормалізація
   «одиниця на пару» з обох боків або обмеження мови.
6. **`public` як керована схема.** Правило 4 лишає гранти схеми `public`
   ролям провайдера і ADP у `public` за провайдером, тож застосунок ними не
   керує. Таблиця в `public` без явних грантів дає REVOKE для `anon`,
   `authenticated` і `service_role`.
7. **Діагностики `dangling_edge`.** Extract засіяної тіні дає 10 таких
   діагностик (`loadDiagnostics`). План вимагає, щоб `dangling_edge` до
   порту не доходив, тож адаптер має їх відфільтрувати.
8. **ACL власника.** Коли у схемі є ADP, об'єкти отримують явний ACL, і
   двигун планує `REVOKE ALL … FROM postgres` + `GRANT ALL … TO postgres`.
   Одиницею такий факт не є: його треба пропускати, якщо
   `privileges` = `_ownerDefault`.
