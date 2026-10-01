import type { MetadataKind, PhysicalSnapshot, Project } from "simetra/model"
import type { Diagnostic } from "./diagnostics"
import { withRanges } from "./locate"
import type { Contracts } from "./contracts"
import type { Presentation } from "./presentation"
import type { ResolvedReference } from "./stages/identity"
import type { CreationNode } from "./sql/dependencies"
import type { SqlUnit } from "./sql/units"
import { readFiles, runStages } from "./pipeline"

export interface SourceObject {
  id: string
  kind: MetadataKind
  name: string
  file: string
  /** Модуль об'єкта: один неявний модуль з іменем проєкту. */
  module: string
  /** Вихід Zod-схеми виду. */
  data: unknown
  /** Вид скоупу об'єкта; відсутній — «без скоупу» (`none`, поле або вид без скоупу). */
  scopeKindId?: string
}

export interface CompiledScopeKind {
  id: string
  name: string
  physicalName: string
  root:
    | { objectId: string }
    | { external: { schema: string; table: string; column: string } }
  setFunction: { schema: string; name: string }
  onRootDelete: "restrict" | "cascade"
}

export interface CompiledModel {
  project: Project
  /** Порядок METADATA_KINDS, далі ім'я. */
  objects: SourceObject[]
  /** Один неявний модуль з іменем проєкту; за `name`. */
  modules: { name: string }[]
  /** Дії над кожним об'єктом з реєстру видів; за `objectId`. */
  actions: { objectId: string; actions: readonly string[] }[]
  /** За `name`. */
  scopeKinds: CompiledScopeKind[]
  /** За (file, pointer). */
  references: ResolvedReference[]
  moduleFiles: { file: string; ownerObjectId: string }[]
  physical: PhysicalSnapshot
  /** Дослівні одиниці `.sql` і обгортки запитів рухів; за `identity`. */
  sqlUnits: SqlUnit[]
  /**
   * Спільний порядок створення енам-типів, таблиць і одиниць: розширення
   * перші, далі топологічно з tie-break (тип вузла, схема, ім'я/ідентичність).
   */
  creationOrder: CreationNode[]
  contracts: Contracts
  /**
   * Подання: мова за замовчуванням і блоки об'єктів (`objects` — за
   * `objectId`, лише об'єкти з полями подання).
   */
  presentation: Presentation
  /** Hex sha256 канонічного знімка (RFC 8785); його звіряє П3. */
  hash: string
}

export interface CompileResult {
  ok: boolean
  diagnostics: Diagnostic[]
  /** Лише коли прогін без помилок: наступні шари не бачать напівмоделі. */
  model?: CompiledModel
}

/**
 * Компілятор — чиста функція над мапою «шлях відносно `metadata/` → вміст»
 * (спека П2 §8.2): читання диска — справа CLI, тож одна реалізація служить
 * CLI, MCP, тестам і студії. Повертає всі діагностики прогону, а не першу.
 * Асинхронна, бо парсер Postgres — WASM, який вантажиться один раз на процес.
 */
export async function compile(
  files: ReadonlyMap<string, string>
): Promise<CompileResult> {
  const result = await runStages(readFiles(files))
  // Діапазони дописуються в одному місці, а не стадіями: стадії знають лише
  // pointer, а текст файлу їм не потрібен.
  return {
    ...result,
    diagnostics: withRanges(result.diagnostics, files),
  }
}
