import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"

/** Attributes of the connected role that decide whether the owner gate passes. */
export interface OwnerAttributes {
  bypassrls: boolean
  superuser: boolean
}

/**
 * Pure decision of the owner gate (decision Р10): the role that plans or
 * applies must bypass row-level security, or be a superuser. A missing row is
 * a refusal, never a pass (fail-closed). One function for plan, apply and
 * rehearsal, so the three entry points cannot disagree.
 */
export function ownerRefusal(
  row: OwnerAttributes | undefined
): EngineDiagnostic | undefined {
  return row !== undefined && (row.bypassrls || row.superuser)
    ? undefined
    : applyDiagnostic("plan.owner-not-bypassrls", "error")
}

/**
 * Reads the attributes of `current_user` on the transaction and applies
 * {@link ownerRefusal}. `current_user`, not `session_user`: the session role
 * may be switched by the `role` setting, and the privileges are the current one's.
 */
export async function checkOwnerAttributes(
  tx: ApplyTransaction
): Promise<EngineDiagnostic | undefined> {
  const [row] = await tx.query<{ bypassrls: boolean; superuser: boolean }>(
    "SELECT rolbypassrls AS bypassrls, rolsuper AS superuser FROM pg_catalog.pg_roles WHERE rolname = current_user"
  )
  return ownerRefusal(row)
}
