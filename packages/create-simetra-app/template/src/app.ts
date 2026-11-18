import { clientCatalogSchema } from "simetra/model"
import { simetraApp } from "simetra/shell"
import clientCatalogJson from "../generated/client-catalog.json"

// Один розбір на модуль: рантайм і хости T5 читають той самий об'єкт (§5),
// тож розбіжності між ними бути не може.
const clientCatalog = clientCatalogSchema.parse(clientCatalogJson)

export const app = simetraApp(clientCatalog)

/** Хеш каталогу клієнта: ним позначено відмови, що не дійшли до сервера. */
export const clientHash: string = clientCatalog.snapshotHash

// Дескриптори об'єктів для маршрутів: невідомий об'єкт падає при імпорті
// модуля, а не першим переходом (спека П4-D §6)
export const Client = app.object({ kind: "Catalog", name: "Client" })
export const Country = app.object({ kind: "Catalog", name: "Country" })
