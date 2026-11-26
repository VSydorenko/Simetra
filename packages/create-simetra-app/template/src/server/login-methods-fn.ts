import { createServerFn } from "@tanstack/react-start"
import { authSettings } from "./config"
import { loginMethodsOf } from "./login-methods"

/** Сторінка входу публічна, тож відповідь не несе нічого, крім способів (Р-D5-12). */
export const loginMethodsFn = createServerFn({ method: "GET" }).handler(() =>
  loginMethodsOf(authSettings())
)
