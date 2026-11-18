/*
 * Геометрія слотів хостів T5 (спека П4-D §5): єдине джерело значень. Розміри
 * фіксовані, щоб гідратація й прокрутка не рухали видимого. Візуальна мова
 * перевизначає CSS-змінні, а типове значення завжди йде запасним у `var()`,
 * тож споживач без жодного CSS-файлу не отримує авто-розмір. Віртуалізатору
 * потрібні пікселі числом, тому висоти рядка й списку — без змінних.
 */

/** Row slot height, px; the row height estimate equals it. */
export const ROW_HEIGHT = 40

/** Visible height of the list scroll area, px. */
export const LIST_HEIGHT = 600

/** Width of the state cell; override with `--simetra-state-cell-width`. */
export const STATE_CELL_WIDTH = "var(--simetra-state-cell-width, 160px)"

/** Height of the selection panel; override with `--simetra-selection-panel-height`. */
export const SELECTION_PANEL_HEIGHT =
  "var(--simetra-selection-panel-height, 32px)"

/** Width of the reserved selection-count slot; override with `--simetra-selection-count-width`. */
export const SELECTION_COUNT_WIDTH =
  "var(--simetra-selection-count-width, 96px)"
