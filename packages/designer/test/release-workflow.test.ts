import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it } from "vitest"

// Trusted publisher на npmjs прив'язаний до файлу воркфлоу, а не до гілки:
// без цієї умови ручний запуск із неперевіреної гілки опублікував би її
it("publishes only from main", async () => {
  const workflow = await readFile(
    resolve(
      import.meta.dirname,
      "../../../.github/workflows/publish-packages.yml"
    ),
    "utf8"
  )
  expect(workflow).toMatch(/^\s+if: github\.ref == 'refs\/heads\/main'$/m)
})
