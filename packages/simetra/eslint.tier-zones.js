// Лінт-зони ярусів T0–T6 і межа з фреймворками (платформна спека §3.1, Р16).
//
// Обмеження механізму: `no-restricted-imports` звіряє рядок специфікатора, а не
// резолвлений модуль, і не бачить динамічного `import()` та типового
// `import("../compiler").X`. Це межа механізму, а не дірка, яку треба
// закривати переліком.

import { STANDARD_COLUMN_SELECTORS } from "./eslint.standard-columns.js"
import { IDENTITY_SELECTORS } from "./eslint.identity.js"

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

const VIRTUAL_PATTERN = "^@tanstack/react-virtual(?:/|$)"

const FRAMEWORK_MESSAGE =
  "Framework boundary: T5 ui imports only React, T4 contracts, the navigation adapter interface and the headless UI libraries the spec names (forms, virtualisation) — never routing, data fetching or the host framework (platform spec §3.1)."

const SERVER_MESSAGE =
  "Tier zone: src/data and src/ui must not import simetra/server; they depend on T4 contracts and T0 metadata only (P4 spec Рт15)."

// Ярусний regex бачить лише `..` на початку шляху, тож `./a/../../server`
// обходив би його. Нормалізований шлях — без `..` після звичайного сегмента.
// Три гілки: `..` після звичайного сегмента; порожній сегмент (`//`); сегмент
// `.` будь-де, крім єдиного початкового `./` (`.././model`, `../../src/./model`).
const NORMALIZED_PATTERN =
  "^\\.\\.?/(?:[^/]+/)*?(?!\\.\\.?/)[^/]+/\\.\\.(?:/|$)|^\\.\\.?/(?:.*/)?/|^\\.\\.?/(?:.*/)?\\.(?:/|$)"

const NORMALIZED_MESSAGE =
  "Tier zone: use a normalized relative path (no `..` after a regular segment, no `.` segment after the start, no empty segment); a non-normalized path bypasses the tier check."

function tierMessage(tier, index) {
  return (
    `Tier zone: src/${tier} is T${index}; import only lower tiers (platform spec §3.1). ` +
    "Moving an import upward is an architectural decision that changes the tier table in eslint.tier-zones.js."
  )
}

const VIRTUAL_MESSAGE =
  "T5 list zone: @tanstack/react-virtual is imported only inside src/ui/list; the anchor and remount live in one list component (P4-B spec §6.7)."

// `useOptimistic` — оптимістичний показ дає лише ядро (політика `predict`).
const UI_IMPORT_PATHS = [
  {
    name: "react",
    importNames: ["useOptimistic"],
    message:
      "T5 rule: optimistic display comes only from the data core (predict policy, P4-B spec §6.7); do not use useOptimistic.",
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
    patterns.push({ regex: VIRTUAL_PATTERN, message: VIRTUAL_MESSAGE })
  }
  // data і ui читають лише контракти T0: серверний рантайм (з'єднання,
  // транзакції) — не їхня залежність, хоч ярус server нижчий.
  if (tier === "data" || tier === "ui") {
    patterns.push({ regex: tierPattern(["server"]), message: SERVER_MESSAGE })
  }
  // Бібліотек рушія даних у T4 немає зовсім (власне ядро); правило ярусу, а не
  // чистоти, бо чистота пропускає `__tests__`, а тест теж не тягне TanStack.
  if (tier === "data") {
    patterns.push({
      regex: "^@tanstack(?:/|$)",
      message:
        "T4 purity: src/data imports no @tanstack/* library (own data core, P4-B spec §3).",
    })
  }
  return [
    {
      files: [`src/${tier}/**/*.{ts,tsx,mts,cts}`],
      rules: {
        "no-restricted-imports": [
          "error",
          tier === "ui" ? { patterns, paths: UI_IMPORT_PATHS } : { patterns },
        ],
      },
    },
  ]
})

// Тека списку — власний блок із повним переліком заборон T5 без шаблону
// віртуалізатора: опції правила замінюються цілком, тож перелік повторено.
const listImportConfig = (() => {
  const ui = tierConfigs.find((c) => c.files[0].startsWith("src/ui/"))
  const { patterns } = ui.rules["no-restricted-imports"][1]
  return {
    files: ["src/ui/list/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: patterns.filter((p) => p.regex !== VIRTUAL_PATTERN),
          paths: UI_IMPORT_PATHS,
        },
      ],
    },
  }
})()

// Правила зони T5 (спека П4-B §6.7, Рд45): лише відомі причини мерехтіння з
// низькими хибними спрацюваннями. Тести виключено, як і в блоках чистоти.
const UI_FILES = ["src/ui/**/*.{ts,tsx,mts,cts}"]
const UI_IGNORES = ["**/__tests__/**"]

// Атрибут — і `JSXAttribute`, і ключ у props `createElement` (тести та
// код без JSX пишуть `createElement(type, { onScroll })`).
const CREATE_ELEMENT =
  ":matches(CallExpression[callee.name='createElement'], CallExpression[callee.property.name='createElement'])"
