import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

// Перевірка платформного `waitUntil` без бази: дія після відповіді пише
// рядок у журнал функції; його читають журнали рантайму Vercel.
export const deferProbe = createServerFn({ method: "GET" }).handler(() => {
  const request = getRequest() as Request & {
    waitUntil?: (p: Promise<unknown>) => void
  }
  const id = crypto.randomUUID()
  const respondedAt = Date.now()
  const work = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.log(
        `P0A_DEFER id=${id} respondedAt=${respondedAt} ranAt=${Date.now()}`
      )
      resolve()
    }, 1500)
  )
  const path =
    typeof request.waitUntil === "function" ? "request.waitUntil" : "none"
  if (path === "request.waitUntil") request.waitUntil!(work)
  return { id, respondedAt, path }
})
