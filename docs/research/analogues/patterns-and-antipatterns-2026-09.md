# Патерни й антипатерни метаданих-керованих бізнес-платформ: дослідження для Simetra (станом на 2026-09-29)

## Про цей документ

- **Питання.** Які патерни й антипатерни відображення метаданих на СУБД і рантайм виявили 1С:Підприємство та сучасні метаданих-керовані бізнес-платформи, і що з цього варто взяти або обійти в Simetra.
- **Дата.** 2026-09-29.
- **Метод.** Дослідження з першоджерел (документація, вихідний код, технічні блоги, обговорення), виконане агентом; версії, ліцензії й дати публікацій перевірено на зазначену дату. Тіло документа — текст дослідження; примітки архітектора лишено в дужках.
- **Куди лягли рішення.** Платформна спека `../../superpowers/specs/2026-09-24-simetra-platform-design.md`: рішення Р2–Р10, §4 (види), §6 (схема й безпека); вибір бібліотек і ліцензійні висновки — `../stack/reuse-map-2026-09.md`.
- **Що уточнено пізніше.** pgsql-parser для нормалізації відхилено (канонічна форма — Postgres на тіні; libpg-query лише для гейтів дослівного SQL); PGlite — лише юніт-тести; exclusive arcs відхилено на користь пари «тип + id»; поіменний вибір бібліотек — [карта перевикористання](../stack/reuse-map-2026-09.md).
- **Статус.** Контекст рішень, не правила: чинні правила живуть у спеках.

## 1. Як 1С:Підприємство відображає метадані на СУБД і рантайм

**Фізичні імена та стандартні реквізити**
- Кожному виду об'єкта відповідає власна таблиця. Її назва складається з префікса виду й порядкового номера: `_Reference<n>`, `_Document<n>`, табличні частини `_Document<n>_VT<k>`, `_Enum<n>`, `_Const<n>`, `_AccumRg<n>` (рухи), `_AccumRgT<n>` (підсумки), `_InfoRg<n>`, `_AccRg<n>`, `_Chrc<n>` ([its.1c.ru](https://its.1c.ru/db/content/metod8dev/src/admins/i8101798.htm)).
- Стандартні поля платформа виводить із виду об'єкта: `_IDRRef`, `_Version`, `_Marked`, `_PredefinedID`, `_Code`, `_Description`, `_Posted`, `_Date_Time`, `_Number`, `_OwnerID…`, `_ParentID…`, `_Folder` (там само).
- Відповідність «UUID об'єкта метаданих → номер таблиці» лежить у стиснутому файлі `DBNames` усередині таблиці `Params` ([infostart](https://infostart.ru/1c/articles/1385677/)). Звідси випливає, що перейменування об'єкта не зачіпає таблицю. Логічне ім'я відокремлене від фізичного вже двадцять років, і це той самий принцип, що в Р4/Р5 спеки Simetra.
- Мінус такого рішення: імена нечитабельні для SQL-клієнтів і BI, тому доводиться звертатися до `ПолучитьСтруктуруХраненияБазыДанных()` або до сторонніх інструментів.

