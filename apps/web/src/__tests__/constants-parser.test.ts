import { describe, it, expect } from "vitest"
import { parseFileStructure, buildProjectModel } from "../storage/web-storage"

// Helper: створити файлову карту для constants parse
function makeConstantsFiles(
  constantsJson: string,
  projectJson = '{"name":"TestProject","schemaVersion":"1.0"}'
): Map<string, string> {
  const files = new Map<string, string>()
  files.set("project.meta.json", projectJson)
  files.set("constants/constants.meta.json", constantsJson)
  return files
}

const VALID_CONSTANT_1 = {
  kind: "Constant",
  name: "CompanyName",
  valueType: "String",
}

const VALID_CONSTANT_2 = {
  kind: "Constant",
  name: "MaxRetries",
  valueType: "Integer",
}

// Broken — missing required field "kind"
const BROKEN_CONSTANT = {
  name: "BadConstant",
  valueType: "String",
}

describe("parseFileStructure: constants", () => {
  it("valid wrapper — all constants parsed", () => {
    const wrapper = {
      constants: [VALID_CONSTANT_1, VALID_CONSTANT_2],
    }
    const files = makeConstantsFiles(JSON.stringify(wrapper))
    const { parsed, warnings } = parseFileStructure(files)

    expect(warnings).toHaveLength(0)
    const constants = parsed.objects.filter((o) => o.kind === "Constant")
    expect(constants).toHaveLength(2)
  })

  it("broken wrapper — graceful degradation: valid siblings preserved, broken items produce warnings", () => {
    const wrapper = {
      constants: [VALID_CONSTANT_1, BROKEN_CONSTANT, VALID_CONSTANT_2],
    }
    const files = makeConstantsFiles(JSON.stringify(wrapper))
    const { parsed, warnings } = parseFileStructure(files)

    // 2 valid constants should be preserved
    const constants = parsed.objects.filter((o) => o.kind === "Constant")
    expect(constants).toHaveLength(2)

    // 1 warning for the broken constant with correct address
    expect(warnings).toHaveLength(1)
    expect(warnings[0].filePath).toBe("constants/constants.meta.json")
    expect(
      warnings[0].errors.some((e: string) => e.includes("constants[1]"))
    ).toBe(true)
  })

  it("broken wrapper — warning includes error details", () => {
    const wrapper = {
      constants: [BROKEN_CONSTANT],
    }
    const files = makeConstantsFiles(JSON.stringify(wrapper))
    const { warnings } = parseFileStructure(files)

    expect(warnings).toHaveLength(1)
    expect(warnings[0].errors[0]).toContain("constants[0]")
  })

  it("legacy array format — backward compat", () => {
    const legacy = [VALID_CONSTANT_1, VALID_CONSTANT_2]
    const files = makeConstantsFiles(JSON.stringify(legacy))
    const { parsed, warnings } = parseFileStructure(files)

    expect(warnings).toHaveLength(0)
    const constants = parsed.objects.filter((o) => o.kind === "Constant")
    expect(constants).toHaveLength(2)
  })

  it("valid wrapper through full pipeline (buildProjectModel)", () => {
    const wrapper = {
      constants: [VALID_CONSTANT_1, VALID_CONSTANT_2],
    }
    const files = makeConstantsFiles(JSON.stringify(wrapper))
    const { parsed } = parseFileStructure(files)
    const { model, warnings } = buildProjectModel(parsed)

    expect(warnings).toHaveLength(0)
    expect(model.constants).toHaveLength(2)
    expect(model.constants[0].name).toBe("CompanyName")
    expect(model.constants[1].name).toBe("MaxRetries")
  })

  it("broken wrapper through full pipeline — valid constants reach model", () => {
    const wrapper = {
      constants: [VALID_CONSTANT_1, BROKEN_CONSTANT, VALID_CONSTANT_2],
    }
    const files = makeConstantsFiles(JSON.stringify(wrapper))
    const { parsed, warnings: parseWarnings } = parseFileStructure(files)
    const { model, warnings: buildWarnings } = buildProjectModel(parsed)

    // Parse-time warnings for broken constant
    expect(parseWarnings).toHaveLength(1)
    // Build-time: no additional warnings (valid items already parsed)
    expect(buildWarnings).toHaveLength(0)
    // Model has only valid constants
    expect(model.constants).toHaveLength(2)
  })
})
