import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@workspace/ui/globals.css"
import "./i18n"
import { App } from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { clearLegacyCredentials } from "@/storage/session-db"

// Одноразовий cleanup legacy credentials (PAT більше не зберігається в SPA)
void clearLegacyCredentials()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>
)