**Посилання та складені типи**
- Посилання на один тип займає 16-байтовий UUID (`…RRef`). Складений тип розкладається на кілька колонок: дискримінатор `_TYPE` (0x01–0x07: Undefined, Boolean, Number, Date, String, Binary, Reference), типізовані колонки `_L/_N/_T/_S/_B`, а для посилання ще пару `_RTRef` (4-байтовий номер таблиці) + `_RRRef` (id запису) ([its.1c.ru](https://its.1c.ru/db/content/metod8dev/src/developers/platform/metod/other/i8101828.htm)). Реєстратор у регістрах зберігається так само, парою `_RecorderTRef/_RecorderRRef` ([infostart](https://infostart.ru/1c/articles/1061227/)).
- Варто взяти: типізований дискримінатор і окремі типізовані колонки замість рядка на кшталт `"model,id"`.
- Не варто брати: у БД немає жодного FK, цілісність тримає лише платформа.

**Проведення**
- Обробник `ОбработкаПроведения` формує набори записів регістрів. Платформа записує їх із заміщенням за реєстратором, а старі рухи видаляє перед перепроведенням ([infostart](https://infostart.ru/1c/articles/417810/)).
- «Нова методика контролю залишків» працює в такому порядку: спершу записати рухи, потім у тій самій транзакції перевірити залишки, з керованими блокуваннями ([its.1c.ru](https://its.1c.ru/db/pubessence/content/132/hdoc); [курси-по-1с](https://xn----1-bedvffifm4g.xn--p1ai/articles/2017-02-12-two-methods-for-inventory-check/)).

**Підсумки**
- Таблиця `_AccumRgT` містить помісячні залишки до «періоду розрахованих підсумків» і рядок поточних підсумків із фіктивною датою 5999‑11‑01. Залишок на довільну дату рахується як найближчий підсумок ± рухи ([infostart](https://infostart.ru/1c/articles/1061227/)).
- Під час запису рухів платформа в тій самій транзакції виконує `UPDATE … SET res = res + @delta` по рядках підсумків ([Habr](https://habr.com/ru/articles/759070/)). Це створює гарячі рядки.
- Ліки від гарячих рядків — «розділення підсумків» через колонку `_Splitter`. Воно не допомагає, якщо ввімкнено контроль залишків. Оборотні регістри додатково мають агрегати, які треба оновлювати регламентно ([Habr/OTUS, лютий 2026](https://habr.com/ru/companies/otus/articles/989660/)).

**Версіонування конфігурації та реструктуризація**
- Конфігурація зберігається в самій БД, у таблицях `Config`, `ConfigSave`, `DBSchema`, `Params`. Редагована версія лежить у `ConfigSave`, застосована — у `Config`. «Оновлення конфігурації БД» реструктуризує таблиці ([1CLancer](https://1clancer.ru/article/avarijnoe_zavershenie_obnovleniya_konfiguratsii_bazy_dannykh_810); [infostart](https://infostart.ru/1c/articles/934237/)).
- Стара реструктуризація переносила дані через платформу. Режим v2 (з 8.3.11) переносить роботу на СУБД через ALTER. Додавання реквізитів у БД на 400 ГБ скоротилося з 2 год до 15 хв, зміна режиму сумісності на 6 ТБ — з 5 днів до 12 год ([Зазеркалье](https://wonderland.v8.1c.ru/blog/optimizatsiya-restrukturizatsii-bazy-dannykh/)).
- На базах 2–5 ТБ реструктуризація все одно триває дні. Режим v2 мав баги аж до 8.3.22, а партиціювання немає ([Habr, 2023](https://habr.com/ru/articles/762574/)).
- Контроль версій: сховище конфігурації працює через монопольне захоплення об'єктів; Git з'явився лише разом з XML-вивантаженням і 1C:EDT, і автомерж там часто ламає XML та зв'язки ідентифікаторів ([infostart](https://infostart.ru/1c/articles/2794766/); [Rarus 2025](https://rarus.ru/publications/20250227-ot-ekspertov-1c-edt-git-734379/)).
- Розширення конфігурації дають змогу дописувати зміни без зняття типової конфігурації з підтримки ([v8.1c.ru](https://v8.1c.ru/platforma/rasshireniya/)). Це правильна відповідь на задачу «типова конфігурація постачальника + доробки клієнта».

**Що варто взяти:** віртуальні таблиці залишків і оборотів; проведення як оболонку, якою керує платформа; підсумки як похідні дані, які можна повністю перерахувати з рухів; UUID метаданих; розширення як окремий шар.

**Що є легасі:** метадані в бінарних блобах у БД; нумеровані імена таблиць; відсутність FK; реструктуризація в режимі «зупинити все»; магічна дата 5999-11-01.

## 2. Порівнянні платформи: механізми, а не маркетинг

**Frappe / ERPNext**
- Зберігання метаданих: JSON DocType лежить у репозиторії застосунку, його дзеркало — у `tabDocType`/`tabDocField`. `bench migrate` синхронізує їх за MD5-хешем JSON ([Frappe docs](https://docs.frappe.io/framework/user/en/bench/reference/migrate)).
- Схема: видалені поля видаляються лише «м'яко», колонки залишаються. Зворотних міграцій немає, і, за словами самої документації, «you will not be able to access metadata of any previous states» ([Frappe migrations](https://docs.frappe.io/framework/user/en/guides/deployment/migrations)).
- Кастомізації (Custom Field, Property Setter) живуть у БД. У git вони потрапляють лише як fixtures через `bench export-fixtures`, і та експортує чужі поля, наприклад додані патчами ERPNext ([Frappe forum](https://discuss.frappe.io/t/bench-export-fixtures-includes-custom-field-added-by-erpnext-patches/73805)).
- Посилання: Link — це рядковий `name`, Dynamic Link — пара `(doctype, name)`. FK не створюються, запит на них відкритий з 2020 року ([#10842](https://github.com/frappe/frappe/issues/10842)). Видалення DocType, на який посилаються Link-поля, не блокується ([#43564](https://github.com/frappe/frappe/issues/43564)).
- Права: Role Permissions задаються на DocType, групи полів розділяються через permlevel, окремо є User Permissions за значеннями Link-полів. Усе це працює лише в застосунку ([docs](https://docs.frappe.io/framework/user/en/basics/users-and-permissions)).
- Документи: `docstatus` 0/1/2 і цикл submit/cancel/amend; `on_submit` створює GL Entry та Stock Ledger Entry ([docs](https://docs.frappe.io/framework/doctypes/docstatus)).
- Критика: залишки зберігаються в таблиці `Bin`, яку оновлює прикладний код. Для бекдейтних документів потрібен Repost Item Valuation, а для розбіжностей є окремий звіт Stock Ledger Variance ([ERPNext docs](https://docs.frappe.io/erpnext/stock-reposting)).

**Odoo**
- Схема: моделі описані Python-класами, `_auto_init` створює та доповнює таблиці.
- Посилання: поле Reference зберігає рядок `"res_model,res_id"` без FK. Many2oneReference — це int плюс Char-поле з назвою моделі ([ORM docs 18](https://www.odoo.com/documentation/18.0/developer/reference/backend/orm.html)).
- Оновлення між мажорними версіями: Community не має міграційних скриптів. Спільнотний OpenUpgrade (OCA) іде лише на одну версію за раз, а скрипти Odoo S.A. закриті й доступні тільки з Enterprise ([OCA](https://github.com/OCA/OpenUpgrade)).
- Права: `ir.model.access` задає адитивні CRUD-права, `ir.rule` — domain-фільтри. Правила груп за замовчуванням дозволяють доступ, а `sudo()` і сирий SQL обходять усе ([security docs](https://www.odoo.com/documentation/18.0/developer/reference/backend/security.html)).
- UI: дефолтні views генеруються, але власний підручник Odoo прямо пише: «the default view is **never** acceptable for a business application» ([Odoo tutorial](https://www.odoo.com/documentation/14.0/developer/tutorials/getting_started/07_basicviews.html)).
- Розширення: `_inherit` через MRO і XPath-успадкування views. Механізм потужний, але крихкий при оновленнях.

**Axelor**
- XML-домени генерують JPA-сутності й репозиторії під час Gradle-збірки ([docs](https://docs.axelor.com/adk/latest/tutorial/step3.html)).
- Схема оновлюється через `db.default.ddl = update`, тобто Hibernate hbm2ddl ([docs](https://docs.axelor.com/adk/5.4/dev-guide/application/config.html)).
- Кастомні поля лежать у JSON-колонці `attrs` (MetaJsonField), визначаються в рантаймі й читаються через `json_extract` ([docs](https://docs.axelor.com/adk/6.1/dev-guide/models/custom-fields.html)). Разом це двоярусна модель: скомпільоване ядро плюс рантайм-JSON.

**Apache OFBiz**
- `entitymodel.xml` лежить у файлах. Прапорці `check-on-start` та `add-missing-on-start` додають відсутні таблиці, колонки, PK і FK, але ніколи не видаляють і не змінюють типи ([cwiki](https://cwiki.apache.org/confluence/display/OFBIZ/Entity+Engine+Configuration+Guide)). Дрейф схеми закладений у саму конструкцію.

**Directus**
- Підхід database-first: платформа інтроспектує БД, а UI-метадані тримає в таблицях `directus_*` ([docs](https://directus.com/docs/guides/data-model/collections)).
- `schema snapshot/apply` вивантажує YAML для git ([docs](https://directus.io/docs/configuration/migrations)). Ролі, права, флоу й налаштування цей знімок не покриває, тому з'явився сторонній directus-sync із власними **SyncID** для стабільних посилань між середовищами ([tractr/directus-sync](https://github.com/tractr/directus-sync)).
- Зв'язок M2A реалізовано через junction-таблицю з колонками `collection` + `item` без FK ([docs](https://directus.io/docs/guides/connect/relations)).
- Офіційний MCP-сервер є з червня 2025 ([docs](https://directus.com/docs/guides/ai/mcp)).

**NocoBase**
- Collections задаються в плагінах або через UI і зберігаються в системних таблицях; міграції плагінів ідуть через Umzug ([docs](https://docs.nocobase.com/api/server/migration)).
- Перенесення конфігурації між середовищами робить Migration Manager, який є лише в Professional-редакції і не дає міграцій без простою ([docs](https://docs.nocobase.com/ops-management/migration-manager/)).

**Twenty CRM**
- `objectMetadata`/`fieldMetadata` лежать у core-схемі, кожен workspace має окрему схему Postgres. GraphQL-схема будується в рантаймі при кожному перемиканні workspace. Автор рев'ю називає цей конвеєр найкрихкішим і слабо покритим тестами ([огляд 2024](https://www.codeline.co/thoughts/repo-review/2024/twenty-open-source-crm)).
- Twenty 2.0 додав `twenty-sdk` із `defineObject` у файлах `.ts`, live-sync через CLI та `app:publish` ([docs](https://docs.twenty.com/getting-started/core-concepts/apps)). Це дрейф від «метадані в БД» до «метадані як код».

**Payload CMS**
- Конфігурація — це код на TypeScript. Postgres-адаптер побудований на Drizzle: у dev працює push, у prod — лише `migrate:create`/`migrate`, змішувати ці режими заборонено ([docs](https://payloadcms.com/docs/database/migrations)).
- Поліморфні зв'язки: таблиця `<collection>_rels` має по nullable FK-колонці на кожну цільову колекцію плюс `path` і `order`. Масиви та блоки винесені в окремі таблиці з `_parent_id`/`_order`, тобто це прямий аналог табличних частин ([Payload RFC](https://payloadcms.com/posts/blog/relational-database-table-structure-rfc)).

**Baserow / Budibase / Saleor**
- Baserow: кожна користувацька таблиця — справжня таблиця Postgres, колонки мають імена `field_{id}` ([docs](https://baserow.io/docs/technical/database-plugin)). Django-моделі генеруються в рантаймі через `type()` і кешуються в Redis ([blog](https://baserow.io/blog/how-baserow-lets-users-generate-django-models)).
- Budibase зберігає метадані й внутрішні таблиці в CouchDB, SQL надається через окремий SQS ([DeepWiki](https://deepwiki.com/Budibase/budibase/2.3-database-system)).
- Saleor має `metadata`/`privateMetadata` як KV-обхідний шлях для невідомих полів ([docs](https://docs.saleor.io/docs/3.x/developer/metadata)).

**Salesforce / ServiceNow (пропрієтарні, але повчальні)**
- Salesforce: окремого DDL на кожен об'єкт немає. Є `MT_Objects`/`MT_Fields`/`MT_Data`, де дані лежать у varchar-колонках `Value0…N` у канонічному форматі. Індекси й унікальність винесені в pivot-таблиці `MT_Indexes`, `MT_Unique_Indexes`, `MT_Relationships`, а зміни схеми йдуть онлайн ([Salesforce Architects](https://architect.salesforce.com/fundamentals/platform-multitenant-architecture)). Перші 3 символи ID кодують тип об'єкта ([SF Ben](https://www.salesforceben.com/salesforce-object-key-prefix-list/)). Salesforce DX переніс джерело істини з org у VCS ([SF blog](https://developer.salesforce.com/blogs/developer-relations/2016/12/salesforce-dx-source-driven-development)).
- ServiceNow: таблиця `task` побудована за схемою Table-per-Hierarchy і обслуговує близько 95% операцій БД. Вона впирається в ліміти рядка та кількості колонок MySQL/MariaDB, і лікують це через hybrid flattening ([SN Community](https://www.servicenow.com/community/now-platform-articles/best-practices-to-manage-and-maintain-task-table/ta-p/2322498)). Update sets дають колізії та «неявні гілки» ([SN Community](https://www.servicenow.com/community/developer-articles/update-set-branch-collision-detection/ta-p/2320755)).

## 3. Антипатерни з доказами

- **EAV для користувацьких полів.** У Magento один продукт — це join 11+ таблиць `catalog_product_entity_*` ([Tigren](https://www.tigren.com/blog/eva-catalog-flat-catalog/)). Для компенсації зробили flat-індекси, які згодом самі отримали статус «no longer recommended» ([Adobe](https://experienceleague.adobe.com/docs/commerce-admin/catalog/catalog/catalog-flat.html?lang=en)). Salesforce — виняток, який лише підтверджує правило: там власні pivot-індекси й оптимізатор, що коштують великих інвестицій.
- **JSONB як ліки від EAV.** Postgres не збирає статистику по ключах JSONB і за замовчуванням закладає вибірковість 0,1%. У Heap запит через це став у 2000 разів повільнішим. Ключі повторюються в кожному рядку, тож таблиця займала 164 МБ проти 79 МБ ([Heap](https://www.heap.io/blog/when-to-avoid-jsonb-in-a-postgresql-schema)). Статистика на вирази частково рятує ([pganalyze](https://pganalyze.com/blog/5mins-postgres-planner-jsonb-selectivity)). Проте для розріджених розширень JSONB все одно кращий за EAV; midPoint задокументував це порівняння ([Evolveum](https://docs.evolveum.com/midpoint/projects/midscale/design/repo/repository-json-vs-eav/)).
- **Метадані лише в БД.** Кожна така платформа згодом добудовує болісний канал «БД → файли → інше середовище»: NocoBase продає Migration Manager; Directus потребує directus-sync; Frappe має fixtures, які тягнуть чужі поля; ServiceNow має update sets із колізіями; 1С пройшла шлях від сховища до EDT; Salesforce розвернувся до DX.
- **Рантайм-інтерпретація без кроку компіляції.** Помилки видно лише під час роботи. Hasura має окремі команди на випадок «inconsistent metadata», яка виникає, коли БД змінили поза нею ([Hasura](https://hasura.io/docs/2.0/migrations-metadata-seeds/resolving-metadata-inconsistencies/)). Twenty — з крихким конвеєром побудови GraphQL-схеми.
- **Магічні ORM, що ховають SQL.** В Odoo права існують лише в ORM, і `sudo()` або сирий SQL їх обходять. У 1С на 5 ТБ «ORM-підхід» без партиціювання не тягне ([Habr](https://habr.com/ru/articles/762574/)).
- **Дрейф між оголошеною і фізичною схемою.** OFBiz і Hibernate `update` лише додають. Frappe не видаляє колонки й не має зворотних міграцій. Payload забороняє змішувати push і міграції саме через дрейф.
- **Поліморфні посилання без FK.** Приклади: Odoo `"model,id"`, Frappe Dynamic Link, Directus M2A, 1С `_RTRef/_RRRef`. Karwin класифікує це як антипатерн Polymorphic Associations. Ліки — exclusive arcs або обернення зв'язку ([Karwin](https://www.slideshare.net/slideshow/practical-object-oriented-models-in-sql/1762095)). Payload показує, що exclusive arcs працюють у продакшні. У Postgres правило «рівно одна колонка заповнена» тримається через `CHECK (num_nonnulls(...) = 1)`.
- **Tenant-колонка, окрема схема на тенанта чи RLS.** Schema-per-tenant роздуває каталог, а міграції коштують O(тенанти × відношення) ([django-tenants #1269](https://github.com/django-tenants/django-tenants/issues/1269)). PlanetScale (квітень 2026) рекомендує спільні таблиці з `tenant_id`, а schema-per-tenant називає «generally not recommended». Там само застерігають не покладатися *лише* на RLS через складність дебагу й пулінгу ([PlanetScale](https://planetscale.com/blog/approaches-to-tenancy-in-postgres)). RLS швидкий лише з формою `(select auth.uid())` (initPlan) та індексами: 179 мс → 9 мс, 178 с → 12 мс ([Supabase](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)).
- **«Божественний» базовий об'єкт.** Таблиця `task` у ServiceNow: ліміти, hybrid flattening, архівація.
- **Метадані без версій.** У Frappe немає попередніх станів метаданих, тож неможливо ні згенерувати міграцію між двома версіями, ні відтворити форму документа на момент проведення.
- **Рукописний код для регістрів.** ERPNext: таблиця `Bin` + Repost Item Valuation + звіт розбіжностей.
- **Одноразовий скафолдинг.** Патерн Generation Gap (Vlissides): згенерований код не редагують, а доробки виносять окремо, інакше повторна генерація їх знищить ([Wikipedia](https://en.wikipedia.org/wiki/Generation_gap_(pattern))).
- **Стандартні екрани, що протікають.** Odoo сам визнає дефолтні views неприйнятними. У 1С автоформи рекомендовані лише тоді, коли «не потрібні програмні дії» ([1s-up](https://www.1s-up.ru/osnovnye-formy-obektov-1c/)).
- **Ідентичність за іменем.** drizzle-kit не відрізняє rename від drop+add і питає інтерактивно, а програмний API без HintsHandler просто падає ([#6053](https://github.com/drizzle-team/drizzle-orm/issues/6053)). Є баги, коли rename «з'їдає» зміни типу ([#3826](https://github.com/drizzle-team/drizzle-orm/issues/3826)). sqldef потребує анотації `@renamed` ([sqldef](https://github.com/sqldef/sqldef)).

## 4. Спільні патерни найкращих систем

- **Метадані як код у VCS плюс крок компіляції.** Приклади: Salesforce DX, `defineObject` у Twenty 2.0, конфігурація Payload, JSON DocType у Frappe. Supabase з 2026 року вимагає явних GRANT, бо так права стають «reviewable, diffable, greppable». Причина прямо названа: таблиці тепер створюють AI-інструменти без людського перегляду ([Supabase changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)).
- **Детермінована компіляція в DDL і типізований клієнт.** Приклади: генерація типів у Payload, kysely-codegen з інтроспекції ([Kysely](https://kysely.dev/docs/generating-types)).
- **Інтроспекція в обидва боки: оголошене й фізичне мають сходитися.** pg-delta завантажує стан у справжній Postgres і читає каталог, а не парсить SQL. Він моделює коментарі, домени, ролі й `security_invoker`, підтримує PG 14–18 і став дефолтом у нових проєктах Supabase ([Supabase](https://supabase.com/docs/guides/local-development/diff-engines)). pg-schema-diff (Stripe) перевіряє план міграції на тимчасовій БД і попереджає про небезпечні кроки ([README](https://github.com/stripe/pg-schema-diff/blob/main/README.md)).
- **Стабільні id окремо від імен.** 1С (UUID + DBNames), Salesforce (ObjID/FieldID), Baserow (`field_{id}`), directus-sync (SyncID). Postgres 18 має `uuidv7()` ([PG18](https://www.postgresql.org/docs/release/18.0/)).
- **Expand/contract.** Патерн ParallelChange описав Фаулер ([Fowler](https://martinfowler.com/bliki/ParallelChange.html)). pgroll реалізує його через «віртуальні» версіоновані схеми на views з миттєвим відкатом ([Xata](https://xata.io/blog/pgroll-expand-contract)).
- **Проведення як оболонка платформи плюс прикладний запит рухів.** 1С: заміна рухів за реєстратором, постконтроль залишків, блокування. Frappe: cancel реверсує GL/SLE, а проведений документ незмінний (замість редагування — cancel/amend).
- **Підсумки: тригери чи перерахунок.** Modern Treasury: сума по записах коштує O(n), тому баланси кешуються. Для balance locks кеш оновлюється синхронно, для гарячих рахунків — асинхронно через чергу ([MT](https://www.moderntreasury.com/journal/how-to-scale-a-ledger-part-vi)). Append-only записи з обчисленням на читанні взагалі уникають гарячих рядків ([pg-ledger](https://github.com/osmncnylmz/pg-ledger); [MT concurrency](https://docs.moderntreasury.com/ledgers/docs/handle-concurrency)).
- **RLS як нижня межа, здібності UI виводяться з метаданих.** RLS — примітив Postgres, тож захищає і від стороннього тулінгу. Потрібні і GRANT, і політики ([Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)). Контрприклад — інцидент із Supabase MCP (липень 2025): сервер працював під `service_role`, prompt injection у тікеті злив таблицю `integration_tokens` ([General Analysis](https://generalanalysis.com/blog/supabase-mcp-blog)).
- **Документи пишуться лише на сервері, довідники — оптимістично.** Zero задепрекейтив декларативні RLS-permissions на користь іменованих synced queries і custom mutators, де «server mutator always takes precedence» ([Zero docs](https://zero.rocicorp.dev/docs/permissions)). Electric: відкат простий, коли синхронізований стан відділено від локального ([Electric](https://electric.ax/docs/guides/writes)).
- **Наскрізний типізований шар даних.** Zod 4 має `z.toJSONSchema` і реєстр метаданих ([Zod](https://zod.dev/json-schema)). Standard Schema дає нейтральний інтерфейс між Zod, Valibot, ArkType та Effect ([standardschema.dev](https://standardschema.dev/json-schema)).
- **MCP і CLI як повноцінні поверхні.** MCP передано в Agentic AI Foundation під Linux Foundation 9 грудня 2025 ([MCP blog](https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/)). Специфікація 2026-07-28 зробила ядро протоколу stateless, додала кешовані list-результати й extensions ([MCP blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).

## 5. Що змінилося у 2025–2026: зріле й ризиковане

**Зріле (можна закладати в ядро)**
- **PostgreSQL 18** (вересень 2025): `uuidv7()`; virtual generated columns за замовчуванням; OLD/NEW у RETURNING; temporal PK/UNIQUE `WITHOUT OVERLAPS` і FK `PERIOD` — корисно для періодичних регістрів відомостей ([release notes](https://www.postgresql.org/docs/release/18.0/)).
- **Supabase як сервер застосунку:** PostgREST v14 ([changelog](https://supabase.com/changelog)); pg_graphql вимкнено за замовчуванням з лютого 2026 ([changelog](https://supabase.com/changelog/42180-breaking-change-pg-graphql-no-longer-enabled-automatically-within-approx-3-weeks-from-today)); явні GRANT: дефолт для нових проєктів з 30 травня 2026, для всіх — з 30 жовтня 2026. Для Simetra висновок такий: GRANT і політики мають бути виходом компілятора.
- **Diff-двигуни з першоджерела-каталогу:** pg-schema-diff (Go, з аналізом небезпечних кроків); sqldef (ідемпотентний, перейменування через анотацію). Atlas із жовтня 2025 (v0.38) переніс lint і детекцію дрейфу в платні плани ([dev.to](https://dev.to/mickelsamuel/atlas-paywalled-their-migration-linter-here-are-your-free-alternatives-4god)).
- **Схемні бібліотеки:** Zod 4 стабільний ([zod.dev](https://zod.dev/v4)); ArkType 2.x ([ArkType](https://arktype.io/docs/blog/2.0)); TypeBox 1.0 вийшов наприкінці 2025 ([releases](https://github.com/sinclairzx81/typebox/releases)).
- **Prisma 7** (листопад 2025): без Rust, `prisma.config.ts`, обов'язкові driver adapters ([changelog](https://www.prisma.io/changelog/2025-11-19)).
- **ElectricSQL 1.x:** лише шлях читання через shapes, записи — відповідальність застосунку ([QueryPlane](https://queryplane.com/blog/electricsql-postgres-sync-engine/)).
- **PowerSync:** синхронізація Postgres→SQLite, черга вивантаження плюс backend connector; Sync Streams замінюють Sync Rules ([docs](https://docs.powersync.com/configuration/app-backend/client-side-integration)).

**Ризиковане (станом на вересень 2026)**
- **Drizzle:** стабільна лінія 0.45.x, v1 досі на стадії RC (rc.4, червень 2026) ([releases](https://github.com/drizzle-team/drizzle-orm/releases)). Rename вирішується інтерактивно.
- **TanStack DB:** версія 0.9.x ([releases](https://github.com/TanStack/db/releases)). Persistence та офлайн додали лише в 0.6 ([blog](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes)).
- **Zero 1.0** (8 червня 2026): лише Postgres, views не синхронізуються, масиви не підтримуються; клієнт не вміє реагувати на відхилені оновлення; бандл 232 КБ gzip ([InfoQ](https://www.infoq.com/news/2026/06/zero-version-1/)).
- **pg-delta:** щойно став дефолтом, раніше був у публічній альфі ([discussion](https://github.com/orgs/supabase/discussions/44938)).
- **pgroll:** версії 0.x ([pgroll](https://xataio.github.io/pgroll/)).
- **Effect v4:** RC з 12 серпня 2026 ([Effect](https://effect.website/blog/effect-v4-rc-august-recap)).
- **LiveStore:** версії 0.4–0.5, модель event sourcing ([docs](https://docs.livestore.dev/evaluation/how-livestore-works/)).
- **Jazz:** CoValues замість бекенду, тож несумісний із моделлю «Postgres як джерело істини».
- **Convex:** ліцензія FSL-1.1-Apache-2.0 з пунктом про неконкуренцію ([GitHub](https://github.com/get-convex/convex-backend)). Це конфліктує з духом Apache-2.0 ядра Simetra.

## Висновки для Simetra

1. **Метадані зберігаються лише у файлах у git, а БД містить тільки згенерований стан і журнал застосованих версій метаданих.** Усі платформи з метаданими в БД (1С, ServiceNow, NocoBase, Directus, кастомізації Frappe) згодом добудовують дорогий канал «БД → файли».
2. **Кожен об'єкт і реквізит має незмінний UUID, а `physicalName` читабельний і призначається один раз.** Так уже працюють 1С, Salesforce, Baserow і directus-sync, тоді як diff за іменами (drizzle-kit, sqldef) не відрізняє rename від drop+add без підказки людини.
3. **Компілятор — чиста детермінована функція: метадані на вході; DDL бажаного стану, GRANT, RLS, типи, серверні команди й опис екранів на виході.** Детермінізм дає відтворюваність і дешевий diff між версіями, а змішування «що хочемо» з «як мігрувати» породжує дрейф у стилі Hibernate `update` чи OFBiz.
4. **План міграції будується порівнянням з реальним каталогом через готовий двигун (pg-schema-diff або pg-delta); UUID-мапінг перейменувань і expand/contract лягають зверху.** Писати власний catalog-diff дорого, а ці двигуни вже моделюють небезпечні кроки й об'єкти, яких бракувало старим інструментам; Drizzle як проміжний шар додає ризик RC-версії та rename за іменами.
5. **Кожне посилання — це FK, а поліморфні посилання — exclusive arc (FK-колонка на кожен тип плюс `CHECK num_nonnulls = 1`), ніколи не `"type,id"`.** Frappe, Odoo, Directus і 1С живуть без цілісності, а Payload довів, що arcs практичні. (Примітка архітектора 30.09.2026: для Simetra ухвалено пару «тип + id» з дискримінатором physicalName і цілісністю на рівні команд; exclusive arcs відхилено через N nullable-колонок на тип і зміну схеми при кожному новому дозволеному типі.)
6. **Проведення — транзакційна оболонка платформи (блокування, заміна рухів за реєстратором, оновлення підсумків, постконтроль), а прикладний код лише повертає рухи.** Це ядро цінності 1С; рукописний `Bin` в ERPNext вимагає Repost і окремого звіту розбіжностей.
7. **Рухи регістрів append-only, а підсумки — похідний кеш, який платформа оновлює в тій самій транзакції, з командою повного перерахунку та перевіркою інваріанта.** Одне джерело істини плюс відновлюваний кеш — практика і 1С, і Modern Treasury; для гарячих регістрів варто закласти режим, аналогічний `_Splitter`.
8. **Тенантність — спільні таблиці з колонкою scope лише для scoped-об'єктів плюс RLS; не окрема схема на тенанта.** Каталог і міграції при schema-per-tenant масштабуються погано, а політики треба генерувати одразу у формі з initPlan та індексами.
9. **RLS і явні GRANT — нижня межа, яку генерує компілятор; UI-здібності виводяться з тих самих правил, і жодна поверхня (MCP, CLI) не виконує користувацькі дії під `service_role`.** Права лише в ORM обходяться (Odoo `sudo`), а інцидент із Supabase MCP показав ціну сервісної ролі в руках агента.
10. **Документи змінюються лише через іменовані серверні команди, довідники допускають оптимістичні записи з відкатом.** До цього незалежно зійшлися Zero (custom mutators замість RLS-permissions), Electric і TanStack DB.
11. **Метадані версіонуються як ціле з маніфестом попередньої версії.** Без цього неможливо згенерувати міграцію, показати історію чи відтворити форму проведеного документа — це відкрито визнане обмеження Frappe.
12. **Стандартні екрани генеруються з метаданих і UI-підказок, з перевизначенням на рівні поля, секції чи дії, а не «все або нічого».** Odoo прямо визнає дефолтні views неприйнятними, тож цінність дає дешева точкова кастомізація.
13. **Згенерований код ніхто не редагує, його завжди можна перегенерувати, а доробки живуть у точках розширення за патерном Generation Gap.** Одноразовий скафолдинг знищує головну властивість платформи — повторну похідність.
14. **Користувацькі реквізити стають справжніми колонками через той самий компілятор; JSONB — лише для явно розріджених «додаткових реквізитів».** І EAV (Magento), і JSONB-статистика (Heap) мають задокументовану ціну.
15. **MCP і CLI — тонкі типізовані поверхні над тими самими серверними командами, що й UI; ядро не залежить від sync-двигуна.** Агенти вже створюють схеми (мотив Supabase), а TanStack DB (0.9) і Zero (1.0 лише з червня 2026) ще не настільки зрілі, щоб на них спиратися.
