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

function tierMessage(tier, index) {
  return (
    `Tier zone: src/${tier} is T${index}; import only lower tiers (platform spec §3.1). ` +
    "Moving an import upward is an architectural decision that changes the tier table in eslint.tier-zones.js."
  )
}

export const tierZoneConfigs = TIERS.flatMap((tier, index) => {
  const higher = TIERS.slice(index + 1)
  const patterns = []
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
  // У shell (T6) заборон немає — блок без патернів не створюється.
  if (patterns.length === 0) return []
  return [
    {
      files: [`src/${tier}/**/*.{ts,tsx}`],
      rules: { "no-restricted-imports": ["error", { patterns }] },
    },
  ]
})
