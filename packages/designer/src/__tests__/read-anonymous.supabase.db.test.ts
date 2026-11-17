import { claimsFor } from "../../../simetra/test/support"
import { describeAnonymousRead } from "./read-anonymous.support"

// Запит без сесії на `supabase` — claims ключа `anon`: лише роль, без `sub`.
describeAnonymousRead(claimsFor("anonymous"))
