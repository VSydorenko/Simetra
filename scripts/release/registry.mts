/** Відповідь `npm view <name>@<version> version --json`. */
export interface NpmViewResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Чи є версія в реєстрі. Будь-яка відповідь, крім «є» і 404, — помилка:
 * мережний збій, прочитаний як «немає», запустив би повторну публікацію.
 */
export function publishedState(
  result: NpmViewResult,
  version: string
): "published" | "absent" {
  if (result.code === 0) {
    const out = result.stdout.trim()
    // Пакет є, а версії немає — npm view мовчить з кодом 0
    if (out === "") return "absent"
    if (JSON.parse(out) === version) return "published"
    throw new Error(`npm view returned ${out} for version ${version}`)
  }
  if (/\bE404\b/.test(result.stderr)) return "absent"
  throw new Error(`npm view failed: ${result.stderr.trim()}`)
}

/** Пререліз не стає `latest`, інакше `npm i` віддав би його як стабільний. */
export function distTagFor(version: string): "latest" | "next" {
  return version.includes("-") ? "next" : "latest"
}
