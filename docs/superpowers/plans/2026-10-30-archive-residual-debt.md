# Залишковий борг виконаних блоків

Статус: беклог. Тут — відкладене з виконаних планів метамоделі, рушія схеми,
промоції, прав і раннього зрізу П4, чого немає ні в спеках, ні у
[борзі П3-2b](2026-10-15-p3-2b-residual-debt.md), ні в
[борзі прав](2026-10-26-rights-residual-debt.md). Пункт знімається звідси,
коли його бере план (посилання на план — поруч із пунктом) або коли його
відхилено з причиною.

## 1. Рушій схеми й застосування

- **Схема розширення без інших об'єктів.** Розширення з
  `WITH SCHEMA <власна схема>`, коли в цій схемі немає інших об'єктів моделі,
  не отримує `CREATE SCHEMA` у бажаному стані: рендер
  (`packages/simetra/src/schema/render/desired-state.ts`) бере схеми лише з
  таблиць, енам-типів і поля `schema` SQL-одиниць, а одиниця класу
  `extension` має порожню схему (`packages/simetra/src/compiler/sql/units.ts`).
  `CREATE SCHEMA` у дослівному SQL одиницею не є, тож розгортання в тінь
  падає. Брати схему з `WITH SCHEMA` у перелік схем рендера плюс кейс у
  `packages/simetra/src/schema/__tests__/desired-state.test.ts`.
- **Нетранзакційні кроки.** Крок двигуна з
  `transactionality: "nonTransactional"` (`CREATE INDEX CONCURRENTLY`) план
  відмовляє `apply.non-transactional`; крок, що вживає результат кроку
  `commitBoundaryAfter` того самого плану, — `apply.commit-boundary` з порадою
  розбити зміну на два застосування. Виконавця кроків поза транзакцією фази
  (ціль платформної спеки §6.2) немає. Код:
  `packages/simetra/src/schema/apply/steps.ts` (`lintSteps`), `execute.ts`.
- **Крок відновлення власника.** Об'єкт межі з чужим власником дає
  `plan.owner-mismatch` з порадою виконати `ALTER … OWNER TO` вручну
  (платформна спека §6.7). Ціль — платформний крок наміру
  `ALTER … OWNER TO <роль, що застосовує>` перед кроками двигуна разом із
  нормалізацією власника у витягу цілі: Postgres переписує ACL на нового
  власника, тож план двигуна після кроку коректний. Без цього pg-delta бачить
  неявні привілеї власника як різницю ACL, а копія доказу не відтворює
  власника (`ALTER … OWNER TO` іде раніше за `GRANT CREATE ON SCHEMA`).
  Окрема робота з власним спайком. Код:
  `packages/simetra/src/schema/apply/plan.ts` (`checkOwnerMembership`,
  `ownerMismatches`).
- **Дочірні таблиці pg_partman.** Операційно керовані таблиці (`managedBy` у
  моделі pg-delta) з власником, членом якого роль сесії не є, дають
  `plan.owner-mismatch` чи `engine.owner-not-member`, хоча двигун їх не
  планує: перепис власників у `plan.ts` (`readOwners`) їх не пропускає.
  Обхід — роль-власник. Закривається фільтром за `managedBy`, коли витяг
  адаптера перестане падати на чужих власниках, або власною абстракцією
  pg_partman (платформна спека Р27).
- **Відбиток каталогу поза PG17.** `packages/simetra/src/schema/apply/fingerprint.ts`
  перевірено лише на PG17; частина колонок каталогу з'явилася в PG15–17, а в
  PG18 `NOT NULL` є ще й у `pg_constraint`. Підтримка PG18:
  `FINGERPRINT_VERSION++`, повторний контракт покриття
  (`packages/designer/src/schema-engine/__tests__/fingerprint-coverage.db.test.ts`)
  і посекційні тести на стеку PG18.
- **Механізми платформної спеки, яких немає в ядрі застосування:** режим
  запису `simetra.write_mode = 'import'` (§6.12), контроль DDL поза
  платформою тригером подій із журналом у схемі `simetra` (§6.12), видалення
  старих планів за контрольними версіями й реєстр відомих інстансів (§6.10).
