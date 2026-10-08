import {
  PROVIDER_FUNCTION_GRANTEES,
  quoteIdent,
  type DatabaseProvider,
} from "simetra/model"

/**
 * Право виконання згенерованої функції — лише названим ролям (платформна
 * спека §6.7: дефолт — `REVOKE ALL`). Postgres дає `EXECUTE` `PUBLIC`, а
 * провайдер — ще й своїм ролям типовими привілеями схеми, тож відкликаються
 * обидва джерела. Кожен оператор — на одного отримувача: у тій самій формі
 * гранти читає extract, і зворотна генерація впізнає їх як описані.
 * `signature` — `схема.ім'я(типи)`, як у `ON FUNCTION`.
 */
export function executeGrants(
  signature: string,
  roles: readonly string[],
  provider: DatabaseProvider
): string[] {
  const revoked = PROVIDER_FUNCTION_GRANTEES[provider].filter(
    (role) => !roles.includes(role)
  )
  return [
    `REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`,
    ...revoked.map(
      (role) =>
        `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${quoteIdent(role)};`
    ),
    ...roles.map(
      (role) => `GRANT EXECUTE ON FUNCTION ${signature} TO ${quoteIdent(role)};`
    ),
  ]
}
