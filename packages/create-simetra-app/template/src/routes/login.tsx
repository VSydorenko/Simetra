import { createFileRoute } from "@tanstack/react-router"
import { LoginView } from "../login-view"
import { loginMethodsFn } from "../server/login-methods-fn"

export const Route = createFileRoute("/login")({
  loader: () => loginMethodsFn(),
  component: function Login() {
    const { host } = Route.useRouteContext()
    const methods = Route.useLoaderData()
    return <LoginView scope={host} methods={methods} />
  },
})
