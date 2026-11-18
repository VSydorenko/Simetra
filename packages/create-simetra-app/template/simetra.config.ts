// Теки проєкту метаданих і згенерованих каталогів: їх читають скрипт
// генерації й тест свіжості, щоб шляхи не розходилися.
export default {
  metadataDir: "metadata",
  generatedDir: "generated",
} as const