- **Діагностика очікування блокувань.** Коли `apply` вичерпує повтори
  (`apply.lock-timeout`), він не називає тримача: читання `pg_blocking_pids`
  в окремій сесії немає. `transaction_timeout` раннер не ставить. Код:
  `packages/simetra/src/schema/apply/execute.ts`.
- **Зміни типу колонки, які план відмовляє.** (1) Тригер з `WHEN` чи
  `UPDATE OF` або SQL-функція `BEGIN ATOMIC`, що залежать від колонки зі
  зміною типу, — `plan.type-change-dependent`. (2) Сторож звуження не
  будується (нестандартний `USING`, невидимий старий тип,
  `ALTER TYPE … ALTER ATTRIBUTE … TYPE`, пара без приведення чи оператора
  рівності) — `plan.type-guard-unsupported`. (3) Тип, що нормалізує текст
  (`text → jsonb`), дає хибну «втрату» сторожа: сторож порівнює
  `(c::new)::old IS DISTINCT FROM c`. Код:
  `packages/simetra/src/schema/apply/type-guard.ts`.
- **Тип, якого немає у вихідному стані.** Зміна типу колонки на тип, який
  той самий план створює, змінює чи знищує, відмовляє `plan.preservation-type`:
  замір збереження «до» приводить колонку до нового типу ще до кроків
  двигуна. Обхід — окреме попереднє застосування; розв'язок — фази
  «розширити → звузити» (П3-4). Код: `packages/simetra/src/schema/apply/plan.ts`,
  `promotion/preservation.ts`.
- **Копія доказу під іншою роллю адміністрування.** Сервер `shadowBase` з
  іншою роллю не доводить план, що створює об'єкти: права власника цієї ролі
  двигун бачить як зайві гранти — `plan.proof-not-empty`; за глобальних
  типових привілеїв — `engine.clone-failed`; репетиція — `apply.role-mismatch`.
  Обхід — копія від тієї самої ролі. Засів «для ролі копії» з мапою
  одержувачів свідомо відхилено: друга мапа ролей тихо розійшлася б із
  семантикою Postgres. Брати лише за реальної потреби. Код: `plan.ts`
  (`seedEnvironment`, `collectEnvironment`).
- **Грант середовища на нову схему.** Глобальні типові привілеї ролі плану
  на схеми (`objtype 'n'`) і план, що створює схему, дають хибне
  `plan.proof-not-empty`: адаптер не кладе схеми в `produced`, тож грант не
  проходить фільтр `environmentSteps`. Залишковий `GRANT` на перевантаженій
  функції зіставляється лише за схемою й іменем. Код:
  `packages/simetra/src/schema/apply/environment.ts`,
  `packages/designer/src/schema-engine/pg-delta/adapter.ts`.
- **Ревалідація не бачить динамічного SQL.** Ні валідатор `plpgsql`, ні
  `plpgsql_check` не розбирають рядок `EXECUTE format(…)`, тож крок, що
  ламає динамічний запит (перейменування колонки чи таблиці), проходить
  перевірку перед `COMMIT` мовчки — для будь-якого плану. Код:
  `packages/simetra/src/schema/apply/function-checks.ts`.
- **`ERROR` у лозі сервера від ревалідації.** Транспорт результатів —
  виняток `SIMFE` з DO-блоку в точці збереження — пише `ERROR` у лог на
  кожну перевірку, а з `log_min_error_statement` — ще й текст блоку.
  Сповіщення провайдера можуть на це реагувати. Описати для оператора
  (`docs/architecture/designer.md`, скіл споживача) або знайти транспорт без
  `ERROR`. Код: `function-checks.ts` (`RESULT_SQLSTATE`).
- **Межа сторожа витягу.** `savepointPool`
  (`packages/designer/src/schema-engine/savepoint-pool.ts`) не блокує
  `set_config(…, false)` як функцію, функції розширень на кшталт `dblink`, що
  виходять за транзакцію, і побічні ефекти функцій користувача, які викликає
  витяг. Межа свідома (довірений код двигуна: сторож ловить помилки, а не
  зловмисника) — дописати її в коментар `REFUSED_FUNCTIONS`.
