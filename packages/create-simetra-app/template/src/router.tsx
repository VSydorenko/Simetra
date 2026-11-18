import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

// Фабрика на кожен запит; опції роутера (§4.6) додає D3.
export function getRouter() {
  return createRouter({ routeTree })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
