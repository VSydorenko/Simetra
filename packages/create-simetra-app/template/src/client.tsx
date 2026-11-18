import { StartClient } from "@tanstack/react-start/client"
import { StrictMode, startTransition } from "react"
import { hydrateRoot } from "react-dom/client"

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    {
      // Відновлювана помилка гідратації — у журнал, а не мовчки
      onRecoverableError: (error, info) => {
        console.error(
          "[simetra] recoverable render error",
          error,
          info.componentStack
        )
      },
    }
  )
})
