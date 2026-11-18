import { describe, expect, it } from "vitest"
// Скрипти CI лежать у корені репо, де немає vitest; їхні чисті функції
// тестуються тут, у пакеті з тестовим раннером
import { changesCode } from "../../../scripts/ci/docs-only.mjs"

describe("changesCode", () => {
  it.each([
    { label: "docs file", files: ["docs/superpowers/specs/x.md"], code: false },
    {
      label: "non-md file under docs",
      files: ["docs/research/diagram.png"],
      code: false,
    },
    { label: "root .md", files: ["README.md"], code: false },
    {
      label: "harness .md outside packages",
      files: [".agents/skills/x/SKILL.md"],
      code: false,
    },
    {
      label: "docs and root .md",
      files: ["docs/ROADMAP.md", "AGENTS.md"],
      code: false,
    },
    {
      label: "package README",
      files: ["packages/simetra/README.md"],
      code: true,
    },
    {
      label: "consumer skill in a package",
      files: ["packages/designer/skills/x/SKILL.md"],
      code: true,
    },
    { label: "workflow", files: [".github/workflows/ci.yml"], code: true },
    { label: "kit profile", files: [".agents/kit.profile.json"], code: true },
    { label: "empty list", files: [], code: true },
    { label: "only blank lines", files: ["", "  "], code: true },
    {
      label: "mixed list",
      files: ["docs/GLOSSARY.md", "packages/simetra/src/index.ts"],
      code: true,
    },
  ] as const)("$label → code=$code", ({ files, code }) => {
    expect(changesCode(files)).toBe(code)
  })
})
