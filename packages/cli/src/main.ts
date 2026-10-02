import { defineCommand, runMain } from "citty"

const main = defineCommand({
  meta: {
    name: "simetra",
    description: "Simetra metadata tooling",
  },
  subCommands: {
    // Ліниві підкоманди повертають саму команду, а не простір імен модуля.
    compile: () => import("./commands/compile").then((m) => m.default),
  },
})

void runMain(main)