const attributeSelector = (name) =>
  `JSXAttribute[name.name='${name}'], ${CREATE_ELEMENT} > ObjectExpression > Property:matches([key.name='${name}'], [key.value='${name}'])`

const HYDRATION_SELECTOR = {
  selector: attributeSelector("suppressHydrationWarning"),
  message:
    "T5 rule: suppressHydrationWarning hides a hydration mismatch the oracle must catch (P4-B spec §6.7).",
}
// Обхід `no-restricted-imports`/`no-restricted-globals`: доступ через
// простір імен React і через глобальний об'єкт.
const BYPASS_SELECTORS = [
  {
    selector:
      "MemberExpression:matches([property.name='useOptimistic'], [property.value='useOptimistic'])",
    message:
      "T5 rule: optimistic display comes only from the data core (predict policy, P4-B spec §6.7); do not use useOptimistic.",
  },
  {
    selector:
      "MemberExpression[object.name=/^(?:globalThis|window|self)$/]:matches([property.name=/^(?:fetch|XMLHttpRequest|WebSocket|EventSource)$/], [property.value=/^(?:fetch|XMLHttpRequest|WebSocket|EventSource)$/])",
    message:
      "T5 rule: data comes only from T4 hooks; own loading skips the core and shows a skeleton after the data (P4-B spec §6.7).",
  },
]
const SCROLL_SELECTORS = [
  {
    selector: attributeSelector("onScroll"),
    message:
      "T5 rule: only the list component in src/ui/list owns scrolling; setState on scroll causes scroll-rigid (P4-B spec §6.7).",
  },
  {
    selector:
      "CallExpression[callee.property.name='addEventListener'][arguments.0.value='scroll']",
    message:
      "T5 rule: only the list component in src/ui/list listens to scroll (P4-B spec §6.7).",
  },
]

const uiRules = {
  // Одні опції `no-restricted-syntax` для T5 і стандартних колонок: пізніший
  // блок замінив би опції цілком.
  syntax: (scroll) => [
    "error",
    ...STANDARD_COLUMN_SELECTORS,
    ...IDENTITY_SELECTORS,
    HYDRATION_SELECTOR,
    ...BYPASS_SELECTORS,
    ...(scroll ? SCROLL_SELECTORS : []),
  ],
  "no-restricted-globals": [
    "error",
    ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({
      name,
      message:
        "T5 rule: data comes only from T4 hooks; own loading skips the core and shows a skeleton after the data (P4-B spec §6.7).",
    })),
  ],
  "no-restricted-properties": [
    "error",
    {
      object: "Math",
      property: "random",
      message:
        "T5 rule: a random value in render differs between SSR and the client; use useId (P4-B spec §6.7).",
    },
  ],
}

const uiRuleConfigs = [
  {
    files: UI_FILES,
    ignores: [...UI_IGNORES, "src/ui/list/**"],
    rules: {
      "no-restricted-syntax": uiRules.syntax(true),
      "no-restricted-globals": uiRules["no-restricted-globals"],
      "no-restricted-properties": uiRules["no-restricted-properties"],
    },
  },
  {
    files: ["src/ui/list/**/*.{ts,tsx,mts,cts}"],
    ignores: UI_IGNORES,
    rules: {
      "no-restricted-syntax": uiRules.syntax(false),
      "no-restricted-globals": uiRules["no-restricted-globals"],
      "no-restricted-properties": uiRules["no-restricted-properties"],
    },
  },
]

// Межі чистоти ярусів T0, T1, T3, T4, T5 і заборона рушія бази в усьому `src`.
// Окреме правило `@typescript-eslint/no-restricted-imports`, а не
// `no-restricted-imports`: flat config замінює опції правила цілком, тож ті
// самі опції в ярусному блоці затерли б ярусну зону (і навпаки). Тести
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

// Better Auth і kysely — лише тестова залежність `simetra`: міграція
// схеми `better_auth` потрібна DB-тестам, а не споживачеві пакета.
const TEST_ONLY_AUTH_PATTERN = {
  regex: "^(?:better-auth|kysely)(?:/|$)",
  message:
    "Test-only dependency: better-auth and kysely are devDependencies of simetra for DB tests; production sources must not import them (postgres profile plan 2a, decision R2).",
}

