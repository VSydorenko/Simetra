export interface MovementBlock {
  /** З маркера: `<Name>` або `<Kind>.<Name>`. */
  register: string
  /** Рядки між маркерами, без самих маркерів. */
  sql: string
  /** 1-базний рядок маркера `-- @movements`. */
  line: number
}

export interface MovementBlockError {
  message: string
  line: number
}

const OPEN = "-- @movements"
const CLOSE = "-- @end"

/**
 * Виймає іменовані блоки запиту рухів з `.sql` документа (спека П2 §7).
 * Решта файлу — не блок і сюди не потрапляє. Кінцеві пробіли маркерів
 * ігноруються, бо редактори їх додають і прибирають невидимо. Працює над
 * рядком, без Node API: компілятор не читає диск.
 */
export function extractMovementBlocks(text: string): {
  blocks: MovementBlock[]
  errors: MovementBlockError[]
} {
  const blocks: MovementBlock[] = []
  const errors: MovementBlockError[] = []
  let open: { register: string; line: number; body: string[] } | undefined

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trimEnd()
    if (trimmed === CLOSE) {
      if (open === undefined) {
        errors.push({ message: `"${CLOSE}" without "${OPEN}"`, line })
        return
      }
      // Блок з порожнім іменем уже названо помилкою; у результат він не йде.
      if (open.register !== "") {
        blocks.push({
          register: open.register,
          sql: open.body.join("\n"),
          line: open.line,
        })
      }
      open = undefined
      return
    }
    if (trimmed === OPEN || trimmed.startsWith(`${OPEN} `)) {
      if (open !== undefined) {
        // Вкладений маркер не відкриває блок: інакше один пропущений `-- @end`
        // породив би лавину хибних помилок нижче.
        errors.push({
          message: `"${OPEN}" inside the block opened at line ${open.line}`,
          line,
        })
        return
      }
      const register = trimmed.slice(OPEN.length).trim()
      if (register === "") {
        errors.push({ message: `"${OPEN}" without a register name`, line })
      }
      open = { register, line, body: [] }
      return
    }
    open?.body.push(raw)
  })

  if (open !== undefined) {
    errors.push({
      message: `"${OPEN} ${open.register}" is not closed by "${CLOSE}"`,
      line: open.line,
    })
  }
  return { blocks, errors }
}

/**
 * 1-базні рядки маркерів з відступом: `extractMovementBlocks` їх не розпізнає
 * (маркер — увесь рядок), тож блок мовчки не потрапив би в рухи, а автор
 * вирішив би, що запит діє.
 */
export function indentedMarkerLines(text: string): number[] {
  const lines: number[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s+-- @(movements|end)\b/.test(raw)) lines.push(index + 1)
  })
  return lines
}