- **Чужий тригер на таблиці провайдера.** Тригер з ім'ям згенерованого,
  функція якого в схемі провайдера, двигун засіває в бажану тінь як базовий
  стан, і згенерований `CREATE TRIGGER` падає на «already exists»: план
  відмовляє загальним `engine.shadow-load-failed` ще до
  `providerTriggerConflicts` (`plan.ts`), а не кодованим
  `plan.provider-trigger-taken`. Розпізнати цей збій тіні й дати кодовану
  відмову.

## 2. Двигун схеми й апстрім

- **Партиції й успадкування** на закріпленому `@supabase/pg-delta`: дрейф
  `ATTACH PARTITION` сходиться через `DROP TABLE` + `CREATE TABLE` (клас
  `destructive`, з дозволом); успадкування копія доказу не відтворює
  (`ADD COLUMN` для успадкованої колонки → `engine.clone-failed`); метамодель
  партицій не має (`CREATE TABLE` у `.sql` — `sql.statement-not-allowed`).
  Кандидати: апстрім pg-delta і властивість метамоделі.
- **`ENABLE ALWAYS`.** Таблицю з тригером користувача в режимі `ENABLE ALWAYS`
  двигун не планує — `engine.unrepresentable`; раннер кроків даних режим `A`
  вже вимикає й відновлює. Кандидат на апстрім чи на мапінг адаптера
  (`packages/designer/src/schema-engine/pg-delta/map-tables.ts`).

## 3. Промоція

- **Зворотне читання дослівного боргу з тіні** (спека промоції Пр4, §6) не
  реалізовано: дослівна не-функція боргу (в'юха, політика іншої таблиці,
  тригер), що згадує промотовану таблицю чи колонку, дає
  `promote.debt-text-reference`
  (`packages/simetra/src/compiler/operations/promote/sql.ts`). Затінення імен
  моделі в `search_path` теж немає.
- **Переклад міток виду** (спека промоції §9.11). `promote` пише
  `labelTranslation`, а план відмовляє `plan.promotion-unsupported`
  (`reason: "labelTranslation"`,
  `packages/simetra/src/schema/apply/promotion/transition.ts`). Об'єкт, чий
  вид дані споживача кодують власною міткою, промотувати не можна.
- **Динамічний гейт доступу** (спека промоції §8). Діє статичний
  `access:<таблиця>` на будь-яку зміну RLS, політик чи грантів таблиці
  одиниці; перевірки еквівалентності «роль × дія × рядок» немає. Перелік
  залежних у пункті не бачить функцій із рядковим тілом. Код:
  `packages/simetra/src/schema/apply/promotion/access.ts`.
- **Видалення без класу.** Прийнятий первинний ключ, не еквівалентний ключу
  виду, і зміна `identity`, `generated` чи колляції колонки дають
  `plan.removal-unclassified` (`UNCOVERED_COLUMN_FIELDS` у
  `promotion/removals.ts`). Еквівалентність канонічних імен текстова:
  `CHECK (a > 0)` проти `CHECK (0 < a)` стає DROP+CREATE.
- **Підплан регістрів** (спека промоції §10): немає перебудови рухів, звірки
  чотирьох зрізів і документа коригування; `promote` відмовляє
  `promote.unit-unsupported` для документа з рухами й регістрів, підпорядкованих
  реєстратору (`operations/promote/index.ts`).
- **Копія бази споживача з даними** для репетиції перед реальною промоцією
  (готує оператор, спека промоції §8): копія лише зі схемою збоїв на даних не
  показує.
- **Скіл конверсії** (спека промоції §13) — діалог про мапінг колонок, класи
  конверсії, дозволи на послаблення, хибнопозитивні відмови переписувача.
  Зараз у `packages/designer/skills/simetra-metadata/SKILL.md` лише маршрут
  `promote` і правила входу.
