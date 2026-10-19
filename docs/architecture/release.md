# Реліз: публікація пакетів на npmjs

Публікуються `simetra` і `@simetrajs/designer`; решта пакетів workspace —
`private`. Рішення й причини — [платформна спека](../superpowers/specs/2026-09-24-simetra-platform-design.md)
§11 «Доставка» і рішення Р1 (одна версія на всі пакети).

## Що в пакеті

Розробка йде на сирому TS: dev-`exports` і dev-`bin` ведуть у `src/` і
`bin/simetra.mjs`. Пакет збирається tsdown у `dist/`, і `pnpm pack` бере поля
`publishConfig`, тож споживач отримує лише зібране:

- `simetra` — по entry на ярус (`model`, `compiler`, `schema`) з `.d.ts`,
  плюс `schemas/` для `$schema` файлів метаданих. Самопосилання
  `simetra/<ярус>` у `dist` лишаються зовнішніми: ярус існує в одному
  екземплярі. Заглушки ярусів без API в пакет не входять.
- `@simetrajs/designer` — `dist/main.js` як бінарник `simetra` і скіли
  споживача `skills/`.

Склад і поведінку пакетів тримає гейт пакування:

```bash
pnpm build:packages && pnpm test:packaging
```

Він пакує tarball-и, ставить їх через `npm install` у тимчасовий проєкт
споживача і проганяє імпорт ярусів у чистому Node, `simetra --version`,
`compile`, `fix` (шлях `$schema` у `node_modules/simetra/schemas/`), MCP,
publint і arethetypeswrong. Той самий гейт іде job `packaging` у CI і кроком
перед публікацією.

## Як випустити версію

1. Підняти версію **в усіх** не-`private` маніфестах `packages/*` до одного
   числа (`X.Y.Z` або пререліз `X.Y.Z-rc.N`) і `PLATFORM_VERSION` у
   `packages/simetra/src/schema/apply/version.ts` (рівність тримає тест)
   окремим комітом `chore(release): vX.Y.Z`. Версія платформи входить у стан
   застосування й артефакт плану: `apply` відмовляє файлу плану, зробленому
   іншою версією, тож незастосовані плани після релізу будуються заново.
2. Перед комітом — гейти з `AGENTS.md` § "Commands and gates", `pnpm test:db`
   і гейт пакування.
3. Merge у `main`. Воркфлоу `.github/workflows/publish-packages.yml` збирає
   пакети, проганяє гейт пакування, публікує версії, яких ще немає в реєстрі
   (`scripts/release/publish.mts`), і ставить тег `vX.Y.Z`.

Воркфлоу публікує лише з `main`: ручний запуск з іншої гілки пропускає job,
бо trusted publisher прив'язаний до файлу воркфлоу, а не до гілки. Пререліз
іде під dist-tag `next`, решта — `latest`. Merge без підняття версії
нічого не публікує. Повторний запуск воркфлоу (`workflow_dispatch`) безпечний:
опубліковане пропускається, наявний тег лишається.

`node scripts/release/publish.mts --dry-run` показує, що поїде, без публікації.

## Авторизація: Trusted Publishing

CI публікує без токена: npm CLI (≥ 11.5.1) обмінює OIDC-токен GitHub Actions
на право публікації й додає provenance. Trusted publisher налаштовується на
npmjs для кожного пакета окремо, і лише для пакета, який уже є в реєстрі.

Provenance звіряє `repository.url` маніфесту з репо воркфлоу: поле має вести
рівно на репо, з якого йде публікація. Перенос репо — це правка
`repository.url` в обох маніфестах і trusted publisher обох пакетів.

## Перша публікація нового пакета

Робить власник, бо до першої версії trusted publisher налаштувати неможливо:

1. `npm login` (з 2FA), `npm whoami`; акаунт — член організації `simetrajs` з
   правом публікації.
2. На релізному коміті: `pnpm install --frozen-lockfile && pnpm build:packages
   && pnpm test:packaging && node scripts/release/publish.mts`. npm просить
   2FA для кожного пакета; опубліковане раніше пропускається.
3. npmjs.com → пакет → Settings → Trusted Publisher → GitHub Actions:
   власник і репо з `repository.url`, workflow `publish-packages.yml`,
   environment порожнє. Там само Publishing access → «Require two-factor
   authentication and disallow tokens».
4. Merge у `main`: воркфлоу бачить версію опублікованою, нічого не публікує й
   ставить тег. Наступні версії публікує CI.

Новий публічний пакет додається в `PUBLISH_ORDER` скрипту публікації (залежність
раніше за залежного) — скрипт падає на публічному пакеті поза списком.

## Типові проблеми

| Симптом | Причина | Що робити |
| --- | --- | --- |
| `404 Not Found - PUT` під час публікації в CI | trusted publisher для пакета не налаштовано або налаштовано на інший репо чи файл воркфлоу | перевірити налаштування пакета на npmjs; новий пакет — перша публікація вручну |
| `401` / `ENEEDAUTH` | немає `registry-url` у `actions/setup-node` — `.npmrc` не створився | повернути `registry-url` |
| крок «Check npm version» червоний | npm, що йде з Node з `.node-version`, старіший за 11.5.1 | підняти Node або поставити новіший npm у воркфлоу |
| `402 Payment Required` | scoped-пакет без `publishConfig.access: "public"` | додати поле |
| provenance відхилено | `repository.url` не збігається з репо воркфлоу | виправити `repository.url` |
| `versions differ` зі скрипта | версії маніфестів розійшлися (Р1) | підняти всі до одного числа |
