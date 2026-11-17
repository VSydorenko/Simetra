import { PROVIDER_LOGIN_ROLES, type DatabaseProvider } from "simetra/model"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"

/** Attributes of the connected role that decide whether the owner gate passes. */
export interface OwnerAttributes {
  role: string
  bypassrls: boolean
  superuser: boolean
}

/**
 * Pure decision of the owner gate. The role that plans or applies becomes
 * the owner of the application's objects, so it must not be a shared login
 * of the provider's services (`PROVIDER_LOGIN_ROLES`): those services would
 * own the objects too. It must also bypass row-level security, or be a
 * superuser. A missing row is a refusal, never a pass (fail-closed). One
 * function for plan, apply and rehearsal, so the three entry points cannot
 * disagree.
 */
export function ownerRefusal(
  row: OwnerAttributes | undefined,
  provider: DatabaseProvider
): EngineDiagnostic | undefined {
  if (row !== undefined && PROVIDER_LOGIN_ROLES[provider].includes(row.role))
    return applyDiagnostic("plan.owner-provider-login", "error", {
      role: row.role,
    })
  return row !== undefined && (row.bypassrls || row.superuser)
    ? undefined
    : applyDiagnostic("plan.owner-not-bypassrls", "error")
}

/**
 * Reads the attributes of `current_user` on the transaction and applies
 * {@link ownerRefusal}. `current_user`, not `session_user`: the session role
 * may be switched by the `role` setting, and the objects get the current
 * one as their owner.
 */
export async function checkOwnerAttributes(
  tx: ApplyTransaction,
  provider: DatabaseProvider
): Promise<EngineDiagnostic | undefined> {
  const [row] = await tx.query<{
    role: string
    bypassrls: boolean
    superuser: boolean
  }>(
    "SELECT rolname AS role, rolbypassrls AS bypassrls, rolsuper AS superuser FROM pg_catalog.pg_roles WHERE rolname = current_user"
  )
  return ownerRefusal(row, provider)
}
