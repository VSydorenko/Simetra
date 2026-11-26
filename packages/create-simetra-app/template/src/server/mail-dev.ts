import { appMailTransport, type MailMessage, type MailTransport } from "./mail"

/** Транспорт розробки: лист іде в журнал процесу. У production не вживається. */
export const devMailTransport: MailTransport = {
  send(message: MailMessage): Promise<void> {
    console.info(
      `[simetra] mail to ${message.to}: ${message.subject}\n${message.text}`
    )
    return Promise.resolve()
  },
}

/** Транспорт застосунку, а поза production — розробки; у production без першого `undefined`. */
export function mailTransport(): MailTransport | undefined {
  const app = appMailTransport()
  if (app !== undefined) return app
  return process.env.NODE_ENV === "production" ? undefined : devMailTransport
}