// Чистота T4 (спека П4-B §3). Allow-list: нерелятивні імпорти — лише
// simetra/model, zod і react; `@tanstack/*` не дозволено ніде в `src/data`
// (власне ядро даних, без бібліотек рушія). Ядро в `src/data/store` ще й без
// `react`: його читає і React-міст, і Node-тести. Відносні імпорти пропущено
// allow-list-ом (`\\.`), а вихід з ярусу й `supabase/…` ловлять окремі
// патерни: `../x` з `src/data/runtime` — легальний шлях усередині T4, тож
// заборона йде за іменем яруса, а не за самим `..`.
// `kind`: "store" — ядро без react; "data" — решта `src/data`; "centrifugo" —
// єдина тека, що імпортує SDK `centrifuge` (необов'язкова peer). Блок
// "centrifugo" іде після "data": у flat-конфігу пізніший блок для того самого
// правила замінює опції раннього цілком, тож усі патерни повторено.
function dataPurity(kind) {
  const store = kind === "store"
  const allowed = [
    "zod",
    "simetra/model",
    ...(store ? [] : ["react"]),
    ...(kind === "centrifugo" ? ["centrifuge"] : []),
  ]
  return {
    files: store
      ? ["src/data/store/**/*.{ts,tsx,mts,cts}"]
      : kind === "centrifugo"
        ? ["src/data/centrifugo/**/*.{ts,tsx,mts,cts}"]
        : PURITY_FILES("data"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            TEST_ONLY_AUTH_PATTERN,
            {
              regex: `^(?!\\.|(?:${allowed.join("|")})(?:/|$))`,
              message: store
                ? "T4 purity: src/data/store imports only ./…, simetra/model and zod; no react and no @tanstack/* (P4-B spec §3)."
                : kind === "centrifugo"
                  ? "T4 purity: src/data/centrifugo imports only ./…, simetra/model, zod, react and centrifuge; no @tanstack/* (P4-B spec §8.5)."
                  : "T4 purity: src/data imports only ./…, simetra/model, zod and react; centrifuge only in src/data/centrifugo; no @tanstack/* (P4-B spec §3).",
            },
            {
              regex: `^(?:\\./)?(?:\\.\\./)+(?:src/)?(?:${TIERS.filter((t) => t !== "data").join("|")})(?:/|$)`,
              message:
                "T4 purity: a relative path out of src/data embeds a second copy of another tier in dist/data (P4-B spec §3).",
            },
            ...(kind === "centrifugo"
              ? []
              : [
                  {
                    // Лише `src/data/centrifugo` імпортує свою теку: відносний
                    // `./centrifugo` чи `../centrifugo` тягнув би `centrifuge` у
                    // `simetra/data`.
                    regex:
                      "^(?:(?:\\./(?:\\.\\./)*|(?:\\.\\./)+)(?:(?:src/)?data/)?centrifugo(?:/|$))",
                    message:
                      "T4 purity: only src/data/centrifugo imports its own folder; a relative centrifugo/… elsewhere pulls centrifuge into simetra/data (P4-B spec §8.5).",
                  },
                ]),
            {
              // Прямі форми й обхід через ярус: `../data/supabase`, `../../src/data/supabase`.
              regex:
                "^(?:(?:\\./(?:\\.\\./)*|(?:\\.\\./)+)(?:(?:src/)?data/)?supabase(?:/|$))",
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
        { patterns: [DB_ENGINE_PATTERN, TEST_ONLY_AUTH_PATTERN] },
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
            TEST_ONLY_AUTH_PATTERN,
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
    // ззовні (спека П4 Рт15, Рт17). Дозволено `./…`, simetra/model, zod,
    // node:async_hooks.
    files: PURITY_FILES("server"),
    ignores: PURITY_IGNORES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            DB_ENGINE_PATTERN,
            TEST_ONLY_AUTH_PATTERN,
            {
              // `./` — лише без сегмента `..`: `./../model` чи `./a/../../model`
              // виходять з теки так само, як `../model`.
              regex:
                "^(?!\\./(?!(?:.*/)?\\.\\.(?:/|$))|zod(?:/|$)|simetra/model(?:/|$)|node:async_hooks$)",
              message:
                "T3 purity: src/server imports only ./…, simetra/model, zod and node:async_hooks (P4 spec Рт17).",
            },
          ],
        },
      ],
    },
  },
  dataPurity("data"),
  dataPurity("store"),
  dataPurity("centrifugo"),
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
            TEST_ONLY_AUTH_PATTERN,
            {
              regex:
                "^(?:centrifuge(?:/|$)|simetra/data/(?:supabase|centrifugo)(?:/|$)|(?:\\./)?(?:\\.\\./)+(?:src/)?data(?:/|$))",
              message:
                "T5 purity: src/ui does not import simetra/data/supabase, simetra/data/centrifugo, centrifuge or a relative ../data; the transport is wired by the host or T6 (P4-B spec §3).",
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
            TEST_ONLY_AUTH_PATTERN,
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

export const tierZoneConfigs = [
  ...tierConfigs,
  listImportConfig,
  ...uiRuleConfigs,
  ...purityConfigs,
]

// Межа фреймворку для пакета `create-simetra-app` (AGENTS.md): TanStack Start —
// лише в застосунку шаблону `template/` і в `e2e/`; `src/` пакета (копіювальник)
// його не імпортує. Конфіг підключає `packages/create-simetra-app/eslint.config.js`,
// файли — відносно теки того пакета, тож `template/**` і `e2e/**` зоною не
// зачеплено.
export const frameworkBoundaryConfigs = [
  {
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@tanstack/(?:react-|solid-)?start(?:[-/].*)?$",
              message:
                "Framework boundary: TanStack Start is imported only by the host template (template/) and its e2e tests (e2e/), never by the package sources (AGENTS.md).",
            },
          ],
        },
      ],
    },
  },
]
