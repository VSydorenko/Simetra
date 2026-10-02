import type { Diagnostic, DiagnosticParams, RuleCode } from "./diagnostics"

export type Locale = "en" | "uk"

type Text = (params: DiagnosticParams) => string
/** Функція, коли підказка залежить від параметрів (наприклад, від ролі посилання). */
type Hint = string | Text

export interface MessageEntry {
  en: Text
  uk: Text
  hint?: { en: Hint; uk: Hint }
}

const FIX_IDS = {
  en: "Run simetra fix to assign ids.",
  uk: "Виконайте simetra fix, щоб призначити id.",
}
const FIX_PHYSICAL_NAMES = {
  en: "Run simetra fix to assign physical names.",
  uk: "Виконайте simetra fix, щоб призначити фізичні імена.",
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
  "scope.name-reserved": {
    en: () => 'Scope kind name "none" is reserved',
    uk: () => 'Ім\'я виду скоупу "none" зарезервоване',
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
      p.detail === undefined
        ? `${p.statement} at line ${p.line} is not allowed in a .sql file`
        : `${p.statement} at line ${p.line} is not allowed in a .sql file: ${p.detail}`,
    uk: (p) =>
      p.detail === undefined
        ? `${p.statement} у рядку ${p.line} не дозволений у файлі .sql`
        : `${p.statement} у рядку ${p.line} не дозволений у файлі .sql: ${p.detail}`,
    hint: {
      en: (p) =>
        p.feature === "rowLevelSecurity"
          ? "Row-level security is a property of the table: set rowLevelSecurity on the table in metadata instead of ALTER TABLE."
          : p.feature === "publication"
            ? "The provider creates publications; a .sql file manages only their membership: use ALTER PUBLICATION … ADD/DROP/SET TABLE."
            : ".sql files hold objects the model does not own: functions, procedures, aggregates, triggers, views, materialized views, policies, grants, default privileges, comments, extensions, sequences, domains, publication membership (ALTER PUBLICATION), REPLICA IDENTITY and function settings. Tables, indexes and enum types are metadata objects; DROP and data changes are not desired state.",
      uk: (p) =>
        p.feature === "rowLevelSecurity"
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
    en: (p) => `Name "${p.name}" is taken by a standard attribute of ${p.kind}`,
    uk: (p) => `Ім'я "${p.name}" зайняте стандартним реквізитом виду ${p.kind}`,
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
  "scope.set-function-signature": {
    en: (p) =>
      `Scope set function ${p.function}() has the wrong signature: ${p.problem}`,
    uk: (p) =>
      `Функція множини скоупу ${p.function}() має хибну сигнатуру: ${p.problem}`,
    hint: {
      en: "A set function takes no arguments, returns SETOF uuid and is STABLE.",
      uk: "Функція множини не приймає аргументів, повертає SETOF uuid і є STABLE.",
    },
  },

  // --- Стадія 4: цілісність ---
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
  "physical.discriminator-duplicate": {
    en: (p) =>
      `Another target of this polymorphic reference has physical name ${p.name}`,
    uk: (p) =>
      `Інша ціль цього поліморфного посилання має фізичне ім'я ${p.name}`,
    hint: {
      en: "The type column stores the target's physicalName, so targets must differ by it regardless of schema.",
      uk: "Колонка типу зберігає physicalName цілі, тож цілі мають відрізнятися ним незалежно від схеми.",
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
    en: (p) => `Physical name ${p.name} is an SQL reserved word`,
    uk: (p) => `Фізичне ім'я ${p.name} — зарезервоване слово SQL`,
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
