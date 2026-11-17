/*
 * Віртуалізатору потрібні пікселі числом, а не CSS-змінна: значення тут і
 * в `slots.css` мають збігатися, і це перевіряє тест геометрії. Оцінка висоти
 * рядка дорівнює самій висоті, тож гідратація й прокрутка не рухають видимого.
 */

/** Row slot height, px: `--simetra-row-height` in `slots.css`. */
export const ROW_HEIGHT = 40

/** Visible height of the list scroll area, px: `--simetra-list-height` in `slots.css`. */
export const LIST_HEIGHT = 600
