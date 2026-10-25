# Права-2c1: заборона дослівних політик і тригерів, межа довіри SQL, діагностика `SECURITY DEFINER` — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: чернетка автора, на аудиті.
Архітектор задачі — сесія `consumer-reconciliation2`; якщо її немає — власник.

**Мета:** таблицю виду захищає лише те, що генерує платформа. Дослівна
політика чи тригер на таблиці виду — помилка компілятора в будь-якому файлі,
зокрема в боргу. Закритий код (функції закритих модулів, обробники підписок,
функції множини) не досягає викликами функції, тіла якої компілятор не може
судити (нелітеральний `EXECUTE`, мова поза `sql`/`plpgsql`, невідома функція).
Борговий SQL прийнятих таблиць уперше судиться перевіркою контексту
команди. Боргова `SECURITY DEFINER`-функція, доступна ролям API, що читає
таблицю під RLS, дає попередження з переліком таблиць — клас «RPC читання повз
RLS» (платформна спека §6.7, Р30).

**Архітектура:** лише компілятор (T1) і факт T0; бази й плану застосування не
змінює.

- **T0** (`packages/simetra/src/model/schemas/project.ts`): `PROVIDER_SCHEMAS`
  — схеми провайдера (перенесено з T2 `SUPABASE_SCHEMAS`, без дубля).
- **T1** (`packages/simetra/src/compiler`):
  - ранній блок `runStages` (`pipeline.ts`, над `stage3.physical`) — `sql.kind-table-verbatim`; стадія 5 (`stages/links.ts`) — `sql.command-context-reach` і `sql.definer-reads-rls`;
  - `sql/reach.ts` (новий) — обхід викликів із закритого коду, `sql.command-context-reach`;
  - `sql/closed-forms.ts` і `sql/command-context.ts` — борговий SQL під перевіркою контексту (`sql.command-context-write` для `simetra.*`, попередження `sql.debt-session-write` для решти).
- **Тести:** лише unit (дерева й діагностики); `test:db` не росте.

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, libpg-query (WASM).

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) — §5.3 (межа
довіри, останній абзац перед гратами DML), §6.1 (дослівна політика чи тригер —
помилка), §8 п.2; [платформна спека](../specs/2026-09-24-simetra-platform-design.md)
§6.3, §6.7, Р30; [спека промоції](../specs/2026-10-06-promotion-design.md) §8,
§9.3, §9.4. Плани [Права-2b1](2026-10-24-rights-2b1-write-policies-effects.md)
(Р2b1-19, Р2b1-19a, Р2b1-19b, Р2b1-22, Р2b1-25) і [Права-2a2](2026-10-18-rights-2a2-read-policies-carriers.md)
— їхні таблиці рішень діють. Борг: [залишковий борг П3-2b](2026-10-15-p3-2b-residual-debt.md)
§4 «Дослівна політика чи тригер на таблиці виду в борговому SQL», §5 «Виклик
динамічного SQL із закритого коду».

**Залежність:** Права-2b1 у `main` (`commandContextWrite`, `checkSqlModules`,
`PROTECTED_SESSION_SETTINGS`). Від 2d1 не залежить і може виконуватися
паралельно в іншому worktree (спільні файли — `compiler/diagnostics.ts`,
`compiler/messages.ts`, скіл споживача). Перед стартом —
`.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-25-rights-2c1-verbatim-ban-trust-boundary.md`.

## Global Constraints

- Усі обмеження планів Права-2a1, 2a2 і 2b1 (розділи «Global Constraints») діють і тут.
- 🔴 `pnpm --filter <pkg> test <pattern>` — **без** `--` перед шаблоном.
- 🔴 Ціль одиниці — лише через `unitTargets`/`statementTargets` (`compiler/sql/unit-target.ts`), об'єкт таблиці — через `PhysicalTable.origin.objectId`; жодного розбору тексту SQL регулярними виразами.
- 🔴 Схеми провайдера — лише `PROVIDER_SCHEMAS[project.database.provider]` (T0); `SUPABASE_SCHEMAS` видаляється разом зі споживачами, без реекспорту.
- 🔴 Вбудовані функції динамічного SQL — один перелік (`DYNAMIC_SQL_BUILTINS`, переноситься в `compiler/sql/reach.ts` і імпортується `rights/dimension-functions.ts`).
- Помилка компілятора — лише там, де рішення каже «помилка»; прийом реальних баз з борговим динамічним SQL не ламається (Р2b1-19a): нелітеральний `EXECUTE`, недосяжний із закритого коду, лишається боргом без діагностики.
- DB-тестів план не додає: усе вирішує дерево розбору. Скіл `.agents/skills/writing-tests/SKILL.md` обов'язковий перед кожним кроком тестів.
- Між задачами гейти не червоні: зміна, що ламає тест чи фікстуру, і її правка — в одному коміті.
- Репо публічне: фікстури синтетичні.

## Рішення плану

Розвилки Ф1, Ф9, Ф10, Ф11 вирішив архітектор задачі 2026-10-25.

