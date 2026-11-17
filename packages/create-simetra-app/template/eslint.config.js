// Лінт споживача (спека П4-D §4.7). Код host-а, що володіє пулом
// `simetra_runtime`, — домен довіри `runCommand` (Рт6): лінт тут — гігієна
// цього домену, а не межа безпеки. Він ловить випадкову помилку, а не
// навмисний обхід.
import tseslint from "typescript-eslint"
import { defineConfig } from "eslint/config"

// Ім'я пакета оракула складене з частин: тест дерева шаблону (Дх9) шукає
// його літерал у кожному файлі, зокрема й тут
const TEST_HOST = ["test", "host"].join("-")

// Що саме файл імпортувати МОЖЕ; усе інше з цього переліку — помилка
const ALLOW = {
  pg: "pg",
  server: "server",
  instrument: "instrument",
  ssrTransport: "ssrTransport",
  // Тести імпортують скрипти вільно; `src/` — ніколи
  scripts: "scripts",
}

// Права на імпорт: кожен запис — що файл МОЖЕ, лише якщо йому це дано.
// Одна таблиця живить і `no-restricted-imports`, і селектори `import()`:
// перше динамічного імпорту не бачить.
const GRANTED_IMPORTS = [
  {
    grant: ALLOW.pg,
    regex:
      "^(?:pg|pg-.+|postgres|@neondatabase/.+|@vercel/postgres|@electric-sql/pglite|slonik)(?:/.*)?$",
    // Типи драйвера безпечні: пул не з'являється
    allowTypeImports: true,
    message:
      "A Postgres driver is imported only by src/server/runtime.ts and src/server/auth-db.ts (P4-D spec §4.7).",
  },
  {
    grant: ALLOW.server,
    regex: "^simetra/server(?:/.*)?$",
    message:
      "simetra/server is imported only by src/server/** (P4 spec Рт15, P4-D spec §4.7).",
  },
  {
    grant: ALLOW.instrument,
    regex: "^#instrument$",
    message:
      "#instrument is imported only by the points named in P4-D spec §4.1 (Дх9).",
  },
  {
    grant: ALLOW.ssrTransport,
    // Хвостовий `/` і запит (`?raw`) — той самий модуль
    regex: "(?:^|/)ssr-transport(?:\\.[a-z]+)?/?(?:\\?.*)?$",
    message: "ssr-transport is imported only by src/router.tsx (Дх7).",
  },
  {
    grant: ALLOW.scripts,
    regex: "(?:^|/)scripts/",
    message: "Scripts (dev-user included) are never imported from src/.",
  },
]

// Заборонено всім файлам шаблону, без винятків
const ORACLE_IMPORTS = [
  {
    // Лише на початку шляху: так само називається пакет оракула, а не файл
    regex: `^${TEST_HOST}(?:/.*)?$`,
    message:
      "The template does not depend on the oracle package (P4-D spec Дх9).",
  },
  {
    regex: "^simetra/[^/]+/testing(?:/.*)?$",
    message: "The template does not import simetra testing entries (Дх9).",
  },
]

/** Опції `@typescript-eslint/no-restricted-imports` для файлу з наданими правами. */
function importRestrictions(allowed) {
  const patterns = [
    ...ORACLE_IMPORTS,
    ...GRANTED_IMPORTS.filter((p) => !allowed.has(p.grant)).map(
      ({ grant: _grant, ...pattern }) => pattern
    ),
  ]
  return ["error", { patterns }]
}

/** Той самий перелік для `import("…")`: типових імпортів у виразі немає. */
function dynamicImportSelectors(allowed) {
  return GRANTED_IMPORTS.filter((p) => !allowed.has(p.grant)).map((p) => ({
    // `/` у regex селектора esquery мусить бути екранованим
    selector: `ImportExpression[source.value=/${p.regex.replaceAll("/", "\\/")}/]`,
    message: `${p.message} (dynamic import() too)`,
  }))
}

