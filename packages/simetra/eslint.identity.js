import { STANDARD_COLUMN_SELECTORS } from "./eslint.standard-columns.js"

/**
 * Ідентичність SQL-одиниці (`<клас>:<ключ>`) складає лише
 * `src/compiler/sql/identity.ts` (#297, Р4): склеєна вручну частина імені без
 * `quoteIdent` знову зробила б ідентичність неін'єктивною. Перелік класів —
 * `SQL_UNIT_CLASSES` у T0 плюс `table` і `enumType` (`IdentityClass`); конфіг
 * не імпортує TS, тож тримає його сам, а тест `identity-lint.test.ts` звіряє
 * його з реєстром. Ідентифікатор двигуна (`StableId` pg-delta) — інша мова:
 * там коментар-виняток `eslint-disable-next-line` з причиною.
 */
export const IDENTITY_CLASSES = [
  "function",
  "procedure",
  "aggregate",
  "trigger",
  "policy",
  "view",
  "materializedView",
  "grant",
  "defaultPrivileges",
  "comment",
  "extension",
  "sequence",
  "sequenceOwnedBy",
  "domain",
  "publication",
  "replicaIdentity",
  "functionSettings",
  "movementQuery",
  "table",
  "enumType",
]

// Після двокрапки — не пропуск (чи кінець шматка шаблону): `table: ...` у тексті
// повідомлення не ключ.
const PREFIX = `/^(?:${IDENTITY_CLASSES.join("|")}):(?:\\S|$)/`
const MESSAGE =
  "Assemble a unit identity only through compiler/sql/identity.ts (unitIdentity, keyIdentity, qualifiedName); an engine StableId needs an eslint-disable comment with the reason (#297, R4)."

// Селектори окремо від блоку: опції `no-restricted-syntax` flat config
// замінює цілком, тож зона T5 (`eslint.tier-zones.js`) бере їх у свої опції.
export const IDENTITY_SELECTORS = [
  {
    selector: `TemplateLiteral > TemplateElement:first-child[value.raw=${PREFIX}]`,
    message: MESSAGE,
  },
  {
    selector: `BinaryExpression[operator='+'] > Literal.left[value=${PREFIX}]`,
    message: MESSAGE,
  },
]

export const identityConfigs = [
  {
    files: ["src/**/*.ts"],
    // Опції `no-restricted-syntax` пізнішого блоку затирають попередні, тож
    // тут і селектори стандартних колонок. `src/ui/**` має власні опції
    // (беруть IDENTITY_SELECTORS у `eslint.tier-zones.js`); реєстр видів не
    // складає ідентичностей, тож лишається на блоці стандартних колонок.
    ignores: [
      "src/**/__tests__/**",
      "src/**/*.support.ts",
      "src/compiler/sql/identity.ts",
      "src/model/kinds/**",
      "src/ui/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...STANDARD_COLUMN_SELECTORS,
        ...IDENTITY_SELECTORS,
      ],
    },
  },
]
