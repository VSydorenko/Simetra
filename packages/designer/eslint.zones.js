// Лінт-зони @simetra/designer: межа тестової опори `simetra` і зона студії.
//
// Обмеження механізму те саме, що в `packages/simetra/eslint.tier-zones.js`:
// `no-restricted-imports` звіряє рядок специфікатора, а не резолвлений модуль.

// Фікстури `simetra` для тестів адаптера йдуть через одну точку —
// `packages/simetra/test/support.ts`; вона не входить у `exports` пакета, тож
// виробничий код, що на неї спирається, зламався б у споживача. Окреме
// правило `@typescript-eslint/no-restricted-imports` (воно ж ловить
// `import type`): flat config замінює опції правила цілком, а набори файлів
// цієї й інших зон різні, тож спільне правило затерло б одну з них.
const TEST_SUPPORT_PATTERN = {
  regex: "(?:^|/)simetra/test/support(?:\\.[cm]?[jt]s)?$",
  message:
    "simetra test support boundary: only packages/designer/**/__tests__/** may import packages/simetra/test/support (designer plan, decision 12).",
}

// Студія — єдине місце designer, що імпортує host-фреймворк (спека designer
// §3.4): CLI, MCP і каталог інструментів лишаються незалежними від нього.
const STUDIO_ZONE = {
  files: ["src/**/*.{ts,tsx,mts,cts}"],
  ignores: ["src/studio/**"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "^@tanstack/(?:react-)?start(?:[-/].*)?$",
            message:
              "Framework boundary: only packages/designer/src/studio may import TanStack Start (designer spec §3.4).",
          },
        ],
      },
    ],
  },
}

export const designerZoneConfigs = [
  {
    files: ["src/**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [TEST_SUPPORT_PATTERN] },
      ],
    },
  },
  STUDIO_ZONE,
]