| # | Рішення | Чому | Вплив на спеку |
| --- | --- | --- | --- |
| Р2c1-1 | `sql.kind-table-verbatim` — помилка на одиницю класу `policy` чи `trigger` (`CREATE POLICY`, `CREATE [CONSTRAINT] TRIGGER`) у будь-якому файлі — спільному `sql/`, модулі боргу `CustomTable`/`PgEnum`, зокрема одиниця, вже перелічена в `sql-debt.json`, — чия ціль (`unitTargets`, `kind` `policy`/`trigger`) — таблиця знімка з `origin.objectId` об'єкта виду, що не є `CustomTable` (основна таблиця, ТЧ, похідна таблиця регістра, системні довідники прав). Параметри `{ identity, table, form: "policy" \| "trigger", line }`, вказівник — файл одиниці. Перевірка — у ранньому блоці `runStages` (`compiler/pipeline.ts`, поруч із `checkSqlModules`) над `stage3.physical` (знімок там уже є — його бере `embedRowRules`): стадія 5 не запускається, коли ранній блок має помилки, а `sql.debt-grows` — помилка ранього блоку. Тому така одиниця **не є боргом**: `debtPredicate` (`compiler/sql/debt.ts`) її виключає (`checkDebt` і `debtUnits` отримують множину таблиць виду), тож неперелічена дає лише `sql.kind-table-verbatim` (а не підказку «внести в борг»), а перелічена — ще й `sql.debt-stale`. Модуль виду ці класи вже відмовляє `sql.statement-not-allowed` (`detail: "kindModule"`), тож там друга діагностика не додається | розширити ізоляцію може лише право (дія, об'єкт); дослівний тригер бачить запис команди й крок даних копій (відомі обмеження 2b1, 2b2) | спека прав §6.1 — без змін (уже «помилка»); спека промоції §9.4 — абзац «Борг `CustomTable`»: дослівна політика чи тригер на таблиці виду не буває боргом (Задача 0) |
| Р2c1-2 | Решту форм, названих архітектором (Ф9), уже відмовляє наявний код — нового коду для них немає: `ALTER TABLE … ENABLE/DISABLE TRIGGER/RULE`, `ENABLE/DISABLE/FORCE/NO FORCE ROW LEVEL SECURITY` і будь-яка інша підкоманда, крім `REPLICA IDENTITY` і правила рядка, — `sql.statement-not-allowed` у будь-якому файлі (`classify`, `compiler/sql/units.ts`: `ROW_SECURITY`, `feature: "rowLevelSecurity"`); `CREATE RULE` і `ALTER POLICY` — `sql.statement-not-allowed` (останній `return { notAllowed }` у `classify`); дослівний `GRANT`/`REVOKE` на таблицю виду з контрактом доступу (усі таблиці видів з RLS — `access-units.ts`) — `sql.generated-grant` (`generatedGrantConflicts`, `compiler/function-execute.ts`; спрацьовує після гейта проєкції). Тест-таблиця Задачі 2 фіксує кожну форму її кодом | факти коду; друга діагностика на ту саму форму — шум | немає |
| Р2c1-3 | Промоція не потребує зміни: `planUnits` (`compiler/operations/promote/sql.ts`) вимагає класу для кожної одиниці з ціллю — промотованою таблицею, тож після `promote` дослівних політик і тригерів на ній у файлах не лишається. Тест Задачі 2: промоція таблиці з борговою політикою компілює результат без `sql.kind-table-verbatim` | факт коду | немає |
| Р2c1-4 | `PROVIDER_SCHEMAS: Readonly<Record<DatabaseProvider, readonly string[]>>` у T0 поруч із `PROVIDER_API_ROLES`; T2 (`schema/engine/desired.ts`, `schema/engine/index.ts`, `schema/engine/provider/supabase.ts`) і designer (`schema-engine/census-read.ts`) беруть перелік звідти; `SUPABASE_SCHEMAS` видаляється (архітектор, Ф10) | компілятору (T1) потрібні схеми провайдера, а T2 він імпортувати не може; один перелік | немає |
| Р2c1-5 | `sql.command-context-reach` — помилка на голову обходу, коли з неї транзитивно досяжна функція, якої компілятор не може судити. Голови: функції закритих модулів (`sqlModule: "closed"`), обробники підписок і функції множини скоупу (`ruledFunctions`). Перевірка — у стадії 5 (`checkLinks`, отримує `membershipFunctions`). Обхід — `reachableCalls` (Задача 3): тіла `LANGUAGE sql` (`unitCalls`, `unitRelations`) і `plpgsql` (виклики й відношення у виразах `plpgsqlExpressionTrees` і в тексті літерального `EXECUTE`); відношення, що є поданням моделі (`view`, `materializedView`), обходиться як `walk` у `rights/dimension-functions.ts`; для таблиці знімка серед відношень одиниці обходяться й дослівні політики, чия ціль (`unitTargets`, `kind: "policy"`) — ця таблиця (Postgres обчислює їх посеред команди, коли закритий код читає чи пише таблицю з RLS, зокрема прийняту). Класифікація виклику, у порядку: **(1)** функція моделі (одиниця класу `function`/`procedure`/`aggregate` з тим самим ім'ям; кваліфікована — і тією самою схемою; некваліфікована — якщо викликач має `SET search_path = ''`, то лише вбудована, інакше — **кожна** функція моделі з таким ім'ям у будь-якій схемі, fail-closed, бо Postgres розв'яже її за `search_path` сесії) — обходиться, **пріоритет над переліком схем**: функція моделі в схемі провайдера обходиться, а не довіряється (архітектор); **(2)** функція схеми платформи (`PLATFORM_SCHEMA`, зокрема `simetra.current_user_id()`) чи згенерована функція схеми застосунку (`membershipFunctions` і `derivedFunctions` контрактів) — платформна, довірена; **(3)** некваліфікована поза моделлю чи `pg_catalog.*` — вбудована; вбудована з `DYNAMIC_SQL_BUILTINS` — недосудна (`dynamicBuiltin`); некваліфікована з голим ім'ям з `UNSAFE_PROVIDER_FUNCTIONS` у викликача без `SET search_path = ''` — теж `dynamicBuiltin` (типовий `search_path` Supabase містить `extensions`); **(4)** кваліфікована схемою з `PROVIDER_SCHEMAS[provider]` — довірена, крім переліку `UNSAFE_PROVIDER_FUNCTIONS` (поруч із `DYNAMIC_SQL_BUILTINS`: `extensions.dblink`, `extensions.dblink_exec`, `extensions.dblink_send_query`, `extensions.dblink_open`, `graphql.resolve`, `graphql_public.graphql` — обгортка Supabase над `graphql.resolve`, `pgtle.install_extension` — виконують SQL з рядка) — `dynamicBuiltin`; **(5)** решта — невідома (`unknown`, fail-closed). Недосудність функції моделі — власний предикат `unjudgeable` (не `closedShellProblem`, який повертає `volatility`/`searchPath` раніше й рахує літеральний `EXECUTE` динамічним): мова поза `sql`/`plpgsql` — `language`; тіло, яке не розбирається, — `unknown`; `EXECUTE` з нелітеральним текстом (та сама перевірка літерала, що `command-context.ts`) — `nonLiteralExecute`. Параметри `{ function, chain, reason: "nonLiteralExecute" \| "language" \| "dynamicBuiltin" \| "unknown" \| "sessionWrite" }` (`sessionWrite` — Р2c1-10), `chain` — `a → b → c` (як `rights.dimension-function-reads-rights`). Власний нелітеральний `EXECUTE` голови закритого модуля вже дає `sql.closed-shell`, обробника — `subscription.handler-not-closed`: голова судиться лише за досяжними функціями, не за власним тілом | закриває борг «Виклик динамічного SQL із закритого коду» і відоме обмеження 2b1 «нелітеральний EXECUTE і тіла інших мов у спільних файлах»: такий код відтепер недосяжний із місць, що виконуються посеред команди | спека прав §5.3 — речення «нелітеральний динамічний SQL і тіла функцій мовами поза `sql`/`plpgsql` у спільних файлах — відоме обмеження до 2c» → правило досяжності (Задача 0) |
| Р2c1-6 | Борговий SQL прийнятих таблиць (модулі з `sqlModule: "debt"` — `CustomTable` і `PgEnum`, крім обробників і функцій множини, які вже судяться) уперше проходить `commandContextWrite`: помилка `sql.command-context-write` — запис налаштування з префіксом `simetra.` у будь-якій формі, а також форми, що зачіпають його неминуче: оператор `RESET ALL` і запис у `pg_settings` (`settingsTable`) (у чужому боргу цього бути не може, а префікс несе контекст команди й режим обслуговування прав 2c2); попередження `sql.debt-session-write` з тими самими параметрами — решта захищених (`request.jwt.*`, `role`, `session_authorization`) і `nonLiteral` (`set_config` з нелітеральним ім'ям чи агрегат над ним — ім'я статично не відоме) (архітектор, Ф10 (б')). Для цього `commandContextWrite` повертає **усі** записи одиниці — `CommandContextHit[]` з `{ form, setting?: string }` (`setting` — літеральне ім'я, коли воно відоме; `RESET ALL` — `setting: "*"`), а не перший: інакше `SET ROLE` перед `set_config('simetra.command', …)` сховав би помилку за попередженням; наявні виклики (закриті модулі, спільні файли) беруть перший елемент. Текст діагностики (en/uk) для боргу називає, що саме прибрати з боргової функції — оператор `RESET ALL`, запис у `pg_settings`, `set_config`/`SET` на ім'я налаштування (з самим ім'ям, коли воно відоме), — і підказку конверсії: на прийомі реальної бази це перша зустріч споживача з правилом | прийом реальних баз із `SET ROLE` у боргових функціях не ламається, а платформний префікс захищено скрізь | спека прав §5.3 — речення про SQL застосунку: «борговий SQL прийнятих таблиць не пише `simetra.*` (помилка), решту захищених налаштувань — попередження» (Задача 0) |
| Р2c1-7 | Відоме обмеження: борговий тригер прийнятої таблиці (`CustomTable`) з нелітеральним `EXECUTE` чи мовою поза `sql`/`plpgsql` виконується посеред команди, коли команду досягає каскад FK чи запис обробника в прийняту таблицю; статично повністю не закривається. Скіл споживача: такий тригер — кандидат на конверсію перед першою командою, що пише в пов'язану таблицю | рішення архітектора (Ф10 (в)) | спека прав §5.3 — рядок у тому самому реченні (Задача 0) |
| Р2c1-8 | `sql.definer-reads-rls` — попередження на кожну дослівну функцію спільного `sql/`-файлу, модуля боргу (`CustomTable`, `PgEnum`) чи закритого модуля (останні — бо закрита оболонка не забороняє читати таблицю під RLS, а без явного `REVOKE` `EXECUTE` має `PUBLIC`), крім обробників і функцій множини (`ruledFunctions`), функцій значень виміру й функцій `RETURNS trigger` (їх не викликати як RPC; `EXECUTE` їм дає чи не дає `buildFunctionExecuteUnits`), — **незалежно від закритої оболонки**: типова RPC «читання повз RLS» якраз має форму `STABLE SECURITY DEFINER SET search_path = ''` і боргом за `debtPredicate` не є, — що одночасно: (а) `SECURITY DEFINER` — опція `security` у дереві `CreateFunctionStmt` або одиниця `functionSettings` (`ALTER FUNCTION … SECURITY DEFINER`) цієї функції (`functionSettingsOf`, Р2c1-10 (б)); (б) має дієвий `EXECUTE` для ролі API (`PROVIDER_API_ROLES[provider]` `user` чи `anonymous`): попередження, **якщо немає** явних `REVOKE EXECUTE` цієї функції і від `PUBLIC` (Postgres дає `EXECUTE` `PUBLIC`), і від цієї ролі API (провайдер дає `EXECUTE` своїм ролям API типовими привілеями схеми — `compiler/sql/execute-grants.ts`), або є явний `GRANT EXECUTE` ролі API чи `PUBLIC` — консервативне правило без моделювання типових привілеїв провайдера (для попередження надлишок безпечніший за пропуск); (в) тіло **або одиниця моделі, транзитивно досяжна з нього** (`reachableUnits` Задачі 3: функції — зокрема `SECURITY INVOKER`-помічник, що виконується від власника зовнішньої функції, — подання моделі) читає таблицю знімка з `rowLevelSecurity` ≠ `"off"` — для `sql` через `unitRelations`, для `plpgsql` через відношення у виразах `plpgsqlExpressionTrees` (кваліфіковане ім'я; некваліфіковане — у схемі функції), або тіло чи досяжна одиниця недосудні (нелітеральний `EXECUTE`, інша мова) — тоді `reason: "unknown"` і перелік уже знайдених таблиць. Параметри `{ function, tables: string, roles: string, reason?: "unknown", line }`, вказівник — файл одиниці; одне попередження на функцію (архітектор, Ф11). Власника функції статично не видно — тому попередження, а не помилка. Рахується в стадії 5: видно в `simetra compile`, `metadata:check`, у звіті прийому (`introspect` компілює результат) і в діагностиках плану промоції | клас «RPC читання повз RLS» (Р21, Р30): функція від власника таблиць читає рядки поза правами викликача | платформна спека §6.7 — речення поруч із «`SECURITY DEFINER`-функція, доступна ролі користувача, зобов'язана сама перевіряти членство/права»: «така функція SQL застосунку, що читає таблицю під RLS сама чи через досяжні функції, дає попередження компілятора з переліком таблиць» (Задача 0) |
| Р2c1-9 | Вимога §6.7 «декларація називає перевірку викликача» лишається П4 (TS-декларації сигнатур); цей план її не реалізує (архітектор) | — | немає |
| Р2c1-10 | Доповнення обходу Р2c1-5 (аудит Codex). **(а) Запис сесії в досяжній функції:** функція моделі, досягнута обходом (не сама голова — її власні записи судить `commandContextWrite` закритого коду), з будь-яким записом `commandContextWrite` — у тілі чи в опціях `SET` самого `CREATE` (`functionOption`), а також у кожній одиниці `functionSettings` цієї функції (ключ — нижче): префікс `simetra.`, `request.jwt.*`, `role`, `session_authorization`, оператор `RESET ALL` у тілі (опція `RESET ALL` записом не є, Р2b1-25), `settingsTable`, `nonLiteral` — дає `sql.command-context-reach` з `reason: "sessionWrite"`: посеред команди така функція підмінила б claims, з яких `current_user_id()` бере користувача прав. Попередження `sql.debt-session-write` (Р2c1-6) лишається для боргу, якого закритий код не досягає. **(б) Ефективний `search_path`:** одиниці `functionSettings` (`ALTER FUNCTION`) зіставляються з функцією за `схема.ім'я` без типів аргументів — з кожним перевантаженням (fail-closed: сигнатуру ідентичності компілятор зводить не так, як Postgres, — `%TYPE` не розгортає, некваліфікований тип поза моделлю лишає як є, тож зіставлення за текстом сигнатури виводило `ALTER` з іншим написанням типу з-під перевірки; рев'ю 2c1); некваліфіковане ім'я `ALTER` — у будь-якій схемі, хелпер `functionSettingsOf(fn: VerbatimUnit, units)` у `closed-forms.ts` (`grantTargetKeys` судить лише `GRANT`/`REVOKE` і тут не годиться). `hasEffectiveEmptySearchPath(unit, units)` (теж у `closed-forms.ts`, бо `reach.ts` імпортує `closed-forms.ts`) — `search_path` порожній, лише коли його задає `CREATE` (опції `CREATE` згортаються по черзі, як у Postgres: ім'я налаштування нечутливе до регістру, опція `RESET ALL` скидає задане до неї, перемагає останнє) і жодна її одиниця `functionSettings` не зачіпає `search_path` (`SET`/`RESET`) і не робить `RESET ALL` — fail-closed, без моделювання порядку. Досягнута одиниця чи вираз таблиці, що пише `search_path` (`SET`, `RESET`, `set_config`), змінює шлях викликачів аж до голови (`SET` без `LOCAL` переживає й вихід із функції з опцією), і котрі виклики виконаються після запису, статично не видно: обхід тоді повторюється з непорожнім шляхом для всіх одиниць, голови теж (fail-closed, рев'ю 2c1). Діє в класифікації некваліфікованого виклику Р2c1-5 (пункти 1 і 3). `closedShellProblem` (одна одиниця, п'ять викликачів, зокрема `debtPredicate`) і `hasEmptySearchPath` ланки виміру `ALTER FUNCTION` не читають, але `search_path` самого `CREATE` судять тим самим згортанням опцій, що й обхід (виправлено дефект 2b1: `RESET ALL` після `SET search_path = ''`; так само пізніший `SET` налаштування в іншому регістрі); вплив на спеку — немає. Натомість одне правило в ранньому блоці `runStages` поруч із `checkSqlModules` (`compiler/pipeline.ts`; набір судимих функцій відомий з метаданих і одиниць ще до стадії 3). Відхилення В5 від первісного «стадія 5, `checkLinks`» схвалив архітектор: `ALTER` у закритому модулі має дати в одній компіляції і `sql.statement-not-allowed`, і цю причину, а обидві помилки ранні; ціна — рання помилка зупиняє стадію 5, тож `sql.command-context-reach` і `sql.definer-reads-rls` автор бачить після виправлення; вплив на спеку — немає. Правило: помилка `sql.function-settings-shell` `{ function, setting }` на одиниці `functionSettings` (у будь-якому модулі чи спільному файлі), чия ціль (`functionSettingsOf` навпаки) — функція, оболонку якої судить платформа: функція закритого модуля, обробник чи функція множини (`ruledFunctions`), функція значень виміру й кожна ланка її ланцюжка (`linkProblem` у `rights/dimension-functions.ts` вимагає від ланки порожнього `search_path`), — **будь-яка**: оболонку такої функції (волатильність, `SECURITY`, `search_path`, опції `SET`) задає лише `CREATE` і судить відповідна перевірка — окремий оператор послабив би її повз неї (`IMMUTABLE` на функції виміру, `SECURITY INVOKER` на функції множини, `SET request.jwt.claims` на обробнику, скидання `search_path`); `setting` — ім'я першої дії одиниці (`volatility`, `security`, `search_path`, ім'я налаштування, `*` для `RESET ALL`). Один код на клас — без розщеплення між `sql.closed-shell`, `subscription.handler-not-closed` і перевіркою функції множини; борг від цього не росте (`debtPredicate` не змінюється) | окрема дозволена одиниця `ALTER FUNCTION … RESET search_path` інакше змінила б розв'язання імені під час виконання повз статичне судження; запис claims досяжною функцією — та сама межа довіри Р2b1-19, що й динамічний SQL | спека прав §5.3 — у реченні про досяжність додати «і функції, що пишуть налаштування сесії; оболонку судимої функції задає лише `CREATE` — окремий `ALTER FUNCTION` її не послаблює» (Задача 0) |
| Р2c1-11 | Обхід досяжності Р2c1-5 (`reachableUnits`/`reachableCalls`, `compiler/sql/reach.ts`) іде й за виразами таблиць знімка, у які досягнута одиниця пише (`INSERT`/`UPDATE`/`MERGE`): `DEFAULT`, `CHECK`, генеровані колонки, ключі й предикати індексів — fail-closed, так само як за дослівними політиками таблиці (архітектор, Ф-А); вираз таблиці із записом налаштувань сесії (`commandContextWrite`) — `reason: "sessionWrite"` на таблиці, як для досягнутої одиниці; запис у подання моделі — запис у кожне його відношення, рекурсивно (Postgres переписує запис у автооновлюване подання на базову таблицю, а котре відношення базове, без каталогу не видно; рев'ю 2c1) | `CustomTable` несе в цих виразах довільний SQL (зокрема виклик функції з нелітеральним `EXECUTE`), а Postgres обчислює їх посеред команди, коли закритий код пише рядок | спека прав §5.3 — у правилі досяжності: «досяжність охоплює й вирази таблиць, у які закритий код пише, — `DEFAULT`, `CHECK`, генеровані колонки, ключі й предикати індексів: Postgres обчислює їх посеред команди, а прийнята таблиця несе там довільний SQL» |
| Р2c1-12 | Типові привілеї застосунку (`ALTER DEFAULT PRIVILEGES … ON TABLES TO` ролі API) нової перевірки не отримують (архітектор, після звірки з кодом). Таблиця виду з `rowLevelSecurity` ≠ `"off"` несе явні `REVOKE ALL` від `PUBLIC` і кожної ролі API в одиницях доступу (`tableGrants`, `accessContracts` — `compiler/access-units.ts`), які граф створення ставить після створення таблиці (`defaultPrivilegeEdges`, `unitEdges` — `compiler/sql/dependencies.ts`): привілей, який типові привілеї дали б таблиці під час `CREATE`, відкликається тим самим застосуванням. `simetra.identities` (RLS `off`, `compiler/platform/identities.ts`) захищена інакше: типові привілеї `IN SCHEMA simetra` — `schema.reserved` (`compiler/sql/reserved-schema.ts`), глобальні типові привілеї двигун відхиляє (`engine.out-of-scope`, `reason: "global-default-privileges"` — `schema/engine/desired.ts`), а типові привілеї середовища задають кроки `schema/apply/environment.ts` | нова перевірка дублювала б захист, який уже тримають явні відкликання одиниць доступу й резервування схеми платформи | немає |
| Р2c1-13 | `sql.definer-reads-rls` (Р2c1-8) судить і подання (архітектор, Ф-Д(2)): дослівна одиниця класу `view` спільного `sql/`-файлу, модуля боргу чи закритого модуля без `security_invoker` (кожне `security_invoker` у `WITH` `CREATE VIEW` — «так»: без значення, `true`, `on`, `yes`, `1`…; інше значення — fail-closed) і **кожна** одиниця класу `materializedView` (рядки зберіг власник під час `REFRESH`, RLS читача до них не застосовується; опцію `security_invoker` Postgres для неї не приймає, компілятор її ігнорує), що читає таблицю знімка з `rowLevelSecurity` ≠ `"off"` сама чи через `reachableUnits`, з дієвим `SELECT` для ролі API — те саме консервативне правило, що й `EXECUTE` Р2c1-8 (без явних `REVOKE SELECT` і від `PUBLIC`, і від ролі API або з явним `GRANT SELECT` ролі API чи `PUBLIC`; `REVOKE` лише на колонки чи `REVOKE GRANT OPTION FOR` привілею не прибирають, і для функцій теж). Окремий `ALTER VIEW … SET/RESET (security_invoker)` — `sql.statement-not-allowed` у будь-якому файлі (`classify`, `compiler/sql/units.ts`: `AlterTableStmt` приймається лише з `objtype` таблиці й `REPLICA IDENTITY`), тож опцію задає лише `CREATE VIEW`, а скинути її мовчки нічим. Параметри — `{ object, form: "function" \| "view" \| "materializedView", tables, roles, reason?, line }` (замість `function` Р2c1-8: `form` обирає текст і підказку, як у `sql.kind-table-verbatim`). Таблиці — з того самого розбору, що й обхід (`relationReads`, `compiler/sql/reach.ts`): некваліфіковане ім'я — у будь-якій схемі, крім тіла з ефективним порожнім `search_path`; таблиці підзапитів досяжних дослівних політик не входять (рядків викликачеві не віддають); `reason: "unknown"` — голова недосудна (`unjudgeable`) чи обхід (`reachableCalls`) знайшов недосудну ціль, крім `sessionWrite` | подання без `security_invoker` і матеріалізоване подання читають від імені власника — та сама дірка «читання повз RLS», що й RPC; попередження, бо подання може саме фільтрувати рядки функціями прав | платформна спека §6.7 — речення Задачі 0 про `SECURITY DEFINER` над RLS поширено на подання й матеріалізовані подання |
| Р2c1-14 | Уточнює Р2b1-22 і Р2c1-6 (архітектор, Р-1 (б)). Попередження `sql.debt-session-write` дістає **кожна** одиниця, яку рахує боргом `debtPredicate` (`compiler/sql/debt.ts`), — у спільних `sql/`-файлах так само, як у модулях `CustomTable`/`PgEnum`. Помилкою `sql.command-context-write` лишаються префікс `simetra.` у будь-якій формі, оператор `RESET ALL`, `settingsTable` — і кожна одиниця, що боргом не є: функція в закритій оболонці (зокрема в модулі прийнятої таблиці — раніше там попередження діставала будь-яка одиниця модуля), закриті модулі, обробники, функції множини. Борговий статус бере сам `debtPredicate` (його експортовано): `checkSqlModules` (`compiler/sql/closed-forms.ts`) приймає предикат `isDebt`, який `runStages` будує з тих самих входів, що й ратчет (`kindTables` — зі знімка стадії 3; без неї — з порожнього: компіляцію вже зупиняють помилки вище за течією, а ратчет тоді не судиться), а параметр `project` у `checkSqlModules` зник. Маркер боргової помилки — нейтральний `unit: "debt"` замість `module: "debt"`: спільний файл модулем не є; текст повідомлень (en/uk) не називає «прийнятої таблиці», підказка попередження додає, що функція в закритій оболонці боргом не є | досяжну з закритого коду функцію з записом сесії вже відмовляє `sql.command-context-reach` (`sessionWrite`, Р2c1-10), а новий неперелічений борг — `sql.debt-grows`, тож попередження дістає лише прийнятий борг реальної бази, якого закритий код не досягає; одне правило боргу для ратчета й для запису сесії не дає їм розійтися | спека прав §5.3 — речення про SQL застосунку: «борговий SQL прийнятих таблиць і спільних файлів (одиниця, яку рахує ратчет боргу; функція в закритій оболонці, обробник і функція множини боргом не бувають) не пише `simetra.*` (помилка), запис інших захищених налаштувань у ньому — попередження» |
| Р2c1-15 | Тіло функції не змінює таблиці виду (архітектор, Р-2 (б), мінімальна форма; `closedShellProblem` не змінюється). Тіло **будь-якої** функції чи процедури (`LANGUAGE sql` — рядкове й `BEGIN ATOMIC`, `plpgsql`) у будь-якому файлі — спільному `sql/`, модулі боргу, модулі виду, зокрема в закритій оболонці, — а в ньому й текст кожного літерального `EXECUTE`, тіло функції, яку тіло визначає, і блоку `DO` plpgsql (рекурсивно) не містить оператора, чия ціль — таблиця виду (`kindTables`, Р2c1-1), крім DML (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`) і `LOCK`. Ціль — `bodyStatementTargets` (`compiler/sql/unit-target.ts`; той самий розбір імен `objectTarget`/`table`, що й `statementTargets`, який знає лише класи одиниць файлів і цілей `ALTER TABLE`, `TRUNCATE`, `DROP` не має — відхилення від «`statementTargets`/`unitTargets`» завдання): кожне відношення оператора поза вкладеним оператором, fail-closed без розбору, що оператор з ним робить (`ALTER TABLE`, `TRUNCATE`, `CREATE INDEX`, політика, тригер, `GRANT`/`REVOKE`, `INHERITS`/`PARTITION OF`, `REFERENCES`, `LIKE`, `COPY`, `CLUSTER`, `VACUUM`/`ANALYZE`, створення відношення з іменем таблиці виду); відношення чи його член, названий списком імен (`COMMENT`, `SECURITY LABEL`, `DROP`); оператор над схемою цілком (`DROP SCHEMA`, `ALTER SCHEMA … RENAME`/`OWNER`, `GRANT`/`REVOKE … ON ALL TABLES IN SCHEMA`) — перша таблиця виду схеми. Таблиця, яку оператор поза DML лише читає вкладеним запитом (`CREATE TABLE … AS SELECT`, підзапит політики), ціллю не є. Некваліфіковане ім'я — fail-closed за будь-якою схемою, як у Р2c1-1 (`kindTableNamed`): порожній `search_path` не враховується, бо тіло може змінити шлях саме, а збіг дає лише відношення з іменем таблиці виду. Код — `sql.kind-table-verbatim` з `form: "functionBody"` і параметрами `{ identity, function, table, form, statement, line }` (`statement` — вузол оператора, як у `sql.statement-not-allowed`): правило одне — таблицю виду визначає лише платформа, а `form` обирає текст і підказку (як у `sql.definer-reads-rls`, Р2c1-13). Перевірка — `checkKindTableVerbatim` у ранньому блоці `runStages`, як Р2c1-1, тож така функція зупиняє й ратчет боргу; у модулі виду теж (функцію модуль приймає, тож діагностика там єдина). Борг: `debtPredicate` виключає таку функцію (`bodyKindTable`; `debtPredicate`, `debtUnits` і `checkDebt` отримують `parse`), тож неперелічена дає лише `sql.kind-table-verbatim`, без `sql.debt-grows`, а перелічена — ще й `sql.debt-stale`, як Р2c1-1. Не судяться: тіло іншої мови, нелітеральний `EXECUTE` і `EXECUTE` підготовленого оператора (наявна межа, закритий код їх не досягає — Р2c1-5), оператори на всю роль (`DROP OWNED`, `REASSIGN OWNED`), типові привілеї (Р2c1-12), `ALTER TABLE ALL IN TABLESPACE` | проба рев'ю: функція в закритій оболонці (`VOLATILE SECURITY DEFINER SET search_path = ''`) створювала політику на `public.task` повз Р2c1-1, а `TRUNCATE` чи `ALTER TABLE … DISABLE ROW LEVEL SECURITY` у тілі обходять RLS; DML і `LOCK` лишаються під RLS і правами таблиці | спека прав §6.1 — речення про дослівну політику чи тригер: «…і не створюється й не змінюється тілом функції: тіло функції чи процедури в будь-якому файлі (зокрема текст літерального `EXECUTE`) робить з таблицею виду лише DML і `LOCK`, а будь-який інший оператор на ній — та сама помилка» |

## Відомі обмеження

- Борговий тригер прийнятої таблиці з динамічним SQL, досяжний каскадом FK
  чи записом обробника посеред команди, статично не закривається (Р2c1-7).
- `set_config` з нелітеральним ім'ям у боргу (`set_config('simetra.' || x, …)`) — лише попередження `sql.debt-session-write` (ім'я статично не відоме), як і нелітеральний `EXECUTE` боргу; скіл радить конверсію.
- Обхід досяжності не йде за тригерами таблиць, у які пише закритий код (лише за політиками), — борговий тригер прийнятої таблиці лишається обмеженням Р2c1-7.
- Обхід досяжності не має голів у запитах рухів (вони виконуються в оболонці
  проведення, П4) і не йде за викликами з `CHECK` доменів і опцій агрегатів.
- Довіра до схем провайдера — за переліком схем з винятками
  `UNSAFE_PROVIDER_FUNCTIONS`; нова функція провайдера, що виконує SQL з
  рядка, потребує поповнення переліку.
- `sql.definer-reads-rls` не знає власника функції й вимог `FORCE`: функцію,
  власник якої не обходить RLS, теж позначено (попередження, не помилка).
- Перевантаження за типами аргументів компілятор не розрізняє: обхід судить
  кожну одиницю з таким ім'ям (як `rights/dimension-functions.ts`).
- Декларація перевірки викликача `SECURITY DEFINER` (§6.7) — П4.
- Типові привілеї застосунку (`ALTER DEFAULT PRIVILEGES … ON TABLES`) діють
  лише на `CustomTable` — власну територію застосунку: таблиці видів їх
  відкликають явно, схема платформи зарезервована (Р2c1-12).
- Тіло функції судиться за відношеннями своїх операторів (Р2c1-15): тіла
  інших мов, нелітеральний `EXECUTE` і оператори на всю роль (`DROP OWNED`,
  `REASSIGN OWNED`) — поза судженням.
- `relationReads` (`compiler/sql/reach.ts`), з якого бере таблиці
  `sql.definer-reads-rls` (`compiler/sql/definer-reads.ts`, Р2c1-8), судить
  некваліфіковане відношення функції з порожнім `search_path` як вбудоване й
  не знає, що досягнута одиниця записала `search_path` (Р2c1-10 (б)): це
  зачіпає лише попередження `sql.definer-reads-rls` і лише в бік пропущеного
  попередження, не хибного дозволу — обхід `sql.command-context-reach`
  повторюється з непорожнім шляхом.

## Review Focus

1. **Виклик через `PERFORM` у plpgsql:** обробник підписки кличе `PERFORM public.helper()` зі спільного файлу, а `helper` робить `EXECUTE format(…)` — `sql.command-context-reach` з ланцюжком. Тест — Задача 3 (`plpgsql-perform`).
2. **Функції розширень і провайдера:** закрита функція кличе `extensions.gen_random_bytes(16)` і `auth.uid()` — без помилки; функція моделі, оголошена в схемі провайдера (якщо компілятор це дозволяє), обходиться. Тест — Задача 3 (`provider-trusted`, `model-over-provider`).
3. **Прийом бази з `SET ROLE` у боргу:** боргова функція прийнятої таблиці з `SET ROLE postgres` — попередження `sql.debt-session-write`, компіляція без помилок; та сама з `set_config('simetra.command', …)` — помилка. Тест — Задача 4.
4. **Дослівна політика в спільному файлі на ТЧ чи на системному довіднику прав:** помилка `sql.kind-table-verbatim`; та сама на `CustomTable` — без помилки (борг). Тест — Задача 2.
5. **`SECURITY DEFINER` без відкликання `EXECUTE`:** функція без жодного явного гранту, що читає таблицю виду, — попередження (`PUBLIC` і ролі API провайдера мають `EXECUTE` за замовчуванням); з `REVOKE … FROM PUBLIC` лише — попередження (типові привілеї провайдера лишаються); з відкликанням і від `PUBLIC`, і від кожної ролі API — без попередження; `SECURITY DEFINER`, поставлене `ALTER FUNCTION`, — теж попередження. Тест — Задача 5.

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/schemas/project.ts` | `PROVIDER_SCHEMAS` |
| `packages/simetra/src/schema/engine/{desired,index}.ts`, `schema/engine/provider/supabase.ts`, `packages/designer/src/schema-engine/census-read.ts`, `packages/simetra/src/schema/__tests__/engine-provider.test.ts` | перелік схем з T0 |
| `packages/simetra/src/compiler/stages/links.ts` | виклики нових перевірок стадії 5 |
| `packages/simetra/src/compiler/sql/kind-table-verbatim.ts` (новий) | `sql.kind-table-verbatim` |
| `packages/simetra/src/compiler/sql/reach.ts` (новий) | `reachableCalls`, `DYNAMIC_SQL_BUILTINS`, `sql.command-context-reach` |
| `packages/simetra/src/compiler/sql/definer-reads.ts` (новий) | `sql.definer-reads-rls` |
| `packages/simetra/src/compiler/sql/{closed-forms,command-context}.ts` | борговий SQL під перевіркою контексту |
| `packages/simetra/src/compiler/rights/dimension-functions.ts` | імпорт `DYNAMIC_SQL_BUILTINS` |
| `packages/simetra/src/compiler/{diagnostics,messages}.ts` | коди |
| `packages/simetra/src/compiler/__tests__/{kind-table-verbatim,reach,definer-reads,closed-forms}.test.ts` | unit |
| `packages/designer/skills/simetra-metadata/references/people-and-rights.md` і довідник SQL-модулів скіла | нові правила |
| `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` | зняти два рядки боргу |

Ратчет боргу в тестах: `readFiles` за відсутності `sql-debt.json` дає порожній перелік, тож кожна дослівна одиниця спільного файлу чи модуля боргу, що є боргом, потребує запису в `sql-debt.json` фікстури тесту — інакше `sql.debt-grows` (рання помилка) зупинить компіляцію раніше за стадію 5; кожен рядок Задач 2–5, дослівні одиниці якого є боргом (зокрема рядок `GRANT … → sql.generated-grant` Задачі 2 і рядки помилок обходу Задачі 3, де спільна функція з `EXECUTE format` — борг), кладе такий файл, як `acceptDebt` у `function-execute.test.ts`. Фікстури — наявні будівники (`withRoles`, `policyDomain`, `promotableTaskNote`
з `fixtures/rights.ts`) плюс SQL-файли, які тест кладе в карту файлів
(`files.set(<шлях>, <SQL>)`, як `policyDomain` кладе обробник лічильника).
Повторюваний SQL (функція з `EXECUTE format`, боргова функція з `SET ROLE`)
— сталими в наявному `fixtures/sql-shape.ts`.

---

### Задача 0: правки спек і боргу

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (§5.3), `docs/superpowers/specs/2026-10-06-promotion-design.md` (§9.4), `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (§6.7), `docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md` (§4, §5)

- [ ] **Step 1:** Спека прав §5.3, кінець речення про SQL застосунку: «…нелітеральний динамічний SQL у закритих модулях і обробниках заборонено (`dynamicSql`), а нелітеральний динамічний SQL і тіла функцій мовами поза `sql`/`plpgsql` у спільних файлах — відоме обмеження до 2c» → «…нелітеральний динамічний SQL у закритих модулях і обробниках заборонено (`dynamicSql`), і закритий код не досягає викликами функції з нелітеральним динамічним SQL, тілом іншої мови чи невідомої (функції схем провайдера довірені) і функції, що пишуть налаштування сесії, а оболонку судимої функції окремий `ALTER FUNCTION` не послаблює; борговий SQL прийнятих таблиць не пише `simetra.*` (помилка), запис інших захищених налаштувань у ньому — попередження; борговий тригер прийнятої таблиці з динамічним SQL, досяжний каскадом чи записом обробника посеред команди, — відоме обмеження» (Р2c1-5, Р2c1-6, Р2c1-7, Р2c1-10). У тому самому реченні вставку «…закритих модулів, обробників і спільних SQL-файлів, крім боргового SQL прийнятих таблиць `CustomTable`; обробник підписки боргом не буває…» замінити на «…закритих модулів, обробників і спільних SQL-файлів (борговий SQL прийнятих таблиць — за правилом нижче); обробник підписки боргом не буває…», щоб речення не суперечило саме собі.
- [ ] **Step 2:** Спека промоції §9.4, абзац «Борг `CustomTable`»: після «нових дослівних політик, тригерів, в'юх і функцій поза закритою оболонкою не додається навіть у `CustomTable`» — «; дослівна політика чи тригер на таблиці виду боргом не буває — це помилка компілятора в будь-якому файлі ([спека прав](2026-10-17-rights-design.md) §6.1)» (Р2c1-1).
- [ ] **Step 3:** Платформна спека §6.7, після пункту «`SECURITY DEFINER`-функція, доступна ролі користувача, зобов'язана сама перевіряти членство/права…»: «`SECURITY DEFINER`-функція SQL застосунку (спільні файли, закриті модулі й борг прийнятих таблиць; крім обробників і функцій множини) з `EXECUTE` для ролей API, що читає таблицю під RLS сама чи через досяжні функції й подання, — попередження компілятора з переліком таблиць (клас «RPC читання повз RLS», Р30)» (Р2c1-8).
- [ ] **Step 4:** Борг: видалити лише два пункти списку — у §4 пункт «Дослівна політика чи тригер на таблиці виду в борговому SQL» і в §5 пункт «Виклик динамічного SQL із закритого коду (2c)»; решта пунктів розділів — живий борг і лишається.
- [ ] **Step 5:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/plans/2026-10-15-p3-2b-residual-debt.md
git commit -m "docs(spec): заборона дослівних політик і тригерів на таблицях виду, досяжність динамічного SQL, SECURITY DEFINER над RLS"
```

---

### Задача 1: схеми провайдера в T0

**Files:**
- Modify: `packages/simetra/src/model/schemas/project.ts`, `packages/simetra/src/model/index.ts` (експорт, якщо потрібен), `schema/engine/provider/supabase.ts`, `schema/engine/desired.ts`, `schema/engine/index.ts`, `packages/designer/src/schema-engine/census-read.ts`, `packages/designer/src/schema-engine/pg-delta/policy.ts`, `packages/designer/src/tools/database-tools.ts`, тести й фікстури designer, що імпортують `SUPABASE_SCHEMAS` (`grep -rn SUPABASE_SCHEMAS packages --include=*.ts`)
- Test: `packages/simetra/src/schema/__tests__/engine-provider.test.ts`

**Interfaces:**
- Produces: `PROVIDER_SCHEMAS: Readonly<Record<DatabaseProvider, readonly string[]>>` (`supabase` — нинішній перелік `SUPABASE_SCHEMAS` дослівно, у тому самому порядку).

- [ ] **Step 1:** `engine-provider.test.ts` бере `PROVIDER_SCHEMAS.supabase` замість `SUPABASE_SCHEMAS` — Run: `pnpm --filter simetra test engine-provider` — FAIL (імпорту немає).
- [ ] **Step 2: Implement:** перенести перелік, видалити `SUPABASE_SCHEMAS` з `supabase.ts` і з реекспорту `schema/engine/index.ts`, оновити споживачів (`grep -rn SUPABASE_SCHEMAS packages --include=*.ts` — порожньо).
- [ ] **Step 3:** Run: `pnpm --filter simetra test engine-provider desired && pnpm --filter @simetrajs/designer test engine-policy && pnpm typecheck && pnpm lint` — PASS (лінт ярусів: T2 імпортує T0 — дозволено).
- [ ] **Step 4: Commit**

```bash
git add packages/simetra/src packages/designer/src
git commit -m "refactor(model): схеми провайдера — факт T0"
```

---

### Задача 2: дослівні політики й тригери на таблицях виду

**Files:**
- Create: `packages/simetra/src/compiler/sql/kind-table-verbatim.ts`
- Modify: `packages/simetra/src/compiler/pipeline.ts` (ранній блок `runStages`), `compiler/sql/debt.ts` (`debtPredicate`, `checkDebt`, `debtUnits` — множина таблиць виду й `parse` для `unitTargets`), `compiler/compile.ts` (якщо передає аргументи `debtUnits`), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/kind-table-verbatim.test.ts`, `sql-debt.test.ts`, `messages.test.ts`

**Interfaces:**
- Produces: `checkKindTableVerbatim(objects: readonly ParsedObject[], physical: PhysicalSnapshot, units: readonly VerbatimUnit[], parse: SqlParser): Diagnostic[]`; код `sql.kind-table-verbatim` (`{ identity, table, form, line }`).

- [ ] **Step 1: Write the failing tests (unit),** одна таблиця `it.each` над `policyDomain()` з SQL-файлом `sql/public/extra.sql` (шляхи карти файлів — від кореня метаданих, як `sql/public/count-comment.sql` у `policyDomain`) (і окремо — у модулі боргу прийнятої таблиці `promotableTaskNote()`), очікуваний **код** на кожен рядок:
  - `CREATE POLICY p ON public.task FOR SELECT TO authenticated USING (true)` → `sql.kind-table-verbatim` (`form: "policy"`, `table: "public.task"`);
  - те саме на ТЧ `public.task_checklist`, на таблицю рухів регістра (`HOURS_TABLES.movements`), на основну таблицю системного довідника прав `org` → `sql.kind-table-verbatim`;
  - `CREATE TRIGGER t BEFORE UPDATE ON public.task FOR EACH ROW EXECUTE FUNCTION public.count_comment()` → `sql.kind-table-verbatim` (`form: "trigger"`); `CREATE CONSTRAINT TRIGGER …` — те саме;
  - та сама політика, вже перелічена в `sql-debt.json`, → `sql.kind-table-verbatim` і `sql.debt-stale`; неперелічена — лише `sql.kind-table-verbatim`, **без** `sql.debt-grows` (мутація: лишити такі одиниці в `debtPredicate` — рядок червоніє на зайвому `sql.debt-grows`);
  - `CREATE POLICY p ON public.task_notes …` (таблиця `CustomTable`) → лише вимога боргу (`sql.debt-grows`, якщо не перелічено), без `sql.kind-table-verbatim`;
  - фіксація Р2c1-2: `ALTER TABLE public.task DISABLE ROW LEVEL SECURITY`, `ALTER TABLE public.task DISABLE TRIGGER ALL`, `CREATE RULE r AS ON UPDATE TO public.task DO INSTEAD NOTHING`, `ALTER POLICY …` → `sql.statement-not-allowed`; `GRANT INSERT ON public.task TO authenticated` → `sql.generated-grant`.
  - `it("a promotion removes verbatim policies of the promoted table")` — промоція `promotableTaskNote()` з борговою політикою на `task_notes` (за зразком `operations-promote.test.ts`) → компіляція результату без `sql.kind-table-verbatim` (Р2c1-3).
  - Мутація: прибрати фільтр «не `CustomTable`» — рядок `task_notes` червоніє; прибрати ТЧ і похідні таблиці з перевірки (лише основні) — рядки ТЧ і рухів регістра червоніють.
- [ ] **Step 2:** Run: `pnpm --filter simetra test kind-table-verbatim messages` — FAIL.
- [ ] **Step 3: Implement** за Р2c1-1: множина таблиць виду — `physical.tables`, чий `origin.objectId` належить об'єкту з `kind !== "CustomTable"` (через `objects`, без назви виду в розгалуженні: факт «таблиця прийнята» — `isDeclaredTable`, як у `rowLevelSecurityOf`); пропуск одиниць закритих модулів (вони вже мають `kindModule`). Виклик — у ранньому блоці `runStages` над `stage3.physical` (коли `stage3` є); `debtPredicate` виключає такі одиниці з боргу (Р2c1-1).
- [ ] **Step 4:** Run: `pnpm --filter simetra test kind-table-verbatim messages links operations-promote field-ratchet && pnpm --filter simetra typecheck` — PASS. `pnpm metadata:check` — код 0 (приклад не має дослівних політик на таблицях виду; якщо має — це дефект прикладу, стоп і звіт архітектору).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): дослівна політика чи тригер на таблиці виду — помилка в будь-якому файлі"
```

---

### Задача 3: досяжність недосудного SQL із закритого коду

**Files:**
- Create: `packages/simetra/src/compiler/sql/reach.ts`
- Modify: `packages/simetra/src/compiler/stages/links.ts` (виклик у `checkLinks`), `compiler/sql/closed-forms.ts` (`functionSettingsOf`, `hasEffectiveEmptySearchPath`), `compiler/pipeline.ts` (передати `derivedFunctions`, якщо `checkLinks` їх ще не має), `compiler/rights/dimension-functions.ts` (імпорт `DYNAMIC_SQL_BUILTINS`; функції значень виміру — множина судимих для `sql.function-settings-shell`), `compiler/diagnostics.ts`, `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/reach.test.ts`, `messages.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_SCHEMAS` (Задача 1); `unitCalls`, `unitRelations` (`compiler/sql/dependencies.ts`), `plpgsqlExpressionTrees` (`compiler/sql/rewrite/plpgsql-body.ts`), `ruledFunctions`, `closedModuleOwners` (`closed-forms.ts`), `membershipFunctions` і `derivedFunctions` (параметри `checkLinks`/контракти), `PLATFORM_SCHEMA`.
- Produces:
  - `type Unjudgeable = "nonLiteralExecute" | "language" | "dynamicBuiltin" | "unknown"`; `type ReachReason = Unjudgeable | "sessionWrite"` (Р2c1-10);
  - `reachableUnits(head: VerbatimUnit, units: readonly VerbatimUnit[], trusted: ReachTrust, parse: SqlParser, plpgsql: PlpgsqlParser): { unit: VerbatimUnit; chain: string[] }[]` — усі одиниці моделі (функції, подання, дослівні політики), досяжні з голови тим самим обходом; на ньому стоять `reachableCalls` і `checkDefinerReads` (Задача 5);
  - `hasEffectiveEmptySearchPath(unit: VerbatimUnit, units: readonly VerbatimUnit[]): boolean` і `functionSettingsOf(fn: VerbatimUnit, units: readonly VerbatimUnit[]): VerbatimUnit[]` — у `closed-forms.ts` (Р2c1-10 (б)); обхід бере їх замість `hasEmptySearchPath`; `closedShellProblem` і `hasEmptySearchPath` `ALTER FUNCTION` не читають, але згортають опції `CREATE` тим самим правилом (`foldedEmptySearchPath`);
  - `judgedFunctionIdentities(objects, project, units): ReadonlySet<string>` — функції закритих модулів, `ruledFunctions`, функції значень виміру та їхні ланки (з `rights/dimension-functions.ts` експортується збирач функцій виміру й ланок);
  - код `sql.function-settings-shell` (`{ function, setting: string }` — ім'я першої дії одиниці; ранній блок `runStages` поруч із `checkSqlModules` — відхилення В5, Р2c1-10);
  - `type ReachTrust = { providerSchemas: ReadonlySet<string>; generated: ReadonlySet<string> }` — довірені множини обходу (`generated` — `схема.ім'я` з `membershipFunctions` і `derivedFunctions`); будує `checkLinks`;
  - `reachableCalls(head: VerbatimUnit, units: readonly VerbatimUnit[], trusted: { providerSchemas: ReadonlySet<string>; generated: ReadonlySet<string> }, parse: SqlParser, plpgsql: PlpgsqlParser): { function: string; chain: string[]; reason: ReachReason }[]` (`trusted: ReachTrust`) — усі недосудні цілі й досяжні функції із записом сесії, досяжні з голови, кожна раз (обхід у ширину з `visited`; `generated` — `схема.ім'я` згенерованих функцій схем застосунку);
  - `unjudgeable(unit: VerbatimUnit, plpgsql: PlpgsqlParser): Unjudgeable | undefined` — власний предикат Р2c1-5;
  - `export const UNSAFE_PROVIDER_FUNCTIONS: ReadonlySet<string>` (кваліфіковані імена);
  - `export const DYNAMIC_SQL_BUILTINS: ReadonlySet<string>` (перенесено з `dimension-functions.ts`);
  - код `sql.command-context-reach` (`{ function, chain, reason }`).

- [ ] **Step 1: Write the failing tests (unit),** `describe("reachableCalls")` таблицею: голова — обробник підписки `count_comment` у `policyDomain()` (чи функція закритого модуля довідника), спільні функції — SQL-файлом:
  - `plpgsql-perform` — обробник `PERFORM public.helper()`, `helper` (plpgsql) — `EXECUTE format('SELECT %s', 1)` → `{ function: "public.helper", chain: ["public.count_comment", "public.helper"], reason: "nonLiteralExecute" }`;
  - `sql-chain` — `LANGUAGE sql` ланцюг з трьох функцій, остання — `LANGUAGE plpython3u` → `reason: "language"`, ланцюг з трьох;
  - `literal-execute` — `EXECUTE 'SELECT public.helper2()'` у plpgsql: виклик у літералі обходиться (`helper2` з нелітеральним `EXECUTE` → знахідка);
  - `dynamic-builtin` — `SELECT query_to_xml('select 1', true, true, '')` → `reason: "dynamicBuiltin"`;
  - `provider-trusted` — `extensions.gen_random_bytes(16)` і `auth.uid()` → знахідок немає;
  - `model-over-provider` — функція моделі в схемі з `PROVIDER_SCHEMAS` (якщо компілятор приймає одиницю в такій схемі; якщо ні — рядок таблиці перевіряє, що одиниці там бути не може, з її кодом) з нелітеральним `EXECUTE` → знахідка (модель має пріоритет);
  - `unknown-schema` — `other_schema.fn()` поза моделлю й провайдером → `reason: "unknown"`;
  - `cycle` — `a` кличе `b`, `b` кличе `a` → обхід завершується, знахідок немає;
  - `platform-trusted` — обробник кличе `simetra.current_user_id()` і згенеровану функцію членства `<таблиця>_my_member(…)` → знахідок немає;
  - `unqualified-session-path` — обробник без `SET search_path` кличе некваліфіковану `helper()`, а модель має `public.helper` з нелітеральним `EXECUTE` → знахідка; той самий виклик з голови з `SET search_path = ''` → вбудована, знахідок немає;
  - `view-edge` — закрита функція читає подання спільного файлу, визначення якого кличе функцію з нелітеральним `EXECUTE` → знахідка з поданням у ланцюжку;
  - `unsafe-provider` — `extensions.dblink_exec(…)` → `reason: "dynamicBuiltin"`; `unqualified-unsafe-provider` — голова без `SET search_path` кличе некваліфіковану `dblink_exec(…)` → `dynamicBuiltin`;
  - `policy-edge` — обробник пише в прийняту таблицю з RLS, дослівна політика якої `USING (public.f(id))`, а `f` має нелітеральний `EXECUTE` → знахідка з політикою в ланцюжку;
  - `literal-only` — функція лише з літеральним `EXECUTE 'SELECT 1'` (без нелітерального) → знахідок немає (`unjudgeable` не рахує літеральний `EXECUTE`);
  - `reached-session-write` — обробник кличе спільну функцію з `PERFORM set_config('request.jwt.claims', '{}', true)` → `reason: "sessionWrite"`; та сама функція, яку ніхто із закритого коду не кличе, — лише попередження боргу (Задача 4);
  - `alter-reset-search-path` — голова з `SET search_path = ''` у `CREATE` і окрема одиниця `ALTER FUNCTION … RESET search_path` кличе некваліфіковану `helper()`, модель має `public.helper` з нелітеральним `EXECUTE` → знахідка; `function-settings-shell` (через `compile`, таблицею; `ALTER` — у спільному файлі, де він дозволений): ціль — функція закритого модуля з `SECURITY INVOKER` і `ALTER … SECURITY DEFINER` → `setting: "security"`; ціль — функція множини скоупу з `ALTER … RESET search_path` → `search_path`; ціль — обробник з `ALTER … RESET ALL` → `*`; ціль — функція значень виміру з `ALTER … IMMUTABLE` → `volatility`; ціль — ланка ланцюжка функції виміру з `ALTER … RESET search_path` → `search_path`; фікстури рядків «без помилки» приймають борг `ALTER` (`acceptDebt`: `functionSettings` — борг за `debtPredicate`); `ALTER` у закритому модулі дає і `sql.statement-not-allowed`, і `sql.function-settings-shell` — тест перевіряє обидва коди; ціль — обробник з `ALTER … SET request.jwt.claims = '{}'` у модулі боргу → помилка; `ALTER` без аргументів зіставляється з перевантаженням; той самий `ALTER` у модулі боргу — теж помилка; ціль — звичайна спільна функція → без помилки й без нового `sql.debt-grows`; `reached-alter-claims` — досягнута функція з окремим `ALTER FUNCTION … SET request.jwt.claims = '{}'` → `sessionWrite`.
  - `describe("checkLinks")` (через `compile`): `sql.command-context-reach` на голові для `plpgsql-perform`; обробник підписки з власним нелітеральним `EXECUTE` — `subscription.handler-not-closed` (стадія 5, як і обхід), без `sql.command-context-reach` на власне тіло; нелітеральний `EXECUTE` у спільній функції, яку ніхто із закритого коду не кличе, — без діагностики (лише борг).
  - Мутації: прибрати обхід виразів plpgsql — `plpgsql-perform` червоніє; довіряти будь-якій кваліфікованій схемі — `unknown-schema` червоніє; перевіряти перелік схем раніше за модель — `model-over-provider` червоніє; некваліфіковане завжди вбудоване — `unqualified-session-path` червоніє; взяти `closedShellProblem` замість `unjudgeable` — `literal-only` червоніє; не судити записи досяжних функцій — `reached-session-write` червоніє; `hasEmptySearchPath` замість ефективного — `alter-reset-search-path` червоніє; прибрати правило `sql.function-settings-shell` — рядки `function-settings-shell` червоніють; судити лише `security`/`search_path`/`RESET ALL` — рядок `volatility` червоніє.
- [ ] **Step 2:** Run: `pnpm --filter simetra test reach closed-forms messages` — FAIL.
- [ ] **Step 3: Implement** за Р2c1-5 і Р2c1-10, виклик — у `checkLinks`. Виклики й відношення plpgsql: `plpgsqlExpressionTrees` дає дерева розбору — збирач викликів (`FuncCall`) і відношень (`RangeVar`) обходить дерева (той самий обхід, що `unitCalls`/`unitRelations` для `sql`), текст літерального `EXECUTE` розбирається й обходиться так само; `compiler/operations/promote/sql.ts` не переводиться (поза обсягом: його `calls` має іншу семантику присвоєнь). Недосудність — `unjudgeable`, не `closedShellProblem`. Коментар «чому» — межа довіри Р2b1-19, пріоритет моделі, розв'язання некваліфікованого імені за `search_path` сесії.
- [ ] **Step 4:** Run: `pnpm --filter simetra test reach closed-forms rights-dimension operations-promote messages field-ratchet && pnpm --filter simetra typecheck` — PASS; `pnpm metadata:check` — код 0.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): закритий код не досягає функцій з динамічним SQL чи іншою мовою"
```

---

### Задача 4: борговий SQL прийнятих таблиць під перевіркою контексту

**Files:**
- Modify: `packages/simetra/src/compiler/sql/command-context.ts`, `compiler/sql/closed-forms.ts`, `compiler/diagnostics.ts` (`WARNING_RULES`), `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/closed-forms.test.ts` (чи наявний файл тестів `command-context`), `messages.test.ts`

**Interfaces:**
- Produces: `commandContextWrite(…): CommandContextHit[]` (`CommandContextHit { form: CommandContextWrite; setting?: string }`; порожній масив — записів немає; наявні виклики беруть перший елемент); код `sql.debt-session-write` (попередження, параметри як у `sql.command-context-write`).

- [ ] **Step 1: Write the failing tests (unit),** таблицею над модулем боргу прийнятої таблиці (`promotableTaskNote()` чи інша фікстура `CustomTable` з модулем `.sql`):
  - функція з `PERFORM set_config('simetra.command', '{}', true)` → `sql.command-context-write` (`form: "setConfig"`);
  - `SET simetra.rights_maintenance = 'on'` у тілі → `sql.command-context-write`;
  - `SET ROLE postgres` → `sql.debt-session-write` (`form: "setStatement"`), помилок немає;
  - `PERFORM set_config(v_name, 'x', true)` → `sql.debt-session-write` (`form: "nonLiteral"`);
  - `set_config('request.jwt.claims', …)` → `sql.debt-session-write`;
  - обробник підписки в модулі боргу з `SET ROLE` → як і раніше `sql.command-context-write` (обробник боргом не буває);
  - `SET ROLE postgres` **перед** `PERFORM set_config('simetra.command', …)` в одній функції → `sql.command-context-write` (не лише попередження);
  - оператор `RESET ALL` у тілі → `sql.command-context-write`; `UPDATE pg_settings SET setting = 'x' WHERE name = 'role'` → `sql.command-context-write` (`settingsTable`).
  - Наявні тести `sql.command-context-write` для спільних файлів і закритих модулів — без змін.
  - Мутації: судити борговий модуль усіма помилками — рядки `SET ROLE` і `nonLiteral` червоніють; не судити борговий модуль зовсім — рядок `simetra.command` червоніє; брати лише перший запис — рядок «`SET ROLE` перед `simetra.command`» червоніє.
- [ ] **Step 2:** Run: `pnpm --filter simetra test closed-forms command-context messages` — FAIL.
- [ ] **Step 3: Implement** за Р2c1-6: у першому проході `checkSqlModules` одиниця модуля боргу (не `ruled`) більше не пропускається — серед усіх записів одиниці `setting` з префіксом `simetra.`, `RESET ALL` чи `settingsTable` дає помилку, інакше — попередження. Коментар біля колишнього `continue` замінити причиною Р2c1-6.
- [ ] **Step 4:** Run: `pnpm --filter simetra test closed-forms command-context messages field-ratchet && pnpm --filter simetra typecheck` — PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): борговий SQL прийнятих таблиць не пише налаштувань платформи"
```

---

### Задача 5: попередження `SECURITY DEFINER` над RLS

**Files:**
- Create: `packages/simetra/src/compiler/sql/definer-reads.ts`
- Modify: `packages/simetra/src/compiler/stages/links.ts`, `compiler/diagnostics.ts` (`WARNING_RULES`), `compiler/messages.ts`
- Test: `packages/simetra/src/compiler/__tests__/definer-reads.test.ts`, `messages.test.ts`

**Interfaces:**
- Consumes: `reachableUnits`, `ReachTrust`, `functionSettingsOf` (Задача 3), `unitRelations`, `plpgsqlExpressionTrees`, `grantTargetKeys` (`compiler/function-execute.ts` — канонічна сигнатура цілі гранту), `PROVIDER_API_ROLES`.
- Produces: `checkDefinerReads(objects: readonly ParsedObject[], project: Project, physical: PhysicalSnapshot, units: readonly VerbatimUnit[], trusted: ReachTrust, parse: SqlParser, plpgsql: PlpgsqlParser): Diagnostic[]` (виклик у `checkLinks`, що вже будує `ReachTrust` для обходу`; код `sql.definer-reads-rls` (`{ object, form, tables, roles, reason?, line }`, Р2c1-13).

- [ ] **Step 1: Write the failing tests (unit),** таблиця над `policyDomain()` зі спільним SQL-файлом, очікування — є/немає попередження й параметри:
  - `SECURITY DEFINER SET search_path = ''` sql-функція `SELECT count(*) FROM public.task`, `GRANT EXECUTE … TO authenticated` → попередження, `tables: "public.task"`, `roles` містить `authenticated`;
  - та сама без жодного гранту й без відкликань → попередження, `roles` — `PUBLIC`, `authenticated`, `anon`;
  - лише `REVOKE EXECUTE … FROM PUBLIC` → попередження (`roles` — ролі API: типові привілеї провайдера);
  - `REVOKE` від `PUBLIC`, `authenticated` і `anon` → без попередження;
  - звичайна спільна функція (не судима платформою): `SECURITY INVOKER` у `CREATE`, але `ALTER FUNCTION … SECURITY DEFINER` окремою одиницею → попередження;
  - функція множини скоупу (`ruledFunctions`) і функція `RETURNS trigger` з тими самими ознаками → без попередження (не борг / не RPC);
  - `SECURITY INVOKER` → без попередження;
  - читає лише `CustomTable` з `rowLevelSecurity: "off"` → без попередження; з `"enabled"` → попередження;
  - plpgsql `SELECT … INTO v FROM public.task_checklist` → `tables: "public.task_checklist"`;
  - plpgsql з `EXECUTE format(…)` → попередження з `reason: "unknown"`, `tables: ""`;
  - функція спільного файлу в закритій оболонці (`STABLE SECURITY DEFINER SET search_path = ''`, боргом не є) з грантом `authenticated`, що читає `public.task`, → попередження (мутація: судити лише `debtPredicate` — рядок червоніє);
  - функція закритого модуля довідника з тими самими ознаками (`SECURITY DEFINER`, без `REVOKE`, читає `public.task`) → попередження (мутація: виключити закриті модулі — рядок червоніє);
  - `invoker-helper` — `SECURITY DEFINER`-функція з грантом `authenticated` кличе `SECURITY INVOKER`-помічник, що читає `public.task`, → попередження з `tables: "public.task"` (мутація: лише власне тіло — рядок червоніє);
  - Мутація: ігнорувати типову поведінку `PUBLIC` — рядок «без гранту» червоніє; не обходити plpgsql — рядок `task_checklist` червоніє.
- [ ] **Step 2:** Run: `pnpm --filter simetra test definer-reads messages` — FAIL.
- [ ] **Step 3: Implement** за Р2c1-8; коментар «чому» — Р21/Р30 і чому попередження (власника не видно).
- [ ] **Step 4:** Run: `pnpm --filter simetra test definer-reads links messages && pnpm --filter simetra typecheck` — PASS; `pnpm metadata:check` — код 0 (попередження прикладу, якщо з'являться, — переглянути: приклад не повинен мати такої функції; якщо має — стоп і звіт архітектору).
- [ ] **Step 5: Commit**

```bash
git add packages/simetra/src
git commit -m "feat(compiler): попередження про SECURITY DEFINER, що читає таблицю під RLS для ролей API"
```

---

### Задача 6: скіл, гейти й заміри

**Files:**
- Modify: `packages/designer/skills/simetra-metadata/references/people-and-rights.md` і розділ SQL-модулів скіла споживача (`grep -rln "sql-debt" packages/designer/skills`), `docs/ROADMAP.md`, цей план (позначки)

- [ ] **Step 1:** Скіл споживача (англійською): дослівна політика чи тригер на таблиці виду — помилка, право й підписка замість них; закритий код не кличе функцій з динамічним SQL чи іншою мовою; борговий SQL не пише `simetra.*`, інші захищені налаштування — попередження; `sql.definer-reads-rls` — як читати й як конвертувати (читання через право й політику, або `SECURITY INVOKER`); борговий тригер з динамічним SQL на таблиці, яку досягає команда, — кандидат на конверсію (Р2c1-7).
- [ ] **Step 2:** Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — код 0.
- [ ] **Step 3:** Run: `pnpm metadata:check && python3 scripts/check-doc-anchors.py && .agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-25-rights-2c1-verbatim-ban-trust-boundary.md` — код 0.
- [ ] **Step 4:** Повний `pnpm test:db` на одному SHA (у фоні, таймаут не коротший за 45 хв): `/usr/bin/time -f %e pnpm test:db` — код 0 (або CI job `db`); приросту немає (DB-тестів план не додає; відхилення > 15 с — звіт архітектору).
- [ ] **Step 5:** ROADMAP — «Права-2c1 виконано»; позначки плану.
- [ ] **Step 6: Commit**

```bash
git add packages/designer/skills docs/ROADMAP.md docs/superpowers/plans/2026-10-25-rights-2c1-verbatim-ban-trust-boundary.md
git commit -m "docs(plan): Права-2c1 виконано — скіл, ROADMAP, позначки"
```

## Критерії приймання

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm metadata:check`, `python3 scripts/check-doc-anchors.py` — зелені після **кожного** коміту; повний `pnpm test:db` — зелений на одному SHA, без приросту.
- `SUPABASE_SCHEMAS` немає; перелік схем — `PROVIDER_SCHEMAS` (Задача 1).
- Дослівна політика чи тригер на таблиці виду — помилка в будь-якому файлі, на `CustomTable` — борг; решта форм Ф9 зафіксована наявними кодами (Задача 2).
- Закритий код не досягає недосудних функцій; функції провайдера довірені, модель — пріоритетна (Задача 3).
- Борговий SQL: `simetra.*` — помилка, решта захищених — попередження (Задача 4).
- `sql.definer-reads-rls` — по одному на функцію з таблицями й ролями (Задача 5).
- Спеки (§5.3 прав, §9.4 промоції, §6.7 платформи) і борг оновлені (Задача 0).
