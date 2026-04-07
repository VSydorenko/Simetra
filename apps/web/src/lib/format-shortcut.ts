// Визначає платформу та форматує shortcut рядок
const isMac =
  typeof navigator !== 'undefined' &&
  (navigator.platform?.startsWith('Mac') ||
    (navigator as unknown as { userAgentData?: { platform: string } })
      .userAgentData?.platform === 'macOS')

const KEY_MAP_MAC: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  ctrl: '⌃',
}

const KEY_MAP_OTHER: Record<string, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  ctrl: 'Ctrl',
}

export function formatShortcut(combo: string): string {
  const map = isMac ? KEY_MAP_MAC : KEY_MAP_OTHER
  return combo
    .split('+')
    .map((key) => {
      const lower = key.trim().toLowerCase()
      return map[lower] ?? key.trim()
    })
    .join(isMac ? '' : '+')
}
