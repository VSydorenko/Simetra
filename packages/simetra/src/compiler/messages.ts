import type {
  Diagnostic,
  DiagnosticParams,
  FillProblem,
  RuleCode,
} from "./diagnostics"

export type Locale = "en" | "uk"

type Text = (params: DiagnosticParams) => string
/** Функція, коли підказка залежить від параметрів (наприклад, від ролі посилання). */
type Hint = string | Text

export interface MessageEntry {
  en: Text
  uk: Text
  hint?: { en: Hint; uk: Hint }
}

/**
 * Порада відмов власників — одна для плану (`plan.owner-mismatch`) і звірки
 * (`engine.owner-not-member`): виправлення те саме, різниться лише наслідок.
 */
const OWNER_RECIPE = {
  en: "Restore the owner with `ALTER … OWNER TO <role>` for each named object (indexes, row types and column sequences follow their table), or connect as the owning role when it is an application role; if the owner is a provider service role, the object belongs to the provider: remove it from the managed scope",
  uk: "Відновіть власника через `ALTER … OWNER TO <роль>` для кожного названого об'єкта (індекси, рядкові типи й послідовності колонок ідуть за своєю таблицею) або підключайтеся від ролі-власника, якщо вона прикладна; якщо власник — службова роль провайдера, об'єкт належить провайдеру: приберіть його з межі керування",
}

/**
 * Причина `cause: "owners"` відмов репетиції (рішення 1 плану П3-2b-3):
 * копію відновлено під іншими власниками. Порада одна для фази 6
 * (`apply.target-changed`) і фази 18 (`apply.rehearsal-proof-failed`).
 */
const COPY_OWNERS = {
  en: "the owners of the copy differ from the target",
  uk: "власники об'єктів копії відрізняються від цілі",
}
const COPY_OWNERS_HINT = {
  en: "Nothing was written. Restore the copy with the plan's role and `pg_restore --no-owner`, so its objects are owned by the plan's role as on the target, then rehearse again.",
  uk: "Нічого не записано. Відновіть копію роллю плану з `pg_restore --no-owner`, щоб її об'єктами, як і на цілі, володіла роль плану, і повторіть репетицію.",
}

/**
 * Перевірки ідентичності цілі фази 4e (рішення 1 плану П3-2b-3): це не секції
 * відбитка каталогу, тож відмова `apply.target-changed` називає їх окремо.
 */
const IDENTITY_CHECK: Readonly<Record<string, { en: string; uk: string }>> = {
  server: {
    en: "identity check: server facts (version, encoding, collation)",
    uk: "перевірка ідентичності: факти сервера (версія, кодування, упорядкування)",
  },
  ledger: {
    en: "identity check: ledger head (the last apply)",
    uk: "перевірка ідентичності: голова ledger (останнє застосування)",
  },
}

/**
 * Причина `cause: "copy"` (рішення 1 плану П3-2b-3): репетиція на базі, що не
 * є копією цілі плану. «Сплануйте знову» тут марне — план на цілі дасть ті
 * самі факти й голову, — тож порада переробити копію.
 */
const COPY_REMAKE_HINT = {
  en: "Nothing was written. Make the copy from the target after the plan was built, on a server with the same major version, encoding and collation, ctype and locale, then rehearse again.",
  uk: "Нічого не записано. Зробіть копію з цілі після побудови плану, на сервері з тією самою мажорною версією, кодуванням, упорядкуванням, ctype і локаллю, і повторіть репетицію.",
}
const COPY_LEDGER_HINT = {
  en: "A database that received the same plans by separate applies is not a copy: every apply records a random id, so its ledger head differs.",
  uk: "База, що отримала ті самі плани окремими застосуваннями, — не копія: кожне застосування записує випадковий ідентифікатор, тож голова її ledger інша.",
}

/** Причини `apply.rehearsal-stale`: чим звіт не відповідає плану чи цілі. */
const REHEARSAL_STALE: Readonly<Record<string, { en: string; uk: string }>> = {
  plan: {
    en: "it is the report of another plan (the plan was rebuilt after the rehearsal)",
    uk: "це звіт іншого плану (план перебудовано після репетиції)",
  },
  format: {
    en: "it has a format this platform does not read",
    uk: "його формат ця платформа не читає",
  },
  server: {
    en: "it was made on another server (version, encoding or collation differ from the plan's)",
    uk: "його зроблено на іншому сервері (версія, кодування чи упорядкування відрізняються від плану)",
  },
  ledger: {
    en: "it was made on a database with another apply history (ledger head)",
    uk: "його зроблено на базі з іншою історією застосувань (голова ledger)",
  },
  tables: {
    en: "it does not hold exactly one row count for every table of the promotion",
    uk: "він не має рівно одного лічильника рядків на кожну таблицю промоції",
  },
}

/** Причини `users.provision-unsafe`: що саме порушила б вставка провізії. */
const PROVISION_HAZARD: Readonly<Record<string, { en: string; uk: string }>> = {
  requiredWithoutDefault: {
    en: "it is required and has no defaultValue",
    uk: "він обов'язковий і не має defaultValue",
  },
  uniqueWithDefault: {
    en: "it is unique and its defaultValue can be the same for different rows, so the second sign-up would duplicate it",
    uk: "він унікальний, а його defaultValue може бути однаковим для різних рядків, тож друга реєстрація дала б дубль",
  },
  defaultViolatesCheck: {
    en: "its defaultValue fails the attribute's own check",
    uk: "його defaultValue не проходить власну перевірку реквізиту",
  },
  rowRule: {
    en: "a row rule cannot be proven statically to accept the provisioned row",
    uk: "правило рядка статично не доводить, що прийме рядок провізії",
  },
}

/** Слова для виду елемента в `promote.property-not-equivalent`. */
const KIND_WORD: Record<"en" | "uk", Record<string, string>> = {
  en: {
    unique: "unique constraint",
    check: "check constraint",
    index: "index",
    constraint: "constraint",
  },
  uk: {
    unique: "унікальний ключ",
    check: "CHECK-обмеження",
    index: "індекс",
    constraint: "обмеження",
  },
}

/** Причини `promote.expression-invalid`: чому вираз не стає кроком даних. */
const FILL_PROBLEM: Readonly<Record<FillProblem, { en: string; uk: string }>> =
  {
    noKey: {
      en: "its table has no single-column primary key, so the step cannot address rows",
      uk: "його таблиця не має одноколонкового первинного ключа, тож крок не адресує рядки",
    },
    syntax: {
      en: "it is not one plain scalar expression: it does not parse, names its output, takes a parameter or uses a form the step does not run",
      uk: "це не один простий скалярний вираз: він не розбирається, називає свій вивід, бере параметр чи має форму, якої крок не виконує",
    },
    subquery: {
      en: "it contains a subquery, a set operation or a CTE",
      uk: "він містить підзапит, операцію над множинами чи CTE",
    },
    aggregate: {
      en: "it calls an aggregate without OVER",
      uk: "він викликає агрегат без OVER",
    },
    foreignTable: {
      en: "it reads a table other than its own",
      uk: "він читає іншу таблицю, ніж свою",
    },
    multipleTargets: {
      en: "it has more than one value",
      uk: "він має більше одного значення",
    },
    multipleStatements: {
      en: "it contains more than one statement",
      uk: "він містить більше одного оператора",
    },
    setReturning: {
      en: "it calls a function that returns a set of rows",
      uk: "він викликає функцію, що повертає множину рядків",
    },
    volatile: {
      en: "it calls a function whose result changes from call to call, or reads transaction time in a repair of existing values",
      uk: "він викликає функцію, результат якої змінюється від виклику до виклику, або читає час транзакції в ремонті наявних значень",
    },
    unknownFunction: {
      en: "it calls a function that is not proven deterministic",
      uk: "він викликає функцію, детермінованість якої не доведено",
    },
    unqualifiedFunction: {
      en: "it calls a model function without its schema, and the step runs with search_path = pg_catalog, pg_temp",
      uk: "він викликає функцію моделі без схеми, а крок виконується з search_path = pg_catalog, pg_temp",
    },
    castToTime: {
      en: "a repair of existing values casts a computed value to a date or time type, which may read transaction time",
      uk: "ремонт наявних значень приводить обчислене значення до типу дати чи часу, а це може прочитати час транзакції",
    },
    specialTimeLiteral: {
      en: "a repair of existing values contains a string such as 'now' or 'today', which reads transaction time once it becomes a date or time",
      uk: "ремонт наявних значень містить рядок на кшталт 'now' чи 'today', який читає час транзакції, щойно стає датою чи часом",
    },
    nondeterministicWindow: {
      en: "its window is not ordered by the table key, so the order of rows is not deterministic",
      uk: "його вікно не впорядковане ключем таблиці, тож порядок рядків не детермінований",
    },
    unknownColumn: {
      en: "it names a column its table does not have",
      uk: "він називає колонку, якої в таблиці немає",
    },
  }

const fillProblem = (reason: unknown, locale: "en" | "uk"): string =>
  Object.hasOwn(FILL_PROBLEM, String(reason))
    ? FILL_PROBLEM[reason as FillProblem][locale]
    : String(reason)

const FIX_IDS = {
  en: "Run simetra fix to assign ids.",
  uk: "Виконайте simetra fix, щоб призначити id.",
}
const FIX_PHYSICAL_NAMES = {
  en: "Run simetra fix to assign physical names.",
  uk: "Виконайте simetra fix, щоб призначити фізичні імена.",
}

/**
 * Властивість, що заміщує клас дослівного SQL у модулі виду 1С (спека
 * промоції §9.4): підказка веде до рамки, а не до обходу через спільний файл.
 */
const KIND_MODULE_REPLACEMENT: Readonly<
  Record<string, { en: string; uk: string }>
> = {
  trigger: {
    en: "The service date and the row version are kept by the platform's row mechanics; for any other reaction declare an EventSubscription for the table's event and keep its handler as a function in the closed shell.",
    uk: "Службову дату й версію рядка тримає механіка платформи; для решти реакцій оголосіть EventSubscription на подію таблиці, а обробник залиште функцією в закритій оболонці.",
  },
  policy: {
    en: "Row access is declared, not written: use publicRead on the object, and a scoped object gets its scope read policy <table>_read derived from the kind; access rights come with the rights spec (P3).",
    uk: "Доступ до рядків оголошується, а не пишеться: використайте publicRead об'єкта, а об'єкт зі скоупом отримує політику читання скоупу <table>_read, виведену з виду; права приходять зі спекою прав (П3).",
  },
  grant: {
    en: "Privileges are derived, not written: on a kind's tables they come from the kind, EXECUTE on a scope set function and a subscription handler comes from the metadata, and EXECUTE on any other function comes from its TypeScript declaration (P4).",
    uk: "Привілеї виводяться, а не пишуться: на таблиці виду — з виду, EXECUTE на функцію множини скоупу й обробник підписки — з метаданих, а EXECUTE на решту функцій — з їхнього оголошення в TypeScript (П4).",
  },
  defaultPrivileges: {
    en: "Privileges on a kind's tables are derived from the kind.",
    uk: "Привілеї на таблиці виду виводяться з виду.",
  },
  comment: {
    en: "Use the description of the object or its attribute.",
    uk: "Використайте description об'єкта чи його реквізиту.",
  },
  view: {
    en: "Read models are virtual tables or read RPC functions in the closed shell.",
    uk: "Моделі читання — віртуальні таблиці або функції читання (RPC) у закритій оболонці.",
  },
  materializedView: {
    en: "Read models are virtual tables or read RPC functions in the closed shell.",
    uk: "Моделі читання — віртуальні таблиці або функції читання (RPC) у закритій оболонці.",
  },
  sequence: {
    en: "Use the numbering of the kind (number or code).",
    uk: "Використайте нумерацію виду (номер чи код).",
  },
  extension: {
    en: "Extensions belong to the provider profile of the project.",
    uk: "Розширення належать профілю провайдера проєкту.",
  },
  domain: {
    en: "Use the logical types of attributes and their properties.",
    uk: "Використайте логічні типи реквізитів та їхні властивості.",
  },
}
const KIND_MODULE_GENERAL = {
  en: "The .sql module of a kind object holds only closed forms: functions in the closed shell, row rules (ALTER TABLE <own table> ADD CONSTRAINT <name> CHECK (…)) and movement query blocks. Describe the rest with metadata properties of the object.",
  uk: "Модуль .sql об'єкта виду містить лише закриті форми: функції в закритій оболонці, правила рядка (ALTER TABLE <своя таблиця> ADD CONSTRAINT <ім'я> CHECK (…)) і блоки запиту рухів. Решту опишіть властивостями метаданих об'єкта.",
}

/** Тексти проблем закритої оболонки функції (`sql.closed-shell`). */
const CLOSED_SHELL_PROBLEM: Readonly<
  Record<string, { en: string; uk: string }>
> = {
  language: {
    en: "its language is not sql or plpgsql",
    uk: "її мова не sql і не plpgsql",
  },
  volatility: {
    en: "its volatility is not explicit",
    uk: "її волатильність не явна",
  },
  searchPath: {
    en: "it is SECURITY DEFINER without SET search_path = ''",
    uk: "вона SECURITY DEFINER без SET search_path = ''",
  },
  dynamicSql: {
    en: "its body runs dynamic SQL (EXECUTE, a dynamic cursor or RETURN QUERY EXECUTE)",
    uk: "її тіло виконує динамічний SQL (EXECUTE, динамічний курсор чи RETURN QUERY EXECUTE)",
  },
  body: {
    en: "its plpgsql body does not parse",
    uk: "її тіло plpgsql не розбирається",
  },
}
/** Причини виходу функції множини скоупу за закриту форму. */
const SET_FUNCTION_REASON: Readonly<
  Record<string, { en: string; uk: string }>
> = {
  language: { en: "its language is not sql", uk: "її мова не sql" },
  security: {
    en: "it is not SECURITY DEFINER",
    uk: "вона не SECURITY DEFINER",
  },
  searchPath: {
    en: "it has no SET search_path = ''",
    uk: "вона без SET search_path = ''",
  },
  unqualified: {
    en: "with an empty search_path an unqualified relation does not resolve",
    uk: "з порожнім search_path некваліфіковане відношення не розв'язується",
  },
  viewUnqualified: {
    en: "a view binds names with the search_path of the creating session, so every relation and function in it is qualified by a schema (builtins as pg_catalog.<name>)",
    uk: "представлення зв'язує імена з search_path сесії, що його створює, тож кожне відношення й функція в ньому кваліфіковані схемою (вбудовані — як pg_catalog.<ім'я>)",
  },
  sqlBody: {
    en: "its SQL-standard body binds names with the search_path of the creating session, so the compiler cannot check it; use a string body (AS $$ ... $$)",
    uk: "її тіло стандарту SQL зв'язує імена з search_path сесії, що її створює, тож компілятор не може його перевірити; використайте рядкове тіло (AS $$ ... $$)",
  },
}
const ROW_RULE_GRAMMAR = {
  en: "A row rule combines with AND, OR, NOT and parentheses the atoms <column> IS [NOT] NULL, <column> = or <> <literal>, <column> [NOT] IN (<literals>), <column> <op> <column> of the same type and num_nonnulls(<columns>) <op> <integer>, where <op> is =, <>, <, <=, > or >=; columns are unqualified columns of the table, without casts, other functions or subqueries; emptiness is checked with IS [NOT] NULL, never with a NULL literal.",
  uk: "Правило рядка поєднує через AND, OR, NOT і дужки атоми <колонка> IS [NOT] NULL, <колонка> = чи <> <літерал>, <колонка> [NOT] IN (<літерали>), <колонка> <оп> <колонка> одного типу й num_nonnulls(<колонки>) <оп> <ціле>, де <оп> — =, <>, <, <=, > чи >=; колонки — некваліфіковані колонки таблиці, без приведень, інших функцій і підзапитів; порожнечу перевіряє IS [NOT] NULL, а не літерал NULL.",
}

const CLOSED_SHELL_HINT = {
  en: "A function in the closed shell is LANGUAGE sql or plpgsql, states IMMUTABLE, STABLE or VOLATILE, and a SECURITY DEFINER function sets search_path = '' and qualifies names with their schema. A plpgsql body parses and runs no dynamic SQL.",
  uk: "Функція в закритій оболонці — LANGUAGE sql чи plpgsql, явно вказує IMMUTABLE, STABLE чи VOLATILE, а функція SECURITY DEFINER задає search_path = '' і кваліфікує імена схемою. Тіло plpgsql розбирається і не виконує динамічний SQL.",
}

/** Каталог Postgres простору імен `sql.namespace-conflict`. */
function catalogOf(space: string | number | undefined): string {
  return space === "proc" ? "pg_proc" : space === "rel" ? "pg_class" : "pg_type"
}

/**
 * Каталог текстів за кодом правила (спека П2 §8.4): англійські обов'язкові,
 * українські стоять поруч в одному записі. Тип `Record<RuleCode, …>` робить
 * каталог вичерпним: нове правило без обох текстів не пройде typecheck.
 */
