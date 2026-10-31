import type { MetadataRef } from "../schemas/metadata-ref"
import type { ObjectOperation, Operation } from "./operation"
import type { ReadQuery } from "./read"

/**
 * The input of a phase a `beforeWrite` hook may change. Без `id` і `mark`:
 * хук не перенаправляє операцію на інший рядок, а позначку бачить у
 * `ctx.mark` (Р-A3-18).
 */
export interface Draft<E> {
  values?: Partial<E>
  tabularSections?: Record<string, Record<string, unknown>[]>
}

/** What a hook sees and may do within its phase (P4 spec §6.9). */
export interface HookContext {
  readonly object: MetadataRef
  readonly id: string
  /** The operation of the phase, not the action of the command context. */
  readonly action: ObjectOperation
  readonly isNew: boolean
  readonly mark?: boolean
  /** Data shared by the hooks of one phase. */
  readonly additionalProperties: Map<string, unknown>
  readonly user: string
  readonly act?: { sub: string }
  run(operation: Operation): Promise<Record<string, unknown>>
  read(query: ReadQuery): Promise<Record<string, unknown>[]>
  reject(code: string, path?: string): never
  afterCommit(fn: () => unknown): void
}

/**
 * Hooks of one object, keyed by 1C write events (P4 spec Рт20). Методи, а
 * не властивості-функції: так модуль типу сутності вкладається в мапу
 * `ObjectModule<object>` host-а.
 */
export interface ObjectModule<E extends object = Record<string, unknown>> {
  beforeWrite?(args: {
    ctx: HookContext
    draft: Draft<E>
  }): Draft<E> | Promise<Draft<E>>
  onWrite?(args: { ctx: HookContext; row: E }): void | Promise<void>
}

/** Keys an object module may define. */
export const OBJECT_MODULE_KEYS = ["beforeWrite", "onWrite"] as const

/** Types an object module by its generated entity type; returns it as is. */
export function defineObjectModule<E extends object>(
  module: ObjectModule<E>
): ObjectModule<E> {
  return module
}
