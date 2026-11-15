import { afterAll, afterEach, onTestFinished, TestRunner } from "vitest"
import {
  expectFileConnectionRoles,
  expectFileEndRoles,
  useTestHooks,
} from "./connection"

/**
 * setupFile DB-проєкту simetra на стеку `postgres`: дрейф ролі ловиться в
 * тесті, що його спричинив (спека профілю §10.3, запобіжник 3). Клієнтів, що
 * хелпер відкрив у тесті, перевіряє `onTestFinished` самого хелпера; тут —
 * ті, що відкриті поза тестом, після кожного тесту, а пули й нове з'єднання
 * з адреси тестів — наприкінці файлу.
 */
useTestHooks({
  current: () => TestRunner.getCurrentTest(),
  onFinished: (check) => onTestFinished(check),
})
afterEach(({ task }) => expectFileConnectionRoles(task))
afterAll(expectFileEndRoles)
