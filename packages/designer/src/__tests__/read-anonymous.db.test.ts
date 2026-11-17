import { describeAnonymousRead } from "./read-anonymous.support"

// Запит без сесії на `postgres` — порожні claims: ключа API, що ніс би роль,
// у профілі немає.
describeAnonymousRead({})