- **Лічильники нумерації** не генеруються: план лише попереджає
  `plan.numbering-not-generated`, а прийнятий тригер нумерації заміни не має.
  Якщо перша міграція споживача промотує таблицю, номер якої заповнює база,
  генерація лічильників (платформна спека Р25) — її передумова. Перевірити на
  переліку таблиць першої міграції до її плану.
- **Гілка «борговий тригер тієї самої форми»** у
  `packages/simetra/src/schema/apply/promotion/replacements.ts` (і коментар
  біля `subscriptionShapes`), схоже, недосяжна, відколи дослівний тригер на
  таблиці виду — помилка `sql.kind-table-verbatim`. Перевірити й прибрати
  мертвий опис чи код.

## 4. Метамодель і компілятор

- **Повторне вживання мітки виду** видаленого об'єкта нічим не заборонене:
  перевірка «призначене раз» (`packages/simetra/src/compiler/assigned-once.ts`)
  зіставляє поля лише за `id`, унікальність мітки — лише в поточному проєкті.
  Видалений і новий об'єкт з тією самою `kindLabel` мовчки переймуть значення
  поліморфних пар `_type`, прав і лічильників. Потрібна перевірка проти
  історії застосованих знімків (marker/ledger у
  `packages/simetra/src/schema/apply/`); спека П2 §3 зараз каже, що цього
  захисту ще немає.
- **Форма `EXCLUDE`-обмежень** — рішення власника. Мапер extract дає
  `engine.unrepresentable`
  (`packages/designer/src/schema-engine/pg-delta/map-definitions.ts`), тож
  базу з `EXCLUDE` прийняти через `introspect` не можна. Варіанти: поле
  `CustomTable` з рендером і мапером, дослівна одиниця або свідомо поза
  моделлю з реченням у спеці П2 §9.
- **Унікальність стандартного найменування в скоупі** — відкрите питання:
  чи потрібна вона як опція виду (зараз у довідника лише `codeUnique`,
  `packages/simetra/src/model/schemas/catalog.ts`, і прийнятий
  `UNIQUE (<скоуп>, <найменування>)` при промоції не має класу «виражено
  властивістю»). Вирішити за першим застосунком, якому вона знадобиться.
- **`USAGE` на схему застосунку**, відмінну від `public`, не генерується:
  `GRANT USAGE ON SCHEMA` дає лише `platformSchemaGrants` для схеми `simetra`
  (`packages/simetra/src/compiler/platform/units.ts`). Новий проєкт із іншою
  `defaultSchema` без дослівного `GRANT USAGE` дає таблиці, яких ролі запиту
  й `simetra_command` не прочитають. Генерувати `USAGE` ролям, яким вид дає
  доступ, або попереджати про його відсутність.
- **Перевірка викликача `SECURITY DEFINER`-функції** з `EXECUTE` для ролі
  користувача (платформна спека §6.7) не реалізована: є лише попередження
  `sql.definer-reads-rls`. Потрібне місце в плані П4.
- **Точність `sql.definer-reads-rls`**
  (`packages/simetra/src/compiler/sql/definer-reads.ts`): компілятор не знає
  власника функції й `FORCE ROW LEVEL SECURITY` (хибне попередження);
  `relationReads` (`sql/reads.ts`) судить некваліфіковане відношення з
  порожнім `search_path` як вбудоване. Низький пріоритет.
- **Відмова в обслуговуванні від SQL застосунку в сесії пулу** (не обхід
  прав): нелокальний `SET` нетаємних налаштувань (`statement_timeout`,
  `lock_timeout`, …) у вільній RPC-функції переживає виклик; тимчасова
  таблиця тіла з `ON COMMIT DROP`, названа як вбудований тип, затіняє тип до
  кінця транзакції (`pg_temp` шукається першим). Врахувати в роботі з
  пулером (спека П4 §7.3). Код: `sql/command-context.ts`, `sql/function-body.ts`.
