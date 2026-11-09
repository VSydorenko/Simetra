import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  quoteIdent,
  type DatabaseProvider,
  type GrantPurpose,
  type PlatformRolePurpose,
} from "simetra/model"

/**
 * Право виконання згенерованої функції — лише ролям названих призначень
 * (платформна спека §6.7: дефолт — `REVOKE ALL`). Postgres дає `EXECUTE`
 * `PUBLIC`, а провайдер — ще й своїм ролям API типовими привілеями схеми, тож
 * відкликаються обидва джерела. Роль платформи типових привілеїв провайдера
 * не має, тож її неназвану нічого відкликати: `REVOKE` — лише ролям API.
 * Кожен оператор — на одного отримувача: у тій самій формі гранти читає
 * extract, і зворотна генерація впізнає їх як описані. `signature` —
 * `схема.ім'я(типи)`, як у `ON FUNCTION`.
 */
export function executeGrants(
  signature: string,
  purposes: readonly GrantPurpose[],
  provider: DatabaseProvider
): string[] {
  const apiRoles = PROVIDER_API_ROLES[provider]
  // Призначення без ролі в профілі (`null`) ні відкликати, ні надати нічого
  const roles = purposes
    .map((purpose) => grantRole(purpose, provider))
    .filter((role): role is string => typeof role === "string")
  const revoked = Object.values(apiRoles)
    .filter((role): role is string => typeof role === "string")
    .filter((role) => !roles.includes(role))
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

/**
 * Ім'я ролі за призначенням: роль API — від провайдера, роль платформи — та
 * сама для кожного провайдера. `null` — профіль провайдера не має ролі за цим
 * призначенням; кожен виклик її пропускає.
 */
export function grantRole(
  purpose: GrantPurpose,
  provider: DatabaseProvider
): string | null {
  // `?? null`: відсутній ключ мапи (`undefined`) не має просочитися в SQL
  // як `"undefined"` — він означає те саме, що й `null`
  return (
    (isPlatformPurpose(purpose)
      ? PLATFORM_ROLES[purpose]
      : PROVIDER_API_ROLES[provider][purpose]) ?? null
  )
}

function isPlatformPurpose(
  purpose: GrantPurpose
): purpose is PlatformRolePurpose {
  return Object.hasOwn(PLATFORM_ROLES, purpose)
}
