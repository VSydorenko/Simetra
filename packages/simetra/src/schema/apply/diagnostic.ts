import {
  localize,
  type DiagnosticParams,
  type RuleCode,
  type Severity,
} from "simetra/compiler"
import type { EngineDiagnostic } from "../engine"

/**
 * Діагностика стану, плану й застосування. Серйозність — властивість
 * випадку, а не правила: той самий код буває й попередженням. `message` —
 * англійською; інші мови споживач будує з коду й параметрів.
 */
export function applyDiagnostic(
  code: RuleCode,
  severity: Severity,
  params: DiagnosticParams = {}
): EngineDiagnostic {
  return {
    code,
    severity,
    message: localize({ code, params }, "en").message,
    params,
  }
}
