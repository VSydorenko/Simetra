// Шов пошти застосунку (Р-D5-5). Шаблон не має транспорту: застосунок повертає
// свій. Підміна транспорту тестом — заміна цього модуля в копії шаблону, а не
// гілка в коді.

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>
}

export function appMailTransport(): MailTransport | undefined {
  return undefined
}