const IN_PROCESS = {
  // Ключ-ідентифікатор, рядок (зокрема обчислюваний доступ) і шаблонний літерал
  selector:
    "Identifier[name='inProcess'], Literal[value='inProcess'], TemplateElement[value.cooked='inProcess']",
  message:
    "inProcess appears only in src/server/ssr-transport.ts: on the HTTP path it would skip the origin rule (Дх7).",
}
const CREATE_SERVER_FN = {
  selector:
    "Identifier[name='createServerFn'], Literal[value='createServerFn'], TemplateElement[value.cooked='createServerFn']",
  message:
    "ssr-transport.ts and router.tsx never use createServerFn: the in-process form must not become an HTTP route (Дх7).",
}
const ENV_RUNTIME_URL = [
  // `process.env.SIMETRA_RUNTIME_DATABASE_URL` рядкового літерала не має
  "MemberExpression[property.name='SIMETRA_RUNTIME_DATABASE_URL']",
  // Деструктуризація `const { SIMETRA_RUNTIME_DATABASE_URL: u } = process.env`
  "Property[key.name='SIMETRA_RUNTIME_DATABASE_URL']",
  "Literal[value=/SIMETRA_RUNTIME_DATABASE_URL/]",
  "TemplateElement[value.raw=/SIMETRA_RUNTIME_DATABASE_URL/]",
].map((selector) => ({
  selector,
  message:
    "SIMETRA_RUNTIME_DATABASE_URL is read only by src/server/runtime.ts (§4.7).",
}))
const SESSION_SQL = [
  "Literal[value=/SET\\s+ROLE|set_config|simetra\\.|request\\.jwt\\.claims/i]",
  "TemplateElement[value.raw=/SET\\s+ROLE|set_config|simetra\\.|request\\.jwt\\.claims/i]",
].map((selector) => ({
  selector,
  message:
    "Session SQL (SET ROLE, set_config, simetra.*, request.jwt.claims) lives only in src/server/runtime.ts (§4.7).",
}))
const DYNAMIC_LOADING = [
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: "A dynamic import() needs a literal argument (§4.7).",
  },
  {
    selector: "ImportSpecifier[imported.name='createRequire']",
    message: "createRequire is forbidden in src/ (§4.7).",
  },
  {
    selector: "CallExpression[callee.property.name='createRequire']",
    message: "createRequire is forbidden in src/ (§4.7).",
  },
]

/** Опції `no-restricted-syntax`: усе, що не названо дозволеним, — помилка. */
function syntaxRestrictions(o) {
  return [
    "error",
    ...DYNAMIC_LOADING,
    ...dynamicImportSelectors(o.allowed),
    ...(o.runtime ? [] : [...ENV_RUNTIME_URL, ...SESSION_SQL]),
    ...(o.ssrTransport ? [] : [IN_PROCESS]),
    ...(o.noServerFn ? [CREATE_SERVER_FN] : []),
  ]
}

// Права файлів `src/`; решта `src/**` не має жодного (`src/server/**` — лише
// `simetra/server`). Файл не з переліку нічого не імпортує зі списку ALLOW.
const GRANTS = {
  "src/server/runtime.ts": [ALLOW.pg, ALLOW.server, ALLOW.instrument],
  "src/server/auth-db.ts": [ALLOW.pg, ALLOW.server],
  "src/server/data-fn.ts": [ALLOW.server, ALLOW.instrument],
  "src/server/ssr-transport.ts": [ALLOW.server],
  "src/router.tsx": [ALLOW.ssrTransport, ALLOW.instrument],
  "src/client.tsx": [ALLOW.instrument],
}

function srcBlock(files, allowed, o = {}) {
  return {
    files,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        new Set(allowed)
      ),
      "no-restricted-syntax": syntaxRestrictions({
        allowed: new Set(allowed),
        runtime: o.runtime === true,
        ssrTransport: o.ssrTransport === true,
        noServerFn: o.noServerFn === true,
      }),
    },
  }
}

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      "**/.output/**",
      "**/.nitro/**",
      "**/.tanstack/**",
      "generated/**",
      "src/routeTree.gen.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs}"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Дх9: оракул і тестові входи — не залежність шаблону, зокрема тестів
      // і скриптів
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        new Set(Object.values(ALLOW))
      ),
    },
  },
  srcBlock(["src/**/*.{ts,tsx}"], []),
  srcBlock(["src/server/**/*.ts", "src/server.ts"], [ALLOW.server]),
  ...Object.entries(GRANTS).map(([file, allowed]) =>
    srcBlock([file], allowed, {
      runtime: file === "src/server/runtime.ts",
      ssrTransport: file === "src/server/ssr-transport.ts",
      noServerFn:
        file === "src/server/ssr-transport.ts" || file === "src/router.tsx",
    })
  ),
])
