import { createFileRoute } from "@tanstack/react-router"
import { LoginView } from "../login-view"

export const Route = createFileRoute("/login")({
  component: function Login() {
    const { host } = Route.useRouteContext()
    return <LoginView scope={host} />
  },
})
