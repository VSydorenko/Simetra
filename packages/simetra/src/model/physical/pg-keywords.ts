// Portions copied from PostgreSQL (https://github.com/postgres/postgres, branch REL_17_STABLE):
// src/include/parser/kwlist.h
// Portions Copyright (c) 1996-2024, PostgreSQL Global Development Group
// Portions Copyright (c) 1994, Regents of the University of California
// Licensed under the PostgreSQL License. Modified: only the keywords that are
// not UNRESERVED_KEYWORD, as a TypeScript set grouped by category.

/**
 * Ключові слова Postgres, які `quote_ident` бере в лапки: усі, що не
 * UNRESERVED_KEYWORD у `kwlist.h` (зарезервовані, col_name і
 * type_func_name). Один список для обох ролей: точна поведінка `quote_ident`
 * (від неї залежить збіг імен у знімку й у каталозі БД) і те, що платформа
 * вважає зарезервованим словом у фізичних іменах — інакше ім'я, яке БД не
 * потребує брати в лапки, отримувало б зайвий суфікс.
 */
export const PG_QUOTED_KEYWORDS: ReadonlySet<string> = new Set([
  // RESERVED_KEYWORD
  ...`all analyse analyze and any array as asc asymmetric both case cast check
  collate column constraint create current_catalog current_date current_role
  current_time current_timestamp current_user default deferrable desc distinct
  do else end except false fetch for foreign from grant group having in
  initially intersect into lateral leading limit localtime localtimestamp not
  null offset on only or order placing primary references returning select
  session_user some symmetric system_user table then to trailing true union
  unique user using variadic when where window with`.split(/\s+/),
  // TYPE_FUNC_NAME_KEYWORD
  ...`authorization binary collation concurrently cross current_schema freeze
  full ilike inner is isnull join left like natural notnull outer overlaps
  right similar tablesample verbose`.split(/\s+/),
  // COL_NAME_KEYWORD
  ...`between bigint bit boolean char character coalesce dec decimal exists
  extract float greatest grouping inout int integer interval json json_array
  json_arrayagg json_exists json_object json_objectagg json_query json_scalar
  json_serialize json_table json_value least merge_action national nchar none
  normalize nullif numeric out overlay position precision real row setof
  smallint substring time timestamp treat trim values varchar xmlattributes
  xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi
  xmlroot xmlserialize xmltable`.split(/\s+/),
])

/** Слово, яке `quote_ident` бере в лапки; регістр не важливий. */
export function isSqlReservedWord(name: string): boolean {
  return PG_QUOTED_KEYWORDS.has(name.toLowerCase())
}
