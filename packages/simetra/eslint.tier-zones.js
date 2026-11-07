// Лінт-зони ярусів T0–T6 і межа з фреймворками (платформна спека §3.1, Р16).
//
// Обмеження механізму: `no-restricted-imports` звіряє рядок специфікатора, а не
// резолвлений модуль, і не бачить динамічного `import()` та типового
// `import("../compiler").X`. Це межа механізму, а не дірка, яку треба
// закривати переліком.

// Порядок = номер ярусу: імпортувати дозволено лише нижчі яруси.
const TIERS = ["model", "compiler", "schema", "server", "data", "ui", "shell"]

// Один regex на зону покриває і bare-субшлях (`simetra/<ярус>`), і будь-яку
// кількість `../` (зокрема через корінь пакета `src/`). Після імені яруса
// вимагаємо `/` або кінець рядка, щоб реальна тека `schemas` у T0 не
// збігалася з ярусом `schema`.
function tierPattern(tiers) {
  const alt = tiers.join("|")
  return `^(?:simetra/(?:${alt})|(?:\\./)?(?:\\.\\./)+(?:src/)?(?:${alt}))(?:/|$)`
}

// Роутер, host-фреймворк і бібліотеки рушія даних заборонені в T5 ui.
const FRAMEWORK_PATTERN =
  "^(?:@tanstack/(?:react-)?(?:router|start|db|query)(?:[-/].*)?|react-router(?:[-/].*)?|next(?:/.*)?|@supabase/.*)$"

const FRAMEWORK_MESSAGE =
  "Framework boundary: T5 ui imports only React, T4 contracts and the navigation adapter interface (platform spec §3.1)."

const SERVER_MESSAGE =
  "Tier zone: src/data and src/ui must not import simetra/server; they depend on T4 contracts and T0 metadata only (P4 A3 decision A3-10)."

// Ярусний regex бачить лише `..` на початку шляху, тож `./a/../../server`
// обходив би його. Нормалізований шлях — без `..` після звичайного сегмента.
const NORMALIZED_PATTERN =
  "^\\.\\.?/(?:[^/]+/)*?(?!\\.\\.?/)[^/]+/\\.\\.(?:/|$)"

const NORMALIZED_MESSAGE =
  "Tier zone: use a normalized relative path (no `..` after a regular segment); a non-normalized path bypasses the tier check."

function tierMessage(tier, index) {
  return (
    `Tier zone: src/${tier} is T${index}; import only lower tiers (platform spec §3.1). ` +
    "Moving an import upward is an architectural decision that changes the tier table in eslint.tier-zones.js."
  )
}

const DATA_FACADE_ONLY_PATTERNS = [
  {
    regex: "^@tanstack/(?:query-db-collection|query-core)(?:/|$)",
    message:
      "Facade boundary: @tanstack/query-db-collection and @tanstack/query-core are imported only in src/data/facade (P4-B spec §3).",
  },
]

const DATA_FACADE_ONLY_PATHS = [
  {
    name: "@tanstack/db",
    importNames: ["createTransaction", "createOptimisticAction"],
    message:
      "Facade boundary: createTransaction and createOptimisticAction are used only in src/data/facade (P4-B spec §3).",
  },
]

const tierConfigs = TIERS.flatMap((tier, index) => {
  const higher = TIERS.slice(index + 1)
  // Нормалізований шлях — у кожному ярусі, зокрема shell: опції правила flat
  // config заміняються цілком, тож шаблон живе в тому самому блоці.
  const patterns = [{ regex: NORMALIZED_PATTERN, message: NORMALIZED_MESSAGE }]
  if (higher.length > 0) {
    patterns.push({
      regex: tierPattern(higher),
      message: tierMessage(tier, index),
    })
  }
  // Ярусна й фреймворкова групи мусять жити в одному правилі ui: flat config
  // замінює опції правила цілком, тож окремий блок затер би ярусну групу.
  if (tier === "ui") {
    patterns.push({ regex: FRAMEWORK_PATTERN, message: FRAMEWORK_MESSAGE })
  }
  // data і ui читають лише контракти T0: серверний рантайм (з'єднання,
  // транзакції) — не їхня залежність, хоч ярус server нижчий.
  if (tier === "data" || tier === "ui") {
    patterns.push({ regex: tierPattern(["server"]), message: SERVER_MESSAGE })
  }
  const options = { patterns }
  if (tier === "data") {
    // Транзакційний рантайм і QueryClient живуть лише у фасаді: решта T4
    // не обходить його ні іменованим імпортом, ні `import *`.
    options.patterns = [...patterns, ...DATA_FACADE_ONLY_PATTERNS]
    options.paths = DATA_FACADE_ONLY_PATHS
  }
  const configs = [
    {
      files: [`src/${tier}/**/*.{ts,tsx,mts,cts}`],
      rules: { "no-restricted-imports": ["error", options] },
    },
  ]
  if (tier === "data") {
    // Фасад — те саме без фасадних заборон: опції flat config заміщуються
    // цілком, тож перелік повторено, а не успадковано.
    configs.push({
      files: ["src/data/facade/**/*.{ts,tsx,mts,cts}"],
      rules: { "no-restricted-imports": ["error", { patterns }] },
    })
  }
  return configs
})

// Межі чистоти T0 і T1. Окреме правило `@typescript-eslint/no-restricted-imports`,
// а не `no-restricted-imports`: flat config замінює опції правила цілком, тож
// ті самі опції в ярусному блоці затерли б ярусну зону (і навпаки). Тести
// виключено: за правилом AGENTS.md тести можуть читати фікстури через Node API.
const PURITY_FILES = (tier) => [`src/${tier}/**/*.{ts,tsx,mts,cts}`]
const PURITY_IGNORES = ["**/__tests__/**"]

