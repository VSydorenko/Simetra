import { KIND_REGISTRY } from "./kinds/registry"
import { projectSchema } from "./schemas/project"
import type { MetadataKind } from "./schemas/metadata-kind"

/** Ключі project.meta.json — у порядку оголошення схеми проєкту. */
export const PROJECT_KEY_ORDER: readonly string[] = Object.keys(
  projectSchema.shape
)

/**
 * Переставляє лише ключі верхнього рівня: вкладені елементи (реквізити,
 * колонки) реєстр порядком не описує, тож їхній вхідний порядок зберігається.
 * Невідомі ключі не губляться — вони йдуть після відомих у вхідному порядку,
 * щоб форматер не маскував помилку, яку покаже валідація.
 */
function orderKeys(
  data: Record<string, unknown>,
  keyOrder: readonly string[]
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  for (const key of keyOrder) {
    if (Object.hasOwn(data, key)) ordered[key] = data[key]
  }
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value
  }
  return ordered
}

function serialize(data: Record<string, unknown>): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

function isKnownKind(kind: unknown): kind is MetadataKind {
  return typeof kind === "string" && Object.hasOwn(KIND_REGISTRY, kind)
}

/**
 * Канонічна форма файлу `.meta.json` (спека П2 §3): порядок ключів за видом,
 * відступ у два пробіли, завершальний перевід рядка. Файл невідомого виду
 * лишається в порядку входу — вид відхилить стадія 1, а не форматер.
 */
export function formatMetaFile(data: Record<string, unknown>): string {
  const keyOrder = isKnownKind(data.kind)
    ? KIND_REGISTRY[data.kind].keyOrder
    : []
  return serialize(orderKeys(data, keyOrder))
}

/** Канонічна форма `project.meta.json`. */
export function formatProjectFile(data: Record<string, unknown>): string {
  return serialize(orderKeys(data, PROJECT_KEY_ORDER))
}
