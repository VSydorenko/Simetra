/**
 * Факти `EXECUTE` з каталогу бази: вхід зворотної генерації для декларацій
 * definer-функцій (спека декларацій функцій §5.5). Одиниці extract не несуть
 * типового `PUBLIC`, типових привілеїв провайдера, грантора, опції передачі й
 * членства, тож дієвий `EXECUTE` береться лише звідси. Читає факти designer
 * в одному знімку з extract (`SchemaEngine.extractWithExecuteFacts`).
 */

/** Один запис ACL функції (`aclexplode`). */
export interface ExecuteAclEntry {
  /** Ім'я ролі; `PUBLIC` — отримувач з oid 0. */
  grantee: string
  grantor: string
  /** Опція передачі (`WITH GRANT OPTION`). */
  grantable: boolean
}

/** Факти однієї функції схеми межі; ключ — `(schema, name, identityArguments)`. */
export interface FunctionExecuteFact {
  schema: string
  name: string
  /** `pg_get_function_identity_arguments`: розрізняє перевантаження. */
  identityArguments: string
  owner: string
  /**
   * Дієвий ACL: `aclexplode(coalesce(proacl, acldefault('f', proowner)))`, тож
   * типовий `EXECUTE` для `PUBLIC` і власника видно, а не домислюється.
   */
  acl: ExecuteAclEntry[]
  /**
   * Дієвий `EXECUTE` кожної ролі профілю, що існує в базі, виведений зі
   * знімка: ACL функції (`acl`), членство з урахуванням `inherit`, власник.
   * Відсутня роль — без ключа: факт не вигадується.
   */
  executeByRole: Record<string, boolean>
  /**
   * Дієвий `USAGE` тих самих ролей на схемі функції: `nspacl` (типовий ACL
   * схеми, коли він порожній), членство, власник схеми.
   */
  schemaUsageByRole: Record<string, boolean>
}

/**
 * Розбіжність виведеного зі знімка з власною перевіркою привілеїв бази
 * (`has_function_privilege`, `has_schema_privilege`): ознака, що ACL чи
 * членство змінилися між читаннями. Читач її не вирішує, а повідомляє.
 */
export interface ExecuteCrossCheckFailure {
  schema: string
  name: string
  identityArguments: string
  role: string
  privilege: "EXECUTE" | "USAGE"
}

export interface ExecuteFacts {
  /** Ролі профілю провайдера, яких у базі немає (наприклад, ролі команд). */
  missingRoles: string[]
  /** Усі функції (не агрегати, не члени розширень) схем межі. */
  functions: FunctionExecuteFact[]
  /** Порожній, коли виведене зі знімка збігається з перевіркою бази. */
  crossCheckFailures: ExecuteCrossCheckFailure[]
  /**
   * Відбиток прав знімка (функції й схеми межі, ролі профілю та їхнє
   * членство) не збігся з відбитком, перечитаним на новому з'єднанні після
   * знімка: стан, з якого виведено факти, уже не той, що в базі. Звірка
   * `has_*` цього не ловить: вона дивиться на oid знімка, а роль чи функцію
   * могли перейменувати, видалити, створити наново або додати.
   */
  catalogChanged: boolean
}
