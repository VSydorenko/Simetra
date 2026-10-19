import { defineConfig } from "tsdown"

// Пакет іде з `dist`, розробка — на сирому TS через dev-`exports`. Ярус — окремий
// entry; публічна поверхня пакета — лише ці яруси (заглушки решти ярусів у
// `publishConfig.exports` не входять, щоб не обіцяти неіснуючого API).
export default defineConfig({
  entry: {
    "model/index": "src/model/index.ts",
    "compiler/index": "src/compiler/index.ts",
    "schema/index": "src/schema/index.ts",
  },
  format: "esm",
  platform: "node",
  target: "esnext",
  // `.js`/`.d.ts` за `"type": "module"`, а не `.mjs`: субшляхи `publishConfig`
  // пишуться один раз і не залежать від дефолту платформи
  fixedExtension: false,
  // Типи — dts-плагіном по файлу на entry, не `tsc`: `tsc` лишає відносні
  // імпорти без розширень, і споживач із `nodenext` типів не резолвить
  dts: true,
  outDir: "dist",
  deps: {
    // Ярус імпортує інший ярус лише через `simetra/<ярус>`; вбудований, він
    // дав би споживачу другу копію яруса (реєстр видів, схеми Zod)
    neverBundle: [/^simetra(\/|$)/],
  },
})
