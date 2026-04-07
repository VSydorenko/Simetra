#!/usr/bin/env node
import { defineCommand, runMain } from "citty"
import { generate } from "./commands/generate"

const main = defineCommand({
  meta: {
    name: "simetra",
    version: "0.0.1",
    description: "Simetra CLI — генерація SQL з метаданих",
  },
  subCommands: {
    generate,
  },
})

runMain(main)