// Драйвер бази й двигун схеми — у @simetrajs/designer (рішення Д5): рантайм-пакет
// не тягне їх навіть `import type`. Тести виключено — DB-тести T2 говорять із
// базою напряму. Патерн живе в кожному блоці правила, бо блок ярусу замінює
// опції загального блоку цілком.
const DB_ENGINE_PATTERN = {
  regex: "^(?:pg|@supabase/pg-delta)(?:/|$)",
  message:
    "Runtime boundary: simetra production sources import neither pg nor @supabase/pg-delta; the schema engine and database readers live in @simetrajs/designer (designer plan, decision 4).",
}

// Чистота T4 (спека П4-B §3). Allow-list: нерелятивні імпорти — лише
// simetra/model, zod, react і бібліотеки рушія; фасад додатково бачить
// query-core та query-db-collection. Відносні імпорти пропущено allow-list-ом
// (`\\.`), а вихід з ярусу й `supabase/…` ловлять окремі патерни: `../x` з
// `src/data/facade` — легальний шлях усередині T4, тож заборона іде за іменем
// яруса, а не за самим `..`.
function dataPurity(facade) {
  const allowed = [
    "zod",
    "react",
    "simetra/model",
    "@tanstack/(?:react-)?db",
    ...(facade
      ? ["@tanstack/query-core", "@tanstack/query-db-collection"]
      : []),
  ]
  return {
    files: facade
      ? ["src/data/facade/**/*.{ts,tsx,mts,cts}"]
      : PURITY_FILES("data"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            {
              regex: `^(?!\\.|(?:${allowed.join("|")})(?:/|$))`,
              message:
                "T4 purity: src/data imports only ./…, simetra/model, zod, react, @tanstack/db and @tanstack/react-db" +
                (facade ? " plus the query libraries in the facade" : "") +
                " (P4-B spec §3).",
            },
            {
              regex: `^(?:\\./)?(?:\\.\\./)+(?:src/)?(?:${TIERS.filter((t) => t !== "data").join("|")})(?:/|$)`,
              message:
                "T4 purity: a relative path out of src/data embeds a second copy of another tier in dist/data (P4-B spec §3).",
            },
            {
              regex: "^(?:\\./|(?:\\.\\./)+)(?:\\./)?supabase(?:/|$)",
              message:
                "T4 purity: only src/data/supabase imports its own folder; a relative supabase/… elsewhere pulls @supabase/realtime-js into simetra/data (P4-B spec §3).",
            },
          ],
        },
      ],
    },
  }
}

export const purityConfigs = [
  {
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [DB_ENGINE_PATTERN] },
      ],
    },
  },
  {
    files: PURITY_FILES("model"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            {
              regex: "^(?!zod(?:/|$)|\\.|simetra/model(?:/|$))",
              message:
                "T0 purity: src/model imports only zod at runtime (AGENTS.md, metamodel rules).",
            },
          ],
        },
      ],
    },
  },
  {
    // Відносний `../model` вбудував би в dist/server другу копію T0, а
    // `pg`/`node:fs` зробили б рантайм залежним від I/O: порт бази приходить
    // ззовні (A3-10). Дозволено `./…`, simetra/model, zod, node:async_hooks.
    files: PURITY_FILES("server"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            {
              // `./` — лише без сегмента `..`: `./../model` чи `./a/../../model`
              // виходять з теки так само, як `../model`.
              regex:
                "^(?!\\./(?!(?:.*/)?\\.\\.(?:/|$))|zod(?:/|$)|simetra/model(?:/|$)|node:async_hooks$)",
              message:
                "T3 purity: src/server imports only ./…, simetra/model, zod and node:async_hooks (P4 A3 decision A3-10).",
            },
          ],
        },
      ],
    },
  },
  dataPurity(false),
  dataPurity(true),
  {
    // T4 — контракт, а не реалізація: `simetra/data/supabase` підключає host
    // чи T6, а відносний `../data` вбудував би другу копію T4 в `dist/ui`.
    files: PURITY_FILES("ui"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            {
              regex:
                "^(?:simetra/data/supabase(?:/|$)|(?:\\./)?(?:\\.\\./)+(?:src/)?data(?:/|$))",
              message:
                "T5 purity: src/ui does not import simetra/data/supabase or a relative ../data; the transport is wired by the host or T6 (P4-B spec §3).",
            },
          ],
        },
      ],
    },
  },
  {
    files: PURITY_FILES("compiler"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            {
              regex:
                "^(?:node:|(?:fs|path|os|crypto|url|child_process)(?:/|$))",
              message:
                "T1 purity: the compiler is a pure function over a file map; disk access belongs to @simetrajs/designer (P2 spec §8.2).",
            },
          ],
        },
      ],
    },
  },
]

// Запис у колекцію в обхід фасаду: форма `{ property }` без `object`, бо лише
// вона ловить `c.utils["writeUpdate"]` і `const { writeInsert } = c.utils`.
const FACADE_PROPERTIES = [
  "writeInsert",
  "writeUpdate",
  "writeDelete",
  "writeUpsert",
  "writeBatch",
  "refetch",
].map((property) => ({
  property,
  message:
    "Facade boundary: utils.write* and refetch are called only in src/data/facade (P4-B spec §3).",
}))

export const facadeConfigs = [
  {
    files: ["src/data/**/*.{ts,tsx,mts,cts}"],
    rules: { "no-restricted-properties": ["error", ...FACADE_PROPERTIES] },
  },
  {
    files: ["src/data/facade/**/*.{ts,tsx,mts,cts}"],
    rules: { "no-restricted-properties": "off" },
  },
]

export const tierZoneConfigs = [
  ...tierConfigs,
  ...purityConfigs,
  ...facadeConfigs,
]