export const MESSAGES: Readonly<Record<RuleCode, MessageEntry>> = {
  // --- Перевірки схем T0 (issue з `params.rule`) ---
  "type.length-required": {
    en: () => "String type requires length",
    uk: () => "Тип String вимагає length",
  },
  "type.length-not-allowed": {
    en: () => "Only String type accepts length",
    uk: () => "Лише тип String приймає length",
  },
  "type.precision-not-allowed": {
    en: () => "Only Numeric type accepts precision",
    uk: () => "Лише тип Numeric приймає precision",
  },
  "type.scale-requires-precision": {
    en: () => "Scale requires precision",
    uk: () => "scale вимагає precision",
  },
  "type.ref-target-required": {
    en: () => "Ref type requires either ref or allowedTypes",
    uk: () => "Тип Ref вимагає ref або allowedTypes",
  },
  "type.ref-exclusive": {
    en: () => "ref and allowedTypes are mutually exclusive",
    uk: () => "ref і allowedTypes взаємовиключні",
  },
  "type.ref-not-allowed": {
    en: (p) => `Only Ref type accepts ${p.field}`,
    uk: (p) => `Лише тип Ref приймає ${p.field}`,
  },
  "type.unique-ignore-case-type": {
    en: () => 'unique "ignoreCase" applies only to a scalar String or Text',
    uk: () =>
      'unique "ignoreCase" застосовується лише до скалярних String і Text',
    hint: {
      en: "Use unique: true for other types, or change the type.",
      uk: "Для інших типів вжийте unique: true або змініть тип.",
    },
  },
  "attribute.unique-within-requires-unique": {
    en: () => "uniqueWithin requires unique",
    uk: () => "uniqueWithin вимагає unique",
    hint: {
      en: 'Set unique to true or "ignoreCase", or remove uniqueWithin.',
      uk: 'Задайте unique: true чи "ignoreCase" або приберіть uniqueWithin.',
    },
  },
  "attribute.personal-data-required": {
    en: () => "A personalData attribute cannot be required",
    uk: () => "Атрибут personalData не може бути обов'язковим",
    hint: {
      en: "Anonymization sets the column to NULL: remove required or personalData.",
      uk: "Знеособлення ставить колонку в NULL: приберіть required або personalData.",
    },
  },
  "type.bound-type": {
    en: () =>
      "Numeric bounds apply only to a scalar Integer, SmallInt, BigInt or Numeric",
    uk: () =>
      "Межі числа застосовуються лише до скалярних Integer, SmallInt, BigInt і Numeric",
    hint: {
      en: "Remove the bound or change the type.",
      uk: "Приберіть межу або змініть тип.",
    },
  },
  "type.bound-conflict": {
    en: () => "positive and nonNegative are mutually exclusive",
    uk: () => "positive і nonNegative взаємовиключні",
    hint: {
      en: "Keep positive (> 0) or nonNegative (>= 0), not both.",
      uk: "Залиште positive (> 0) або nonNegative (>= 0), не обидва.",
    },
  },
  "type.bound-order": {
    en: () => "minValue must not exceed maxValue",
    uk: () => "minValue не може перевищувати maxValue",
  },
  "type.bound-invalid": {
    en: () => "The bound is not a value of the attribute type",
    uk: () => "Межа не є значенням типу реквізиту",
    hint: {
      en: "Use a number (Integer, SmallInt) or a number or decimal-fraction string (BigInt, Numeric) within the type's range and scale.",
      uk: "Задайте число (Integer, SmallInt) або число чи десятковий дріб рядком (BigInt, Numeric) у межах діапазону й scale типу.",
    },
  },
  "type.format-type": {
    en: () => "pattern and minLength apply only to a scalar String or Text",
    uk: () =>
      "pattern і minLength застосовуються лише до скалярних String і Text",
    hint: {
      en: "Remove the property or change the type.",
      uk: "Приберіть властивість або змініть тип.",
    },
  },
  "type.pattern-invalid": {
    en: () =>
      "pattern is not a valid expression for both JavaScript and Postgres",
    uk: () =>
      "pattern не є коректним виразом одночасно для JavaScript і Postgres",
    hint: {
      en: 'It must compile with new RegExp(pattern, "u") and avoid named groups, \\p{...}, \\k<...>, \\b and \\B, which Postgres reads differently or not at all.',
      uk: 'Вираз мусить компілюватися через new RegExp(pattern, "u") і не містити іменованих груп, \\p{...}, \\k<...>, \\b та \\B: Postgres читає їх інакше або не знає.',
    },
  },
  "register.balance-control-type": {
    en: () => "balanceControl is allowed only on a Balance register",
    uk: () => "balanceControl дозволений лише для регістра залишків (Balance)",
    hint: {
      en: "A Turnover register keeps no balances to control.",
      uk: "Регістр типу Turnover не веде залишків, тож контролювати нічого.",
    },
  },
  "customTable.column-type": {
    en: (p) =>
      `Field "${p.field}" does not fit the column type form (logical type, PgEnum or Raw)`,
    uk: (p) =>
      `Поле "${p.field}" не підходить до форми типу колонки (логічний тип, PgEnum або Raw)`,
  },
  "customTable.identity-type": {
    en: () => "identity requires SmallInt, Integer or BigInt type",
    uk: () => "identity вимагає тип SmallInt, Integer або BigInt",
  },
  "posting.parse": {
    en: (p) => `Invalid expression: ${p.detail ?? "syntax error"}`,
    uk: (p) => `Некоректний вираз: ${p.detail ?? "синтаксична помилка"}`,
  },
  "pgEnum.value-duplicate": {
    en: () => "Enum label is already declared earlier in values",
    uk: () => "Мітка переліку вже оголошена раніше в values",
  },
  "debt.not-canonical": {
    en: () =>
      "sql-debt.json lists its units sorted by code units and without duplicates",
    uk: () =>
      "sql-debt.json перелічує одиниці відсортованими за кодовими одиницями й без дублів",
    hint: {
      en: "Run simetra fix once the metadata files are valid and every .sql parses: it sorts the list and removes duplicates and entries that are no longer debt.",
      uk: "Виконайте simetra fix, коли файли метаданих коректні й кожен .sql розбирається: він відсортує перелік і прибере дублі та записи, що вже не є боргом.",
    },
  },
  "scope.name-reserved": {
    en: () => 'Scope kind name "none" is reserved',
    uk: () => 'Ім\'я виду скоупу "none" зарезервоване',
  },
  "schema.reserved": {
    en: () => "Schema simetra belongs to the platform",
    uk: () => "Схема simetra належить платформі",
    hint: {
      en: "Choose another schema; the platform keeps its own objects in simetra.",
      uk: "Оберіть іншу схему: платформа тримає власні об'єкти в simetra.",
    },
  },
  "project.database-required": {
    en: (p) =>
      p.field === "provider"
        ? "project.meta.json declares no database provider"
        : "project.meta.json declares no database",
    uk: (p) =>
      p.field === "provider"
        ? "project.meta.json не вказує провайдера бази"
        : "project.meta.json не описує базу",
    hint: {
      en: 'Add "database": { "provider": "supabase" } to project.meta.json.',
      uk: 'Додайте "database": { "provider": "supabase" } до project.meta.json.',
    },
  },
  "scope.not-allowed": {
    en: () => 'Enumeration scope can only be "none"',
    uk: () => 'Скоуп переліку може бути лише "none"',
  },
  "type.cross-scope-not-allowed": {
    en: () => "Only Ref type accepts crossScope",
    uk: () => "Лише тип Ref приймає crossScope",
  },
  "type.default-not-allowed": {
    en: () =>
      "defaultValue is not allowed for an array, allowedTypes, Bytes or Json value",
    uk: () =>
      "defaultValue не допускається для масиву, allowedTypes, Bytes чи Json",
    hint: {
      en: "Such a value has no scalar literal that would make a valid column DEFAULT.",
      uk: "Таке значення не має скалярного літерала, з якого вийшов би коректний DEFAULT колонки.",
    },
  },
  "type.default-mismatch": {
    en: () => "defaultValue does not match the logical type",
    uk: () => "defaultValue не відповідає логічному типу",
    hint: {
      en: "Boolean takes a boolean; SmallInt and Integer take a number; BigInt and Numeric take a number or a string; UUID, String, Text, Date, DateTime and a Ref to an enumeration take a string.",
      uk: "Boolean приймає булеве значення; SmallInt і Integer — число; BigInt і Numeric — число або рядок; UUID, String, Text, Date, DateTime і Ref на перерахування — рядок.",
    },
  },
  "type.default-fill-mismatch": {
    en: () => "defaultValue fill does not match the logical type",
    uk: () => "fill у defaultValue не відповідає логічному типу",
    hint: {
      en: (p) =>
        p.expected
          ? `Use ${p.expected} for this type.`
          : "fill applies only to a scalar DateTime (now), Date (today) or UUID (newUuid).",
      uk: (p) =>
        p.expected
          ? `Для цього типу вжийте ${p.expected}.`
          : "fill застосовується лише до скалярних DateTime (now), Date (today) чи UUID (newUuid).",
    },
  },
  "type.default-empty-mismatch": {
    en: () => "defaultValue empty does not match the logical type",
    uk: () => "empty у defaultValue не відповідає логічному типу",
    hint: {
      en: (p) =>
        p.expected
          ? `Use ${p.expected} for this type.`
          : "empty applies only to an array (true) or a scalar Json (object or array).",
      uk: (p) =>
        p.expected
          ? `Для цього типу вжийте ${p.expected}.`
          : "empty застосовується лише до масиву (true) чи скалярного Json (object або array).",
    },
  },
  "type.default-invalid": {
    en: () => "defaultValue is outside the type",
    uk: () => "defaultValue виходить за межі типу",
    hint: {
      en: "SmallInt and Integer take an integer in range; BigInt takes a safe integer or an int8 integer string; Numeric fits precision and scale, a string being a plain decimal; String fits length; Date is YYYY-MM-DD; DateTime is ISO 8601 with a zone; UUID is a UUID string.",
      uk: "SmallInt і Integer — ціле в межах типу; BigInt — точне ціле число або рядок цілого в межах int8; Numeric — у межах precision і scale, рядок — простий десятковий дріб; String — не довший за length; Date — YYYY-MM-DD; DateTime — ISO 8601 з поясом; UUID — рядок UUID.",
    },
  },

  // --- Стадія 1: файли ---
  "project.missing": {
    en: () => "project.meta.json is missing",
    uk: () => "Немає project.meta.json",
    hint: {
      en: "Create project.meta.json at the root of metadata/.",
      uk: "Створіть project.meta.json у корені metadata/.",
    },
  },
  "project.timezone-unknown": {
    en: (p) => `Unknown time zone "${p.timezone}"`,
    uk: (p) => `Невідомий часовий пояс "${p.timezone}"`,
    hint: {
      en: "Use an IANA time zone name such as UTC or Europe/Kyiv.",
      uk: "Вкажіть ім'я поясу IANA, наприклад UTC чи Europe/Kyiv.",
    },
  },
  "file.unknown-path": {
    en: () => "File is not part of the metadata layout",
    uk: () => "Файл не входить до розкладки метаданих",
    hint: {
      en: "Objects live in <kind folder>/<Name>/<Name>.meta.json with optional <Name>.module.ts and <Name>.sql; shared SQL lives in sql/<schema>/<file>.sql.",
      uk: "Об'єкти лежать у <тека виду>/<Name>/<Name>.meta.json з необов'язковими <Name>.module.ts і <Name>.sql; спільний SQL лежить у sql/<схема>/<файл>.sql.",
    },
  },
  "file.movements-block": {
    en: (p) =>
      p.line === undefined
        ? `Invalid movement query block: ${p.detail}`
        : `Invalid movement query block at line ${p.line}: ${p.detail}`,
    uk: (p) =>
      p.line === undefined
        ? `Некоректний блок запиту рухів: ${p.detail}`
        : `Некоректний блок запиту рухів у рядку ${p.line}: ${p.detail}`,
    hint: {
      en: "Movement queries live in <Document>.sql between '-- @movements <Register>' and '-- @end'.",
      uk: "Запити рухів лежать у <Document>.sql між '-- @movements <Register>' і '-- @end'.",
    },
  },
  "file.movements-marker-indented": {
    en: (p) =>
      `Marker at line ${p.line} is indented and is not recognized as a movement query marker`,
    uk: (p) =>
      `Маркер у рядку ${p.line} має відступ і не розпізнається як маркер запиту рухів`,
    hint: {
      en: "Markers '-- @movements' and '-- @end' must start at the beginning of the line; an indented one is treated as a plain comment.",
      uk: "Маркери '-- @movements' і '-- @end' мають починатися з початку рядка; маркер з відступом вважається звичайним коментарем.",
    },
  },
  "sql.parse": {
    en: (p) =>
      `SQL syntax error at line ${p.line}, column ${p.column}: ${p.detail}`,
    uk: (p) =>
      `Синтаксична помилка SQL у рядку ${p.line}, колонці ${p.column}: ${p.detail}`,
  },
  "sql.statement-not-allowed": {
    en: (p) =>
      p.detail === "kindModule"
        ? `${p.statement} (${p.class}) at line ${p.line} is not allowed in the .sql module of a kind object`
        : p.detail === "rowRuleName"
          ? `CHECK at line ${p.line} has no constraint name`
          : p.detail === undefined || p.detail === "allInSchema"
            ? `${p.statement} at line ${p.line} is not allowed in a .sql file`
            : `${p.statement} at line ${p.line} is not allowed in a .sql file: ${p.detail}`,
    uk: (p) =>
      p.detail === "kindModule"
        ? `${p.statement} (${p.class}) у рядку ${p.line} не дозволений у модулі .sql об'єкта виду`
        : p.detail === "rowRuleName"
          ? `CHECK у рядку ${p.line} не має імені обмеження`
          : p.detail === undefined || p.detail === "allInSchema"
            ? `${p.statement} у рядку ${p.line} не дозволений у файлі .sql`
            : `${p.statement} у рядку ${p.line} не дозволений у файлі .sql: ${p.detail}`,
    hint: {
      en: (p) =>
        p.detail === "kindModule"
          ? (KIND_MODULE_REPLACEMENT[String(p.class)] ?? KIND_MODULE_GENERAL).en
          : p.detail === "rowRuleName"
            ? "Name the row rule: ALTER TABLE <table> ADD CONSTRAINT <name> CHECK (…). The name identifies the constraint in the database and in explain."
            : p.detail === "allInSchema"
              ? "Grant on each object: ON ALL … IN SCHEMA is a one-off action, not a catalog state."
              : p.feature === "rowLevelSecurity"
                ? "Row-level security is a property of the table: set rowLevelSecurity on the table in metadata instead of ALTER TABLE."
                : p.feature === "publication"
                  ? "The provider creates publications; a .sql file manages only their membership: use ALTER PUBLICATION … ADD/DROP/SET TABLE."
                  : ".sql files hold objects the model does not own: functions, procedures, aggregates, triggers, views, materialized views, policies, grants, default privileges, comments, extensions, sequences, domains, publication membership (ALTER PUBLICATION), REPLICA IDENTITY and function settings. Tables, indexes and enum types are metadata objects; DROP and data changes are not desired state.",
      uk: (p) =>
        p.detail === "kindModule"
          ? (KIND_MODULE_REPLACEMENT[String(p.class)] ?? KIND_MODULE_GENERAL).uk
          : p.detail === "rowRuleName"
            ? "Дайте правилу рядка ім'я: ALTER TABLE <таблиця> ADD CONSTRAINT <ім'я> CHECK (…). Ім'я ідентифікує обмеження в базі й у explain."
            : p.detail === "allInSchema"
              ? "Надавайте гранти на кожен об'єкт: ON ALL … IN SCHEMA — разова дія, а не стан каталогу."
              : p.feature === "rowLevelSecurity"
                ? "Row-level security — властивість таблиці: задайте rowLevelSecurity на таблиці в метаданих замість ALTER TABLE."
                : p.feature === "publication"
                  ? "Публікації створює провайдер; файл .sql керує лише членством у них: використайте ALTER PUBLICATION … ADD/DROP/SET TABLE."
                  : "Файли .sql містять об'єкти, якими модель не володіє: функції, процедури, агрегати, тригери, представлення, матеріалізовані представлення, політики, гранти, привілеї за замовчуванням, коментарі, розширення, послідовності, домени, членство в публікаціях (ALTER PUBLICATION), REPLICA IDENTITY і налаштування функцій. Таблиці, індекси й енам-типи — об'єкти метаданих; DROP і зміни даних не є бажаним станом.",
    },
  },
  "sql.unit-duplicate": {
    en: (p) =>
      `${p.identity} at line ${p.line} is already defined by ${p.first}`,
    uk: (p) => `${p.identity} у рядку ${p.line} уже визначений у ${p.first}`,
    hint: {
      en: "A function is identified by schema, name and argument types; a trigger or policy by its table and name; a grant by its object, grantees and privileges.",
      uk: "Функцію ідентифікують схема, ім'я й типи аргументів; тригер або політику — таблиця й ім'я; грант — об'єкт, отримувачі й привілеї.",
    },
  },
  "sql.generated-grant": {
    en: (p) =>
      `Privileges on ${p.object} are generated from the metadata; this statement contradicts them`,
    uk: (p) =>
      `Права на ${p.object} генеруються з метаданих; цей оператор їм суперечить`,
    hint: {
      en: "Remove the statement; simetra fix removes it when every target belongs to the platform — a statement that also names other objects is split by hand.",
      uk: "Приберіть оператор; simetra fix прибирає його, коли всі цілі належать платформі, — оператор, що називає й чужі об'єкти, ділять вручну.",
    },
  },
  "sql.namespace-conflict": {
    en: (p) =>
      `${p.identity} at line ${p.line} takes ${p.key} in ${catalogOf(p.space)}, already taken by ${p.other}`,
    uk: (p) =>
      `${p.identity} у рядку ${p.line} займає ${p.key} у ${catalogOf(p.space)}, яке вже займає ${p.other}`,
    hint: {
      en: "Postgres keeps functions, procedures and aggregates in one catalog (pg_proc, by name and argument types); tables, views, materialized views, sequences and indexes in another (pg_class); enum types, domains and the row types of tables and views in a third (pg_type). Objects of different classes cannot share a name there: rename one of them or put it in another schema.",
      uk: "Postgres тримає функції, процедури й агрегати в одному каталозі (pg_proc, за іменем і типами аргументів); таблиці, представлення, матеріалізовані представлення, послідовності й індекси — в іншому (pg_class); енам-типи, домени й типи рядків таблиць і представлень — у третьому (pg_type). Об'єкти різних класів не можуть ділити там ім'я: перейменуйте один із них або перенесіть в іншу схему.",
    },
  },
  // Для `dynamicSql` рядок — це оператор у тілі, а не початок функції, тож
  // текст ставить його до самого оператора; решта проблем — про функцію цілком.
  "sql.closed-shell": {
    en: (p) => {
      const problem = (
        CLOSED_SHELL_PROBLEM[String(p.problem)] ?? { en: p.problem }
      ).en
      return p.problem === "dynamicSql"
        ? `Function ${p.function} is outside the closed shell: ${problem} at line ${p.line}`
        : `Function ${p.function} at line ${p.line} is outside the closed shell: ${problem}`
    },
    uk: (p) => {
      const problem = (
        CLOSED_SHELL_PROBLEM[String(p.problem)] ?? { uk: p.problem }
      ).uk
      return p.problem === "dynamicSql"
        ? `Функція ${p.function} поза закритою оболонкою: ${problem} у рядку ${p.line}`
        : `Функція ${p.function} у рядку ${p.line} поза закритою оболонкою: ${problem}`
    },
    hint: CLOSED_SHELL_HINT,
  },
  "sql.function-overload": {
    en: (p) =>
      `${p.identity} at line ${p.line} overloads ${p.function}: a function of a kind module has one signature`,
    uk: (p) =>
      `${p.identity} у рядку ${p.line} перевантажує ${p.function}: функція модуля виду має одну сигнатуру`,
    hint: {
      en: "Give each function of a kind module its own name in the schema: an overload makes a call resolve by argument types, which the frame cannot check.",
      uk: "Дайте кожній функції модуля виду власне ім'я в схемі: перевантаження робить виклик залежним від типів аргументів, чого рамка не перевіряє.",
    },
  },
  "sql.row-rule-grammar": {
    en: (p) =>
      `Row rule on ${p.table} at line ${p.line} is outside the row rule grammar: ${p.construct}`,
    uk: (p) =>
      `Правило рядка на ${p.table} у рядку ${p.line} поза граматикою правила рядка: ${p.construct}`,
    hint: ROW_RULE_GRAMMAR,
  },
  "sql.row-rule-foreign-table": {
    en: (p) =>
      `Row rule at line ${p.line} targets ${p.table}, which is not a table of this object`,
    uk: (p) =>
      `Правило рядка у рядку ${p.line} стоїть на ${p.table}, яка не є таблицею цього об'єкта`,
    hint: {
      en: "A row rule of a kind module constrains only the tables of its own object: move it to the module of the object that owns the table.",
      uk: "Правило рядка модуля виду обмежує лише таблиці свого об'єкта: перенесіть його в модуль об'єкта, якому належить таблиця.",
    },
  },
  "sql.row-rule-outside-module": {
    en: (p) =>
      `Row rule on ${p.table} at line ${p.line} is outside the .sql module of a kind object`,
    uk: (p) =>
      `Правило рядка на ${p.table} у рядку ${p.line} поза модулем .sql об'єкта виду`,
    hint: {
      en: "A row rule belongs to the .sql module of the kind object that owns the table; an adopted table describes its checks in its metadata (checks).",
      uk: "Правило рядка належить модулю .sql об'єкта виду, якому належить таблиця; прийнята таблиця описує свої перевірки в метаданих (checks).",
    },
  },
  "sql.row-rule-name-taken": {
    en: (p) =>
      `Row rule ${p.name} at line ${p.line} reuses the name of another constraint of ${p.table}`,
    uk: (p) =>
      `Правило рядка ${p.name} у рядку ${p.line} повторює ім'я іншого обмеження ${p.table}`,
    hint: {
      en: "Postgres keeps the constraint names of a table in one namespace, including the checks the kind derives: give the row rule its own name.",
      uk: "Postgres тримає імена обмежень таблиці в одному просторі, разом із перевірками, які виводить вид: дайте правилу рядка власне ім'я.",
    },
  },
  "sql.bare-current-user": {
    en: (p) =>
      `${p.clause} of ${p.policy} at line ${p.line} calls simetra.current_user_id() outside the uncorrelated subquery (select simetra.current_user_id())`,
    uk: (p) =>
      `${p.clause} у ${p.policy} у рядку ${p.line} кличе simetra.current_user_id() поза некорельованим підзапитом (select simetra.current_user_id())`,
    hint: {
      en: "Write the call exactly as (select simetra.current_user_id()): a bare call runs once per row, while the uncorrelated subquery is evaluated once per statement as an init plan.",
      uk: "Пишіть виклик рівно як (select simetra.current_user_id()): голий виклик виконується для кожного рядка, а некорельований підзапит обчислюється один раз на оператор як init plan.",
    },
  },
  "sql.debt-grows": {
    en: (p) =>
      `${p.identity} at line ${p.line} is verbatim SQL debt that sql-debt.json does not list`,
    uk: (p) =>
      `${p.identity} у рядку ${p.line} — борг дослівного SQL, якого немає в sql-debt.json`,
    hint: {
      en: "Debt only shrinks: introspect alone writes sql-debt.json, fix only removes entries. Express the statement through metadata (a kind property, an EventSubscription) or as a function in the closed shell (LANGUAGE sql or plpgsql, explicit volatility, SECURITY DEFINER only with SET search_path = ''); moving it from a kind module to sql/ does not make it acceptable.",
      uk: "Борг лише зменшується: sql-debt.json пише тільки introspect, fix лише прибирає записи. Виразіть оператор метаданими (властивість виду, EventSubscription) або функцією в закритій оболонці (LANGUAGE sql чи plpgsql, явна волатильність, SECURITY DEFINER лише з SET search_path = ''); перенесення з модуля виду в sql/ не робить його прийнятним.",
    },
  },
  "sql.debt-stale": {
    en: (p) =>
      `sql-debt.json lists ${p.identity}, which is no longer verbatim SQL debt`,
    uk: (p) =>
      `sql-debt.json перелічує ${p.identity}, що вже не є боргом дослівного SQL`,
    hint: {
      en: "The unit is gone or now has a closed form. Run simetra fix: it removes exactly such entries. Debt only shrinks: a removed entry comes back only through introspect.",
      uk: "Одиниці вже немає або вона тепер у закритій формі. Виконайте simetra fix: він прибирає саме такі записи. Борг лише зменшується: прибраний запис повертає тільки introspect.",
    },
  },
  "rewrite.ambiguous-name": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: a name cannot be resolved for the rename: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: ім'я не резолвиться для перейменування: ${p.detail}`,
    hint: {
      en: 'Qualify the column with its table alias (c.name), give the promoted table an alias, rename the PL/pgSQL variable or schema-qualify the table, then promote again. "capture" means the name would lead to another source after the promotion; "search-path" means a schema outside the model precedes the table in search_path.',
      uk: "Кваліфікуйте колонку псевдонімом таблиці (c.name), дайте промотованій таблиці псевдонім, перейменуйте змінну PL/pgSQL або кваліфікуйте таблицю схемою і повторіть промоцію. «capture» — після промоції ім'я вело б в інше джерело; «search-path» — у search_path перед таблицею стоїть схема поза моделлю.",
    },
  },
  "rewrite.unqualified-table": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: an unqualified table name depends on the caller's search_path: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: некваліфіковане ім'я таблиці залежить від search_path викликача: ${p.detail}`,
    hint: {
      en: "Qualify the table with its schema or give the function SET search_path.",
      uk: "Кваліфікуйте таблицю схемою або задайте функції SET search_path.",
    },
  },
  "rewrite.unsupported": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: this reference cannot be rewritten in place: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: це посилання не переписується на місці: ${p.detail}`,
    hint: {
      en: "Rewrite the construct by hand so that each renamed name is written out (an ON clause instead of USING, an explicit column list, an alias for an output column), then promote again.",
      uk: "Перепишіть конструкцію вручну, щоб кожне перейменоване ім'я було написане явно (ON замість USING, явний список колонок, псевдонім колонки виводу), і повторіть промоцію.",
    },
  },
  "rewrite.trigger-binding": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: a NEW/OLD field cannot be rewritten: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: поле NEW/OLD не переписується: ${p.detail}`,
    hint: {
      en: "One function body serves every table it is bound to: split the function per table or promote the tables together so they rename the column the same way.",
      uk: "Одне тіло функції обслуговує всі таблиці, до яких її прив'язано: розділіть функцію за таблицями або промотуйте таблиці разом, щоб вони однаково перейменовували колонку.",
    },
  },
  "rewrite.label-literal": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: a string literal equals a consumer label that the promotion replaces: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: рядковий літерал дорівнює мітці споживача, яку промоція замінює: ${p.detail}`,
    hint: {
      en: "After the promotion the data carries the kind label: compare with the kind label instead of the old value.",
      uk: "Після промоції дані несуть мітку виду: порівнюйте з міткою виду замість старого значення.",
    },
  },
  "rewrite.dynamic-sql": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: dynamic SQL cannot be rewritten statically: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: динамічний SQL не переписується статично: ${p.detail}`,
    hint: {
      en: "Replace EXECUTE with static SQL, or rewrite the function by hand before the promotion.",
      uk: "Замініть EXECUTE статичним SQL або перепишіть функцію вручну до промоції.",
    },
  },
  "rewrite.unresolved-type": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: a %TYPE reference does not resolve: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: посилання %TYPE не резолвиться: ${p.detail}`,
    hint: {
      en: "Write the type as schema.table.column%TYPE of a table of the model, or use the column's type directly.",
      uk: "Запишіть тип як схема.таблиця.колонка%TYPE таблиці моделі або вкажіть тип колонки прямо.",
    },
  },
  "rewrite.body-quoting": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: the body is not in dollar quotes, so positions in it cannot be mapped: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: тіло не в доларових лапках, тож позиції в ньому не відображаються: ${p.detail}`,
    hint: {
      en: "Put the function body in dollar quotes ($fn$ … $fn$).",
      uk: "Візьміть тіло функції в доларові лапки ($fn$ … $fn$).",
    },
  },
  "rewrite.verification-failed": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: the rewritten body does not match the expected statements: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: переписане тіло не збігається з очікуваними операторами: ${p.detail}`,
    hint: {
      en: "The rewriter refused instead of guessing; put the statements on separate lines or rewrite the function by hand.",
      uk: "Переписувач відмовився, а не вгадував; розмістіть оператори на окремих рядках або перепишіть функцію вручну.",
    },
  },
  "rewrite.contract-change": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: the promotion changes the shape of a result: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: промоція змінює форму результату: ${p.detail}`,
    hint: {
      en: "A star, a whole row or a table row type follows the new columns of the kind; list the columns explicitly where callers depend on the old shape. An INSERT without a column list breaks because the promotion adds and removes columns: list the columns.",
      uk: "Зірочка, цілий рядок чи тип рядка таблиці йдуть за новими колонками виду; перелічіть колонки явно там, де викликачі залежать від старої форми. INSERT без списку колонок ламається, бо промоція додає й знімає колонки: перелічіть колонки.",
    },
  },
  "rewrite.dynamic-sql-unscoped": {
    en: (p) =>
      `Function ${p.function} at line ${p.line}, column ${p.column}: dynamic SQL may reach the promoted table, and static analysis cannot see it: ${p.detail}`,
    uk: (p) =>
      `Функція ${p.function}, рядок ${p.line}, колонка ${p.column}: динамічний SQL може звертатися до промотованої таблиці, а статичний аналіз цього не бачить: ${p.detail}`,
  },
  "sql.dependency-cycle": {
    en: (p) =>
      p.line === undefined
        ? `${p.identity} is part of a dependency cycle: ${p.cycle}`
        : `${p.identity} at line ${p.line} is part of a dependency cycle: ${p.cycle}`,
    uk: (p) =>
      p.line === undefined
        ? `${p.identity} входить до циклу залежностей: ${p.cycle}`
        : `${p.identity} у рядку ${p.line} входить до циклу залежностей: ${p.cycle}`,
    hint: {
      en: "Each object in the cycle needs the next one to exist first, so no creation order exists. Unqualified names match objects of every schema, because the search_path is not known when compiling: qualify names with their schema so that a reference reaches only the object it means. A real cycle has to be broken by changing one of the objects.",
      uk: "Кожен об'єкт циклу потребує, щоб наступний уже існував, тож порядку створення немає. Некваліфіковані імена збігаються з об'єктами всіх схем, бо під час компіляції search_path невідомий: кваліфікуйте імена схемою, щоб посилання досягало лише потрібного об'єкта. Справжній цикл розриває зміна одного з об'єктів.",
    },
  },

  "file.orphan": {
    en: (p) => `No ${p.expected} next to this file`,
    uk: (p) => `Поруч із цим файлом немає ${p.expected}`,
  },
  "file.invalid-json": {
    en: (p) => `Invalid JSON: ${p.detail}`,
    uk: (p) => `Некоректний JSON: ${p.detail}`,
  },
  "file.schema": {
    en: (p) => String(p.detail),
    // Український текст Zod рахує stage 1 (`detailUk`); власні повідомлення
    // схем T0 англійські.
    uk: (p) => String(p.detailUk ?? p.detail),
  },
  "file.unknown-key": {
    en: (p) => `Unknown key "${p.key}"`,
    uk: (p) => `Невідомий ключ "${p.key}"`,
    hint: {
      en: "Check the spelling against the JSON Schema of the file, or remove the key.",
      uk: "Звірте написання з JSON Schema файлу або приберіть ключ.",
    },
  },
  "file.kind-mismatch": {
    en: (p) =>
      `Folder ${p.dir}/ holds ${p.expected} objects, but kind is ${p.actual}`,
    uk: (p) =>
      `Тека ${p.dir}/ містить об'єкти виду ${p.expected}, але kind — ${p.actual}`,
  },
  "file.name-mismatch": {
    en: (p) => `Folder and file name must equal the logical name "${p.name}"`,
    uk: (p) =>
      `Тека й ім'я файлу мають збігатися з логічним іменем "${p.name}"`,
  },

  // --- Стадія 2: ідентичність, імена, посилання ---
  "identity.id-missing": {
    en: () => "id is missing",
    uk: () => "Немає id",
    hint: FIX_IDS,
  },
  "identity.id-duplicate": {
    en: (p) => `id ${p.id} is already used in ${p.firstFile}`,
    uk: (p) => `id ${p.id} уже використано в ${p.firstFile}`,
    hint: {
      en: "Ids are never reused; assign a new id to one of the elements.",
      uk: "Id не використовують повторно; призначте новий id одному з елементів.",
    },
  },
  "identity.physical-name-missing": {
    en: () => "physicalName is missing",
    uk: () => "Немає physicalName",
    hint: FIX_PHYSICAL_NAMES,
  },
  "identity.kind-label-missing": {
    en: () => "kindLabel is missing",
    uk: () => "Немає kindLabel",
    hint: FIX_PHYSICAL_NAMES,
  },
  "identity.kind-label-retained": {
    en: () =>
      "Without a single-column uuid key this object can no longer be a target of polymorphic references; kindLabel is kept because it is assigned once",
    uk: () =>
      "Без одноколонкового uuid-ключа цей об'єкт більше не може бути ціллю поліморфних посилань; kindLabel лишається, бо призначається раз",
  },
  "identity.kind-label-duplicate": {
    en: (p) => `kindLabel "${p.label}" is already used in ${p.firstFile}`,
    uk: (p) => `kindLabel "${p.label}" уже використано в ${p.firstFile}`,
    hint: {
      en: "Kind labels are unique across the project and assigned once; give one of the objects a new label.",
      uk: "Мітки виду унікальні в проєкті й призначаються раз; дайте одному з об'єктів нову мітку.",
    },
  },
  "identity.assigned-once-changed": {
    // `objectFile` є лише тоді, коли схема об'єкта успадкована з обох боків:
    // діагностика стоїть на проєкті, і текст мусить назвати об'єкт.
    en: (p) =>
      p.objectFile === undefined
        ? `${p.field} is assigned once and cannot change: "${p.before}" became "${p.after}"`
        : `Schema of ${p.objectFile} changed from "${p.before}" to "${p.after}": it inherits defaultSchema, and the schema is assigned once`,
    uk: (p) =>
      p.objectFile === undefined
        ? `${p.field} призначається раз і не змінюється: було "${p.before}", стало "${p.after}"`
        : `Схема ${p.objectFile} змінилася з "${p.before}" на "${p.after}": вона успадковує defaultSchema, а схема призначається раз`,
    hint: {
      en: (p) =>
        p.objectFile === undefined
          ? "Restore the previous value. A rename keeps physical names; a different table or column is a new element with a new id."
          : `Restore defaultSchema, or give ${p.objectFile} an explicit schema "${p.before}".`,
      uk: (p) =>
        p.objectFile === undefined
          ? "Поверніть попереднє значення. Перейменування зберігає фізичні імена; інша таблиця чи колонка — новий елемент з новим id."
          : `Поверніть defaultSchema або задайте ${p.objectFile} явну схему "${p.before}".`,
    },
  },
  "identity.name-duplicate": {
    en: (p) => `Name "${p.name}" is already declared in ${p.scope}`,
    uk: (p) => `Ім'я "${p.name}" уже оголошене в ${p.scope}`,
  },
  "identity.name-case": {
    en: (p) =>
      `Name "${p.name}" does not follow the project naming style ${p.style}`,
    uk: (p) => `Ім'я "${p.name}" не відповідає стилю імен проєкту ${p.style}`,
  },
  "identity.name-reserved": {
    en: (p) =>
      `Name "${p.name}" is taken by a standard element of the kind ${p.kind}`,
    uk: (p) => `Ім'я "${p.name}" зайняте стандартним елементом виду ${p.kind}`,
  },
  "reference.unresolved": {
    en: (p) => `${p.kind} "${p.name}" does not exist`,
    uk: (p) => `${p.kind} "${p.name}" не існує`,
  },
  "reference.ambiguous": {
    en: (p) => `Name "${p.name}" is ambiguous between ${p.candidates}`,
    uk: (p) => `Ім'я "${p.name}" неоднозначне між ${p.candidates}`,
    hint: {
      en: (p) =>
        `Qualify the marker as <Kind>.<Name>, for example ${String(p.candidates).split(", ")[0]}.`,
      uk: (p) =>
        `Кваліфікуйте маркер як <Kind>.<Name>, наприклад ${String(p.candidates).split(", ")[0]}.`,
    },
  },
  "register.balance-control-resource": {
    en: (p) => `Register has no resource "${p.name}"`,
    uk: (p) => `У регістрі немає ресурсу "${p.name}"`,
    hint: {
      en: "balanceControl lists logical names of the register's resources.",
      uk: "balanceControl перелічує логічні імена ресурсів регістра.",
    },
  },
  "register.balance-control-duplicate": {
    en: (p) => `Resource "${p.name}" is already listed in balanceControl`,
    uk: (p) => `Ресурс "${p.name}" уже є в balanceControl`,
    hint: {
      en: "List each resource once.",
      uk: "Перелічіть кожен ресурс один раз.",
    },
  },
  "posting.field-unknown": {
    en: (p) => `${p.scope} has no field "${p.name}"`,
    uk: (p) => `У ${p.scope} немає поля "${p.name}"`,
    hint: {
      en: "Standard attributes are written by their logical name in the project naming style.",
      uk: "Стандартні реквізити записують за логічним іменем у стилі імен проєкту.",
    },
  },
  "posting.register-field-unknown": {
    en: (p) => `Register has no dimension, resource or attribute "${p.name}"`,
    uk: (p) => `У регістрі немає виміру, ресурсу чи реквізиту "${p.name}"`,
    hint: {
      en: "Keys of a movement's fields are logical names of the register's own fields.",
      uk: "Ключі fields руху — логічні імена власних полів регістра.",
    },
  },
  "posting.tabular-section-unknown": {
    en: (p) => `Document has no tabular section "${p.name}"`,
    uk: (p) => `У документі немає табличної частини "${p.name}"`,
  },
  "scope.declaration-missing": {
    en: (p) => `${p.kind} "${p.name}" does not declare its scope`,
    uk: (p) => `${p.kind} "${p.name}" не оголошує свій скоуп`,
    hint: {
      en: 'Once the project declares a scope kind, every scoped object sets "scope" to a kind name or "none".',
      uk: 'Щойно проєкт оголошує вид скоупу, кожен об\'єкт задає "scope" як ім\'я виду або "none".',
    },
  },
  "scope.unknown-kind": {
    en: (p) => `Scope kind "${p.name}" is not declared in the project`,
    uk: (p) => `Вид скоупу "${p.name}" не оголошений у проєкті`,
    hint: {
      en: 'Scope kinds are declared in project.meta.json under "scopeKinds"; "none" opts the object out of scope.',
      uk: 'Види скоупу оголошують у project.meta.json у "scopeKinds"; "none" виводить об\'єкт зі скоупу.',
    },
  },
  "storage.bucket-duplicate": {
    en: (p) => `Storage bucket "${p.bucket}" is declared more than once`,
    uk: (p) => `Бакет сховища "${p.bucket}" оголошений більше одного разу`,
    hint: {
      en: "A bucket has one access policy, so it names exactly one scope kind.",
      uk: "Бакет має одну політику доступу, тож називає рівно один вид скоупу.",
    },
  },
  "storage.scope-kind-unknown": {
    en: (p) =>
      `Storage bucket "${p.bucket}" names scope kind "${p.name}" that is not declared in the project`,
    uk: (p) =>
      `Бакет сховища "${p.bucket}" називає вид скоупу "${p.name}", якого немає в проєкті`,
    hint: {
      en: 'Scope kinds are declared in project.meta.json under "scopeKinds".',
      uk: 'Види скоупу оголошують у project.meta.json у "scopeKinds".',
    },
  },
  "scope.attribute-name-collision": {
    en: (p) =>
      `Name "${p.name}" collides with the scope column of this ${p.kind}`,
    uk: (p) =>
      `Ім'я "${p.name}" збігається з колонкою скоупу цього об'єкта виду ${p.kind}`,
    hint: {
      en: "The scope column takes the scope kind's logical name in the object's table.",
      uk: "Колонка скоупу в таблиці об'єкта бере логічне ім'я виду скоупу.",
    },
  },
  "scope.root-duplicate": {
    en: () => "Another scope kind already uses this root",
    uk: () => "Цей корінь уже використовує інший вид скоупу",
    hint: {
      en: "Every scope kind has its own root.",
      uk: "Кожен вид скоупу має власний корінь.",
    },
  },
  "scope.root-hierarchy": {
    en: (p) =>
      `Root ${p.kind} "${p.name}" of scope kind "${p.scope}" cannot be hierarchical`,
    uk: (p) =>
      `Корінь ${p.kind} "${p.name}" виду скоупу "${p.scope}" не може бути ієрархічним`,
    hint: {
      en: 'Scope hierarchy is not supported; set hierarchyType to "None" and express a holding with an attribute that sets "crossScope".',
      uk: 'Ієрархія скоупу не підтримується; задайте hierarchyType "None", а холдинг виразіть реквізитом із "crossScope".',
    },
  },
  "scope.root-key": {
    en: (p) =>
      `Root of scope kind "${p.scope}" (${p.kind} "${p.name}") has no single-column uuid key`,
    uk: (p) =>
      `Корінь виду скоупу "${p.scope}" (${p.kind} "${p.name}") не має одноколонкового ключа uuid`,
    hint: {
      en: "A scope root is a table object with a single-column uuid primary key; its key is the scope value.",
      uk: "Корінь скоупу — табличний об'єкт з одноколонковим первинним ключем uuid; його ключ — значення скоупу.",
    },
  },
  "scope.root-declaration": {
    en: (p) =>
      `${p.kind} "${p.name}" is the root of scope kind "${p.scope}" but does not declare it`,
    uk: (p) =>
      `${p.kind} "${p.name}" — корінь виду скоупу "${p.scope}", але не оголошує його`,
    hint: {
      en: 'Set "scope" of the root to its own scope kind.',
      uk: 'Задайте "scope" кореня як його власний вид скоупу.',
    },
  },
  "scope.root-self-reference": {
    en: (p) =>
      `Reference to ${p.kind} "${p.name}", the root of the same scope kind "${p.scope}"`,
    uk: (p) =>
      `Посилання на ${p.kind} "${p.name}" — корінь того самого виду скоупу "${p.scope}"`,
    hint: {
      en: (p) =>
        p.via === "owner"
          ? "An owner cannot be the root of its own scope kind; a cross-scope owner is not supported."
          : 'The root key is already the scope value of the object; drop the reference, or set "crossScope" if it deliberately points to another tenant.',
      uk: (p) =>
        p.via === "owner"
          ? "Власник не може бути коренем власного виду скоупу; власник з іншого скоупу не підтримується."
          : 'Ключ кореня вже є значенням скоупу об\'єкта; приберіть посилання або задайте "crossScope", якщо воно свідомо веде до іншого тенанта.',
    },
  },
  "scope.global-to-scoped": {
    en: (p) =>
      `Unscoped object references ${p.kind} "${p.name}" of scope kind "${p.scope}"`,
    uk: (p) =>
      `Об'єкт без скоупу посилається на ${p.kind} "${p.name}" виду скоупу "${p.scope}"`,
    hint: {
      en: (p) =>
        p.via === "owner"
          ? "An owner must share the scope kind; a cross-scope owner is not supported."
          : 'Set "crossScope": true on the Ref if the link is intentional.',
      uk: (p) =>
        p.via === "owner"
          ? "Власник має мати той самий вид скоупу; власник з іншого скоупу не підтримується."
          : 'Задайте "crossScope": true на Ref, якщо зв\'язок навмисний.',
    },
  },
  "scope.cross-kind": {
    en: (p) =>
      `Object of scope kind "${p.from}" references ${p.kind} "${p.name}" of scope kind "${p.scope}"`,
    uk: (p) =>
      `Об'єкт виду скоупу "${p.from}" посилається на ${p.kind} "${p.name}" виду скоупу "${p.scope}"`,
    hint: {
      en: (p) =>
        p.via === "owner"
          ? "An owner must share the scope kind; a cross-scope owner is not supported."
          : 'Set "crossScope": true on the Ref if the link is intentional.',
      uk: (p) =>
        p.via === "owner"
          ? "Власник має мати той самий вид скоупу; власник з іншого скоупу не підтримується."
          : 'Задайте "crossScope": true на Ref, якщо зв\'язок навмисний.',
    },
  },
  "scope.recorder-mismatch": {
    en: (p) =>
      `Register scope "${p.scope}" differs from the scope "${p.recorderScope}" of recorder ${p.kind} "${p.name}"`,
    uk: (p) =>
      `Скоуп регістра "${p.scope}" відрізняється від скоупу "${p.recorderScope}" реєстратора ${p.kind} "${p.name}"`,
    hint: {
      en: "A register and all of its recorders share one scope kind.",
      uk: "Регістр і всі його реєстратори мають один вид скоупу.",
    },
  },
  "scope.custom-table-column": {
    en: (p) =>
      p.column === undefined
        ? "Scoped CustomTable must name its scope column in scopeColumn"
        : p.unscoped !== undefined
          ? `scopeColumn "${p.column}" is set, but the table has no scope kind`
          : `scopeColumn "${p.column}" must be a uuid column`,
    uk: (p) =>
      p.column === undefined
        ? "CustomTable зі скоупом має назвати колонку скоупу в scopeColumn"
        : p.unscoped !== undefined
          ? `scopeColumn "${p.column}" задано, але таблиця не має виду скоупу`
          : `scopeColumn "${p.column}" має бути колонкою uuid`,
  },
  "scope.cross-scope-redundant": {
    en: () => "crossScope has no effect: the reference is allowed without it",
    uk: () => "crossScope нічого не змінює: посилання дозволене й без нього",
    hint: { en: "Remove crossScope.", uk: "Приберіть crossScope." },
  },
  "scope.custom-table-cross-tenant": {
    en: (p) =>
      `The reference to the scoped CustomTable ${p.table} cannot be a composite key: the foreign key does not hold the tenant`,
    uk: (p) =>
      `Посилання на CustomTable ${p.table} зі скоупом не може бути складеним ключем: зовнішній ключ не тримає тенант`,
    hint: {
      en: "Add a unique constraint over the scope column and the key to the metadata of the adopted table, or mark the reference crossScope.",
      uk: "Додайте в метадані прийнятої таблиці обмеження унікальності над колонкою скоупу й ключем або позначте посилання crossScope.",
    },
  },

  "scope.set-function-missing": {
    en: (p) =>
      `Scope set function ${p.function}() is not defined in any .sql file`,
    uk: (p) =>
      `Функція множини скоупу ${p.function}() не визначена в жодному файлі .sql`,
    hint: {
      en: "Add 'CREATE FUNCTION <schema>.<name>() RETURNS SETOF uuid LANGUAGE sql STABLE ...' to a .sql file.",
      uk: "Додайте 'CREATE FUNCTION <схема>.<ім'я>() RETURNS SETOF uuid LANGUAGE sql STABLE ...' до файлу .sql.",
    },
  },
  "scope.membership-missing": {
    en: (p) =>
      `Scope kind "${p.kind}" takes its set function from membership, but no catalog of this scope kind has membership`,
    uk: (p) =>
      `Вид скоупу "${p.kind}" бере функцію множини з членства, але жоден довідник цього виду не має membership`,
    hint: {
      en: "Add membership to a catalog scoped by this kind, or name a set function from a .sql file.",
      uk: "Додайте membership довіднику цього виду скоупу або назвіть функцію множини з файлу .sql.",
    },
  },
  "scope.set-function-signature": {
    en: (p) =>
      p.reason === undefined
        ? `Scope set function ${p.function}() has the wrong signature: ${p.problem}`
        : `Scope set function ${p.function}() is outside the closed form: ${SET_FUNCTION_REASON[String(p.reason)]?.en ?? p.reason}`,
    uk: (p) =>
      p.reason === undefined
        ? `Функція множини скоупу ${p.function}() має хибну сигнатуру: ${p.problem}`
        : `Функція множини скоупу ${p.function}() поза закритою формою: ${SET_FUNCTION_REASON[String(p.reason)]?.uk ?? p.reason}`,
    hint: {
      en: "A set function takes no arguments, returns SETOF uuid and is LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '', with every relation in its body qualified by a schema.",
      uk: "Функція множини не приймає аргументів, повертає SETOF uuid і є LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '', а кожне відношення в тілі кваліфіковане схемою.",
    },
  },

  "subscription.source-not-table": {
    en: (p) =>
      `${p.kind} "${p.name}" has no table, so an event subscription cannot listen to it`,
    uk: (p) =>
      `${p.kind} "${p.name}" не має таблиці, тож підписка на подію не може її слухати`,
    hint: {
      en: "A subscription source is an object with a table (catalog, document, register, constant, custom table) or a provider table from the preset.",
      uk: "Джерело підписки — об'єкт із таблицею (довідник, документ, регістр, константа, прийнята таблиця) або таблиця провайдера з пресету.",
    },
  },
  "subscription.provider-table-unknown": {
    en: (p) =>
      `Provider table ${p.table} is not an event source of the ${p.provider} preset`,
    uk: (p) =>
      `Таблиця провайдера ${p.table} не є джерелом подій пресету ${p.provider}`,
    hint: {
      en: (p) => `Event sources of the preset: ${p.known}.`,
      uk: (p) => `Джерела подій пресету: ${p.known}.`,
    },
  },
  "subscription.when-changed-unknown": {
    en: (p) => `whenChanged names "${p.name}", which ${p.source} does not have`,
    uk: (p) => `whenChanged називає "${p.name}", якого немає в ${p.source}`,
    hint: {
      en: "Every name must be an attribute or standard attribute of each object source, or a preset column of each provider table.",
      uk: "Кожне ім'я мусить бути реквізитом чи стандартним реквізитом кожного джерела-об'єкта або колонкою пресету кожної таблиці провайдера.",
    },
  },
  "subscription.when-changed-duplicate": {
    en: (p) => `whenChanged names "${p.name}" more than once`,
    uk: (p) => `whenChanged називає "${p.name}" більше одного разу`,
  },
  "subscription.source-duplicate": {
    en: (p) => `Subscription source ${p.source} is listed more than once`,
    uk: (p) => `Джерело підписки ${p.source} указане більше одного разу`,
    hint: {
      en: "One source gets one trigger per subscription; list it once.",
      uk: "Джерело отримує один тригер на підписку; вкажіть його один раз.",
    },
  },
  "subscription.name-duplicate": {
    en: (p) =>
      `Subscription physical name "${p.name}" is already used in ${p.firstFile}`,
    uk: (p) => `Фізичне ім'я підписки "${p.name}" уже зайняте в ${p.firstFile}`,
    hint: {
      en: "The physical name is the base of the trigger name; two equal ones would give same-named triggers on a shared table.",
      uk: "Фізичне ім'я — база імені тригера; два однакові дали б однойменні тригери на спільній таблиці.",
    },
  },
  "subscription.when-changed-on-delete": {
    en: (p) => `whenChanged is not allowed with the ${p.event} event`,
    uk: (p) => `whenChanged недопустимий з подією ${p.event}`,
    hint: {
      en: "A deleted row changes no columns; remove whenChanged or choose a write event.",
      uk: "Видалений рядок не змінює колонок; приберіть whenChanged або оберіть подію запису.",
    },
  },
  "subscription.handler-missing": {
    en: (p) =>
      `Subscription handler ${p.function}() is not declared in .sql files`,
    uk: (p) => `Обробник підписки ${p.function}() не оголошений у файлах .sql`,
    hint: {
      en: "Declare the handler with CREATE FUNCTION in an object .sql file or under sql/<schema>/.",
      uk: "Оголосіть обробник через CREATE FUNCTION у .sql об'єкта або в sql/<схема>/.",
    },
  },
  "subscription.handler-signature": {
    en: (p) =>
      `Subscription handler ${p.function}() has the wrong signature: ${p.problem}`,
    uk: (p) =>
      `Обробник підписки ${p.function}() має хибну сигнатуру: ${p.problem}`,
    hint: {
      en: "A handler takes no arguments and returns trigger.",
      uk: "Обробник не приймає аргументів і повертає trigger.",
    },
  },
  "subscription.handler-not-closed": {
    en: (p) =>
      `Subscription handler ${p.function}() is outside the closed shell: ${(CLOSED_SHELL_PROBLEM[String(p.problem)] ?? { en: p.problem }).en}`,
    uk: (p) =>
      `Обробник підписки ${p.function}() поза закритою оболонкою: ${(CLOSED_SHELL_PROBLEM[String(p.problem)] ?? { uk: p.problem }).uk}`,
    hint: {
      en: `A handler is never debt, wherever its file is. ${CLOSED_SHELL_HINT.en}`,
      uk: `Обробник ніколи не буває боргом, хоч би де лежав його файл. ${CLOSED_SHELL_HINT.uk}`,
    },
  },
  "subscription.handler-assigns-mechanics": {
    en: (p) =>
      `Handler ${p.function} assigns a row-mechanics column or replaces the row (${p.problem}); the platform maintains updated_at and version`,
    uk: (p) =>
      `Обробник ${p.function} присвоює колонку механіки рядка або підміняє рядок (${p.problem}); updated_at і version веде платформа`,
    hint: {
      en: "Change other columns of NEW and return NEW, or NULL to skip the write.",
      uk: "Змінюйте інші колонки NEW і повертайте NEW або NULL, щоб пропустити запис.",
    },
  },
  "subscription.trigger-name-taken": {
    en: (p) =>
      `Trigger ${p.name} of this subscription on ${p.table} is already generated by ${p.holder}`,
    uk: (p) =>
      `Тригер ${p.name} цієї підписки на ${p.table} уже генерує ${p.holder}`,
    hint: {
      en: "Give the subscription another physicalName.",
      uk: "Дайте підписці інший physicalName.",
    },
  },
  "subscription.when-changed-mechanics": {
    en: (p) =>
      `whenChanged lists ${p.column}, which the row mechanics maintains; the trigger condition would depend on trigger order`,
    uk: (p) =>
      `whenChanged містить ${p.column}, яку веде механіка рядка; умова тригера залежала б від порядку тригерів`,
    hint: {
      en: "List business attributes only.",
      uk: "Перелічіть лише бізнес-реквізити.",
    },
  },

  // --- Стадія 4: цілісність ---
  "users.catalog-duplicate": {
    en: (p) =>
      `Catalog "${p.name}" is a second users catalog: "${p.firstFile}" already has role users`,
    uk: (p) =>
      `Довідник "${p.name}" — другий довідник користувачів: "${p.firstFile}" уже має роль users`,
    hint: {
      en: "A project has one users catalog, the one the platform layer provisions accounts into: remove role from the other one.",
      uk: "У проєкті один довідник користувачів — той, у який платформний шар провізує облікові записи: приберіть role з іншого.",
    },
  },
  "users.scope-not-none": {
    en: (p) => `Users catalog "${p.name}" must have scope "none"`,
    uk: (p) => `Довідник користувачів "${p.name}" мусить мати scope "none"`,
    hint: {
      en: "A user exists before and across tenants; membership in a tenant is a separate scoped catalog.",
      uk: "Користувач існує раніше за тенант і поза ним; членство в тенанті — окремий скоуплений довідник.",
    },
  },
  "users.description-required": {
    en: (p) => `Users catalog "${p.name}" must have a description`,
    uk: (p) => `Довідник користувачів "${p.name}" мусить мати найменування`,
    hint: {
      en: "The description is the user's display name, filled from the account at provisioning: set descriptionLength above 0.",
      uk: "Найменування — відображуване ім'я користувача, його заповнює провізія з облікового запису: задайте descriptionLength більше 0.",
    },
  },
  "users.provision-unsafe": {
    en: (p) =>
      `${p.reason === "rowRule" ? `Row rule "${p.element}"` : `Attribute "${p.element}"`} of users catalog "${p.name}" would break provisioning: ${(PROVISION_HAZARD[String(p.reason)] ?? { en: p.reason }).en}`,
    uk: (p) =>
      `${p.reason === "rowRule" ? `Правило рядка "${p.element}"` : `Реквізит "${p.element}"`} довідника користувачів "${p.name}" зірвав би провізію: ${(PROVISION_HAZARD[String(p.reason)] ?? { uk: p.reason }).uk}`,
    hint: {
      en: "Provisioning inserts a user row with only the key and the description, and a failure there aborts sign-up: every other column must accept that row.",
      uk: "Провізія вставляє рядок користувача лише з ключем і найменуванням, а помилка в ній зриває реєстрацію: кожна інша колонка мусить прийняти такий рядок.",
    },
  },
  "users.catalog-missing": {
    en: (p) =>
      `${p.kind} "${p.name}" has ${p.feature}, which references the users catalog, but no catalog has role users`,
    uk: (p) =>
      `${p.kind} "${p.name}" має ${p.feature}, що посилається на довідник користувачів, але жоден довідник не має ролі users`,
    hint: {
      en: "Add a catalog with role users, or remove the field.",
      uk: "Додайте довідник із роллю users або приберіть поле.",
    },
  },

  "membership.not-scoped": {
    en: (p) =>
      `Catalog "${p.name}" has membership but no scope column of its own: it is unscoped or the root of its scope kind`,
    uk: (p) =>
      `Довідник "${p.name}" має membership, але не має власної скоуп-колонки: він без скоупу або корінь свого виду скоупу`,
    hint: {
      en: "Membership belongs to a catalog scoped by a scope kind it is not the root of; set its scope or remove membership.",
      uk: "Членство має довідник, скоуплений видом, коренем якого він не є; задайте йому scope або приберіть membership.",
    },
  },
  "membership.user-not-users-ref": {
    en: (p) =>
      `membership.user of catalog "${p.name}" names "${p.attribute}", which is not a scalar Ref attribute to the users catalog`,
    uk: (p) =>
      `membership.user довідника "${p.name}" називає "${p.attribute}", а це не скалярний реквізит Ref на довідник користувачів`,
    hint: {
      en: "Name an own attribute of type Ref with ref to the catalog with role users, without array or allowedTypes.",
      uk: "Назвіть власний реквізит типу Ref з ref на довідник із роллю users, без array і allowedTypes.",
    },
  },
  "membership.duplicate": {
    en: (p) =>
      `Catalog "${p.name}" is a second membership catalog of scope kind "${p.scopeKind}"; the first is in ${p.firstFile}`,
    uk: (p) =>
      `Довідник "${p.name}" — другий довідник членства виду скоупу "${p.scopeKind}"; перший — у ${p.firstFile}`,
    hint: {
      en: "A scope kind has at most one membership catalog; remove membership from one of them.",
      uk: "Вид скоупу має щонайбільше один довідник членства; приберіть membership з одного з них.",
    },
  },

  "rights.action-unknown": {
    en: (p) => `Action "${p.action}" is not an action of ${p.object}`,
    uk: (p) => `Дія "${p.action}" не є дією ${p.object}`,
    hint: {
      en: "Name a standard action of the kind or a custom action of the same object.",
      uk: "Назвіть стандартну дію виду або кастомну дію того самого об'єкта.",
    },
  },
  "rights.custom-action-reserved": {
    en: (p) =>
      `Custom action "${p.action}" repeats a standard action of ${p.kind}`,
    uk: (p) =>
      `Кастомна дія "${p.action}" повторює стандартну дію виду ${p.kind}`,
    hint: {
      en: "Rename the custom action: the standard action already exists.",
      uk: "Перейменуйте кастомну дію: стандартна дія вже існує.",
    },
  },
  "rights.custom-action-effects": {
    en: (p) =>
      p.reason === "noWrite"
        ? `Custom action "${p.action}" declares effects, but no standard action of the kind writes its rows`
        : `Custom action "${p.action}" writes tabular sections, but the kind has none`,
    uk: (p) =>
      p.reason === "noWrite"
        ? `Кастомна дія "${p.action}" оголошує ефекти, але жодна стандартна дія виду не пише його рядків`
        : `Кастомна дія "${p.action}" пише табличні частини, а вид їх не має`,
    hint: {
      en: (p) =>
        p.reason === "noWrite"
          ? "Rows of this kind are written only by posting movements: declare no effects, or move the action to a kind that writes."
          : "Drop tabularSections: true or declare the action on a kind with tabular sections.",
      uk: (p) =>
        p.reason === "noWrite"
          ? "Рядки цього виду пишуть лише рухи проведення: не оголошуйте ефектів або перенесіть дію на вид із записом."
          : "Приберіть tabularSections: true або оголосіть дію на виді з табличними частинами.",
    },
  },
  "rights.requires-cycle": {
    en: (p) => `Custom action requirements form a cycle: ${p.actions}`,
    uk: (p) => `Вимоги кастомних дій утворюють цикл: ${p.actions}`,
    hint: {
      en: "Remove one requirement of the chain.",
      uk: "Приберіть одну вимогу ланцюжка.",
    },
  },
  "rights.attribute-unknown": {
    en: (p) =>
      p.target === undefined
        ? `${p.field} names "${p.attribute}", which is not an attribute of the object`
        : `${p.field} names "${p.attribute}", which is not an attribute of ${p.target}, the target of the path`,
    uk: (p) =>
      p.target === undefined
        ? `${p.field} називає "${p.attribute}", а це не реквізит об'єкта`
        : `${p.field} називає "${p.attribute}", а це не реквізит ${p.target} — цілі шляху`,
    hint: {
      en: "Name an own attribute or a standard attribute of the object.",
      uk: "Назвіть власний або стандартний реквізит об'єкта.",
    },
  },
  "rights.carrier-not-ref": {
    en: (p) =>
      `Rights carrier "${p.attribute}" is not a single reference or the key`,
    uk: (p) =>
      `Носій прав "${p.attribute}" не є одиночним посиланням чи ключем`,
    hint: {
      en: "A carrier names a Ref attribute with one target; the first step of a path must be such a reference too, not a polymorphic one.",
      uk: "Носій називає реквізит Ref з однією ціллю; перший крок шляху — теж таке посилання, а не поліморфне.",
    },
  },
  "rights.carrier-cross-tenant": {
    en: (p) =>
      p.host === "unscoped"
        ? `Rights carrier "${p.attribute}" is not a reference within the scope: its object is not scoped`
        : `Rights carrier "${p.attribute}" leaves the tenant`,
    uk: (p) =>
      p.host === "unscoped"
        ? `Носій прав "${p.attribute}" не є посиланням у межах скоупу: його об'єкт не скоуплений`
        : `Носій прав "${p.attribute}" виходить за межі тенанта`,
    hint: {
      en: (p) =>
        p.host === "unscoped"
          ? "A carrier stays within the scope through a composite foreign key, which only a scoped object has: scope the object or drop the declaration."
          : "The reference must stay within the scope (a composite foreign key): drop crossScope or name another attribute.",
      uk: (p) =>
        p.host === "unscoped"
          ? "Носій тримається межі скоупу складеним зовнішнім ключем, а його має лише скоуплений об'єкт: скоупіть об'єкт або приберіть декларацію."
          : "Посилання мусить лишатися в межах скоупу (складений зовнішній ключ): приберіть crossScope або назвіть інший реквізит.",
    },
  },
  "rights.carrier-column-taken": {
    en: (p) =>
      `Column "${p.column}" of table "${p.table}" is taken: a rights carrier copies its value there`,
    uk: (p) =>
      `Колонка "${p.column}" таблиці "${p.table}" зайнята: туди копіює значення носій прав`,
    hint: {
      en: "The platform keeps a copy of every rights carrier in each tabular section and of a path carrier in the object row under this name; rename the attribute that takes it.",
      uk: "Платформа тримає копію кожного носія прав у кожній ТЧ, а носія через шлях — і в рядку об'єкта, під цим ім'ям; перейменуйте реквізит, що його займає.",
    },
  },
  "rights.carrier-path-adopted": {
    en: (p) =>
      `Rights carrier path "${p.attribute}" goes through an adopted table`,
    uk: (p) => `Шлях носія прав "${p.attribute}" іде через прийняту таблицю`,
    hint: {
      en: "The step of a path must point to an object of a kind: the platform propagates the carrier copy with a trigger on the target table, and an adopted table carries no platform triggers.",
      uk: "Крок шляху мусить указувати на об'єкт виду: копію носія платформа поширює тригером на таблиці цілі, а прийнята таблиця платформних тригерів не несе.",
    },
  },
  "rights.register-access-dimension": {
    en: (p) =>
      `Access mapping "${p.attribute}" of a register is not a register dimension`,
    uk: (p) => `Мапінг доступу "${p.attribute}" регістра не є виміром регістра`,
    hint: {
      en: "A register is read by its dimensions in the movements and the totals alike, so an access mapping names a dimension of the register itself, not a resource, an attribute or a path.",
      uk: "Регістр читається за вимірами і в рухах, і в підсумках, тож мапінг доступу називає вимір самого регістра, а не ресурс, реквізит чи шлях.",
    },
  },
  "rights.dimension-name-reserved": {
    en: (p) => `Access dimension name "${p.name}" is reserved`,
    uk: (p) => `Ім'я виміру доступу "${p.name}" зарезервоване`,
    hint: {
      en: "A rights read policy is named after the dimension next to the extent forms any, own and in_<container>; choose a name that is not any or own and does not start with own or in.",
      uk: "Політику прав читання названо за виміром поруч із формами обсягу any, own та in_<контейнер>; оберіть ім'я, що не є any чи own і не починається з own чи in.",
    },
  },
  "rights.container-target": {
    en: (p) =>
      p.role !== undefined
        ? `Role "${p.role}" is assigned on "${p.name}", which is not a rights container`
        : p.source === undefined
          ? `Container binding "${p.attribute}" references "${p.name}", which is not a rights container`
          : `Assignment source "${p.source}" is assigned on "${p.name}", which is not a rights container`,
    uk: (p) =>
      p.role !== undefined
        ? `Роль "${p.role}" має рівень "${p.name}", який не є контейнером прав`
        : p.source === undefined
          ? `Прив'язка до контейнера "${p.attribute}" посилається на "${p.name}", який не є контейнером прав`
          : `Джерело призначень "${p.source}" має рівень "${p.name}", який не є контейнером прав`,
    hint: {
      en: "Set rightsContainer: true on the target catalog or name another attribute.",
      uk: "Задайте rightsContainer: true на довіднику-цілі або назвіть інший реквізит.",
    },
  },
  "rights.container-self": {
    en: (p) =>
      `Container "${p.name}" is bound to itself through "${p.attribute}"`,
    uk: (p) =>
      `Контейнер "${p.name}" прив'язаний сам до себе через "${p.attribute}"`,
    hint: {
      en: "A container is the top of its own level: bind it to nothing, or to another container.",
      uk: "Контейнер — вершина власного рівня: не прив'язуйте його або прив'яжіть до іншого контейнера.",
    },
  },
  "rights.dimension-unknown": {
    en: (p) =>
      `Access dimension "${p.dimension}" is not declared in the project`,
    uk: (p) => `Вимір доступу "${p.dimension}" не оголошено в проєкті`,
    hint: {
      en: "Declare the dimension in accessDimensions of project.meta.json or name a declared one.",
      uk: "Оголосіть вимір в accessDimensions файлу project.meta.json або назвіть оголошений.",
    },
  },
  "rights.dimension-target": {
    en: (p) =>
      p.reason === "kind"
        ? `Target of access dimension "${p.dimension}" is not a catalog`
        : `Target of access dimension "${p.dimension}" is not scoped, but the project has scope kinds`,
    uk: (p) =>
      p.reason === "kind"
        ? `Ціль виміру доступу "${p.dimension}" — не довідник`
        : `Ціль виміру доступу "${p.dimension}" не скоуплена, а в проєкті є види скоупу`,
    hint: {
      en: "The values of a dimension are rows of a catalog; in a project with scope kinds the catalog is scoped, so values of one tenant never open rows of another.",
      uk: "Значення виміру — рядки довідника; у проєкті з видами скоупу довідник скоуплений, щоб значення одного тенанта не відкривали рядків іншого.",
    },
  },
  "rights.dimension-relation": {
    en: (p) =>
      p.reason === "unknown"
        ? `Relation object of access dimension "${p.dimension}" has no field "${p.name}" (${p.field})`
        : p.reason === "table"
          ? `Relation object of access dimension "${p.dimension}" has no table`
          : p.reason === "scope"
            ? `Relation object of access dimension "${p.dimension}" is not in the scope kind of the dimension target`
            : p.field === "subject"
              ? `Subject of access dimension "${p.dimension}" references neither the users catalog nor the membership catalog of the target's scope kind`
              : `Value of access dimension "${p.dimension}" does not reference the dimension target`,
    uk: (p) =>
      p.reason === "unknown"
        ? `Об'єкт зв'язку виміру доступу "${p.dimension}" не має поля "${p.name}" (${p.field})`
        : p.reason === "table"
          ? `Об'єкт зв'язку виміру доступу "${p.dimension}" не має таблиці`
          : p.reason === "scope"
            ? `Об'єкт зв'язку виміру доступу "${p.dimension}" не у виді скоупу цілі виміру`
            : p.field === "subject"
              ? `Суб'єкт виміру доступу "${p.dimension}" не посилається ні на «Користувачі», ні на довідник членства виду скоупу цілі`
              : `Значення виміру доступу "${p.dimension}" не посилається на ціль виміру`,
    hint: {
      en: "A relation row links a user (or a member) to a value: subject is a single Ref to users or to the membership catalog, value is a single Ref to the target, both in the target's scope kind.",
      uk: "Рядок зв'язку пов'язує користувача (чи учасника) зі значенням: subject — одиночний Ref на «Користувачі» чи на довідник членства, value — одиночний Ref на ціль, обидва у виді скоупу цілі.",
    },
  },
  "rights.access-target": {
    en: (p) =>
      `Access carrier "${p.attribute}" does not reference the target of dimension "${p.dimension}"`,
    uk: (p) =>
      `Носій доступу "${p.attribute}" не посилається на ціль виміру "${p.dimension}"`,
    hint: {
      en: "Name an attribute (or a path) whose last reference is to the value catalog of the dimension.",
      uk: "Назвіть реквізит (чи шлях), чиє кінцеве посилання — на довідник значень виміру.",
    },
  },
  "rights.access-duplicate": {
    en: (p) => `Access dimension "${p.dimension}" is mapped more than once`,
    uk: (p) => `Вимір доступу "${p.dimension}" зіставлено більше одного разу`,
    hint: {
      en: "A grant restricts a row by one carrier per dimension; keep one mapping.",
      uk: "Грант обмежує рядок одним носієм на вимір; лишіть один мапінг.",
    },
  },
  "rights.dimension-function-missing": {
    en: (p) =>
      `Values function ${p.function}() of access dimension "${p.dimension}" is not defined in any .sql file`,
    uk: (p) =>
      `Функція значень ${p.function}() виміру доступу "${p.dimension}" не визначена в жодному файлі .sql`,
    hint: {
      en: "Add 'CREATE FUNCTION <schema>.<name>() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ...' to a .sql file.",
      uk: "Додайте 'CREATE FUNCTION <схема>.<ім'я>() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ...' до файлу .sql.",
    },
  },
  "rights.dimension-function-signature": {
    en: (p) =>
      p.reason === undefined
        ? `Values function ${p.function}() of access dimension "${p.dimension}" has the wrong signature: ${p.problem}`
        : `${p.function} in the values of access dimension "${p.dimension}" is outside the closed form: ${SET_FUNCTION_REASON[String(p.reason)]?.en ?? p.reason}`,
    uk: (p) =>
      p.reason === undefined
        ? `Функція значень ${p.function}() виміру доступу "${p.dimension}" має хибну сигнатуру: ${p.problem}`
        : `${p.function} у значеннях виміру доступу "${p.dimension}" — поза закритою формою: ${SET_FUNCTION_REASON[String(p.reason)]?.uk ?? p.reason}`,
    hint: {
      en: "The values function takes no arguments, returns SETOF uuid and is LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''; every function it calls is LANGUAGE sql SET search_path = ''; every relation is qualified by a schema.",
      uk: "Функція значень не приймає аргументів, повертає SETOF uuid і є LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''; кожна функція, яку вона кличе, — LANGUAGE sql SET search_path = ''; кожне відношення кваліфіковане схемою.",
    },
  },
  "rights.dimension-function-reads-rights": {
    en: (p) =>
      p.object === "dynamic"
        ? `Values of access dimension "${p.dimension}" execute SQL from a string, which the compiler cannot check: ${p.chain}`
        : p.object === "plpgsql" || p.object === "unknown"
          ? `Values of access dimension "${p.dimension}" depend on a function the compiler cannot check (${p.object}): ${p.chain}`
          : `Values of access dimension "${p.dimension}" read the platform object ${p.object}: ${p.chain}`,
    uk: (p) =>
      p.object === "dynamic"
        ? `Значення виміру доступу "${p.dimension}" виконують SQL з рядка, якого компілятор не може перевірити: ${p.chain}`
        : p.object === "plpgsql" || p.object === "unknown"
          ? `Значення виміру доступу "${p.dimension}" залежать від функції, яку компілятор не може перевірити (${p.object}): ${p.chain}`
          : `Значення виміру доступу "${p.dimension}" читають об'єкт платформи ${p.object}: ${p.chain}`,
    hint: {
      en: "Rights checks call the values function, so it must not read rights itself: of the platform schema only simetra.current_user_id() is allowed, and every called function must be a LANGUAGE sql function of the project, a generated membership function or a builtin that does not execute SQL from a string.",
      uk: "Перевірка прав кличе функцію значень, тож сама вона прав не читає: зі схеми платформи дозволено лише simetra.current_user_id(), а кожна викликана функція — LANGUAGE sql функція проєкту, згенерована функція членства чи вбудована, що не виконує SQL з рядка.",
    },
  },
  "rights.source-table": {
    en: (p) => `Table of source "${p.source}" is not an adopted table`,
    uk: (p) => `Таблиця джерела "${p.source}" — не прийнята таблиця`,
    hint: {
      en: "A source names a CustomTable; a membership catalog declares membership itself.",
      uk: "Джерело називає CustomTable; довідник членства оголошує членство сам.",
    },
  },
  "rights.source-forced-rls": {
    en: (p) =>
      `Table ${p.table} of source "${p.source}" forces row level security`,
    uk: (p) =>
      `Таблиця ${p.table} джерела "${p.source}" примусово вмикає безпеку рядків`,
    hint: {
      en: "Rights functions are SECURITY DEFINER and would pass through the table policies: drop rowLevelSecurity: forced.",
      uk: "Функції прав — SECURITY DEFINER і проходили б політики таблиці: приберіть rowLevelSecurity: forced.",
    },
  },
  "rights.source-scope-column": {
    en: (p) =>
      p.reason === "scope"
        ? `Table of membership source "${p.source}" is not scoped by the scope kind of the source`
        : `Scope column of membership source "${p.source}" is not the scope column of its table`,
    uk: (p) =>
      p.reason === "scope"
        ? `Таблиця джерела членства "${p.source}" не скоуплена видом скоупу джерела`
        : `Колонка скоупу джерела членства "${p.source}" — не скоуп-колонка його таблиці`,
    hint: {
      en: "Scope the table by the source's scope kind and map columns.scope to its scopeColumn: the composite foreign key of an owner keeps exactly that column within the tenant.",
      uk: "Скоупте таблицю видом скоупу джерела й зіставте columns.scope з її scopeColumn: складений зовнішній ключ власника тримає в межах тенанта саме цю колонку.",
    },
  },
  "rights.membership-source-duplicate": {
    en: (p) => `Scope kind "${p.scopeKind}" already has a membership`,
    uk: (p) => `Вид скоупу "${p.scopeKind}" уже має членство`,
    hint: {
      en: "A scope kind has one membership: a membership catalog or one membership source.",
      uk: "Вид скоупу має одне членство: довідник членства або одне джерело членства.",
    },
  },
  "rights.source-container-column": {
    en: (p) =>
      p.reason === "missing"
        ? `Assignment source "${p.source}" is assigned on a container but names no container column`
        : `Assignment source "${p.source}" names a container column, but its level is not a container`,
    uk: (p) =>
      p.reason === "missing"
        ? `Джерело призначень "${p.source}" має рівень контейнера, але не називає колонки контейнера`
        : `Джерело призначень "${p.source}" називає колонку контейнера, а його рівень — не контейнер`,
    hint: {
      en: "columns.container is required on the container level and only there.",
      uk: "columns.container обов'язкова на контейнерному рівні й лише там.",
    },
  },
  "rights.scope-kind-unknown": {
    en: (p) => `Scope kind "${p.scopeKind}" is not declared in the project`,
    uk: (p) => `Вид скоупу "${p.scopeKind}" не оголошено в проєкті`,
    hint: {
      en: "Name a scope kind from scopeKinds of project.meta.json.",
      uk: "Назвіть вид скоупу з scopeKinds файлу project.meta.json.",
    },
  },
  "rights.users-missing": {
    en: () =>
      "The project declares rights but has neither the users catalog nor a membership source",
    uk: () =>
      "Проєкт оголошує права, але не має ні довідника «Користувачі», ні джерела членства",
    hint: {
      en: "Declare a catalog with role: users, or an adopted membership source on a provider where the user id is the session subject.",
      uk: "Оголосіть довідник з role: users або прийняте джерело членства на провайдері, де id користувача — суб'єкт сесії.",
    },
  },
  "rights.include-target": {
    en: (p) =>
      `include names ${p.kind} "${p.name}", but only a rights set can be included`,
    uk: (p) =>
      `include називає ${p.kind} "${p.name}", але включити можна лише набір прав`,
    hint: {
      en: "Move the shared grants into a RightsSet and include it in both roles.",
      uk: "Винесіть спільні гранти в RightsSet і включіть його в обидві ролі.",
    },
  },
  "rights.include-cycle": {
    en: (p) => `Rights sets include each other in a cycle: ${p.chain}`,
    uk: (p) => `Набори прав включають одне одного по колу: ${p.chain}`,
    hint: {
      en: "Remove one include of the chain.",
      uk: "Приберіть одне включення ланцюжка.",
    },
  },
  "rights.scope-without-membership": {
    en: (p) =>
      p.container === undefined
        ? `The role is assigned on scope kind "${p.scopeKind}", which has no membership`
        : `Container ${p.container} lives in scope kind "${p.scopeKind}", which has no membership`,
    uk: (p) =>
      p.container === undefined
        ? `Роль має рівень виду скоупу "${p.scopeKind}", у якого немає членства`
        : `Контейнер ${p.container} у виді скоупу "${p.scopeKind}" без членства`,
    hint: {
      en: "Declare a membership catalog of the scope kind or an adopted membership source; a scope role is assigned to members.",
      uk: "Оголосіть довідник членства виду скоупу чи прийняте джерело членства: роль рівня скоупу призначають учаснику.",
    },
  },
  "rights.full-access-level": {
    en: (p) =>
      p.level === "container"
        ? "fullAccess is not allowed on a container role"
        : "fullAccess is not allowed on a role of every user",
    uk: (p) =>
      p.level === "container"
        ? "fullAccess не дозволено на контейнерній ролі"
        : "fullAccess не дозволено на ролі кожного користувача",
    hint: {
      en: "Full access belongs to a global or a scope role; list the grants of this role instead.",
      uk: "Повні права — властивість глобальної ролі чи ролі рівня скоупу; перелічіть гранти цієї ролі.",
    },
  },
  "rights.root-creator-level": {
    en: (p) =>
      p.level === "global"
        ? "rootCreator is allowed on a scope role only, not on a global role"
        : p.level === "container"
          ? "rootCreator is allowed on a scope role only, not on a container role"
          : "rootCreator is allowed on a scope role only, not on a role of every user",
    uk: (p) =>
      p.level === "global"
        ? "rootCreator дозволено лише на ролі рівня скоупу, а не на глобальній ролі"
        : p.level === "container"
          ? "rootCreator дозволено лише на ролі рівня скоупу, а не на контейнерній ролі"
          : "rootCreator дозволено лише на ролі рівня скоупу, а не на ролі кожного користувача",
    hint: {
      en: "The creator of a scope root gets a role of that scope kind; assign other levels explicitly.",
      uk: "Творець кореня скоупу отримує роль цього виду скоупу; інші рівні призначайте явно.",
    },
  },
  "rights.root-creator-duplicate": {
    en: (p) =>
      `Scope kind "${p.scopeKind}" already has a root creator role in ${p.firstFile}`,
    uk: (p) =>
      `Вид скоупу "${p.scopeKind}" уже має роль творця кореня в ${p.firstFile}`,
    hint: {
      en: "Keep rootCreator on one role of the scope kind.",
      uk: "Залиште rootCreator на одній ролі виду скоупу.",
    },
  },
  "rights.source-unknown": {
    en: (p) => `Assignment source "${p.source}" is not declared in the project`,
    uk: (p) => `Джерело призначень "${p.source}" не оголошено в проєкті`,
    hint: {
      en: "Name a source from assignmentSources of project.meta.json.",
      uk: "Назвіть джерело з assignmentSources файлу project.meta.json.",
    },
  },
  "rights.source-key-level": {
    en: (p) =>
      `Assignment source "${p.source}" assigns on another level than the role`,
    uk: (p) =>
      `Джерело призначень "${p.source}" призначає на іншому рівні, ніж роль`,
    hint: {
      en: "Key the role in a source of its own level; a role of every user needs no source.",
      uk: "Задайте ключ ролі в джерелі її рівня; ролі кожного користувача джерело не потрібне.",
    },
  },
  "rights.source-key-duplicate": {
    en: (p) =>
      `Key "${p.key}" of assignment source "${p.source}" already names a role in ${p.firstFile}`,
    uk: (p) =>
      `Ключ "${p.key}" джерела призначень "${p.source}" уже називає роль у ${p.firstFile}`,
    hint: {
      en: "Give each role its own key in the source.",
      uk: "Дайте кожній ролі власний ключ у джерелі.",
    },
  },
  "rights.grant-level": {
    en: (p) =>
      p.extent !== undefined
        ? `Role ${p.role} of every user cannot grant with the ${p.extent} extent: it covers unscoped objects with the own or a dimension extent only`
        : p.level === "scope"
          ? `Scope role ${p.role} cannot grant "${p.action}" on ${p.object}: it covers the objects of its scope kind and only reads unscoped ones`
          : p.level === "global"
            ? `Global role ${p.role} cannot grant "${p.action}" on ${p.object}: in a project with scope kinds it covers unscoped objects only`
            : p.level === "container"
              ? `Container role ${p.role} cannot grant "${p.action}" on ${p.object}: the object is not bound to the role container`
              : `Role ${p.role} of every user cannot grant "${p.action}" on ${p.object}: it covers unscoped objects only`,
    uk: (p) =>
      p.extent !== undefined
        ? `Роль кожного користувача ${p.role} не може давати з обсягом ${p.extent}: вона покриває нескоуплені об'єкти лише з обсягом own чи виміру`
        : p.level === "scope"
          ? `Роль рівня скоупу ${p.role} не може дати "${p.action}" на ${p.object}: вона покриває об'єкти свого виду скоупу, а нескоуплені лише читає`
          : p.level === "global"
            ? `Глобальна роль ${p.role} не може дати "${p.action}" на ${p.object}: у проєкті з видами скоупу вона покриває лише нескоуплені об'єкти`
            : p.level === "container"
              ? `Контейнерна роль ${p.role} не може дати "${p.action}" на ${p.object}: об'єкт не прив'язаний до контейнера ролі`
              : `Роль кожного користувача ${p.role} не може дати "${p.action}" на ${p.object}: вона покриває лише нескоуплені об'єкти`,
    hint: {
      en: "Grant the action on a role of the level that covers the object, or use the own or a dimension extent for every user.",
      uk: "Дайте дію на ролі того рівня, який покриває об'єкт, а кожному користувачу — з обсягом own чи виміру.",
    },
  },
  "rights.extent-unsupported": {
    en: (p) =>
      p.extent === "own"
        ? `${p.object} has no ownership, so it has no own extent`
        : `${p.object} has no mapping to access dimension "${p.extent}"`,
    uk: (p) =>
      p.extent === "own"
        ? `${p.object} не має власності, тож не має обсягу own`
        : `${p.object} не має мапінгу на вимір доступу "${p.extent}"`,
    hint: {
      en: "Declare ownership or an access mapping on the object, or grant another extent.",
      uk: "Оголосіть власність чи мапінг access на об'єкті або дайте інший обсяг.",
    },
  },
  "rights.requires-missing": {
    en: (p) =>
      `"${p.action}" on ${p.object} with extent ${p.extent} requires "${p.requires}", which role ${p.role} does not grant with that extent or any`,
    uk: (p) =>
      `"${p.action}" на ${p.object} з обсягом ${p.extent} вимагає "${p.requires}", якої роль ${p.role} не дає з тим самим обсягом чи any`,
    hint: {
      en: "Grant the required action too, or deny the action that requires it.",
      uk: "Дайте й потрібну дію або заберіть дію, яка її вимагає.",
    },
  },
  "rights.custom-table-no-contract": {
    en: (p) =>
      `Adopted table ${p.object} has no rights contract yet and cannot be granted`,
    uk: (p) =>
      `Прийнята таблиця ${p.object} ще не має контракту прав, тож її не можна дати в гранті`,
    hint: {
      en: "Rights of adopted tables are not designed yet; promote the table into a kind to grant it.",
      uk: "Права прийнятих таблиць ще не спроєктовано; промотуйте таблицю у вид, щоб дати її в гранті.",
    },
  },
  "rights.object-without-rights": {
    en: (p) => `${p.object} is a ${p.kind}, which has no rights to grant`,
    uk: (p) => `${p.object} — ${p.kind}, вид без прав, які можна дати`,
    hint: {
      en: "Grant objects of kinds with a rights contract: catalogs, documents, registers.",
      uk: "Давайте в грантах об'єкти видів з контрактом прав: довідники, документи, регістри.",
    },
  },
  "rights.custom-action-multi-object": {
    en: (p) =>
      `Custom action "${p.action}" is granted on several objects or through withAction`,
    uk: (p) =>
      `Кастомну дію "${p.action}" дано на кількох об'єктах чи через withAction`,
    hint: {
      en: "One name in different objects is a different custom action; grant it on one object at a time.",
      uk: "Одне ім'я в різних об'єктах — різні кастомні дії; давайте її на один об'єкт за раз.",
    },
  },
  "rights.system-catalog-missing": {
    en: (p) =>
      `Roles of the ${p.level} level have no catalog with role ${p.missing}`,
    uk: (p) => `Ролі рівня ${p.level} не мають довідника з роллю ${p.missing}`,
    hint: {
      en: (p) =>
        `Declare one catalog with role ${p.missing} on this level, for example simetra create '{"kind":"Catalog","name":"<Name>","data":{"role":"${p.missing}","scope":"${p.level === "global" ? "none" : p.level}"}}', or adopt an assignment source for the level.`,
      uk: (p) =>
        `Оголосіть на цьому рівні один довідник з роллю ${p.missing}, наприклад simetra create '{"kind":"Catalog","name":"<Name>","data":{"role":"${p.missing}","scope":"${p.level === "global" ? "none" : p.level}"}}', або прийняте джерело призначень рівня.`,
    },
  },
  "rights.system-catalog-duplicate": {
    en: (p) =>
      `The ${p.level} level already has a catalog with role ${p.role} in ${p.firstFile}`,
    uk: (p) =>
      `Рівень ${p.level} уже має довідник з роллю ${p.role} у ${p.firstFile}`,
    hint: {
      en: "Keep one catalog per role and level; extend it with your own attributes instead.",
      uk: "Лишіть один довідник на роль і рівень; розширюйте його власними реквізитами.",
    },
  },
  "rights.system-catalog-scope": {
    en: (p) =>
      `${p.name} is scoped by "${p.scopeKind}", which has no membership catalog`,
    uk: (p) =>
      `${p.name} скоуплено видом "${p.scopeKind}", у якого немає довідника членства`,
    hint: {
      en: "The assignment subject is a member of the scope kind: declare its membership catalog; members of an adopted membership source are not assignable yet.",
      uk: "Суб'єкт призначення — учасник виду скоупу: оголосіть довідник членства виду; учасників прийнятого джерела членства поки призначати не можна.",
    },
  },
  "rights.system-catalog-description": {
    en: (p) =>
      `${p.name} keeps custom role names in its description, but descriptionLength is 0`,
    uk: (p) =>
      `${p.name} зберігає назви кастомних ролей у найменуванні, але descriptionLength дорівнює 0`,
    hint: {
      en: "Give the catalog a positive descriptionLength.",
      uk: "Задайте довіднику додатний descriptionLength.",
    },
  },
  "rights.system-catalog-parallel": {
    en: (p) =>
      `The ${p.level} level gets its assignments from the adopted source "${p.source}", so its rights catalog would be a parallel system`,
    uk: (p) =>
      `Рівень ${p.level} бере призначення з прийнятого джерела "${p.source}", тож його довідник прав був би паралельною системою`,
    hint: {
      en: "Keep either the adopted source or the rights catalogs on a level: remove the catalog, or promote the source table.",
      uk: "Лишіть на рівні або прийняте джерело, або довідники прав: приберіть довідник чи промотуйте таблицю джерела.",
    },
  },
  "rights.system-catalog-custom-action": {
    en: (p) =>
      `${p.name} is a rights catalog, so it cannot declare the custom action "${p.action}"`,
    uk: (p) =>
      `${p.name} — довідник прав, тож кастомної дії "${p.action}" в нього не буває`,
    hint: {
      en: "Rights catalogs are written only by the rights administration action; remove the custom action.",
      uk: "Довідники прав пишуться лише дією адміністрування прав; приберіть кастомну дію.",
    },
  },
  "rights.adopted-source-unsupported": {
    en: (p) =>
      `Rights from the adopted source "${p.source}" are not computed yet: members of the source will not get rights on the objects of the kind`,
    uk: (p) =>
      `Права з прийнятого джерела "${p.source}" ще не обчислюються: учасники джерела не отримають прав на об'єкти виду`,
  },
  "rights.scope-kind-unread": {
    en: (p) =>
      `No role reads the objects of scope kind "${p.scopeKind}": nobody will see their rows`,
    uk: (p) =>
      `Об'єкти виду скоупу "${p.scopeKind}" не читає жодна роль: їхніх рядків не побачить ніхто`,
    hint: {
      en: "Grant read on these objects to a role, or declare a role with fullAccess.",
      uk: "Надайте ролі читання цих об'єктів або оголосіть роль із fullAccess.",
    },
  },
  "rights.ownership-target": {
    en: (p) =>
      p.reason === "key"
        ? `Owner "${p.attribute}" is the key, but only the users catalog owns its own rows`
        : `Owner "${p.attribute}" references neither a membership catalog or adopted membership source of the object's scope kind nor the users catalog`,
    uk: (p) =>
      p.reason === "key"
        ? `Власник "${p.attribute}" — ключ, але власником свого рядка є лише довідник «Користувачі»`
        : `Власник "${p.attribute}" не посилається ні на довідник членства чи прийняте джерело членства виду скоупу об'єкта, ні на «Користувачі»`,
    hint: {
      en: "Name a reference to a member of the same scope kind or to the users catalog; ref is an owner only on the users catalog.",
      uk: "Назвіть посилання на учасника того самого виду скоупу чи на «Користувачі»; ref — власник лише в довіднику «Користувачі».",
    },
  },

  "reference.not-referenceable": {
    en: (p) => `${p.kind} "${p.name}" cannot be referenced here`,
    uk: (p) => `На ${p.kind} "${p.name}" тут не можна посилатися`,
    hint: {
      en: "The kind registry decides which kinds a Ref may target; a PgEnum is referenced only by a CustomTable column, and a foreign key needs a target that has a table.",
      uk: "Реєстр видів вирішує, на які види може вказувати Ref; на PgEnum посилається лише колонка CustomTable, а зовнішньому ключу потрібна ціль із таблицею.",
    },
  },
  "reference.default-to-table": {
    en: (p) => `A Ref to ${p.kind} "${p.name}" cannot have a defaultValue`,
    uk: (p) => `Ref на ${p.kind} "${p.name}" не може мати defaultValue`,
    hint: {
      en: "There is no default reference to a data row; only a Ref to an enumeration takes a default value.",
      uk: "Типового посилання на рядок даних немає; типове значення приймає лише Ref на перерахування.",
    },
  },
  "reference.default-unknown-value": {
    en: (p) => `${p.kind} "${p.name}" has no value "${p.value}"`,
    uk: (p) => `${p.kind} "${p.name}" не має значення "${p.value}"`,
    hint: {
      en: "A default of a Ref to an enumeration names the logical name of one of its values, not the physical label.",
      uk: "Типове значення Ref на перерахування називає логічне ім'я одного з його значень, а не фізичну мітку.",
    },
  },
  "reference.custom-table-key": {
    en: (p) =>
      `${p.kind} "${p.name}" has no single-column uuid primary key to reference`,
    uk: (p) =>
      `${p.kind} "${p.name}" не має одноколонкового первинного ключа uuid, на який можна посилатися`,
    hint: {
      en: "A Ref to a CustomTable, single or polymorphic, stores the value of its single uuid primary key column.",
      uk: "Ref на CustomTable, одиночний чи поліморфний, зберігає значення єдиної колонки первинного ключа uuid.",
    },
  },
  "reference.custom-table-deferrable-key": {
    en: (p) =>
      `The primary key of ${p.kind} "${p.name}" is deferrable and cannot be the target of a foreign key`,
    uk: (p) =>
      `Первинний ключ ${p.kind} "${p.name}" відкладений і не може бути ціллю зовнішнього ключа`,
    hint: {
      en: "Postgres rejects a foreign key to a DEFERRABLE primary key or unique constraint; make the key not deferrable or add a non-deferrable unique constraint on the same column.",
      uk: "Postgres відкидає зовнішній ключ на DEFERRABLE первинний ключ чи UNIQUE; зробіть ключ невідкладеним або додайте невідкладений UNIQUE на ту саму колонку.",
    },
  },
  "reference.polymorphic-target-kind": {
    en: (p) =>
      `${p.kind} "${p.name}" cannot be a target of a polymorphic reference`,
    uk: (p) =>
      `${p.kind} "${p.name}" не може бути ціллю поліморфного посилання`,
    hint: {
      en: "The pair stores a uuid key, so only a Catalog, a Document or a CustomTable with a single uuid primary key fits. Enumeration values are text labels and cannot share the uuid column of a polymorphic pair; use a separate attribute.",
      uk: "Пара зберігає ключ uuid, тож підходить лише Catalog, Document або CustomTable з єдиним первинним ключем uuid. Значення переліку — текстові мітки й не можуть ділити колонку uuid поліморфної пари; використайте окремий реквізит.",
    },
  },
  "attribute.unique-within-place": {
    en: (p) =>
      `${p.kind} "${p.name}" has no standard ${p.within} for uniqueWithin`,
    uk: (p) =>
      `${p.kind} "${p.name}" не має стандартного реквізиту ${p.within} для uniqueWithin`,
    hint: {
      en: "owner needs catalog owners, parent needs a hierarchy.",
      uk: "owner потребує власників довідника, parent — ієрархії.",
    },
  },
  "index.attribute-unknown": {
    en: (p) =>
      p.section === undefined
        ? `${p.kind} "${p.object}" has no attribute "${p.name}" for an index`
        : `Tabular section "${p.section}" of ${p.kind} "${p.object}" has no attribute "${p.name}" for an index`,
    uk: (p) =>
      p.section === undefined
        ? `${p.kind} "${p.object}" не має реквізиту "${p.name}" для індексу`
        : `Таблична частина "${p.section}" виду ${p.kind} "${p.object}" не має реквізиту "${p.name}" для індексу`,
    hint: {
      en: "An index names attributes and standard attributes of its own table (the object, or the section rows).",
      uk: "Індекс називає реквізити й стандартні реквізити власної таблиці (об'єкта чи рядків секції).",
    },
  },
  "index.attribute-duplicate": {
    en: (p) => `Attribute "${p.name}" is repeated in one index`,
    uk: (p) => `Реквізит "${p.name}" повторюється в одному індексі`,
    hint: {
      en: "List each attribute once per index; a second occurrence adds nothing to the key.",
      uk: "Вказуйте кожен реквізит в індексі один раз: друге входження нічого не додає до ключа.",
    },
  },
  "catalog.owner-kind": {
    en: (p) => `${p.kind} "${p.name}" cannot own a catalog`,
    uk: (p) => `${p.kind} "${p.name}" не може бути власником довідника`,
    hint: {
      en: "The owner of a catalog must be a catalog.",
      uk: "Власником довідника має бути довідник.",
    },
  },
  "register.recorder-kind": {
    en: (p) => `${p.kind} "${p.name}" cannot be a recorder`,
    uk: (p) => `${p.kind} "${p.name}" не може бути реєстратором`,
    hint: {
      en: "Movements are written by posting, so a recorder must be a document.",
      uk: "Рухи пише проведення, тож реєстратором має бути документ.",
    },
  },
  "posting.register-kind": {
    en: (p) => `${p.kind} "${p.name}" is not a register`,
    uk: (p) => `${p.kind} "${p.name}" не є регістром`,
    hint: {
      en: "registerMovements and movements of a document target only accumulation and information registers.",
      uk: "registerMovements і movements документа вказують лише на регістри накопичення та відомостей.",
    },
  },
  "posting.register-independent": {
    en: (p) =>
      `Register "${p.name}" is independent and takes no movements from documents`,
    uk: (p) =>
      `Регістр "${p.name}" незалежний і не приймає рухів від документів`,
    hint: {
      en: "Set writeMode: RecorderSubordinate on the register: posting rewrites movements by their recorder, and an independent register has none.",
      uk: "Задайте на регістрі writeMode: RecorderSubordinate: проведення перезаписує рухи за реєстратором, а незалежний регістр його не має.",
    },
  },
  "posting.register-undeclared": {
    en: (p) =>
      `Register "${p.name}" is not listed in the document's registerMovements`,
    uk: (p) => `Регістр "${p.name}" не вказаний у registerMovements документа`,
    hint: {
      en: "Add the register to registerMovements.",
      uk: "Додайте регістр до registerMovements.",
    },
  },
  "posting.source-missing": {
    en: (p) =>
      `Register "${p.name}" has no movement source: neither a constructor movement nor a query block`,
    uk: (p) =>
      `Регістр "${p.name}" не має джерела рухів: ні руху конструктора, ні блока запиту`,
    hint: {
      en: "Add a movement for this register to posting, or a '-- @movements' block to the document's .sql file.",
      uk: "Додайте рух для цього регістра до posting або блок '-- @movements' до файлу .sql документа.",
    },
  },
  "posting.source-ambiguous": {
    en: (p) =>
      `Register "${p.name}" has more than one movement source: ${p.sources}`,
    uk: (p) =>
      `Регістр "${p.name}" має більше одного джерела рухів: ${p.sources}`,
    hint: {
      en: "Keep exactly one source: the constructor or a single query block.",
      uk: "Залиште рівно одне джерело: конструктор або один блок запиту.",
    },
  },
  "posting.query-not-select": {
    en: (p) =>
      `The movement query block at line ${p.line} must be exactly one SELECT statement${p.detail === undefined ? "" : `: ${p.detail}`}`,
    uk: (p) =>
      `Блок запиту рухів у рядку ${p.line} має бути рівно одним оператором SELECT${p.detail === undefined ? "" : `: ${p.detail}`}`,
    hint: {
      en: "WITH ... SELECT and SELECT ... UNION ALL ... are allowed; other statements, several statements, data-modifying WITH, SELECT INTO and FOR UPDATE/FOR SHARE are not.",
      uk: "WITH ... SELECT і SELECT ... UNION ALL ... дозволені; інші оператори, кілька операторів, WITH зі зміною даних, SELECT INTO і FOR UPDATE/FOR SHARE — ні.",
    },
  },
  "posting.query-order-missing": {
    en: (p) => `The movement query block at line ${p.line} has no ORDER BY`,
    uk: (p) => `Блок запиту рухів у рядку ${p.line} не має ORDER BY`,
    hint: {
      en: "Add ORDER BY so that the movement rows are produced in a deterministic order.",
      uk: "Додайте ORDER BY, щоб рядки рухів видавалися в детермінованому порядку.",
    },
  },
  "posting.recorder-not-allowed": {
    en: (p) =>
      `Register "${p.name}" does not list document "${p.document}" in its recorderTypes`,
    uk: (p) =>
      `Регістр "${p.name}" не містить документа "${p.document}" у своїх recorderTypes`,
    hint: {
      en: "Add the document to the register's recorderTypes.",
      uk: "Додайте документ до recorderTypes регістра.",
    },
  },
  "posting.fields-incomplete": {
    en: (p) => `Movement does not set register fields: ${p.missing}`,
    uk: (p) => `Рух не задає поля регістра: ${p.missing}`,
    hint: {
      en: "An accumulation register movement sets every dimension and resource; an information register movement sets every dimension and required resource.",
      uk: "Рух регістра накопичення задає кожен вимір і ресурс; рух регістра відомостей задає кожен вимір і обов'язковий ресурс.",
    },
  },
  "posting.row-in-document-source": {
    en: () => "row. fields need a tabular section source",
    uk: () => "Поля row. потребують джерела — табличної частини",
    hint: {
      en: 'With source "document" the movement reads the document header: use doc. fields or sum()/count().',
      uk: 'З джерелом "document" рух читає шапку документа: використовуйте поля doc. або sum()/count().',
    },
  },
  "posting.aggregate-in-section-source": {
    en: () => "sum() and count() are allowed only with the document source",
    uk: () => "sum() і count() дозволені лише з джерелом document",
    hint: {
      en: "A tabular section source gives one movement per row; aggregate with the document source.",
      uk: "Джерело — таблична частина — дає один рух на рядок; агрегуйте з джерелом document.",
    },
  },
  "posting.movement-type": {
    en: (p) =>
      p.problem === "missing"
        ? `Balance register "${p.register}" needs movementType`
        : p.problem === "forbidden"
          ? `Register "${p.register}" has no movement type`
          : p.problem === "value"
            ? `movementType '${p.value}' is neither 'Receipt' nor 'Expense'`
            : `movementType expression gives ${p.actual}, not text`,
    uk: (p) =>
      p.problem === "missing"
        ? `Регістр залишків "${p.register}" потребує movementType`
        : p.problem === "forbidden"
          ? `Регістр "${p.register}" не має виду руху`
          : p.problem === "value"
            ? `movementType '${p.value}' — ні 'Receipt', ні 'Expense'`
            : `Вираз movementType дає ${p.actual}, а не текст`,
    hint: {
      en: 'Use the literal "Receipt" or "Expense", or an expression that gives one of them.',
      uk: 'Використайте літерал "Receipt" або "Expense", або вираз, що дає одне з них.',
    },
  },
  "posting.period-not-allowed": {
    en: (p) => `Register "${p.register}" is not periodic and has no period`,
    uk: (p) => `Регістр "${p.register}" неперіодичний і не має періоду`,
    hint: {
      en: "Remove period from the movement, or make the register periodic.",
      uk: "Приберіть period з руху або зробіть регістр періодичним.",
    },
  },
  "posting.type-mismatch": {
    en: (p) => `Expression gives ${p.actual}, but ${p.expected} is expected`,
    uk: (p) => `Вираз дає ${p.actual}, а очікується ${p.expected}`,
    hint: {
      en: "An integer field does not take a fractional number, a reference field takes only its own targets, and null goes only into a column that may be empty.",
      uk: "Ціле поле не приймає дробового числа, поле-посилання приймає лише власні цілі, а null можна лише в колонку, що може бути порожньою.",
    },
  },
  "physical.table-duplicate": {
    en: (p) =>
      `Physical name ${p.name} is already used by a table or enum type in ${p.firstFile}`,
    uk: (p) =>
      `Фізичне ім'я ${p.name} уже використовує таблиця або енам-тип у ${p.firstFile}`,
  },
  "physical.relation-duplicate": {
    en: (p) =>
      `Index or key name ${p.name} is already taken by ${p.other} in ${p.firstFile}`,
    uk: (p) =>
      `Ім'я індексу чи ключа ${p.name} уже займає ${p.other === "a table" ? "таблиця" : "індекс чи ключ"} у ${p.firstFile}`,
    hint: {
      en: "Tables, indexes and the indexes of primary keys and UNIQUE constraints share one Postgres namespace (pg_class) per schema; rename the index or key.",
      uk: "Таблиці, індекси та індекси первинних ключів і обмежень UNIQUE ділять один простір імен Postgres (pg_class) у схемі; перейменуйте індекс чи ключ.",
    },
  },
  "physical.column-duplicate": {
    en: (p) => `Column ${p.name} is already declared in table ${p.table}`,
    uk: (p) => `Колонка ${p.name} уже оголошена в таблиці ${p.table}`,
    hint: {
      en: "Standard columns of the kind and polymorphic <name>_type/<name>_id pairs take column names too.",
      uk: "Стандартні колонки виду та поліморфні пари <ім'я>_type/<ім'я>_id теж займають імена колонок.",
    },
  },
  "physical.function-duplicate": {
    en: (p) =>
      `Function ${p.name} (${p.description}) collides with ${p.other} in schema ${p.schema}`,
    uk: (p) =>
      `Функція ${p.name} (${p.description}) збігається з ${p.other} у схемі ${p.schema}`,
    hint: {
      en: "Function names are derived from physical names of catalogs, documents and registers by the Postgres naming algorithm; change a physicalName or rename the function in .sql so the names differ. Platform functions are called by name, so argument types do not tell them apart.",
      uk: "Імена функцій виводяться з фізичних імен довідників, документів і регістрів за алгоритмом іменування Postgres; змініть physicalName або перейменуйте функцію в .sql, щоб імена відрізнялися. Функції платформи викликаються за іменем, тож типи аргументів їх не розрізняють.",
    },
  },
  "physical.reserved-word": {
    en: (p) =>
      `Physical name ${p.name} is a PostgreSQL keyword; some positions need it quoted`,
    uk: (p) =>
      `Фізичне ім'я ${p.name} — ключове слово Postgres; на деяких позиціях його треба брати в лапки`,
    hint: {
      en: "It works when quoted, but new elements should not take reserved words.",
      uk: "У лапках воно працює, але нові елементи не мають брати зарезервованих слів.",
    },
  },
  "physical.constraint-name-required": {
    en: () =>
      "Postgres names this constraint or index from its expression, so the name cannot be derived",
    uk: () =>
      "Postgres іменує це обмеження чи індекс за його виразом, тож ім'я не можна вивести",
    hint: {
      en: "Give the index/constraint an explicit name; the reverse generator always writes names.",
      uk: "Задайте індексу чи обмеженню явне ім'я; зворотний генератор завжди записує імена.",
    },
  },
  "customTable.column-unknown": {
    en: (p) => `${p.table} has no column "${p.column}"`,
    uk: (p) => `У ${p.table} немає колонки "${p.column}"`,
    hint: {
      en: "Constraints, indexes and foreign keys refer to columns by logical name.",
      uk: "Обмеження, індекси та зовнішні ключі посилаються на колонки за логічним іменем.",
    },
  },
  "customTable.foreign-key-arity": {
    en: (p) =>
      `Foreign key has ${p.local} column(s) but references ${p.referenced}`,
    uk: (p) =>
      `Зовнішній ключ має локальних колонок: ${p.local}, а цільових: ${p.referenced}`,
  },
  "customTable.foreign-key-deferrable-target": {
    en: (p) =>
      `Foreign key references a deferrable key of ${p.kind} "${p.name}"`,
    uk: (p) =>
      `Зовнішній ключ посилається на відкладений ключ ${p.kind} "${p.name}"`,
    hint: {
      en: "Postgres rejects a foreign key to a DEFERRABLE primary key or unique constraint; reference a non-deferrable key on the same columns.",
      uk: "Postgres відкидає зовнішній ключ на DEFERRABLE первинний ключ чи UNIQUE; посилайтеся на невідкладений ключ на тих самих колонках.",
    },
  },
  "customTable.generated-conflict": {
    en: (p) => `Generated column cannot also have ${p.field}`,
    uk: (p) => `Генерована колонка не може мати ще й ${p.field}`,
    hint: {
      en: "The value of a stored generated column comes from its expression.",
      uk: "Значення збереженої генерованої колонки дає її вираз.",
    },
  },
  "customTable.key-column-nullable": {
    en: (p) =>
      `${p.role === "identity" ? "Identity" : "Primary key"} column "${p.column}" must declare notNull: true`,
    uk: (p) =>
      `Колонка ${p.role === "identity" ? "identity" : "первинного ключа"} "${p.column}" мусить мати notNull: true`,
    hint: {
      en: "Set notNull: true (Postgres makes primary key and identity columns NOT NULL).",
      uk: "Задайте notNull: true (Postgres робить колонки первинного ключа й identity NOT NULL).",
    },
  },
  "presentation.unknown-standard-attribute": {
    en: (p) =>
      p.section === undefined
        ? `${p.kind} has no standard attribute "${p.name}" to override`
        : `Tabular section "${p.section}" of ${p.kind} has no standard attribute "${p.name}" to override`,
    uk: (p) =>
      p.section === undefined
        ? `${p.kind} не має стандартного реквізиту "${p.name}", який можна перевизначити`
        : `Таблична частина "${p.section}" виду ${p.kind} не має стандартного реквізиту "${p.name}", який можна перевизначити`,
    hint: {
      en: "Keys of standardAttributeOverrides name standard attributes derived from the kind and its settings, in camelCase or in the project attribute case.",
      uk: "Ключі standardAttributeOverrides називають стандартні реквізити, похідні від виду та його налаштувань, у camelCase або в стилі імен реквізитів проєкту.",
    },
  },
  "physical.name-too-long": {
    en: (p) =>
      `Physical name ${p.name} is longer than 63 bytes and would be truncated by Postgres`,
    uk: (p) =>
      `Фізичне ім'я ${p.name} довше за 63 байти й було б усічене Postgres`,
  },
  "operation.physical-name-too-long": {
    en: (p) =>
      `simetra fix did not assign physical name ${p.name}: the derived name ${p.longest} would exceed 63 bytes`,
    uk: (p) =>
      `simetra fix не призначив фізичне ім'я ${p.name}: похідне ім'я ${p.longest} перевищило б 63 байти`,
    hint: {
      en: "Set a shorter physicalName yourself; it is assigned once and never changes.",
      uk: "Задайте коротше physicalName самі; воно призначається раз і більше не змінюється.",
    },
  },
  // Дві причини одного коду: зламаний вхідний каталог або `id` у вхідних
  // даних операції (`at` — pointer у вході). Обидві — «вхід непридатний».
  "operation.input-invalid": {
    en: (p) =>
      p.at === undefined
        ? "The operation needs metadata that compiles without errors; nothing was changed"
        : `The operation input must not carry "id" (at ${p.at}): ids are assigned by the operation; nothing was changed`,
    uk: (p) =>
      p.at === undefined
        ? "Операція потребує метаданих, що компілюються без помилок; нічого не змінено"
        : `Вхід операції не повинен містити "id" (у ${p.at}): id призначає операція; нічого не змінено`,
    hint: {
      en: (p) =>
        p.at === undefined
          ? "Fix the errors reported with this diagnostic (simetra fix handles missing ids and physical names), then repeat the operation."
          : "Remove the id from the input; a new element gets a fresh id that is never reused.",
      uk: (p) =>
        p.at === undefined
          ? "Виправте помилки, наведені поряд із цією діагностикою (відсутні id і фізичні імена лагодить simetra fix), і повторіть операцію."
          : "Приберіть id із входу; новий елемент отримує свіжий id, який ніколи не перевикористовується.",
    },
  },
  "operation.target-not-found": {
    en: (p) => `Target ${p.target} not found: no element named "${p.name}"`,
    uk: (p) =>
      `Ціль ${p.target} не знайдено: немає елемента з іменем "${p.name}"`,
    hint: {
      en: "Address the target as kind and object name plus a chain of logical element names from the object; Project is only a search root for scope kinds.",
      uk: "Адресуйте ціль видом і іменем об'єкта плюс ланцюжком логічних імен елементів від об'єкта; Project — лише корінь пошуку видів скоупу.",
    },
  },
  "operation.object-exists": {
    en: (p) => `${p.kind} ${p.name} already exists`,
    uk: (p) => `${p.kind} ${p.name} уже існує`,
    hint: {
      en: "Choose another name or change the existing object.",
      uk: "Оберіть інше ім'я або змініть наявний об'єкт.",
    },
  },
  "operation.collection-unknown": {
    en: (p) =>
      `${p.target} has no collection of named elements "${p.collection}"; available: ${p.collections}`,
    uk: (p) =>
      `${p.target} не має колекції іменованих елементів "${p.collection}"; доступні: ${p.collections}`,
    hint: {
      en: "A collection is the key of an array of named elements in the schema of the target.",
      uk: "Колекція — ключ масиву іменованих елементів у схемі цілі.",
    },
  },
  "operation.delete-referenced": {
    en: (p) =>
      `${p.target} cannot be deleted: it is referenced here (${p.role})`,
    uk: (p) =>
      `${p.target} не можна видалити: на нього посилаються тут (${p.role})`,
    hint: {
      en: "Remove or repoint every reference listed, then repeat the deletion.",
      uk: "Приберіть або перенаправте кожне зазначене посилання й повторіть видалення.",
    },
  },
  // Промоція (спека промоції §4, §7.1): вхід — повний мапінг, тож кожна
  // відмова називає місце входу (`at`) чи елемент прийнятої таблиці.
  "promote.column-unplaced": {
    en: (p) =>
      `Column ${p.column} of ${p.table} has no place in the promotion mapping`,
    uk: (p) =>
      `Колонка ${p.column} таблиці ${p.table} не має місця в мапінгу промоції`,
    hint: {
      en: "Map every column of the adopted table: to a standard attribute of the kind, to an attribute, to the scope, or retire it explicitly.",
      uk: "Розмістіть кожну колонку прийнятої таблиці: у стандартний реквізит виду, у реквізит, у скоуп або явно виведіть її з ужитку.",
    },
  },
  "promote.mapping-unknown": {
    en: (p) =>
      p.reason === "implied"
        ? `The promotion input at ${p.at} classifies a subject that promote records itself with class ${p.class}`
        : `The promotion input at ${p.at} does not fit the model: ${p.detail}`,
    uk: (p) =>
      p.reason === "implied"
        ? `Вхід промоції в ${p.at} класифікує предмет, клас якого promote записує сам: ${p.class}`
        : `Вхід промоції в ${p.at} не відповідає моделі: ${p.detail}`,
    hint: {
      en: (p) =>
        p.reason === "implied"
          ? "Remove the key: a comment carried over verbatim into a description is recorded by promote itself; the input classifies only what needs a decision."
          : p.reason === "scopeColumn"
            ? "Declare `scope` and `scopeColumn` on the CustomTable, naming this column, before the promotion; only the scope column of a table can map to the scope."
            : "Name columns of the adopted table, standard attributes that the target kind has with its settings (canonical camelCase names), each target once, and conversion keys that name a SQL unit or a structural element of the promoted tables.",
      uk: (p) =>
        p.reason === "implied"
          ? "Приберіть ключ: дослівно перенесений в опис коментар promote записує сам; вхід класифікує лише те, що потребує рішення."
          : p.reason === "scopeColumn"
            ? "Оголосіть `scope` і `scopeColumn` на CustomTable з цією колонкою до промоції; на скоуп мапиться лише колонка-носій скоупу таблиці."
            : "Називайте колонки прийнятої таблиці, стандартні реквізити, які цільовий вид має з його налаштуваннями (канонічні camelCase-імена), кожну ціль один раз і ключі конверсій, що називають SQL-одиницю чи структурний елемент промотованих таблиць.",
    },
  },
  "promote.unit-unsupported": {
    en: (p) => `${p.kind} ${p.name} cannot be a promotion target: ${p.detail}`,
    uk: (p) => `${p.kind} ${p.name} не може бути ціллю промоції: ${p.detail}`,
    hint: {
      en: "Promotion takes a catalog, a document without posting or an independent information register, together with their tabular sections; a posting document and its registers are promoted by the registers plan.",
      uk: "Промоція приймає довідник, документ без проведення або незалежний регістр відомостей разом із їхніми табличними частинами; документ із проведенням і його регістри промотує план регістрів.",
    },
  },
  "promote.reference-not-promoted": {
    en: (p) =>
      `${p.table} references ${p.target}, an adopted table outside the promotion unit`,
    uk: (p) =>
      `${p.table} посилається на ${p.target} — прийняту таблицю поза одиницею промоції`,
    hint: {
      en: "Promote the referenced table first, promote it in the same unit, or retire the referencing column.",
      uk: "Спершу промотуйте таблицю-ціль, промотуйте її в тій самій одиниці або виведіть колонку-посилання з ужитку.",
    },
  },
  "promote.retired-referenced": {
    en: (p) =>
      `Column ${p.column} of ${p.table} is referenced here (${p.role}), but the promotion leaves no attribute for it`,
    uk: (p) =>
      `На колонку ${p.column} таблиці ${p.table} тут посилаються (${p.role}), а промоція не лишає для неї реквізиту`,
    hint: {
      en: "A retired column and the scope carrier are not attributes of the kind: repoint or remove the reference, or map the column to an attribute or a standard attribute.",
      uk: "Виведена з ужитку колонка й носій скоупу не є реквізитами виду: перенаправте чи приберіть посилання або змапте колонку на реквізит чи стандартний реквізит.",
    },
  },
  "promote.unclassified": {
    en: (p) =>
      p.allowed !== undefined
        ? `${p.subject} has conversion class ${p.class}, and only ${p.allowed} is allowed for it`
        : p.line === undefined
          ? `${p.subject} has no conversion class in the promotion input`
          : `${p.subject} at line ${p.line} has no conversion class in the promotion input`,
    uk: (p) =>
      p.allowed !== undefined
        ? `${p.subject} має клас конверсії ${p.class}, а для нього допустимий лише ${p.allowed}`
        : p.line === undefined
          ? `${p.subject} не має класу конверсії у вході промоції`
          : `${p.subject} у рядку ${p.line} не має класу конверсії у вході промоції`,
    hint: {
      en: "Name it in conversions with a class: platform, property, rowRule, metadata, applicationCode or removed. The promotion removes it from the files and records the class. A comment that the kind has no place for is only removed: the kind describes its standard attributes itself.",
      uk: "Назвіть його в conversions із класом: platform, property, rowRule, metadata, applicationCode чи removed. Промоція знімає його з файлів і пише клас у запис. Коментар, якому у виді немає місця, лише знімається: стандартні реквізити описує сам вид.",
    },
  },
  "promote.write-path": {
    en: (p) =>
      `${p.table} is writable through the API (${p.detail}), and the write path after promotion is an open question`,
    uk: (p) =>
      `${p.table} доступна на запис через API (${p.detail}), а шлях запису після промоції — відкрите питання`,
    hint: {
      en: 'Revoke the write privilege or drop the write policy before promoting; see the open question "Write path after promotion" in the promotion spec.',
      uk: "Відкличте привілей запису чи зніміть політику запису перед промоцією; див. відкрите питання «Шлях запису після промоції» у спеці промоції.",
    },
  },
  "promote.provider-user-reference": {
    en: (p) =>
      `Column ${p.column} of ${p.table} references the users table of the database provider`,
    uk: (p) =>
      `Колонка ${p.column} таблиці ${p.table} посилається на таблицю користувачів провайдера бази`,
    hint: {
      en: 'Such a column is promoted only as { "to": "scope" } of a scope kind whose root is that table.',
      uk: 'Таку колонку промотують лише як { "to": "scope" } виду скоупу, корінь якого — ця таблиця.',
    },
  },
  "promote.enum-labels": {
    en: (p) =>
      `Column ${p.column} of ${p.table} has enum type ${p.enum}: it maps only to a Ref to an Enumeration whose value labels include ${p.labels}`,
    uk: (p) =>
      `Колонка ${p.column} таблиці ${p.table} має енам-тип ${p.enum}: її мапять лише на Ref до перерахування, мітки значень якого включають ${p.labels}`,
    hint: {
      en: "Create the Enumeration with these value labels (physicalName of the values) or map the column to a Ref to an existing one.",
      uk: "Створіть перерахування з цими мітками значень (physicalName значень) або змапте колонку на Ref до наявного.",
    },
  },
  "promote.type-unsupported": {
    en: (p) =>
      p.reason === "nullable-scope"
        ? `Column ${p.column} of ${p.table} allows NULL, and the scope column of the kind is NOT NULL`
        : `Column ${p.column} of ${p.table} cannot become an attribute of the kind: ${p.detail}`,
    uk: (p) =>
      p.reason === "nullable-scope"
        ? `Колонка ${p.column} таблиці ${p.table} допускає NULL, а колонка скоупу виду — NOT NULL`
        : `Колонка ${p.column} таблиці ${p.table} не може стати реквізитом виду: ${p.detail}`,
    hint: {
      en: (p) =>
        p.reason === "nullable-scope"
          ? "A fill step does not assign tenants: mark the column notNull in the CustomTable, apply it through the normal pipeline (it fails on existing NULLs, so fix that data first), then promote."
          : "Retire the column or change it in the adopted table first: a raw type, a generated or identity column and an explicit collation have no attribute counterpart, and a foreign key becomes a Ref only as a single column referencing the key of a metadata object.",
      uk: (p) =>
        p.reason === "nullable-scope"
          ? "Крок fill тенантів не призначає: позначте колонку notNull у CustomTable, застосуйте це звичайним конвеєром (він впаде на наявних NULL, тож спершу виправте ці дані), потім промотуйте."
          : "Виведіть колонку з ужитку або спершу змініть її в прийнятій таблиці: сирий тип, генерована чи identity-колонка й явна колляція не мають відповідника в реквізиті, а FK стає Ref лише однією колонкою на ключ об'єкта метаданих.",
    },
  },
  "promote.default-unplaced": {
    en: (p) =>
      `Column ${p.column} of ${p.table} has a default, and the attribute it maps to has none`,
    uk: (p) =>
      `Колонка ${p.column} таблиці ${p.table} має значення за замовчуванням, а реквізит, на який її змаплено, — ні`,
    hint: {
      en: (p) =>
        `Give the element a defaultValue, or classify the default in conversions as "${p.subject}".`,
      uk: (p) =>
        `Задайте елементу defaultValue або класифікуйте значення в conversions як "${p.subject}".`,
    },
  },
  "promote.fill-missing": {
    en: (p) =>
      p.reason === "nullable-source"
        ? `${p.column} of ${p.kind} ${p.name} is NOT NULL, its source column ${p.source} allows NULL, and nothing fills it`
        : p.reason === "new-attribute"
          ? `Attribute ${p.column} of ${p.kind} ${p.name} is required without a defaultValue, no column carries it, and nothing fills it`
          : `Standard attribute ${p.column} of ${p.kind} ${p.name} is NOT NULL without a default, and nothing fills it`,
    uk: (p) =>
      p.reason === "nullable-source"
        ? `${p.column} виду ${p.kind} ${p.name} — NOT NULL, його колонка-джерело ${p.source} допускає NULL, а заповнити його нічим`
        : p.reason === "new-attribute"
          ? `Реквізит ${p.column} виду ${p.kind} ${p.name} обов'язковий без defaultValue, жодна колонка його не несе, а заповнити його нічим`
          : `Стандартний реквізит ${p.column} виду ${p.kind} ${p.name} — NOT NULL без значення за замовчуванням, а заповнити його нічим`,
    hint: {
      en: "Map a column of the adopted table to it, give a new attribute a defaultValue, or add a fill step that computes it. A default does not fill existing NULLs, so a nullable source needs a fill step even when the kind gives the column a default. The key is never filled: it carries the row's identity, so map the table's key column to it.",
      uk: "Змапте на нього колонку прийнятої таблиці, дайте новому реквізиту defaultValue або додайте крок fill, що його обчислює. Значення за замовчуванням не заповнює наявних NULL, тож джерело з NULL потребує кроку fill, навіть коли вид дає колонці значення за замовчуванням. Ключ не заповнюється ніколи: він несе ідентичність рядка, тож змапте на нього ключову колонку таблиці.",
    },
  },
  "promote.expression-invalid": {
    en: (p) =>
      `Fill expression ${p.expression} is not allowed: ${fillProblem(p.reason, "en")}`,
    uk: (p) =>
      `Вираз заповнення ${p.expression} не дозволено: ${fillProblem(p.reason, "uk")}`,
    hint: {
      en: "A fill expression is one deterministic scalar expression over the columns of its own table, in old names: no subqueries, aggregates without OVER, or other tables, and a window ordered by the table key; the table needs a single-column key. It calls only IMMUTABLE functions of pg_catalog and functions of the model declared IMMUTABLE, the latter qualified with their schema: the step runs with search_path = pg_catalog, pg_temp. Transaction time (now(), current_timestamp, 'now'::timestamptz) is allowed except in a repair, that is, a mapped target written other than coalesce(<its column>, <value>), and a repair casts to a date or time type only a plain string literal.",
      uk: "Вираз заповнення — один детермінований скалярний вираз над колонками своєї таблиці в старих іменах: без підзапитів, агрегатів без OVER чи інших таблиць, а вікно впорядковане ключем таблиці; таблиця потребує одноколонкового ключа. Він викликає лише IMMUTABLE-функції pg_catalog і функції моделі, явно оголошені IMMUTABLE, — останні кваліфікованими схемою: крок виконується з search_path = pg_catalog, pg_temp. Час транзакції (now(), current_timestamp, 'now'::timestamptz) дозволено всюди, крім ремонту — змапленої цілі, записаної інакше, ніж coalesce(<своя колонка>, <значення>), — а ремонт приводить до типу дати чи часу лише звичайний рядковий літерал.",
    },
  },
  "promote.debt-text-reference": {
    en: (p) =>
      `${p.identity} at line ${p.line} is verbatim SQL that reads a promoted table, and its text does not follow the promotion`,
    uk: (p) =>
      `${p.identity} у рядку ${p.line} — дослівний SQL, що читає промотовану таблицю, і його текст не йде за промоцією`,
    hint: {
      en: "Only functions are rewritten: rewrite or drop this unit by hand before promoting.",
      uk: "Переписуються лише функції: перепишіть чи зніміть цю одиницю вручну до промоції.",
    },
  },
  "promote.text-conflict": {
    en: (p) =>
      `The SQL units of ${p.file} cannot be cut or rewritten one by one: ${p.detail}`,
    uk: (p) =>
      `SQL-одиниці ${p.file} не вирізати й не переписати поодинці: ${p.detail}`,
    hint: {
      en: "Put each statement of the file on its own line and promote again.",
      uk: "Розмістіть кожен оператор файлу в окремому рядку й повторіть промоцію.",
    },
  },
  "promote.property-not-equivalent": {
    en: (p) =>
      `The adopted ${KIND_WORD.en[String(p.kind)] ?? p.kind} ${p.name} is classified \`property\`, but the kind recreates it differently: ${p.detail}`,
    uk: (p) =>
      `Прийнятий ${KIND_WORD.uk[String(p.kind)] ?? p.kind} ${p.name} має клас \`property\`, але вид відтворює його інакше: ${p.detail}`,
    hint: {
      en: "Classify it removed (the plan then needs permission to drop it) or keep the table a CustomTable. The metamodel does not express a DEFERRABLE attribute, so such an element cannot be property.",
      uk: "Класифікуйте його removed (план тоді потребує дозволу на видалення) або лишіть таблицю CustomTable. Метамодель не виражає DEFERRABLE-реквізит, тож такий елемент не може бути property.",
    },
  },
  "engine.diagnostic": {
    en: (p) => `Schema engine reported ${p.engineCode}: ${p.detail}`,
    uk: (p) => `Рушій схеми повідомив ${p.engineCode}: ${p.detail}`,
    hint: {
      en: "The engine code is in the diagnostic's engineCode field; check the named object in the schema engine's documentation.",
      uk: "Код рушія — у полі engineCode діагностики; перевірте названий об'єкт за документацією рушія схеми.",
    },
  },
  "engine.unmodeled-drift": {
    en: (p) =>
      `Desired state has an object the schema engine does not model, so the plan cannot create it on the target: ${p.detail}`,
    uk: (p) =>
      `Бажаний стан має об'єкт, якого рушій схеми не моделює, тож план не створить його на цілі: ${p.detail}`,
    hint: {
      en: "A planned statement that depends on this object will fail on the target; create the object on the target first or remove it from the desired state.",
      uk: "Запланований оператор, що залежить від цього об'єкта, впаде на цілі; спершу створіть об'єкт на цілі або приберіть його з бажаного стану.",
    },
  },
  "engine.shadow-load-failed": {
    en: (p) =>
      `Desired state did not load into the shadow database: ${p.detail}`,
    uk: (p) => `Бажаний стан не завантажився в тіньову базу: ${p.detail}`,
    hint: {
      en: "Fix the SQL statement named in the message; the shadow is a fresh database seeded with the provider's base state.",
      uk: "Виправте SQL-оператор, названий у повідомленні; тінь — свіжа база, засіяна базовим станом провайдера.",
    },
  },
  "engine.desired-rejected": {
    en: (p) => `Desired state was rejected: ${p.detail}`,
    uk: (p) => `Бажаний стан відхилено: ${p.detail}`,
    hint: {
      en: "The schema engine refused the desired SQL before planning (empty input, cluster DDL such as roles, an extension the shadow cannot run, or a failed provider seed); fix the cause named in the message.",
      uk: "Рушій схеми відмовив бажаному SQL до планування (порожній вхід, кластерний DDL на кшталт ролей, розширення, яке тінь не виконає, або збій засіву провайдера); усуньте причину з повідомлення.",
    },
  },
  "engine.clone-failed": {
    en: (p) =>
      `The current target state could not be reproduced in a copy: ${p.detail}`,
    uk: (p) => `Поточний стан цілі не відтворився в копії: ${p.detail}`,
    hint: {
      en: "The copy is a fresh shadow seeded with the provider's base state, so the cause is in the target or the environment, not in the metadata: an extension the shadow cannot install, the provider seed, or the shadow connection mode (use a direct or session connection). Fix the cause named in the message.",
      uk: "Копія — свіжа тінь, засіяна базовим станом провайдера, тож причина в цілі чи середовищі, а не в метаданих: розширення, якого тінь не встановить, засів провайдера або режим з'єднання тіні (потрібне пряме чи сесійне з'єднання). Усуньте причину з повідомлення.",
    },
  },
  "engine.preamble-unknown": {
    en: (p) =>
      `The schema engine's plan preamble sets ${p.name} = ${p.value}, which is not on the allowed list`,
    uk: (p) =>
      `Преамбула плану рушія схеми виставляє ${p.name} = ${p.value}, чого немає в дозволеному переліку`,
    hint: {
      en: "The executor sets only the allowed session settings, so this plan was not applied as written. The installed schema engine emits a setting this platform version does not know; update the platform or pin the engine version.",
      uk: "Виконавець виставляє лише дозволені налаштування сесії, тож цей план не застосовано як є. Встановлений рушій схеми видає налаштування, якого ця версія платформи не знає; оновіть платформу або зафіксуйте версію рушія.",
    },
  },
  "engine.unrepresentable": {
    en: (p) =>
      `${p.object}: property ${p.property} cannot be represented in the catalog model: ${p.detail}`,
    uk: (p) =>
      `${p.object}: властивість ${p.property} не виражається в моделі каталогу: ${p.detail}`,
    hint: {
      en: "The database holds a form the model has no field or SQL unit for; bring the object to a form the metadata can declare, or extend the model first.",
      uk: "База тримає форму, для якої модель не має ні поля, ні SQL-одиниці; приведіть об'єкт до форми, яку можуть оголосити метадані, або спершу розширте модель.",
    },
  },
  "engine.unmodeled-class": {
    en: (p) =>
      `${p.count} object(s) of class ${p.class} in the managed boundary have no fact in the schema engine, so the catalog model cannot see them`,
    uk: (p) =>
      `${p.count} об'єкт(ів) класу ${p.class} у межі керування не мають факту в рушії схеми, тож модель каталогу їх не бачить`,
    hint: {
      en: "The schema engine does not model this class, so neither the comparison nor a plan would ever mention these objects; remove them from the managed schemas or keep them outside the managed boundary.",
      uk: "Рушій схеми не моделює цей клас, тож ні звірка, ні план ніколи не згадали б ці об'єкти; приберіть їх із керованих схем або тримайте поза межею керування.",
    },
  },
  "engine.census-mismatch": {
    en: (p) =>
      `Class ${p.class} has ${p.census} object(s) in the managed boundary, but the schema engine extracted ${p.engine}`,
    uk: (p) =>
      `Клас ${p.class} має ${p.census} об'єкт(ів) у межі керування, а рушій схеми витягнув ${p.engine}`,
    hint: {
      en: "The engine skipped or added objects of a class it models, so the catalog model would silently differ from the database; find the objects the engine policy or extraction treats differently.",
      uk: "Рушій пропустив або додав об'єкти класу, який він моделює, тож модель каталогу тихо розійшлася б із базою; знайдіть об'єкти, які політика чи екстракт рушія обробляє інакше.",
    },
  },
  "engine.unmodeled-property": {
    en: (p) =>
      `${p.count} object(s) in the managed boundary have a non-default ${p.property}, which the schema engine does not read, so the catalog model cannot see it`,
    uk: (p) =>
      `${p.count} об'єкт(ів) у межі керування мають нетипове значення властивості ${p.property}, якої рушій схеми не читає, тож модель каталогу її не бачить`,
    hint: {
      en: "The catalog model does not express physical storage parameters (storage, compression, statistics target, column options, access method, CLUSTER); reset them to the default or keep the object outside the managed boundary.",
      uk: "Модель каталогу не виражає фізичних параметрів зберігання (storage, compression, statistics target, опції колонки, метод доступу, CLUSTER); поверніть типові значення або тримайте об'єкт поза межею керування.",
    },
  },
  "engine.owner-not-member": {
    en: (p) =>
      `${p.count} object(s) in the managed boundary are owned by a role the connecting role is not a member of, so the schema engine cannot read the database: ${p.objects}`,
    uk: (p) =>
      `Об'єктів у межі керування, якими володіє роль, членом якої роль підключення не є, тож рушій схеми не може прочитати базу: ${p.count}: ${p.objects}`,
    hint: {
      en: `Nothing was compared. ${OWNER_RECIPE.en}, and compare again.`,
      uk: `Нічого не порівняно. ${OWNER_RECIPE.uk} й порівняйте знову.`,
    },
  },
  "engine.out-of-scope": {
    en: (p) =>
      `${p.object} lies outside the boundary the schema engine compares, so a comparison would never see it: ${outOfScopeReason(p)?.en(p) ?? p.reason}`,
    uk: (p) =>
      `${p.object} лежить поза межею, яку порівнює рушій схеми, тож звірка ніколи його не побачить: ${outOfScopeReason(p)?.uk(p) ?? p.reason}`,
    hint: {
      en: "In a provider schema the application owns only policies and triggers on the provider's surface tables, with trigger functions outside provider schemas; move the object into a schema of the application, scope default privileges with IN SCHEMA, and leave provider extensions to the provider.",
      uk: "У схемі провайдера застосунку належать лише політики й тригери на таблицях поверхні провайдера, з функціями тригерів поза схемами провайдера; перенесіть об'єкт у схему застосунку, обмежте типові привілеї через IN SCHEMA, а розширення провайдера лишіть провайдерові.",
    },
  },
  "apply.state-format": {
    en: (p) =>
      `The apply state in schema simetra has format ${p.found}, which this platform version cannot read`,
    uk: (p) =>
      `Стан застосування в схемі simetra має форму ${p.found}, якої ця версія платформи не читає`,
    hint: {
      en: "The state was written by another platform version; apply with the version that wrote it. The format is never guessed, so nothing is planned or applied over it.",
      uk: "Стан записала інша версія платформи; застосовуйте версією, що його записала. Форму ніколи не вгадуємо, тож поверх неї нічого не плануємо й не застосовуємо.",
    },
  },
  "apply.ledger-without-marker": {
    en: () =>
      "The apply ledger in schema simetra has records but the marker row is missing: the apply state is damaged, this is not a first apply",
    uk: () =>
      "Журнал застосувань у схемі simetra має записи, а рядка marker немає: стан застосування пошкоджено, це не перше застосування",
    hint: {
      en: "Restore the marker from a backup of the database before applying; a first apply would treat a database with history as new.",
      uk: "Перед застосуванням відновіть marker із резервної копії бази: перше застосування вважало б базу з історією новою.",
    },
  },
  "apply.cascade": {
    en: (p) =>
      `Plan step ${p.step} runs ${p.verb} with CASCADE, which extends it to dependent objects that the plan does not name`,
    uk: (p) =>
      `Крок плану ${p.step} виконує ${p.verb} з CASCADE, а це поширює його на залежні об'єкти, яких план не називає`,
    hint: {
      en: "The platform never runs DROP, TRUNCATE or REVOKE with CASCADE, and no permission allows it. Every affected object must be a step of its own; report the plan as an engine defect.",
      uk: "Платформа ніколи не виконує DROP, TRUNCATE чи REVOKE з CASCADE, і жоден дозвіл цього не змінює. Кожен зачеплений об'єкт мусить бути окремим кроком; повідомте про план як про дефект двигуна.",
    },
  },
  "apply.non-transactional": {
    en: (p) =>
      `Plan step ${p.step} cannot run inside a transaction, and a plan is applied in one transaction`,
    uk: (p) =>
      `Крок плану ${p.step} не може виконуватися в транзакції, а план застосовується однією транзакцією`,
    hint: {
      en: "Running such steps separately is not supported yet; change the metadata so that the plan does not need this step.",
      uk: "Окреме виконання таких кроків ще не підтримується; змініть метадані так, щоб план не потребував цього кроку.",
    },
  },
  "apply.commit-boundary": {
    en: (p) =>
      `Plan step ${p.step} uses the result of an earlier step that must be committed first (such as a new enum value), so the plan cannot run in one transaction`,
    uk: (p) =>
      `Крок плану ${p.step} вживає результат попереднього кроку, який треба спершу закомітити (наприклад, нове значення енаму), тож план не виконати однією транзакцією`,
    hint: {
      en: "Split the metadata change into two applies: first the change the step depends on, then the rest.",
      uk: "Розбийте зміну метаданих на два застосування: спершу те, від чого залежить крок, потім решту.",
    },
  },
  "apply.permission-required": {
    en: (p) =>
      `Plan items ${p.items} need explicit permission: a step that drops data or relaxes a guarantee, drift (a change made to the database outside the platform), or a promotion's access change, delete semantics, removal or repair of existing values`,
    uk: (p) =>
      `Пункти плану ${p.items} потребують явного дозволу: крок, що знищує дані чи знімає гарантію, дрейф (зміна бази повз платформу) або зміна доступу, семантика видалення, видалення чи ремонт наявних значень промоції`,
    hint: {
      en: "Review these items in the plan and allow each one: a step by its id, drift by the word drift, a promotion item by its access:, delete:, remove: or repair: token.",
      uk: "Перегляньте ці пункти в плані й дозвольте кожен: крок — за його id, дрейф — словом drift, пункт промоції — його токеном access:, delete:, remove: чи repair:.",
    },
  },
  "apply.permission-unknown": {
    en: (p) =>
      `Allowed items ${p.items} are not in the plan or need no permission`,
    uk: (p) =>
      `Дозволені пункти ${p.items} відсутні в плані або не потребують дозволу`,
    hint: {
      en: "Allow only the ids of destructive and relaxation steps of this plan, drift only when the plan reports drift, and only the promotion items (access:, delete:, remove:, repair:) the plan lists; a stale item means the permission was given for another plan.",
      uk: "Дозволяйте лише id деструктивних кроків і послаблень цього плану, drift — лише коли план повідомляє дрейф, і лише ті пункти промоції (access:, delete:, remove:, repair:), які план перелічує; застарілий пункт означає, що дозвіл давали іншому плану.",
    },
  },
  "apply.first-apply": {
    en: () =>
      "The database has no apply state: this is the first apply, so there is no recorded state to check for drift",
    uk: () =>
      "База не має стану застосування: це перше застосування, тож дрейф немає з чим порівнювати",
  },
  "apply.drift": {
    en: (p) =>
      `The database differs from the state recorded at the last apply${p.sections === "" ? "" : `; catalog fingerprint sections: ${p.sections}`}${p.count === 0 ? "" : `; catalog model differences (${p.count}): ${p.paths}`}`,
    uk: (p) =>
      `База відрізняється від стану, зафіксованого при останньому застосуванні${p.sections === "" ? "" : `; секції відбитка каталогу: ${p.sections}`}${p.count === 0 ? "" : `; відмінності моделі каталогу (${p.count}): ${p.paths}`}`,
    hint: {
      en: "Someone changed the database outside the platform. The plan starts from the live database, so its steps show what happens to the drifted objects; review them and allow drift to apply, or bring the database back and plan again.",
      uk: "Хтось змінив базу повз платформу. План починається від живої бази, тож його кроки показують, що станеться з об'єктами, які дрейфнули; перегляньте їх і дозвольте drift, щоб застосувати, або поверніть базу й сплануйте знову.",
    },
  },
  "apply.drift-partial": {
    en: (p) =>
      `The catalog fingerprint algorithm changed since the last apply (${p.fingerprintFrom} → ${p.fingerprintTo}), so the drift check is limited to the catalog model`,
    uk: (p) =>
      `Від останнього застосування змінився алгоритм відбитка каталогу (${p.fingerprintFrom} → ${p.fingerprintTo}), тож перевірка дрейфу обмежена моделлю каталогу`,
    hint: {
      en: "The catalog model does not carry owners, partitions, inheritance or sequence settings; check those by hand if the database may have been changed outside the platform.",
      uk: "Модель каталогу не несе власників, партицій, успадкування й налаштувань послідовностей; перевірте їх вручну, якщо базу могли змінити повз платформу.",
    },
  },
  "apply.versions-changed": {
    en: (p) =>
      `Both the schema engine (${p.engineFrom} → ${p.engineTo}) and the catalog fingerprint (${p.fingerprintFrom} → ${p.fingerprintTo}) changed since the last apply, so drift cannot be checked and the plan carries it as drift to accept`,
    uk: (p) =>
      `Від останнього застосування змінились і двигун схеми (${p.engineFrom} → ${p.engineTo}), і відбиток каталогу (${p.fingerprintFrom} → ${p.fingerprintTo}), тож дрейф перевірити нічим, і план несе його як дрейф до прийняття`,
    hint: {
      en: "Make sure nobody changed the database outside the platform since the last apply, review the plan steps, and allow drift to apply.",
      uk: "Переконайтеся, що від останнього застосування базу ніхто не змінював повз платформу, перегляньте кроки плану й дозвольте drift, щоб застосувати.",
    },
  },
  "apply.plan-versions": {
    en: (p) =>
      `The plan was built with ${p.field} ${p.plan}, but the current one is ${p.current}`,
    uk: (p) =>
      `План побудовано з ${p.field} ${p.plan}, а поточне значення — ${p.current}`,
    hint: {
      en: "Plan again with the current platform: a plan applies only with the versions that built and proved it.",
      uk: "Сплануйте знову поточною платформою: план застосовується лише з тими версіями, що його побудували й довели.",
    },
  },
  "apply.plan-format": {
    en: (p) =>
      `The plan format ${p.found} is not supported (this platform reads plan format ${p.supported}), so rebuild the plan`,
    uk: (p) =>
      `Формат плану ${p.found} не підтримується (ця платформа читає формат плану ${p.supported}), тож побудуйте план наново`,
    hint: {
      en: "Nothing was written. Plan again with the current platform and review the new plan before applying it.",
      uk: "Нічого не записано. Сплануйте знову поточною платформою й перегляньте новий план перед застосуванням.",
    },
  },
  "apply.plan-hash": {
    en: (p) =>
      `The plan file ${p.file} does not carry the confirmed plan hash ${p.planHash}: it is another plan, or it was edited after planning`,
    uk: (p) =>
      `Файл плану ${p.file} не має підтвердженого хешу плану ${p.planHash}: це інший план, або його змінено після планування`,
    hint: {
      en: "Nothing was written. Apply only the plan that was reviewed: plan again, review the plan and pass its planHash.",
      uk: "Нічого не записано. Застосовуйте лише переглянутий план: сплануйте знову, перегляньте план і передайте його planHash.",
    },
  },
  "apply.plan-stale": {
    en: (p) =>
      `The plan leads to snapshot ${p.plan}, but the metadata now compiles to ${p.current}`,
    uk: (p) =>
      `План веде до знімка ${p.plan}, а метадані тепер компілюються в ${p.current}`,
    hint: {
      en: "Nothing was written. The metadata changed after planning; plan again and review the new plan.",
      uk: "Нічого не записано. Метадані змінилися після планування; сплануйте знову й перегляньте новий план.",
    },
  },
  "apply.busy": {
    en: () =>
      "Another apply is running on this database: the apply lock is taken",
    uk: () =>
      "На цій базі вже йде інше застосування: блокування застосування зайняте",
    hint: {
      en: "Nothing was written. Wait until the other apply finishes and plan again: it may have changed the database.",
      uk: "Нічого не записано. Дочекайтеся кінця іншого застосування й сплануйте знову: воно могло змінити базу.",
    },
  },
  "apply.api-role": {
    en: (p) =>
      `The apply runs as ${p.role}, a role the provider serves API requests with; the schema is never changed under such a role`,
    uk: (p) =>
      `Застосування виконується від ролі ${p.role}, якою провайдер обслуговує запити API; схему під такою роллю не змінюють ніколи`,
    hint: {
      en: "Nothing was written. Connect as the role that owns the application schema, not as an API role.",
      uk: "Нічого не записано. Підключіться роллю, що володіє схемою застосунку, а не роллю API.",
    },
  },
  "apply.role-mismatch": {
    en: (p) =>
      `The plan was built for role ${p.plan}, but the apply runs as ${p.current}: the locks, owners and write path of the plan hold for its role only`,
    uk: (p) =>
      `План побудовано для ролі ${p.plan}, а застосування виконується від ${p.current}: замки, власники й шлях запису плану чинні лише для його ролі`,
    hint: {
      en: (p) =>
        `Nothing was written. Apply as ${p.plan}, or plan again as the role that will apply.`,
      uk: (p) =>
        `Нічого не записано. Застосуйте від ролі ${p.plan} або побудуйте план знову від ролі, що застосовуватиме.`,
    },
  },
  "apply.chain": {
    en: (p) =>
      `The plan starts from snapshot ${p.expected}, but the database is at ${p.found}`,
    uk: (p) =>
      `План починається від знімка ${p.expected}, а база перебуває на ${p.found}`,
    hint: {
      en: "Nothing was written. A plan applies only to the state it was built from; plan again against this database.",
      uk: "Нічого не записано. План застосовується лише до стану, від якого його побудовано; сплануйте знову проти цієї бази.",
    },
  },
  "apply.server-unsupported": {
    en: (p) =>
      `Simetra requires PostgreSQL 17 or newer; this server is ${p.version}`,
    uk: (p) =>
      `Simetra потребує PostgreSQL 17 або новішого; цей сервер — ${p.version}`,
    hint: {
      en: "Nothing was written. Upgrade the database server to PostgreSQL 17 or newer, then plan again.",
      uk: "Нічого не записано. Оновіть сервер бази до PostgreSQL 17 або новішого й сплануйте знову.",
    },
  },
  "apply.target-changed": {
    en: (p) =>
      p.cause === "copy"
        ? `This database is not a copy of the plan's target; ${p.sections === "server" ? `the server facts differ: ${p.facts}` : "the ledger head differs"}`
        : `The database changed after the plan was built; ${IDENTITY_CHECK[String(p.sections)]?.en ?? `catalog fingerprint sections: ${p.sections}`}${p.cause === "owners" ? `; ${COPY_OWNERS.en}` : ""}`,
    uk: (p) =>
      p.cause === "copy"
        ? `Ця база — не копія цілі плану; ${p.sections === "server" ? `різняться факти сервера: ${p.facts}` : "різниться голова ledger"}`
        : `База змінилася після побудови плану; ${IDENTITY_CHECK[String(p.sections)]?.uk ?? `секції відбитка каталогу: ${p.sections}`}${p.cause === "owners" ? `; ${COPY_OWNERS.uk}` : ""}`,
    hint: {
      en: (p) =>
        p.cause === "owners"
          ? COPY_OWNERS_HINT.en
          : p.cause === "copy"
            ? `${COPY_REMAKE_HINT.en}${p.sections === "ledger" ? ` ${COPY_LEDGER_HINT.en}` : ""}`
            : "Nothing was written. Plan again; permissions of the old plan no longer apply.",
      uk: (p) =>
        p.cause === "owners"
          ? COPY_OWNERS_HINT.uk
          : p.cause === "copy"
            ? `${COPY_REMAKE_HINT.uk}${p.sections === "ledger" ? ` ${COPY_LEDGER_HINT.uk}` : ""}`
            : "Нічого не записано. Сплануйте знову; дозволи старого плану більше не діють.",
    },
  },
  "apply.verify-failed": {
    en: (p) =>
      `After the plan steps the database does not match the desired state; catalog fingerprint sections: ${p.sections}${p.paths === undefined ? "" : `; differing catalog paths: ${p.paths}`}. The transaction was rolled back`,
    uk: (p) =>
      `Після кроків плану база не відповідає бажаному стану; секції відбитка каталогу: ${p.sections}${p.paths === undefined ? "" : `; шляхи розбіжності в каталозі: ${p.paths}`}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. The proof of the plan did not hold on this database; plan again, and report the plan if the mismatch repeats.",
      uk: "Нічого не записано. Доказ плану не справдився на цій базі; сплануйте знову, а якщо розбіжність повториться, повідомте про план.",
    },
  },
  "apply.step-failed": {
    en: (p) =>
      `Plan step ${p.step} failed with SQLSTATE ${p.sqlstate}: ${p.error}. The transaction was rolled back`,
    uk: (p) =>
      `Крок плану ${p.step} завершився помилкою SQLSTATE ${p.sqlstate}: ${p.error}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Fix what the database reports, such as rows that break a new constraint, and apply again.",
      uk: "Нічого не записано. Виправте те, про що повідомляє база, наприклад рядки, що порушують нове обмеження, і застосуйте знову.",
    },
  },
  "apply.lock-timeout": {
    en: (p) =>
      `The apply could not take its locks in ${p.attempts} attempts: other sessions hold the tables it changes, or the transaction kept ending in a deadlock`,
    uk: (p) =>
      `Застосування не змогло взяти блокування за ${p.attempts} спроб: таблиці, які воно змінює, тримають інші сесії, або транзакція щоразу закінчувалася взаємним блокуванням`,
    hint: {
      en: "Nothing was written. Apply again when the load is lower, or raise the lock timeout.",
      uk: "Нічого не записано. Застосуйте знову, коли навантаження менше, або збільште тайм-аут блокування.",
    },
  },
  "apply.lock-privilege": {
    en: (p) =>
      `The apply role may not lock ${p.tables} in ${p.mode} mode up front (${p.error}); the right was there when the plan was built`,
    uk: (p) =>
      `Роль застосування не може наперед заблокувати ${p.tables} у режимі ${p.mode} (${p.error}); під час побудови плану це право було`,
    hint: {
      en: "Nothing was written. An explicit LOCK stronger than ROW EXCLUSIVE needs MAINTAIN, UPDATE, DELETE or TRUNCATE on the table, or membership in its owner role; restore the right, or plan again so the table becomes an implicit lock of its step.",
      uk: "Нічого не записано. Явний LOCK сильніше за ROW EXCLUSIVE потребує MAINTAIN, UPDATE, DELETE чи TRUNCATE на таблиці або членства в ролі-власнику; поверніть право або побудуйте план знову, і таблиця стане неявним замком свого кроку.",
    },
  },
  "apply.lock-footprint-exceeded": {
    en: (p) =>
      `A step locked ${p.table} in ${p.mode} mode, but the plan expected ${p.planned === "none" ? "no lock" : `at most ${p.planned}`} on it: the lock was taken in the middle of the steps, not up front`,
    uk: (p) =>
      `Крок заблокував ${p.table} у режимі ${p.mode}, а план очікував на ній ${p.planned === "none" ? "жодного замка" : `не більше за ${p.planned}`}: замок узято посеред кроків, а не наперед`,
    hint: {
      en: "The plan is still valid. The lock footprint model of the platform missed this lock; report the plan, because on the live database the wait for this lock comes outside the single up-front lock point.",
      uk: "План чинний. Модель сліду замків платформи пропустила цей замок; повідомте про план, бо на живій базі очікування цього замка буде поза єдиною точкою блокування наперед.",
    },
  },
  "apply.connection-lost": {
    en: (p) =>
      p.outcome === "applied"
        ? `The connection was lost at the end of the apply, but the apply ledger records it (apply id ${p.applyId}): it was committed`
        : p.outcome === "not-applied"
          ? `The connection was lost during the apply, and the apply ledger has no record of it (apply id ${p.applyId}): it was rolled back`
          : `The connection was lost during the apply, and the apply ledger could not be read to tell whether it was committed (apply id ${p.applyId})`,
    uk: (p) =>
      p.outcome === "applied"
        ? `З'єднання обірвалося наприкінці застосування, але журнал застосувань його містить (id застосування ${p.applyId}): його закомічено`
        : p.outcome === "not-applied"
          ? `З'єднання обірвалося під час застосування, а журнал застосувань не має його запису (id застосування ${p.applyId}): його відкочено`
          : `З'єднання обірвалося під час застосування, а журнал застосувань не вдалося прочитати, щоб з'ясувати, чи його закомічено (id застосування ${p.applyId})`,
    hint: {
      en: (p) =>
        p.outcome === "unknown"
          ? "Before applying again, look for this apply id in the apply_id column of simetra.ledger: a row means the apply was committed."
          : p.outcome === "applied"
            ? "Nothing to repeat: the database is at the new state."
            : "Nothing was written; apply again.",
      uk: (p) =>
        p.outcome === "unknown"
          ? "Перед повторним застосуванням знайдіть цей id у колонці apply_id таблиці simetra.ledger: рядок означає, що застосування закомічено."
          : p.outcome === "applied"
            ? "Повторювати нічого: база вже в новому стані."
            : "Нічого не записано; застосуйте знову.",
    },
  },
  "apply.type-narrowing": {
    en: (p) =>
      p.lost !== undefined
        ? `Plan step ${p.step} would change the type of column ${p.column} of ${p.table} and lose ${p.lost} value(s): converting them to the new type and back does not give the same value. The transaction was rolled back`
        : `Plan step ${p.step} would change the type of column ${p.column} of ${p.table}, but a value does not convert to the new type (SQLSTATE ${p.sqlstate}). The transaction was rolled back`,
    uk: (p) =>
      p.lost !== undefined
        ? `Крок плану ${p.step} змінив би тип колонки ${p.column} таблиці ${p.table} і втратив би значень: ${p.lost} — приведення до нового типу й назад не дає того самого значення. Транзакцію відкочено`
        : `Крок плану ${p.step} змінив би тип колонки ${p.column} таблиці ${p.table}, але значення не приводиться до нового типу (SQLSTATE ${p.sqlstate}). Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. A permission for a destructive step allows it to fail on the data, not to truncate or round values silently. If the change is intended, record it as a fill step of the promotion (a repair such as left(<column>, <n>) or <column>::jsonb): the step writes the converted values before the type change. Otherwise fix the data or the target type; then plan again.",
      uk: "Нічого не записано. Дозвіл на руйнівний крок дозволяє йому впасти на даних, а не мовчки обрізати чи округлити значення. Якщо зміна задумана, запишіть її кроком fill промоції (ремонт на кшталт left(<колонка>, <n>) чи <колонка>::jsonb): крок записує приведені значення до зміни типу. Інакше виправте дані чи цільовий тип; потім сплануйте знову.",
    },
  },
  "apply.type-guard-failed": {
    en: (p) =>
      `The check before plan step ${p.step} for column ${p.column} failed with SQLSTATE ${p.sqlstate}: ${p.error}. The transaction was rolled back`,
    uk: (p) =>
      `Перевірка перед кроком плану ${p.step} для колонки ${p.column} завершилася помилкою SQLSTATE ${p.sqlstate}: ${p.error}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. The check compares each value with itself after converting it to the new type and back; a type without equality (such as json) cannot be compared, so change such a column through a data step.",
      uk: "Нічого не записано. Перевірка порівнює кожне значення з ним самим після приведення до нового типу й назад; тип без рівності (як-от json) не порівняти, тож таку колонку змінюйте кроком даних.",
    },
  },
  "apply.preservation-failed": {
    en: (p) =>
      p.rows !== undefined
        ? `The plan changed the number of rows of ${p.table} (${p.rows}). The transaction was rolled back`
        : `The plan changed values of column ${p.column} of ${p.table}: the column no longer holds the same value in the same row. The transaction was rolled back`,
    uk: (p) =>
      p.rows !== undefined
        ? `План змінив кількість рядків таблиці ${p.table} (${p.rows}). Транзакцію відкочено`
        : `План змінив значення колонки ${p.column} таблиці ${p.table}: у тому самому рядку вже не те саме значення. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. A promotion renames and retypes the tables of the object but keeps every row and every mapped value; a step that changes them is a defect of the plan, so report it to the platform maintainers.",
      uk: "Нічого не записано. Промоція перейменовує таблиці об'єкта й змінює їхні типи, але зберігає кожен рядок і кожне змаплене значення; крок, що їх змінює, — дефект плану, тож повідомте про нього супровідникам платформи.",
    },
  },
  "apply.preservation-measure-failed": {
    en: (p) =>
      `The data measurement of ${p.table} ${p.side === "before" ? "before" : "after"} the plan's steps failed with SQLSTATE ${p.sqlstate}: ${p.error}. The transaction was rolled back`,
    uk: (p) =>
      `Замір даних таблиці ${p.table} ${p.side === "before" ? "до" : "після"} кроків плану завершився помилкою SQLSTATE ${p.sqlstate}: ${p.error}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Without the measurement the apply cannot prove that rows and mapped values survive the steps; fix what the error names (a missing table, a privilege) and apply again, or report the plan if it repeats.",
      uk: "Нічого не записано. Без заміру застосування не доведе, що рядки й змаплені значення пережили кроки; виправте те, що називає помилка (відсутня таблиця, право), і застосуйте знову, а якщо повториться — повідомте про план.",
    },
  },
  "apply.function-check-failed": {
    en: (p) =>
      p.cut !== undefined
        ? `The function check cannot compare the function errors ${p.cut === "baseline" ? "before" : "after"} the plan's steps: there are at least ${p.count}, more than the ${p.limit} it compares. The transaction was rolled back`
        : `After the plan's steps ${p.count} function(s) have errors they did not have before: ${p.functions}. The transaction was rolled back`,
    uk: (p) =>
      p.cut !== undefined
        ? `Перевірка функцій не може порівняти помилки функцій ${p.cut === "baseline" ? "до" : "після"} кроків плану: їх щонайменше ${p.count}, більше за ${p.limit}, які вона порівнює. Транзакцію відкочено`
        : `Після кроків плану ${p.count} функцій мають помилки, яких до кроків не було: ${p.functions}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Fix the function body in the same plan, or split the change so the function is changed together with what it reads; with too many errors to compare, fix the existing function errors first.",
      uk: "Нічого не записано. Виправте тіло функції в тому самому плані або розбийте зміну так, щоб функція змінювалася разом із тим, що вона читає; коли помилок забагато для порівняння, спершу виправте наявні помилки функцій.",
    },
  },
  "apply.function-check-blind": {
    en: (p) =>
      `${p.count} function(s) cannot be checked after the steps (another procedural language, no EXECUTE for the applying role, or plpgsql_check skips them): ${p.functions}`,
    uk: (p) =>
      `${p.count} функцій не можна перевірити після кроків (інша процедурна мова, немає EXECUTE для ролі застосування або plpgsql_check їх пропускає): ${p.functions}`,
    hint: {
      en: "The check does not see these function bodies: review them by hand against the plan's changes.",
      uk: "Перевірка не бачить тіл цих функцій: перегляньте їх вручну проти змін плану.",
    },
  },
  "apply.deferred-constraint-failed": {
    en: (p) =>
      `A deferred trigger or constraint failed when the transaction checked it ${p.after === "data" ? "right after the data steps wrote their values" : "after the plan's steps"} (SQLSTATE ${p.sqlstate}): ${p.error}. The transaction was rolled back`,
    uk: (p) =>
      `Відкладений тригер чи обмеження не спрацювали, коли транзакція перевірила їх ${p.after === "data" ? "одразу після запису значень кроків даних" : "після кроків плану"} (SQLSTATE ${p.sqlstate}): ${p.error}. Транзакцію відкочено`,
    hint: {
      en: (p) =>
        p.after === "data"
          ? "Nothing was written. The values the data steps wrote violate a DEFERRABLE constraint or a deferred trigger rejects them: fix the expression of the step or the data it reads."
          : "Nothing was written. A step leaves rows that violate a DEFERRABLE constraint or a deferred trigger rejects them: fix the step or the data it works on.",
      uk: (p) =>
        p.after === "data"
          ? "Нічого не записано. Значення, які записали кроки даних, порушують обмеження DEFERRABLE або їх відхиляє відкладений тригер: виправте вираз кроку чи дані, які він читає."
          : "Нічого не записано. Крок лишає рядки, що порушують обмеження DEFERRABLE, або їх відхиляє відкладений тригер: виправте крок або дані, з якими він працює.",
    },
  },
  "apply.constraint-invalid": {
    en: (p) =>
      `After the plan's steps these constraints or indexes are invalid, and the desired state has them valid: ${p.objects}. The transaction was rolled back`,
    uk: (p) =>
      `Після кроків плану ці обмеження чи індекси недійсні, а в бажаному стані вони дійсні: ${p.objects}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. A NOT VALID constraint or an index left invalid is not what the desired state describes: validate it in the same plan or drop it.",
      uk: "Нічого не записано. Обмеження NOT VALID чи недійсний індекс — не те, що описує бажаний стан: перевірте його в тому самому плані або приберіть.",
    },
  },
  "apply.rehearsal-proof-failed": {
    en: (p) =>
      `After the plan's steps the engine still finds ${p.count} action(s) to the desired state, the first: ${p.first}${p.cause === "owners" ? `; ${COPY_OWNERS.en}` : ""}. The rehearsal was rolled back`,
    uk: (p) =>
      `Репетиція не довела стан: після кроків двигун ще бачить ${p.count} дій до бажаного стану, перша — ${p.first}${p.cause === "owners" ? `; ${COPY_OWNERS.uk}` : ""}. Репетицію відкочено.`,
    hint: {
      en: (p) =>
        p.cause === "owners"
          ? COPY_OWNERS_HINT.en
          : "Nothing was written. The plan does not reach the desired state on this database; plan again, and report the plan if the difference repeats.",
      uk: (p) =>
        p.cause === "owners"
          ? COPY_OWNERS_HINT.uk
          : "Нічого не записано. План не доводить цю базу до бажаного стану; сплануйте знову, а якщо розбіжність повториться, повідомте про план.",
    },
  },
  "apply.rehearsal-required": {
    en: () =>
      "The plan carries a promotion, and a promotion is applied with COMMIT only with a valid rehearsal report, but this plan has none",
    uk: () =>
      "План несе промоцію, а промоцію застосовують із COMMIT лише з чинним звітом репетиції, але звіту цього плану немає",
    hint: {
      en: "Nothing was written. Rehearse the plan first on a copy of the target with data (`apply --rehearse` against the copy): a successful rehearsal writes its report next to the plan; then apply again.",
      uk: "Нічого не записано. Спершу відрепетируйте план на копії цілі з даними (`apply --rehearse` на копії): успішна репетиція пише звіт поруч із планом; потім застосуйте знову.",
    },
  },
  "apply.rehearsal-stale": {
    en: (p) =>
      `The rehearsal report is stale: ${REHEARSAL_STALE[String(p.reason)]?.en ?? String(p.reason)}`,
    uk: (p) =>
      `Звіт репетиції застарів: ${REHEARSAL_STALE[String(p.reason)]?.uk ?? String(p.reason)}`,
    hint: {
      en: "Nothing was written. Rehearse this plan again on a copy of the target with data, then apply.",
      uk: "Нічого не записано. Відрепетируйте цей план знову на копії цілі з даними, потім застосуйте.",
    },
  },
  "apply.rehearsal-copy-empty": {
    en: (p) =>
      `Table ${p.table} has rows on the target but none on the rehearsal copy, so the rehearsal proved nothing about its data. The transaction was rolled back`,
    uk: (p) =>
      `Таблиця ${p.table} має рядки на цілі, але жодного на копії репетиції, тож репетиція нічого не довела про її дані. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Rehearse on a copy that holds the target's data (for example, a restored recent backup), then apply.",
      uk: "Нічого не записано. Відрепетируйте на копії з даними цілі (наприклад, з відновленого свіжого бекапу), потім застосуйте.",
    },
  },
  "apply.rehearsal-fewer-rows": {
    en: (p) =>
      `Table ${p.table} has ${p.target} rows on the target but ${p.copy} on the rehearsal copy: the rehearsal's durations understate this apply`,
    uk: (p) =>
      `Таблиця ${p.table} має ${p.target} рядків на цілі, але ${p.copy} на копії репетиції: тривалості репетиції недооцінюють це застосування`,
    hint: {
      en: "A copy closer to the target's size gives a more faithful rehearsal. Without an explicit statementTimeoutMs, the statement timeout taken from the report is scaled by the table ratio.",
      uk: "Копія, ближча за розміром до цілі, дає точнішу репетицію. Без явного statementTimeoutMs тайм-аут оператора зі звіту масштабовано відношенням таблиць.",
    },
  },
  "apply.rehearsal-timeout-unbounded": {
    en: (p) =>
      `The statement timeout computed from the rehearsal report (${p.computed} ms) exceeds what Postgres accepts, so it was capped at ${p.limit} ms: no statement of this apply is effectively limited in time`,
    uk: (p) =>
      `Тайм-аут оператора, обчислений зі звіту репетиції (${p.computed} мс), більший за те, що приймає Postgres, тож його обмежено ${p.limit} мс: фактично жоден оператор цього застосування не обмежений у часі`,
    hint: {
      en: "Set the statement timeout explicitly with statementTimeoutMs, or rehearse on a copy closer to the target's size.",
      uk: "Задайте тайм-аут оператора явно через statementTimeoutMs або відрепетируйте на копії, ближчій за розміром до цілі.",
    },
  },
  "apply.temp-name-taken": {
    en: (p) =>
      `The name ${p.name} the apply needs inside its transaction is already taken. Nothing was written`,
    uk: (p) =>
      `Ім'я ${p.name}, яке застосуванню потрібне всередині транзакції, уже зайняте. Нічого не записано`,
    hint: {
      en: "Remove or rename the object with this name, then apply again.",
      uk: "Приберіть чи перейменуйте об'єкт із цим іменем і застосуйте знову.",
    },
  },
  "apply.plpgsql-check-unavailable": {
    en: (p) =>
      `The plan checks function bodies with plpgsql_check, but the apply could not take the extension in its transaction (SQLSTATE ${p.sqlstate}: ${p.error}). The transaction was rolled back`,
    uk: (p) =>
      `План перевіряє тіла функцій через plpgsql_check, але застосування не змогло взяти розширення у своїй транзакції (SQLSTATE ${p.sqlstate}: ${p.error}). Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Give the applying role back what the plan found (the right to install plpgsql_check, or USAGE on the schema of the installed extension), or plan again.",
      uk: "Нічого не записано. Поверніть ролі застосування те, що план застав (право поставити plpgsql_check чи USAGE на схему встановленого розширення), або сплануйте знову.",
    },
  },
  "apply.replication-role": {
    en: (p) =>
      `The apply transaction runs with session_replication_role = ${p.value}, and the promotion's data steps need origin: otherwise foreign key triggers do not fire and the written values bypass the reference checks. Nothing was written`,
    uk: (p) =>
      `Транзакція застосування має session_replication_role = ${p.value}, а кроки даних промоції потребують origin: інакше тригери зовнішніх ключів не спрацьовують, і записані значення обходять перевірку посилань. Нічого не записано`,
    hint: {
      en: "Remove the session_replication_role setting of the database or the role (ALTER DATABASE … RESET / ALTER ROLE … RESET), then apply again.",
      uk: "Зніміть налаштування session_replication_role бази чи ролі (ALTER DATABASE … RESET / ALTER ROLE … RESET) і застосуйте знову.",
    },
  },
  "apply.data-step-failed": {
    en: (p) =>
      p.phase === "measure-before"
        ? `The expression of data step ${p.step} for column ${p.column} of ${p.table} fails on the existing rows (SQLSTATE ${p.sqlstate}). The transaction was rolled back`
        : p.phase === "cast-guard"
          ? `The check of data step ${p.step} that the value converts to the type of column ${p.column} of ${p.table} failed (SQLSTATE ${p.sqlstate}). The transaction was rolled back`
          : p.statement === "trigger-disable"
            ? `Disabling the user triggers of ${p.table} before writing the values of data steps ${p.steps} failed with SQLSTATE ${p.sqlstate}: ${p.error}. The transaction was rolled back`
            : p.statement === "trigger-enable"
              ? `Enabling the user triggers of ${p.table} again after writing the values of data steps ${p.steps} failed with SQLSTATE ${p.sqlstate}: ${p.error}. The transaction was rolled back`
              : `${p.phase === "compute" ? "Computing" : "Writing"} the values of data steps ${p.steps} of ${p.table} failed with SQLSTATE ${p.sqlstate}: ${p.error}. The transaction was rolled back`,
    uk: (p) =>
      p.phase === "measure-before"
        ? `Вираз кроку даних ${p.step} для колонки ${p.column} таблиці ${p.table} не обчислюється на наявних рядках (SQLSTATE ${p.sqlstate}). Транзакцію відкочено`
        : p.phase === "cast-guard"
          ? `Перевірка кроку даних ${p.step}, що значення приводиться до типу колонки ${p.column} таблиці ${p.table}, завершилася помилкою (SQLSTATE ${p.sqlstate}). Транзакцію відкочено`
          : p.statement === "trigger-disable"
            ? `Вимкнення тригерів користувача таблиці ${p.table} перед записом значень кроків даних ${p.steps} завершилося помилкою SQLSTATE ${p.sqlstate}: ${p.error}. Транзакцію відкочено`
            : p.statement === "trigger-enable"
              ? `Повторне ввімкнення тригерів користувача таблиці ${p.table} після запису значень кроків даних ${p.steps} завершилося помилкою SQLSTATE ${p.sqlstate}: ${p.error}. Транзакцію відкочено`
              : `${p.phase === "compute" ? "Обчислення" : "Запис"} значень кроків даних ${p.steps} таблиці ${p.table} завершився помилкою SQLSTATE ${p.sqlstate}: ${p.error}. Транзакцію відкочено`,
    // Збій `ALTER TABLE` на тригері — не проблема даних чи виразу (рішення
    // В17); запис іде під закріпленим `search_path`, тож функція обмеження,
    // індексу чи згенерованої колонки без схеми в іменах падає саме тут
    hint: {
      en: (p) =>
        p.statement === "trigger-disable" || p.statement === "trigger-enable"
          ? "Nothing was written. Switching the user triggers of the table is an ALTER TABLE, not a data problem: make sure the applying role owns the table and that nothing else in the transaction left pending trigger events on it, then apply again; if it repeats, report it to the platform maintainers."
          : p.statement === "update"
            ? "Nothing was written. Fix the data the step reads, or its expression in the promotion record, then plan again. Check constraints, index expressions and generated columns of the table are evaluated under the pinned search_path (pg_catalog, pg_temp), so a function they call must qualify the names it uses."
            : "Nothing was written. Fix the data the step reads, or its expression in the promotion record, then plan again.",
      uk: (p) =>
        p.statement === "trigger-disable" || p.statement === "trigger-enable"
          ? "Нічого не записано. Перемикання тригерів користувача таблиці — це ALTER TABLE, а не проблема даних: переконайтеся, що роль застосування володіє таблицею і що ніщо інше в транзакції не лишило на ній відкладених подій тригерів, і застосуйте знову; якщо повториться — повідомте супровідникам платформи."
          : p.statement === "update"
            ? "Нічого не записано. Виправте дані, які читає крок, або його вираз у записі промоції й сплануйте знову. CHECK-обмеження, вирази індексів і згенеровані колонки таблиці обчислюються під закріпленим search_path (pg_catalog, pg_temp), тож функція, яку вони викликають, мусить кваліфікувати імена, що вживає."
            : "Нічого не записано. Виправте дані, які читає крок, або його вираз у записі промоції й сплануйте знову.",
    },
  },
  "apply.data-step-narrowing": {
    en: (p) =>
      `Data step ${p.step} would change ${p.lost} value(s) of its expression when it writes them as column ${p.column} of ${p.table}: the conversion to the column type truncates or rounds them. The transaction was rolled back`,
    uk: (p) =>
      `Крок даних ${p.step}, записуючи значення свого виразу в колонку ${p.column} таблиці ${p.table}, змінив би їх: ${p.lost} — приведення до типу колонки їх обрізає чи округлює. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Write the conversion explicitly in the expression (for example left(code, 20), round(x, 2) or payload::jsonb), then plan again.",
      uk: "Нічого не записано. Запишіть приведення явно у виразі (наприклад, left(code, 20), round(x, 2) чи payload::jsonb) і сплануйте знову.",
    },
  },
  "apply.data-write-mismatch": {
    en: (p) =>
      `The data steps of ${p.table} computed values for ${p.computed} row(s) but wrote ${p.written}. The transaction was rolled back`,
    uk: (p) =>
      `Кроки даних таблиці ${p.table} обчислили значення для рядків: ${p.computed}, а записали: ${p.written}. Транзакцію відкочено`,
    hint: {
      en: "Nothing was written. Every computed row is written once by its key; a different count is a defect of the plan, so report it to the platform maintainers.",
      uk: "Нічого не записано. Кожен обчислений рядок записується один раз за ключем; інша кількість — дефект плану, тож повідомте про нього супровідникам платформи.",
    },
  },
  "plan.temp-name-taken": {
    en: (p) =>
      `The promotion renames through temporary names simetra_tmp_<n> and simetra_retired_<n>, and these objects already carry such a name: ${p.names}. No plan was written`,
    uk: (p) =>
      `Промоція перейменовує через тимчасові імена simetra_tmp_<n> і simetra_retired_<n>, а ці об'єкти вже носять таке ім'я: ${p.names}. План не записано`,
    hint: {
      en: "Rename these objects on the target so that no name matches simetra_tmp_<n> or simetra_retired_<n>, then plan again.",
      uk: "Перейменуйте ці об'єкти на цілі так, щоб жодне ім'я не мало вигляду simetra_tmp_<n> чи simetra_retired_<n>, і сплануйте знову.",
    },
  },
  "plan.data-step-volatile": {
    en: (p) =>
      `Data step ${p.step} of the promotion calls ${p.function}, which on the target is not IMMUTABLE in every overload, returns a set or does not exist, so the computed values would not be deterministic`,
    uk: (p) =>
      `Крок даних ${p.step} промоції викликає ${p.function}, яка на цілі не IMMUTABLE в кожному перевантаженні, повертає множину чи відсутня, тож обчислені значення не були б детермінованими`,
    hint: {
      en: "No plan was written. Rewrite the fill expression with functions that are IMMUTABLE on the target, or make the model function IMMUTABLE there first; only the transaction time functions are allowed outside a repair.",
      uk: "План не записано. Перепишіть вираз fill функціями, що на цілі IMMUTABLE, або спершу зробіть функцію моделі там IMMUTABLE; поза ремонтом дозволено лише функції часу транзакції.",
    },
  },
  "plan.data-step-function-changed": {
    en: (p) =>
      p.detail === "unproven"
        ? `Data step ${p.step} of the promotion calls the model function ${p.function}, and plan step ${p.by} uses it in a statement whose object the plan cannot determine, so it cannot prove the function stays unchanged before the data steps compute with it`
        : `Data step ${p.step} of the promotion calls the model function ${p.function}, which this plan creates, changes or drops${p.by === undefined ? "" : ` (step ${p.by})`}, while the data steps run before the engine steps and would compute with the old body`,
    uk: (p) =>
      p.detail === "unproven"
        ? `Крок даних ${p.step} промоції викликає функцію моделі ${p.function}, а крок плану ${p.by} вживає її в операторі, предмета якого план не визначає, тож не доведе, що функція не зміниться до обчислення кроків даних`
        : `Крок даних ${p.step} промоції викликає функцію моделі ${p.function}, яку цей план створює, змінює чи знищує${p.by === undefined ? "" : ` (крок ${p.by})`}, а кроки даних ідуть до кроків двигуна й рахували б старим тілом`,
    hint: {
      en: "No plan was written. Apply the change of the function first, then plan the promotion.",
      uk: "План не записано. Спершу застосуйте зміну функції, потім сплануйте промоцію.",
    },
  },
  "plan.temp-privilege": {
    en: (p) =>
      `The promotion's data steps compute values in temporary tables, and role ${p.role} has no TEMP privilege on the target database`,
    uk: (p) =>
      `Кроки даних промоції обчислюють значення в тимчасових таблицях, а роль ${p.role} не має права TEMP на базу цілі`,
    hint: {
      en: "No plan was written. Grant TEMP on the database to the applying role, then plan again.",
      uk: "План не записано. Надайте ролі застосування право TEMP на базу й сплануйте знову.",
    },
  },
  "plan.replication-role": {
    en: (p) =>
      `The target session runs with session_replication_role = ${p.value}, and the promotion's data steps need origin: otherwise foreign key triggers do not fire and the written values bypass the reference checks`,
    uk: (p) =>
      `Сесія цілі має session_replication_role = ${p.value}, а кроки даних промоції потребують origin: інакше тригери зовнішніх ключів не спрацьовують, і записані значення обходять перевірку посилань`,
    hint: {
      en: "No plan was written. Remove the session_replication_role setting of the database or the role (ALTER DATABASE … RESET / ALTER ROLE … RESET), then plan again.",
      uk: "План не записано. Зніміть налаштування session_replication_role бази чи ролі (ALTER DATABASE … RESET / ALTER ROLE … RESET) і сплануйте знову.",
    },
  },
  "plan.preservation-type": {
    en: (p) =>
      `The preservation measure casts ${p.column} to its new type ${p.type} before any step, and ${p.detail === "missing" ? "that type does not exist on the target before the plan" : p.detail === "unparsed" ? "the plan cannot name that type as a schema and a type to check it on the target" : p.detail === "changed" ? `step ${p.by} of the plan creates, changes or drops that type` : `step ${p.by} of the plan uses that type in a statement whose object the plan cannot determine, so the plan cannot prove it unchanged`}`,
    uk: (p) =>
      `Замір збереження приводить ${p.column} до нового типу ${p.type} до будь-якого кроку, а ${p.detail === "missing" ? "цього типу на цілі до плану немає" : p.detail === "unparsed" ? "план не називає цей тип схемою й типом, щоб перевірити його на цілі" : p.detail === "changed" ? `крок плану ${p.by} створює, змінює чи знищує цей тип` : `крок плану ${p.by} вживає цей тип в операторі, предмета якого план не визначає, тож план не доведе, що тип не зміниться`}`,
    hint: {
      en: "No plan was written. Create or change the type in a separate, earlier apply, then plan the promotion.",
      uk: "План не записано. Створіть чи змініть тип окремим попереднім застосуванням, потім сплануйте промоцію.",
    },
  },
  "plan.unparsable-step": {
    en: (p) =>
      `The schema engine produced plan step ${p.step} that the SQL parser cannot read: ${p.message}`,
    uk: (p) =>
      `Двигун схеми видав крок плану ${p.step}, який SQL-парсер не читає: ${p.message}`,
    hint: {
      en: "No plan was written. Without a parse tree the step cannot be classified or checked for CASCADE; report the step to the platform maintainers.",
      uk: "План не записано. Без дерева розбору крок не класифікувати й не перевірити на CASCADE; повідомте про крок супровідникам платформи.",
    },
  },
  "plan.clone-mismatch": {
    en: (p) =>
      `The copy of the database for the proof does not match the database (${p.how}): ${p.detail}`,
    uk: (p) =>
      `Копія бази для доказу не збігається з базою (${p.how}): ${p.detail}`,
    hint: {
      en: "No plan was written. The schema engine cannot reproduce part of the current database, so the plan cannot be proved; bring the named objects to a form the engine models, or fix the drift by hand and plan again.",
      uk: "План не записано. Двигун схеми не відтворює частину поточної бази, тож план не довести; приведіть названі об'єкти до форми, яку двигун моделює, або виправте дрейф вручну й сплануйте знову.",
    },
  },
  "plan.proof-not-empty": {
    en: (p) =>
      `After the proof run the copy still differs from the desired state: ${p.count} engine action(s) remain, the first is \`${p.first}\``,
    uk: (p) =>
      `Після прогону-доказу копія все ще відрізняється від бажаного стану: лишилось дій двигуна — ${p.count}, перша — \`${p.first}\``,
    hint: {
      en: "No plan was written. The plan does not bring the database to the desired state; if the database drifted, fix the drift by hand and plan again, otherwise report the plan.",
      uk: "План не записано. План не приводить базу до бажаного стану; якщо база дрейфнула, виправте дрейф вручну й сплануйте знову, інакше повідомте про план.",
    },
  },
  "plan.fingerprint-disagrees": {
    en: (p) =>
      `After the proof run the catalog fingerprint of the copy differs from the desired state; sections: ${p.sections}`,
    uk: (p) =>
      `Після прогону-доказу відбиток каталогу копії відрізняється від бажаного стану; секції: ${p.sections}`,
    hint: {
      en: "No plan was written. The plan steps do not reach what the fingerprint sees; if the database drifted in these sections, fix the drift by hand and plan again, otherwise report the plan.",
      uk: "План не записано. Кроки плану не досягають того, що бачить відбиток; якщо база дрейфнула в цих секціях, виправте дрейф вручну й сплануйте знову, інакше повідомте про план.",
    },
  },
  "plan.schema-only-proof": {
    en: () =>
      "The proof ran on a copy without data: it shows the schema converges, not that existing rows satisfy new constraints. Rehearse with `apply --rehearse` or rely on the atomic rollback of apply.",
    uk: () =>
      "Доказ виконано на копії без даних: він показує, що схема сходиться, а не що наявні рядки задовольняють нові обмеження. Відрепетируйте через `apply --rehearse` або покладіться на атомарний відкат застосування.",
  },
  "plan.owner-mismatch": {
    en: (p) =>
      `${p.count} object(s) are owned by a role other than the one that applies, so the plan cannot manage them: ${p.objects}`,
    uk: (p) =>
      `Об'єктів, якими володіє не роль, що застосовує, тож план не може ними керувати: ${p.count}: ${p.objects}`,
    hint: {
      en: `No plan was written. Managed objects belong to the role that applies: another owner can bypass row level security, and an object the plan drops or alters needs an owner the applying role is a member of. ${OWNER_RECIPE.en}, and plan again.`,
      uk: `План не записано. Керовані об'єкти належать ролі, що застосовує: інший власник може обходити захист рядків, а об'єкт, який план знімає чи змінює, потребує власника, членом якого є роль застосування. ${OWNER_RECIPE.uk} й сплануйте знову.`,
    },
  },
  "plan.platform-role-missing": {
    en: (p) =>
      `The platform role ${p.role} that the generated SQL grants to does not exist on the ${p.server} server`,
    uk: (p) =>
      `Платформної ролі ${p.role}, якій згенерований SQL дає гранти, немає на сервері ${p.server === "shadow" ? "тіні" : "цілі"}`,
    hint: {
      en: "Nothing was planned or created. Platform roles live in the cluster, not in the database, so plan and apply do not create them: run `simetra roles` once with a role that has CREATEROLE, and run the command again.",
      uk: "Нічого не сплановано й не створено. Платформні ролі живуть у кластері, а не в базі, тож план і застосування їх не створюють: один раз запустіть `simetra roles` від ролі з CREATEROLE і повторіть команду.",
    },
  },
  "plan.platform-role-shape": {
    en: (p) =>
      `The platform role ${p.role} on the ${p.server} server has an unsafe shape (${p.violation}): it must be NOLOGIN NOINHERIT with no other attribute, belong to no role, and its members may only administer it`,
    uk: (p) =>
      `Платформна роль ${p.role} на сервері ${p.server === "shadow" ? "тіні" : "цілі"} має небезпечну форму (${p.violation}): вона мусить бути NOLOGIN NOINHERIT без інших атрибутів, ні в що не входити, а її члени можуть лише керувати нею`,
    hint: {
      en: "Nothing was planned or created. `simetra roles` does not change an existing role: fix it by hand with `ALTER ROLE <role> NO<attribute>` for an attribute, or `REVOKE <role> FROM <member>` (or revoke the role it belongs to) for a membership, and run the command again.",
      uk: "Нічого не сплановано й не створено. `simetra roles` наявну роль не змінює: виправте її вручну — `ALTER ROLE <роль> NO<атрибут>` для атрибута чи `REVOKE <роль> FROM <член>` (або відкличте роль, у яку вона входить) для членства — і повторіть команду.",
    },
  },
  "plan.type-guard-unsupported": {
    en: (p) =>
      p.reason === "equality"
        ? `Plan step ${p.step} changes the type of a column whose old type has no equality operator, so the platform cannot compare the values before and after the change`
        : `Plan step ${p.step} changes a column type in a way the platform cannot check for lost values (${p.reason})`,
    uk: (p) =>
      p.reason === "equality"
        ? `Крок плану ${p.step} змінює тип колонки, старий тип якої не має оператора рівності, тож платформа не може порівняти значення до й після зміни`
        : `Крок плану ${p.step} змінює тип колонки так, що платформа не може перевірити втрату значень (${p.reason})`,
    hint: {
      en: (p) =>
        p.reason === "equality"
          ? "No plan was written. A type such as json has no equality, so the check cannot tell whether values survive; move the column to a comparable type (for example jsonb or text) through a data step first, then change the type."
          : "No plan was written. The check needs a plain `<column>::<new type>` conversion, an old type the plan can see and a cast both ways between the types; make the change through a data step instead.",
      uk: (p) =>
        p.reason === "equality"
          ? "План не записано. Тип на кшталт json не має рівності, тож перевірка не скаже, чи збереглися значення; спершу переведіть колонку в порівнюваний тип (наприклад, jsonb чи text) кроком даних, потім змініть тип."
          : "План не записано. Перевірці потрібне просте приведення `<колонка>::<новий тип>`, видимий планові старий тип і приведення між типами в обидва боки; зробіть зміну кроком даних.",
    },
  },
  "plan.type-change-dependent": {
    en: (p) =>
      `The plan changes the type of a column that these objects depend on, and the schema engine does not rebuild them: ${p.objects}`,
    uk: (p) =>
      `План змінює тип колонки, від якої залежать ці об'єкти, а двигун схеми їх не перебудовує: ${p.objects}`,
    hint: {
      en: "No plan was written. A trigger WHEN condition or UPDATE OF list and a BEGIN ATOMIC function block a column type change; drop them in one metadata change and create them again after the type change in the next.",
      uk: "План не записано. Умова WHEN чи перелік UPDATE OF тригера й функція BEGIN ATOMIC блокують зміну типу колонки; зніміть їх однією зміною метаданих і створіть знову після зміни типу наступною.",
    },
  },
  "plan.promotion-record-missing": {
    en: (p) =>
      `${p.kind} ${p.name} (${p.objectId}) was a CustomTable when the target was last applied: the plan is a promotion, and its record plans/${p.objectId}.promotion.json is missing`,
    uk: (p) =>
      `${p.kind} ${p.name} (${p.objectId}) був CustomTable під час останнього застосування цілі: план — промоція, а її запису plans/${p.objectId}.promotion.json немає`,
    hint: {
      en: "No plan was written. The record carries what the database cannot derive (which adopted column becomes which attribute, the conversion classes); restore the file written by promote from version control, or check out the commit of the promotion.",
      uk: "План не записано. Запис несе те, чого не вивести з бази (яка прийнята колонка стає яким реквізитом, класи конверсій); відновіть файл, записаний promote, з контролю версій або перейдіть на коміт промоції.",
    },
  },
  "plan.promotion-record-invalid": {
    en: (p) => `The promotion record ${p.file} is not valid: ${p.detail}`,
    uk: (p) => `Запис промоції ${p.file} невалідний: ${p.detail}`,
    hint: {
      en: "No plan was written. A record is never repaired by guessing; restore the file written by promote, or promote again on the state before the promotion.",
      uk: "План не записано. Запис ніколи не виправляється вгадуванням; відновіть файл, записаний promote, або повторіть промоцію на стані до неї.",
    },
  },
  "plan.promotion-base": {
    en: (p) =>
      `The promotion record ${p.file} was written for model ${p.base}, but the target was last applied with model ${p.marker}`,
    uk: (p) =>
      `Запис промоції ${p.file} написано для моделі ${p.base}, а ціль востаннє застосовано з моделлю ${p.marker}`,
    hint: {
      en: "No plan was written. A promotion is applied exactly on the state it was made from: apply the commit before the promotion first, then plan the promotion.",
      uk: "План не записано. Промоція застосовується рівно на стані, з якого її зроблено: спершу застосуйте коміт до промоції, потім сплануйте промоцію.",
    },
  },
  "plan.promotion-record-mismatch": {
    en: (p) =>
      p.detail === "dataSteps"
        ? `The promotion record ${p.file} has data step ${p.step} that does not match the record and the desired state: ${p.reason}`
        : `The promotion record ${p.file} does not match what the models before and after the promotion show: ${p.detail}`,
    uk: (p) =>
      p.detail === "dataSteps"
        ? `Запис промоції ${p.file} має крок даних ${p.step}, що не збігається із записом і бажаним станом: ${p.reason}`
        : `Запис промоції ${p.file} не збігається з тим, що показують моделі до й після промоції: ${p.detail}`,
    hint: {
      en: "No plan was written. Either the record was edited, or a later commit changed the promoted object; apply the promotion on its own commit, then plan the later changes.",
      uk: "План не записано. Або запис змінено вручну, або пізніший коміт змінив промотований об'єкт; застосуйте промоцію на її коміті, потім сплануйте пізніші зміни.",
    },
  },
  "plan.promotion-record-stale": {
    en: (p) =>
      `The promotion record ${p.file} does not fit the state of object ${p.objectId} in the target and in the metadata`,
    uk: (p) =>
      `Запис промоції ${p.file} не відповідає стану об'єкта ${p.objectId} у цілі й у метаданих`,
    hint: {
      en: "No plan was written. The promotion it describes was reverted or never reached this state; remove the record if the promotion is abandoned, or restore the metadata of the promotion.",
      uk: "План не записано. Промоцію, яку він описує, скасовано або вона не дійшла до цього стану; приберіть запис, якщо від промоції відмовились, або відновіть метадані промоції.",
    },
  },
  "plan.promotion-needs-marker": {
    en: (p) =>
      `The target has no apply state, but table ${p.table} that the promotion record ${p.file} adopts already exists`,
    uk: (p) =>
      `Ціль не має стану застосування, а таблиця ${p.table}, яку приймає запис промоції ${p.file}, уже існує`,
    hint: {
      en: "No plan was written. Without the state before the promotion the plan cannot prove the live table is the adopted one; apply the state before the promotion first, then plan the promotion.",
      uk: "План не записано. Без стану до промоції план не доведе, що жива таблиця — та сама прийнята; спершу застосуйте стан до промоції, потім сплануйте промоцію.",
    },
  },
  "plan.promotion-multiple": {
    en: (p) => `One plan cannot carry more than one promotion: ${p.objects}`,
    uk: (p) => `Один план не несе більше однієї промоції: ${p.objects}`,
    hint: {
      en: "No plan was written. Apply the promotions one at a time, each on its own commit.",
      uk: "План не записано. Застосовуйте промоції по одній, кожну на її коміті.",
    },
  },
  "plan.promotion-unsupported": {
    en: (p) =>
      p.reason === "labelTranslation"
        ? `The promotion record ${p.file} translates kind labels, which plans support from P3-3 on`
        : p.reason === "sequenceSchema"
          ? `Column ${p.column} of ${p.table} in the promotion ${p.file} depends on the sequence ${p.sequence} outside the table's schema, so the plan would recreate the sequence and reset its counter`
          : p.reason === "dataStepTable"
            ? p.detail === "rule"
              ? `Table ${p.table} of data step ${p.step} in the promotion ${p.file} has an UPDATE rewrite rule, which would run other statements beside or instead of the update of the data steps, so the write could not prove the rows it wrote`
              : `Table ${p.table} of data step ${p.step} in the promotion ${p.file} has inheritance children or is partitioned, so one update and its preservation measure would cover different rows`
            : p.reason === "dataStepType"
              ? p.detail === "oldType"
                ? `Data step ${p.step} in the promotion ${p.file} fills ${p.column} of ${p.table}, whose type also changes, and the old type ${p.type} is not an unbounded string type, so the value written before the change could be rounded silently`
                : p.detail === "cast"
                  ? `The value of data step ${p.step} in the promotion ${p.file} cannot be cast to ${p.type}, the type of ${p.column} of ${p.table} at the write`
                  : p.detail === "unparsed"
                    ? `Data step ${p.step} in the promotion ${p.file} writes ${p.column} of ${p.table} in type ${p.type}, which the plan cannot name as a schema and a type, so it cannot check that the type exists on the target`
                    : `Data step ${p.step} in the promotion ${p.file} writes ${p.column} of ${p.table} in type ${p.type}, which ${p.detail === "changed" ? `step ${p.by} of the plan creates, changes or drops` : p.detail === "unproven" ? `step ${p.by} of the plan uses in a statement whose object the plan cannot determine, so the plan cannot prove it unchanged` : "does not exist on the target before the plan"}, while the data steps run before the engine steps`
              : p.reason === "dataStepKey"
                ? `Data step ${p.step} in the promotion ${p.file} addresses rows of ${p.table} by ${p.key}, which ${p.detail === "notPrimaryKey" ? "is not the single-column primary key of the table" : p.detail === "retired" ? "is retired" : p.detail === "fillTarget" ? "is itself a fill target" : "changes its type"}`
                : p.reason === "dataStepReferenced"
                  ? `Data step ${p.step} in the promotion ${p.file} changes ${p.column} of ${p.table}, which a foreign key references with ON UPDATE CASCADE, SET NULL or SET DEFAULT, so rows of other tables would change outside the preservation proof`
                  : `Table ${p.table} of the promotion ${p.file} has no primary key, so the plan cannot prove that rows keep their values`,
    uk: (p) =>
      p.reason === "labelTranslation"
        ? `Запис промоції ${p.file} перекладає мітки виду, які план підтримує з П3-3`
        : p.reason === "sequenceSchema"
          ? `Колонка ${p.column} таблиці ${p.table} промоції ${p.file} залежить від послідовності ${p.sequence} поза схемою таблиці, тож план перестворив би послідовність і скинув би її лічильник`
          : p.reason === "dataStepTable"
            ? p.detail === "rule"
              ? `Таблиця ${p.table} кроку даних ${p.step} промоції ${p.file} має правило перезапису UPDATE, яке виконало б інші оператори поряд з оновленням кроків даних чи замість нього, тож запис не довів би записані рядки`
              : `Таблиця ${p.table} кроку даних ${p.step} промоції ${p.file} має нащадків за успадкуванням чи партиціонована, тож один запис і його замір збереження охопили б різні рядки`
            : p.reason === "dataStepType"
              ? p.detail === "oldType"
                ? `Крок даних ${p.step} промоції ${p.file} заповнює ${p.column} таблиці ${p.table}, тип якої теж змінюється, а старий тип ${p.type} — не рядковий тип без межі, тож значення, записане до зміни, могло б мовчки округлитися`
                : p.detail === "cast"
                  ? `Значення кроку даних ${p.step} промоції ${p.file} не приводиться до ${p.type} — типу ${p.column} таблиці ${p.table} на момент запису`
                  : p.detail === "unparsed"
                    ? `Крок даних ${p.step} промоції ${p.file} пише ${p.column} таблиці ${p.table} у типі ${p.type}, якого план не називає схемою й типом, тож не перевірить, що тип є на цілі`
                    : `Крок даних ${p.step} промоції ${p.file} пише ${p.column} таблиці ${p.table} у типі ${p.type}, який ${p.detail === "changed" ? `крок плану ${p.by} створює, змінює чи знищує` : p.detail === "unproven" ? `крок плану ${p.by} вживає в операторі, предмета якого план не визначає, тож план не доведе, що тип не зміниться` : "відсутній на цілі до плану"}, а кроки даних ідуть до кроків двигуна`
              : p.reason === "dataStepKey"
                ? `Крок даних ${p.step} промоції ${p.file} адресує рядки ${p.table} за ${p.key}, який ${p.detail === "notPrimaryKey" ? "не є одноколонковим первинним ключем таблиці" : p.detail === "retired" ? "виводиться з ужитку" : p.detail === "fillTarget" ? "сам є ціллю fill" : "змінює тип"}`
                : p.reason === "dataStepReferenced"
                  ? `Крок даних ${p.step} промоції ${p.file} змінює ${p.column} таблиці ${p.table}, на яку посилається зовнішній ключ з ON UPDATE CASCADE, SET NULL чи SET DEFAULT, тож рядки інших таблиць змінилися б поза доказом збереження`
                  : `Таблиця ${p.table} промоції ${p.file} не має первинного ключа, тож план не доведе, що рядки зберегли значення`,
    hint: {
      en: (p) =>
        p.reason === "sequenceSchema"
          ? "No plan was written. Move the sequence into the schema of the table or remove the dependency before promoting."
          : p.reason === "dataStepTable"
            ? p.detail === "rule"
              ? "No plan was written. Drop the UPDATE rule of the table before promoting, or promote this table without data steps."
              : "No plan was written. Promote this table without data steps."
            : p.reason === "dataStepType"
              ? p.detail === "cast"
                ? "No plan was written. Cast the fill expression explicitly to the type of the column."
                : p.detail === "unparsed"
                  ? "No plan was written. Give the column a type the plan can name: a type name, optionally qualified with its schema, with modifiers or array bounds if needed; or promote without a data step on this column."
                  : "No plan was written. Apply the change of the type first (a plan of its own), then promote."
              : p.reason === "dataStepKey"
                ? "No plan was written. A data step addresses rows by the single-column primary key of the table, which keeps its name meaning and type through the promotion."
                : p.reason === "dataStepReferenced"
                  ? "No plan was written. Drop the cascading update of the referencing foreign key, or promote without a step on this column."
                  : "No plan was written. Promote without this part, or wait for the platform version that supports it; a table needs a primary key before it is promoted.",
      uk: (p) =>
        p.reason === "sequenceSchema"
          ? "План не записано. Перенесіть послідовність у схему таблиці або зніміть залежність перед промоцією."
          : p.reason === "dataStepTable"
            ? p.detail === "rule"
              ? "План не записано. Зніміть правило UPDATE таблиці перед промоцією або промотуйте цю таблицю без кроків даних."
              : "План не записано. Промотуйте цю таблицю без кроків даних."
            : p.reason === "dataStepType"
              ? p.detail === "cast"
                ? "План не записано. Приведіть вираз fill явно до типу колонки."
                : p.detail === "unparsed"
                  ? "План не записано. Дайте колонці тип, який план може назвати: ім'я типу, за потреби кваліфіковане схемою, з модифікаторами чи межами масиву, коли треба; або промотуйте без кроку даних на цю колонку."
                  : "План не записано. Спершу застосуйте зміну типу окремим планом, потім промотуйте."
              : p.reason === "dataStepKey"
                ? "План не записано. Крок даних адресує рядки одноколонковим первинним ключем таблиці, який зберігає зміст і тип через промоцію."
                : p.reason === "dataStepReferenced"
                  ? "План не записано. Зніміть каскадне оновлення зовнішнього ключа, що посилається, або промотуйте без кроку на цю колонку."
                  : "План не записано. Промотуйте без цієї частини або дочекайтеся версії платформи, що її підтримує; таблиці потрібен первинний ключ до промоції.",
    },
  },
  "plan.promotion-applied": {
    en: (p) =>
      `The promotion record ${p.file} is already applied to this target and is ignored`,
    uk: (p) =>
      `Запис промоції ${p.file} уже застосовано до цієї цілі, його проігноровано`,
    hint: {
      en: "The file stays in plans/ until every instance has applied it.",
      uk: "Файл лишається в plans/, доки його не застосують усі інстанси.",
    },
  },
  "plan.promotion-not-applicable": {
    en: (p) =>
      `The promotion record ${p.file} does not apply to this target: object ${p.objectId} was never an adopted table here, and it is ignored`,
    uk: (p) =>
      `Запис промоції ${p.file} не стосується цієї цілі: об'єкт ${p.objectId} тут ніколи не був прийнятою таблицею, його проігноровано`,
    hint: {
      en: "A new environment gets the promoted object directly; the record matters only to instances that hold the adopted table.",
      uk: "Нове середовище отримує промотований об'єкт одразу; запис важить лише для інстансів, які мають прийняту таблицю.",
    },
  },
  "plan.rename-not-realized": {
    en: (p) =>
      `The schema engine plan would drop or lose data of tables or columns that the promotion renames: ${p.objects}`,
    uk: (p) =>
      `План двигуна схеми знищив би чи втратив би дані таблиць або колонок, які перейменовує промоція: ${p.objects}`,
    hint: {
      en: "No plan was written. The promotion renames these objects before the engine compares the states, so the engine should keep them; the record and the desired state disagree. Promote again on the state before the promotion, or report the plan output as a platform defect.",
      uk: "План не записано. Промоція перейменовує ці об'єкти до того, як двигун порівнює стани, тож двигун мав би їх зберегти; запис і бажаний стан розходяться. Повторіть промоцію на стані до неї або повідомте вивід плану як дефект платформи.",
    },
  },
  "plan.removal-unclassified": {
    en: (p) =>
      `The promotion removes or redefines objects of the adopted tables that no conversion class covers: ${p.paths}`,
    uk: (p) =>
      `Промоція знімає чи перевизначає об'єкти прийнятих таблиць, яких не покриває жоден клас конверсії: ${p.paths}`,
    hint: {
      en: "No plan was written. Every adopted constraint, index, default, comment, policy or grant that disappears needs a conversion class in promote; give it one, or keep the object. An adopted primary key must match the kind's key, and the identity, generated expression or collation of a column cannot change in a promotion.",
      uk: "План не записано. Кожне прийняте обмеження, індекс, значення за замовчуванням, коментар, політика чи грант, що зникає, потребує класу конверсії в promote; призначте його або збережіть об'єкт. Прийнятий первинний ключ мусить збігатися з ключем виду, а identity, вираз генерованої колонки чи колляція колонки в промоції не змінюються.",
    },
  },
  "plan.platform-replacement-missing": {
    en: (p) =>
      `The promotion gives the class platform to adopted objects that the desired state has no replacement for: ${p.objects}`,
    uk: (p) =>
      `Промоція дає клас platform прийнятим об'єктам, яким бажаний стан не має заміни: ${p.objects}`,
    hint: {
      en: "No plan was written. The class platform means the kind replaces the adopted object: an equivalent index or constraint on the same table, a foreign key with the same columns, target, MATCH and deferrability (only RESTRICT and NO ACTION may swap), a Ref to an enumeration for a CHECK value list, or a unit of the same class on the same table. Generated grants and read policies replace only equal grants and permissive policies of the same command; triggers are replaced only by a subscription trigger with the same handler, timing, level, events and condition columns, or by the row mechanics for moddatetime; register keys are not generated yet. Give such an object the class removed (it then needs the remove: permission) or keep the table adopted.",
      uk: "План не записано. Клас platform означає, що вид заміняє прийнятий об'єкт: еквівалентним індексом чи обмеженням на тій самій таблиці, FK з тими самими колонками, ціллю, MATCH і відкладеністю (міняються місцями лише RESTRICT і NO ACTION), Ref на перерахування для переліку значень у CHECK або одиницею того самого класу на тій самій таблиці. Згенеровані гранти й політики читання замінюють лише рівні гранти й permissive-політики тієї самої команди; тригер замінюють лише тригер підписки з тим самим обробником, часом, рівнем, подіями й колонками умови або механіка рядка замість moddatetime; ключів регістрів ще немає. Дайте такому об'єкту клас removed (тоді потрібен дозвіл remove:) або лишіть таблицю прийнятою.",
    },
  },
  "plan.property-not-reproduced": {
    en: (p) =>
      `The promotion gives the class property to the adopted ${p.object} of ${p.subject}, but the desired state does not recreate it equivalently: ${p.detail}`,
    uk: (p) =>
      `Промоція дає клас property прийнятому об'єкту ${p.object} предмета ${p.subject}, але бажаний стан не відтворює його еквівалентно: ${p.detail}`,
    hint: {
      en: "No plan was written. The class property means the kind recreates the adopted element equivalently on the same table: the same columns, expression, predicate, NULLS NOT DISTINCT and deferrability. The record, a later metadata change or a hand edit broke that. Give the element the class removed in promote (it then needs the remove: permission) or make the kind recreate it equivalently.",
      uk: "План не записано. Клас property означає, що вид відтворює прийнятий елемент еквівалентно на тій самій таблиці: ті самі колонки, вираз, предикат, NULLS NOT DISTINCT і відкладеність. Запис, пізніша зміна метаданих чи ручна правка це порушили. Дайте елементу клас removed у promote (тоді потрібен дозвіл remove:) або зробіть так, щоб вид відтворював його еквівалентно.",
    },
  },
  "plan.write-path": {
    en: (p) =>
      `The adopted tables ${p.table} of the promotion are writable through the API on the target (${p.detail}), and the write path after promotion is an open question`,
    uk: (p) =>
      `Прийняті таблиці ${p.table} промоції доступні на запис через API на цілі (${p.detail}), а шлях запису після промоції — відкрите питання`,
    hint: {
      en: 'No plan was written. Revoke the write privileges, default privileges or write policies on the target and plan again; see the open question "Write path after promotion" in the promotion spec.',
      uk: "План не записано. Відкличте привілеї запису, типові привілеї чи політики запису на цілі й побудуйте план знову; див. відкрите питання «Шлях запису після промоції» у спеці промоції.",
    },
  },
  // Попередження, не відмова: читання сервісним ключем вид свідомо не дає
  // (спека промоції §8 «Сервісна роль»), а запис зупиняє `plan.write-path`
  "plan.service-role-access-lost": {
    en: (p) =>
      `Server code using the service key loses access to ${p.tables}: after promotion the service role has no privileges on kind tables`,
    uk: (p) =>
      `Серверний код на сервісному ключі втрачає доступ до ${p.tables}: після промоції сервісна роль не має привілеїв на таблицях виду`,
    hint: {
      en: "If server code reads or writes these tables with the service key, keep them CustomTable until platform commands (P4).",
      uk: "Якщо серверний код читає чи пише ці таблиці сервісним ключем, лишіть їх CustomTable до команд платформи (П4).",
    },
  },
  "plan.provider-trigger-taken": {
    en: (p) =>
      `Trigger ${p.trigger} on ${p.table} already exists and was not created by Simetra; the generated trigger would silently replace it`,
    uk: (p) =>
      `Тригер ${p.trigger} на ${p.table} уже є і створений не Simetra; згенерований тригер тихо замінив би його`,
    hint: {
      en: "No plan was written. Rename or drop the existing trigger; for a subscription, another physicalName also works.",
      uk: "План не записано. Перейменуйте чи зніміть наявний тригер; підписці можна й дати інший physicalName.",
    },
  },
  "plan.numbering-not-generated": {
    en: (p) =>
      `${p.object} (${p.table}) numbers rows on first write, but counters are not generated yet: the number stays empty`,
    uk: (p) =>
      `${p.object} (${p.table}) нумерує рядки першим записом, але лічильники ще не генеруються: номер лишиться порожнім`,
    hint: {
      en: "If the object needs no number, set autonumber: false, or codeLength: 0 for a catalog; otherwise the number stays empty until the platform generates counters.",
      uk: "Якщо номер об'єкту не потрібен, задайте autonumber: false, а довіднику — codeLength: 0; інакше номер лишатиметься порожнім, доки платформа не генерує лічильників.",
    },
  },
  // Попередження, не відмова: заміна законна (рішення 6 плану П3-3a2), але
  // тригер звужується, і автор має це побачити
  "plan.update-of-narrowed": {
    en: (p) =>
      `Trigger ${p.trigger} on ${p.table} fired on UPDATE OF ${p.columns}; the subscription fires only when a value actually changes`,
    uk: (p) =>
      `Тригер ${p.trigger} на ${p.table} спрацьовував на UPDATE OF ${p.columns}; підписка спрацьовує лише на справжню зміну значення`,
    hint: {
      en: "Review the handler: an UPDATE that writes the current values into these columns no longer runs it.",
      uk: "Перевірте обробник: UPDATE, що записує в ці колонки їхні поточні значення, його більше не запускає.",
    },
  },
  // `services` — таблиці провайдера, які займає сам провайдер для оператора
  // кроку (R27 плану П3-2a): одне попередження на крок з переліком таблиць
  "plan.foreign-exclusive-lock": {
    en: (p) =>
      p.services === undefined
        ? `Step ${p.step} takes ACCESS EXCLUSIVE on ${p.table}, a table outside the managed schemas: every read of it is blocked until the apply transaction ends`
        : `Step ${p.step} makes the provider take ACCESS EXCLUSIVE on its tables ${p.table}: ${p.services} stall until the apply transaction ends`,
    uk: (p) =>
      p.services === undefined
        ? `Крок ${p.step} бере ACCESS EXCLUSIVE на ${p.table} — таблиці поза керованими схемами: кожне її читання заблоковане до кінця транзакції застосування`
        : `Через крок ${p.step} провайдер бере ACCESS EXCLUSIVE на своїх таблицях ${p.table}: ${p.services} стоять до кінця транзакції застосування`,
    hint: {
      en: (p) =>
        p.services === undefined
          ? "Apply when the services that read this table can wait, or split the change so that this step goes alone."
          : "The provider takes these locks for policy and trigger statements of the applying role. Apply when these services can wait, or split the change so that policy and trigger changes go alone.",
      uk: (p) =>
        p.services === undefined
          ? "Застосовуйте, коли сервіси, що читають цю таблицю, можуть зачекати, або розділіть зміну, щоб цей крок ішов окремо."
          : "Провайдер бере ці замки для операторів політик і тригерів ролі, що застосовує. Застосовуйте, коли ці служби можуть зачекати, або розділіть зміну, щоб зміни політик і тригерів ішли окремо.",
    },
  },
  "plan.plpgsql-check-unavailable": {
    en: (p) =>
      p.on === "copy"
        ? `plpgsql_check could not be taken on the copy of the database for the proof (SQLSTATE ${p.sqlstate}: ${p.error}), so the proof did not check plpgsql function bodies with it`
        : "plpgsql_check is not available on the database: it is not installed for the applying role, and the role cannot install it, so function bodies are checked by the language validators only",
    uk: (p) =>
      p.on === "copy"
        ? `plpgsql_check не вдалося взяти на копії бази для доказу (SQLSTATE ${p.sqlstate}: ${p.error}), тож доказ не перевірив ним тіла plpgsql-функцій`
        : "plpgsql_check недоступне в базі: воно не встановлене для ролі застосування, і роль не може його поставити, тож тіла функцій перевіряють лише валідатори мов",
    hint: {
      en: (p) =>
        p.on === "copy"
          ? "A promotion requires plpgsql_check and is refused without it; another plan only warns. The copy lives on the server of the proof copies (shadowBase when it is set): make plpgsql_check available there for the applying role, or use a server that has it, then plan again."
          : "A promotion requires plpgsql_check and is refused without it; another plan only warns. Install plpgsql_check on the database (or let the applying role install it), then plan again.",
      uk: (p) =>
        p.on === "copy"
          ? "Промоція вимагає plpgsql_check і без нього відхиляється; інший план лише попереджає. Копія живе на сервері копій доказу (shadowBase, коли його задано): зробіть там plpgsql_check доступним для ролі застосування чи візьміть сервер, де воно є, і сплануйте знову."
          : "Промоція вимагає plpgsql_check і без нього відхиляється; інший план лише попереджає. Поставте plpgsql_check у базі (чи дозвольте ролі застосування його ставити) і сплануйте знову.",
    },
  },
  "database.failed": {
    en: (p) =>
      `The ${p.tool} call to the database at ${p.database} failed (${p.error}${p.sqlstate === undefined ? "" : `, SQLSTATE ${p.sqlstate}`}). Nothing was written.`,
    uk: (p) =>
      `Виклик ${p.tool} до бази ${p.database} не вдався (${p.error}${p.sqlstate === undefined ? "" : `, SQLSTATE ${p.sqlstate}`}). Нічого не записано.`,
    hint: {
      en: "The connection itself worked; the failure happened during the database work. The text of the driver error is withheld because it may carry credentials; look up the SQLSTATE, or rerun after fixing the database.",
      uk: "Саме підключення вдалося; збій стався під час роботи з базою. Текст помилки драйвера приховано, бо він може нести облікові дані; знайдіть SQLSTATE або повторіть після виправлення бази.",
    },
  },
  "roles.create-role-denied": {
    en: (p) =>
      `The connecting role cannot create the platform role ${p.role} on the ${p.server} server: it has neither CREATEROLE nor SUPERUSER`,
    uk: (p) =>
      `Роль підключення не може створити платформну роль ${p.role} на сервері ${p.server === "shadow" ? "тіні" : "цілі"}: у неї немає ні CREATEROLE, ні SUPERUSER`,
    hint: {
      en: "Nothing was created on any server. Run `simetra roles` with a connection whose role has CREATEROLE, or ask the database administrator to create the role as NOLOGIN NOINHERIT.",
      uk: "Ні на одному сервері нічого не створено. Запустіть `simetra roles` з підключенням, роль якого має CREATEROLE, або попросіть адміністратора бази створити роль як NOLOGIN NOINHERIT.",
    },
  },
  "introspect.unrepresentable": {
    en: (p) =>
      `${p.object}: ${p.property} cannot be represented in metadata files: ${p.detail}`,
    uk: (p) =>
      `${p.object}: ${p.property} не виражається у файлах метаданих: ${p.detail}`,
    hint: {
      en: "Reverse generation writes nothing while any object is unrepresentable; bring the object to a form CustomTable, PgEnum or a verbatim SQL unit can declare, or extend the model first.",
      uk: "Зворотна генерація нічого не пише, поки хоч один об'єкт невиражений; приведіть об'єкт до форми, яку оголошує CustomTable, PgEnum чи дослівна SQL-одиниця, або спершу розширте модель.",
    },
  },
  "introspect.identity-conflict": {
    en: (p) =>
      `${p.key} is described by more than one element of the metadata folder; the other one is at ${p.other}`,
    uk: (p) =>
      `${p.key} описано кількома елементами теки метаданих; інший — у ${p.other}`,
    hint: {
      en: "Identity is kept by schema and physical name, so each database object must have one description; remove the duplicate before introspecting again.",
      uk: "Ідентичність зберігається за схемою й фізичним іменем, тож кожен об'єкт бази мусить мати один опис; приберіть дублікат і повторіть інтроспекцію.",
    },
  },
  "introspect.project-mismatch": {
    en: (p) =>
      `project.meta.json declares ${p.field} ${p.project}, but introspection was asked for ${p.requested}`,
    uk: (p) =>
      `project.meta.json оголошує ${p.field} ${p.project}, а інтроспекцію запущено для ${p.requested}`,
    hint: {
      en: "An existing project file is never rewritten; introspect with the values it declares, or change the project file first.",
      uk: "Наявний файл проєкту не переписується; запустіть інтроспекцію з його значеннями або спершу змініть файл проєкту.",
    },
  },
  "introspect.path-collision": {
    en: (p) =>
      `${p.first} and ${p.second} would be written to the same file ${p.path}`,
    uk: (p) => `${p.first} і ${p.second} потрапили б в один файл ${p.path}`,
    hint: {
      en: "File names are derived from unit identities; rename one of the database objects so their file names differ.",
      uk: "Імена файлів виводяться з ідентичностей одиниць; перейменуйте один з об'єктів бази, щоб імена файлів різнилися.",
    },
  },
}

