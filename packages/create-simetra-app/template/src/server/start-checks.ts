import runtimeCatalog from "../../generated/runtime-catalog.json"
import { authSettings } from "./config"
import { appMailTransport } from "./mail"

/**
 * Відмови старту входу (Р-D5-2): хибне значення Р-D5-1 кидає `authSettings`;
 * тут — суперечності між налаштуваннями й рештою застосунку. Викликається з
 * `startupPlugin` і з `src/server.ts`, як решта відмов (причина — у плагіні).
 */
export function assertAuthStartable(): void {
  const settings = authSettings()
  const selfSignUp =
    (runtimeCatalog as { selfSignUp?: true }).selfSignUp === true
  if (settings.signUp === "open" && !selfSignUp) {
    throw new Error(
      'SIMETRA_SIGN_UP=open needs "selfSignUp": true in the project metadata'
    )
  }
  if (
    settings.emailCode &&
    process.env.NODE_ENV === "production" &&
    appMailTransport() === undefined
  ) {
    throw new Error(
      "SIMETRA_SIGN_IN_METHODS lists email-code, but the app has no mail transport (appMailTransport) in production"
    )
  }
}
