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
   * `has_function_privilege(роль, функція, 'EXECUTE')` для кожної ролі профілю,
   * що існує в базі (з урахуванням членства й успадкування). Відсутня роль —
   * без ключа: `to_regrole` її не знаходить, і факт не вигадується.
   */
  executeByRole: Record<string, boolean>
  /** `has_schema_privilege(роль, схема, 'USAGE')` для тих самих ролей. */
  schemaUsageByRole: Record<string, boolean>
}

export interface ExecuteFacts {
  /** Ролі профілю провайдера, яких у базі немає (наприклад, ролі команд). */
  missingRoles: string[]
  /** Усі функції (не агрегати, не члени розширень) схем межі. */
  functions: FunctionExecuteFact[]
}
