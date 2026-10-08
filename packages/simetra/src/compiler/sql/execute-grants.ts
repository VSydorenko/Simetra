import {
  PROVIDER_API_ROLES,
  quoteIdent,
  type ApiRolePurpose,
  type DatabaseProvider,
} from "simetra/model"

/**
 * Право виконання згенерованої функції — лише ролям API названих призначень
 * (платформна спека §6.7: дефолт — `REVOKE ALL`). Postgres дає `EXECUTE`
 * `PUBLIC`, а провайдер — ще й своїм ролям API типовими привілеями схеми, тож
 * відкликаються обидва джерела. Кожен оператор — на одного отримувача: у тій
 * самій формі гранти читає extract, і зворотна генерація впізнає їх як
 * описані. `signature` — `схема.ім'я(типи)`, як у `ON FUNCTION`.
 */
export function executeGrants(
  signature: string,
  purposes: readonly ApiRolePurpose[],
  provider: DatabaseProvider
): string[] {
  const apiRoles = PROVIDER_API_ROLES[provider]
  const roles = purposes.map((purpose) => apiRoles[purpose])
  const revoked = Object.values(apiRoles).filter(
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
