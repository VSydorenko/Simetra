import type { AuthSettings } from "./config"

/** Способи входу для екрана: лише прапорці й ідентифікатори, без секретів. */
export interface LoginMethods {
  password: boolean
  emailCode: boolean
  providers: string[]
}

/**
 * Явний перелік полів, а не розгортання `AuthSettings`: ідентифікатори й
 * client id провайдерів лежать поруч із секретами, і нове поле налаштувань не
 * повинно потрапити в публічну відповідь мовчки (Р-D5-12).
 */
export function loginMethodsOf(settings: AuthSettings): LoginMethods {
  return {
    password: settings.password,
    emailCode: settings.emailCode,
    providers: settings.providers.map((provider) => provider.id),
  }
}
