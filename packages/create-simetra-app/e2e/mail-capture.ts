// Захоплювач пошти e2e (Р-D5-5): транспорт, що пише кожен лист рядком JSON у
// файл прогону. Шаблон його не імпортує; збірка D7 — копія шаблону з підміненим
// `src/server/mail.ts` (`copyTemplateWithMailCapture`), де цей файл лежить поруч.
import { appendFileSync } from "node:fs"

/**
 * Рядкова стала, за якою видно, що захоплювач потрапив у збірку: це літерал, а
 * не коментар, тож мініфікація його не прибере. Пишеться в кожен лист, щоб
 * бандлер не відкинув її як невикористану.
 */
export const MAIL_CAPTURE_MARKER = "simetra-e2e-mail-capture"

/** Змінна з шляхом файлу прогону. */
export const MAIL_CAPTURE_FILE_ENV = "SIMETRA_E2E_MAIL_FILE"

export interface CapturedMail {
  to: string
  subject: string
  text: string
}

/** Шлях беремо з параметра, інакше зі змінної; без жодного з них — відмова. */
export function mailCapture(file?: string): {
  send(message: CapturedMail): Promise<void>
} {
  return {
    async send(message) {
      const path = file ?? process.env[MAIL_CAPTURE_FILE_ENV]
      if (!path) throw new Error(`${MAIL_CAPTURE_FILE_ENV} is not set`)
      appendFileSync(
        path,
        `${JSON.stringify({ marker: MAIL_CAPTURE_MARKER, ...message })}\n`
      )
    },
  }
}
