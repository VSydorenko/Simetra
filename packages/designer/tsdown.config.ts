import { defineConfig } from "tsdown"

// Пакет — лише CLI: один entry, ліниві `import()` команд лишаються окремими
// чанками, тож `--help` не вантажить компілятор і SDK MCP. `simetra` і решта
// `dependencies` зовнішні — споживач ставить їх поруч.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: "esm",
  platform: "node",
  target: "esnext",
  fixedExtension: false,
  dts: false,
  outDir: "dist",
  // `publishConfig.bin` вказує на `dist/main.js`: без shebang npm-симлінк не запуститься
  banner: { js: "#!/usr/bin/env node" },
})
