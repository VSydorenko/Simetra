import type { Explanation } from "simetra/compiler"

/** Текст пояснення об'єкта для терміналу; JSON-вигляд друкується як є. */
export function renderExplanation(e: Explanation): string {
  const lines = [`${e.object.kind} ${e.object.name} (${e.object.file})`]
  if (e.object.scopeKind !== undefined) {
    lines.push(`scope: ${e.object.scopeKind}`)
  }
  for (const t of e.tables) {
    lines.push("", `table ${t.schema}.${t.name}${t.part ? ` [${t.part}]` : ""}`)
    for (const c of t.columns) {
      const tags = [
        c.notNull ? "not null" : undefined,
        c.logical === undefined ? undefined : `logical: ${c.logical}`,
        c.standard === undefined ? undefined : `standard: ${c.standard}`,
        c.scope === true ? "scope" : undefined,
      ].filter((x) => x !== undefined)
      lines.push(
        `  ${c.name} ${c.type}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`
      )
    }
    if (t.primaryKey !== undefined) {
      lines.push(`  primary key (${t.primaryKey.join(", ")})`)
    }
    for (const u of t.uniques) lines.push(`  unique (${u.join(", ")})`)
    for (const f of t.foreignKeys) {
      lines.push(`  foreign key (${f.columns.join(", ")}) -> ${f.references}`)
    }
  }
  for (const q of e.movementQueries) {
    lines.push("", `movement query ${q.identity}`, q.sql)
  }
  if (e.contracts.length > 0) {
    lines.push("", "contracts:", JSON.stringify(e.contracts, null, 2))
  }
  if (e.referencedBy.length > 0) {
    lines.push("", "referenced by:")
    for (const r of e.referencedBy) {
      lines.push(`  ${r.file}#${r.pointer} (${r.role})`)
    }
  }
  return `${lines.join("\n")}\n`
}
