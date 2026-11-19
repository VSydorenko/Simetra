import { describeSignalDelivery } from "../../src/__tests__/signal-delivery.support"

// Заміри затримки «коміт → подія клієнта» з LISTEN на стенді сигналів (ціль
// спеки профілю postgres §5: p95 ≤ 50 мс); гейт доставки — у test:db
describeSignalDelivery("bench")