- **Роль «користувачі» як гілка компілятора.** Правила `users.*`, стандартні
  `userKind`/`invalid` і ціль `ref: "users"` — гілки за `role === "users"` у
  `stages/integrity.ts`, `stages/identity.ts`, `stages/model.ts`, а не хук опису ролі в
  реєстрі видів. Друга роль довідника дублювала б їх.
- **`users.provision-unsafe` з причиною `rowRule`** відхиляє будь-яке правило
  рядка в модулі «Користувачів». Кандидат на послаблення — правило лише над
  колонками застосунку з безпечними значеннями заповнення. Низький пріоритет,
  до першого запиту.

## 5. Права

- **`setFunction: "membership"` з прийнятим джерелом.** Стадія 5
  (`packages/simetra/src/compiler/stages/links.ts`, `checkSetFunctions`)
  вимагає скоупленого довідника з `membership`, інакше
  `scope.membership-missing`; межу тенанта виду, чиє членство дає лише
  прийняте джерело, дає тільки дослівна функція множини. Задача —
  генерувати функцію множини з `membershipSources` (спека П2 §6 каже, що
  поки лише довідник).
- **Аналіз прав на рівні з прийнятим джерелом призначень.** Гейт функцій
  аналізу (`analysisGate` у `packages/simetra/src/compiler/rights/functions.ts`)
  вимагає `administerRights` на довіднику «Призначення ролей» рівня запиту;
  рівень без такого довідника гейта не проходить, і функції повертають
  порожньо. Не блокер першої міграції (права від цього не змінюються):
  потрібен інший носій права аналізу або правило в спеці прав §5.1.
- **`rights_explain`** (`compiler/rights/explain-units.ts`) не пояснює рядків
  регістрів, констант і ТЧ; для дослівних функцій виміру чи множини скоупу
  іншого користувача `carrier_match` — `NULL`. Вирішити для екранів аналізу
  прав П4.
- **`title`/`description` кастомних дій і вимірів доступу** (`customActionSchema`,
  `accessDimensionSchema` у `packages/simetra/src/model/schemas/rights.ts`)
  — додати з першим читачем (матриця ролей, екрани аналізу П4); ратчет полів
  поле без читача не пропускає.
- **Функції провайдера, що виконують текст SQL**
  (`PROVIDER_SQL_TEXT_FUNCTIONS`, `packages/simetra/src/model/schemas/project.ts`)
  — поіменний денайліст: неназвана функція розширення обходить дозвільний
  перелік операторів тіла. Звірка з каталогом стека DB-тестом (як
  `BUILTIN_FUNCTIONS`) або позитивний перелік викликів провайдера.
- **Зберігання журналу прав.** `simetra.rights_journal` росте без меж; строк,
  архів і хто чистить (інструмент режиму обслуговування) не визначено. Код:
  `compiler/rights/admin-tables.ts`.
- **Ролі входу сервісів провайдера** в `PROVIDER_LOGIN_ROLES.supabase`
  включено за призначенням, а не за фактом: що Auth, Storage і Realtime
  виконують SQL запиту користувача саме з таким `session_user`, на стеку не
  доведено. Інакше режим обслуговування прав (`simetra.rights_maintenance`)
  діяв би в їхній сесії. Потрібен DB-тест чи проба `pg_stat_activity`. Код:
  `project.ts`, `maintenanceSql` у `compiler/rights/guard-units.ts`.
- **Хибна `escalation` у `SET CONSTRAINTS ALL IMMEDIATE`**: перевірка ⊆
  спрацьовує в кінці оператора, а знімок актора береться на кожному; один
  оператор з CTE, що пише дві таблиці системних об'єктів прав, дає хибну
  відмову (fail-closed). Записати в
  `packages/designer/skills/simetra-metadata/references/people-and-rights.md`
  або виправити в `guard-units.ts`.
- **Прийняті джерела прав** (`packages/simetra/src/schema/apply/rights-sources.ts`):
  читання ключів ролей порівнює літерал умови з колонкою цілі ще до гейта
  дрейфу — якщо план змінює тип колонки, падає сира помилка приведення;
  гілку `rolsuper` перевірки власника таблиці-джерела живим тестом не
  доведено.

## 6. Користувачі, сховище, рантайм

