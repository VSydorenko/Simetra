// Класифікатор змін PR для CI (#249): чи PR змінює лише документацію.
// Лише документація — бази, пакування й шаблон host-а пропускаються, `Checks`
// біжить завжди (формат документації теж перевіряється).
// Використання: `git diff --name-only <base>...<head> | node scripts/ci/docs-only.mts`
// друкує `code=true` або `code=false`.

/**
 * Чи змінює список файлів код. Документація — файл під `docs/` або `.md` поза
 * `packages/`: `.md` у пакеті може їхати в tarball (README, скіл споживача),
 * тож це код. Порожній список — код: невизначеність не має пропускати перевірки.
 */
export function changesCode(files: readonly string[]): boolean {
  const paths = files.map((f) => f.trim()).filter((f) => f !== "")
  if (paths.length === 0) return true
  return !paths.every(
    (f) =>
      f.startsWith("docs/") || (f.endsWith(".md") && !f.startsWith("packages/"))
  )
}

if (import.meta.main) {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const files = Buffer.concat(chunks).toString("utf8").split("\n")
  process.stdout.write(`code=${changesCode(files)}\n`)
}