/** Причини `engine.out-of-scope`: параметр `reason` межі моделі (T2). */
export type OutOfScopeReason =
  | "provider-schema"
  | "provider-surface"
  | "provider-trigger-function"
  | "global-default-privileges"
  | "provider-extension"

/**
 * Тексти причин: тип за `OutOfScopeReason` робить каталог вичерпним — причина
 * без тексту не пройде typecheck.
 */
const OUT_OF_SCOPE_REASONS: Readonly<
  Record<OutOfScopeReason, Record<Locale, Text>>
> = {
  "provider-schema": {
    en: (p) => `schema ${p.schema} belongs to the provider`,
    uk: (p) => `схема ${p.schema} належить провайдерові`,
  },
  "provider-surface": {
    en: (p) =>
      `the provider lets the application own ${p.class === "trigger" ? "triggers" : "policies"} only on its surface tables, and ${p.table} is not one of them`,
    uk: (p) =>
      `провайдер віддає застосунку ${p.class === "trigger" ? "тригери" : "політики"} лише на таблицях своєї поверхні, а ${p.table} до них не належить`,
  },
  "provider-trigger-function": {
    en: (p) =>
      `the trigger calls a function in the provider schema ${p.schema}, so the provider preset treats it as the provider's own`,
    uk: (p) =>
      `тригер викликає функцію в схемі провайдера ${p.schema}, тож пресет провайдера вважає його власним тригером провайдера`,
  },
  "global-default-privileges": {
    en: () =>
      "default privileges without IN SCHEMA belong to no managed schema",
    uk: () =>
      "типові привілеї без IN SCHEMA не належать жодній керованій схемі",
  },
  "provider-extension": {
    en: () => "the provider installs this extension itself",
    uk: () => "це розширення ставить сам провайдер",
  },
}

/** Параметр приходить як `unknown`: невідома причина — без тексту, не виняток. */
function outOfScopeReason(
  p: DiagnosticParams
): Record<Locale, Text> | undefined {
  const reason = String(p.reason)
  return Object.hasOwn(OUT_OF_SCOPE_REASONS, reason)
    ? OUT_OF_SCOPE_REASONS[reason as OutOfScopeReason]
    : undefined
}

/** Текст діагностики потрібною мовою; `message`/`hint` самої діагностики — англійські. */
export function localize(
  d: Pick<Diagnostic, "code" | "params">,
  locale: Locale
): { message: string; hint?: string } {
  const entry = MESSAGES[d.code]
  const params = d.params ?? {}
  const hint = entry.hint?.[locale]
  return {
    message: entry[locale](params),
    ...(hint === undefined
      ? {}
      : { hint: typeof hint === "string" ? hint : hint(params) }),
  }
}