- **Політики сховища файлів** за `project.storageBuckets` не генеруються:
  компілятор лише валідує декларацію (`stages/identity.ts`) і віддає
  `contracts.storageBuckets`, але генератора немає (спека промоції §9.3,
  спека профілів провайдера ПП4).
- **Команда знеособлення** ([спека системної схеми й користувачів](../specs/2026-10-07-system-schema-users-design.md) §6) не реалізована: є лише
  контракт `contracts.personalData`; спека П4 цієї команди не називає.

## 7. Тести

- **Таблиці схеми `simetra` під Правилом 1.** Що SQL застосунку не пише в
  `rights_versions`, `rights_journal`, `rights_tx_actor`, `rights_tx_pending`,
  `identities`, гарантує походження: `rightsAdminTables` дає їм
  `origin.objectId` об'єкта виду, тож `kindTables`
  (`packages/simetra/src/compiler/sql/kind-table-verbatim.ts`) їх включає.
  Тесту немає — додати рядки з мутацією в `kind-table-verbatim.test.ts`.
- **Мутаційна перевірка політик читання й копій носіїв** не підтверджена —
  повторити. Прогін: `pnpm --filter simetra exec vitest run --project db
  rights-policies` і `pnpm --filter @simetrajs/designer exec vitest run
  --project db carrier-locks`. Кожна мутація згенерованого SQL мусить
  почервонити свій кейс: прибрати `task_read_own` — `own`; `_read_region` —
  `dimension`; `_read_in_project_any` — `container`; `users_scope_read` —
  `users-cross-tenant`; з'єднання `rights_visible_users` лише за скоупом —
  `users-cross-kind`; `users_devices_scope_read` —
  `users-devices-cross-tenant`; політику ТЧ — `tabular`; копію шляху з
  предиката — `path`; поширення копії до ТЧ коментаря — `path-tabular`;
  предикат ТЧ за `parent_id` для носія-ключа — `key-carrier`; політику
  підсумків — `register-totals`; ігнорування значення з запиту в тригері
  носіїв — `forged-copy`; гілку `INSERT` тригера поширення —
  `source-after-dependent`; тригер поширення — `propagation-owner`;
  `contentChangeCondition` механіки чи підписки — `propagation-path`;
  `FOR SHARE` на `INSERT` — «inserting a tabular row waits…»; блокування
  власника на `UPDATE` рядка ТЧ — «… does not deadlock»; `RESTRICTIVE` →
  `PERMISSIVE` у `task_scope_read` — `member-without-role`. Мутація, після
  якої все зелене, — дірка в тестах, а не в коді.
- **Кроки даних і механіка платформи.** Правило спеки промоції §7.2 «кроки
  даних вимикають і тригери механіки, тож `version` і `updated_at` не
  змінюються» не перевіряє жоден тест. Тест — з першим кроком даних, що пише
  таблицю виду з уже наявною механікою (`writeData` у
  `packages/simetra/src/schema/apply/execute.ts`).
- **Копія доказу з доменом чи складеним типом, що тягне таблицю.** Додати
  DB-кейс у `packages/designer/src/schema-engine/__tests__/engine-apply-port.db.test.ts`
  і зафіксувати поведінку: відтворений порядок або чесна відмова
  `plan.clone-mismatch` / `engine.clone-failed`.
- **Перегенерація JSON Schema.** Тест дрейфу
  (`packages/simetra/src/compiler/__tests__/json-schema.test.ts`) не каже, як
  оновити `packages/simetra/schemas/*.schema.json`; команду
  (`UPDATE_JSON_SCHEMAS=1 pnpm --filter simetra test json-schema`) знає лише
  код тесту. Підказка в повідомленні `expect` або скрипт пакета.

## 8. Designer

- **Розмір `tools/list`.** JSON Schema входів MCP повторює схему мапінгу
  `promote` без `$defs`; винесення повторів зменшить опис без зміни входу.
  Бюджет і замір — коментар над `TOOLS_LIST_BUDGET` у
  `packages/designer/src/__tests__/mcp.test.ts`.
