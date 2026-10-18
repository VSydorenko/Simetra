# Права-1b: набори прав і ролі — план імплементації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Статус: прийнято архітектором задачі 2026-10-18 після аудиту Codex.
Архітектор задачі — сесія, що замовила план (`consumer-reconciliation2`);
якщо її немає — власник.

**Мета:** нові види без сховища `RightsSet` і `Role`; компілятор розгортає
гранти ролей (набори, `grantAll`, `deny`, частковий порядок обсягів, граф
вимог), перевіряє рівні призначення й віддає проєкцію прав як дані — без SQL.

**Архітектура:** види — записи реєстру з `materializes: "none"` за прецедентом
`EventSubscription`; посилання ролей і наборів (набори, об'єкти, вид скоупу,
контейнер, виміри, кастомні дії, джерела) — у загальному індексі, тож каскад
`rename`/`delete` працює без нового коду операцій; розгортання — чиста функція
над контрактами прав об'єктів плану 1a; результат — `contracts.roles` і
`contracts.rightsProjection`.

**Стек:** TypeScript 7 (native `tsc`), Zod 4, Vitest, pnpm workspace.

**Спека:** [спека прав](../specs/2026-10-17-rights-design.md) §2 (Рх3–Рх9, Рх16,
Рх18–Рх20), §3, §4.1, §4.4, §4.7; [спека П2](../specs/2026-09-28-p2-metamodel-compiler-design.md)
§3 («Призначене раз»), §8.

**Залежність:** план [Права-1a](2026-10-18-rights-1a-carriers-contract.md)
виконано повністю: є `KindAction`, `actionRequires`, `closeRequires`,
`RightsContract` (з `actions[].extents`, `ownership`, `access`, `container`,
`binding`), `Contracts.accessDimensions`, `Contracts.assignmentSources`,
`assignedOnSchema`, `CompiledAssignedOn`, `projectReferences?`,
`idElementFields`, `checkRights`, `membershipOfScopeKind`, коди
`rights.action-unknown`, `rights.dimension-unknown`, `rights.scope-kind-unknown`,
`rights.container-target`, `rights.users-missing`. Перед стартом виконавець
звіряє ці імена з кодом (`orient --plan`).

## Global Constraints

- Усі обмеження плану Права-1a (розділ «Global Constraints») діють і тут: T0 лише на `zod`, строгі схеми, реєстр замість назви виду, без шимів, індекс посилань і ратчет полів без винятків, коди en/uk, регенерація JSON Schema, `pnpm --filter <pkg> test <pattern>` без `--`, коміти українською без трейлерів, синтетичні приклади.
- Ролі в `examples/` не додаються (перехід прикладів — Права-2).
- Поза планом: SQL проєкції й функцій прав, системні об'єкти, запобіжники §7, перевірки плану Рх20 над даними цілі, команда першого призначення Рх19, DB-тести.

## Рішення плану

| # | Рішення | Вплив на спеку |
| --- | --- | --- |
| Р1b-1 | Глобальна роль у проєкті з видами скоупу покриває лише нескоуплені об'єкти; в однотенантному — усі | спека прав Рх7 (Задача 0) |
| Р1b-2 | Гранти контейнерної ролі — лише на об'єкти з `containerBinding` на цей контейнер; рядок контейнера читається роллю рівня скоупу | немає |
| Р1b-3 | Четверта форма `assignedOn: "everyUser"` — лише для `Role` (не для джерел); її гранти — лише обсяги `own` і вимір на нескоуплених об'єктах | спека прав §4.1 (Задача 0) |
| Р1b-4 | Розгортання: `X@any` породжує `X@own` і `X@<кожен вимір об'єкта>` (там, де об'єкт їх підтримує); вимога `X ⇒ Y` для обсягу e виконана, коли є `Y@e'`, де e' = e або e' = `any` | спека прав §3 (Задача 0) |
| Р1b-5 | `deny` — лише в грантах `Role` (схема набору його не має); віднімає з архетипу своєї ролі після розгортання й породження, з точністю до обсягу; без обсягу — усі обсяги дії | спека прав §4.1 (Задача 0) |
| Р1b-6 | Селектор об'єктів — `[{ kind, name }, …]` або `{ withAction: "<дія>" }` (усі об'єкти рівня ролі, чиї дії її мають) | немає |
| Р1b-7 | `grantAll` на обсязі, якого об'єкт не підтримує, цей об'єкт пропускає; явний `grant` — помилка `rights.extent-unsupported` | немає |
| Р1b-8 | `assignedOn` у `ASSIGNED_ONCE` порівнюється розв'язаним значенням (id виду скоупу чи контейнера): перейменування не є зміною рівня | немає |
| Р1b-9 | `Role` і `RightsSet` не мають `physicalName` — новий факт реєстру `physicalName: false` | немає |
| Р1b-10 | Кастомна дія в `grant.actions` — посилання за іменем на кастомну дію об'єкта (роль `grant.customAction`), з власним резолвером і простором посилань (не колонки, як `elementReferences`). Грант із кастомною дією — **рівно на один явний об'єкт**: селектор `withAction` і список з кількох об'єктів — лише для стандартних дій, інакше `rights.custom-action-multi-object` (одне ім'я в різних об'єктах — різні UUID). Грант на вид з порожнім `rightsExtents`: `declared` — `rights.custom-table-no-contract` (дизайн прав прийнятих таблиць відкладено), інші — `rights.object-without-rights` | спека прав §4.1 (Задача 0) |
| Р1b-13 | `deny` розв'язується й перевіряється до віднімання так само, як `grant`: невідома дія — `rights.action-unknown`, непідтриманий обсяг — `rights.extent-unsupported`, об'єкт поза рівнем — `rights.grant-level` | немає |
| Р1b-14 | `title`/`description` у `RightsSet` і `Role` відкладено до плану зі споживачем (матриця ролей, П4); ратчет не обходиться | немає |
| Р1b-11 | Тека видів: `rights-sets/`, `roles/` | немає |
| Р1b-12 | Рядок проєкції несе джерела гранту (`sources`: роль і набори, через які рядок з'явився) — для аналізу прав Рх17 | немає |

## Відомі обмеження

- Глобальна роль у багатотенантному проєкті не дає доступу до скоуплених
  об'єктів жодного тенанта; доступ «оператора платформи» до всіх тенантів —
  продуктове питання поза спекою прав, механізму для нього немає.
- Невідомий `sourceKey` у даних прийнятого джерела й дельти-сироти видно лише
  з даних цілі — це перевірки плану Прав-2 (§4.7, Рх20).
- `rootCreator` лише оголошується й перевіряється; призначення творцю кореня —
  команда раннього зрізу П4 (Рх19).

## Review Focus

1. **`deny read@any`** лишає `read@own` і `read@<вимір>`, а `deny read` без обсягу знімає всі; невідома дія чи непідтриманий обсяг у `deny` — помилка, а не тихий no-op (Задача 2).
2. **Ромб включень** (роль включає набори A і B, обидва включають C) — не цикл і не дублікати рядків; `sources` рядка — обидва шляхи (Задача 2).
3. **`withAction` на ролі рівня скоупу** не підбирає нескоуплених об'єктів для дій, яких рівень не дозволяє: нескоуплений документ `Announcement` з `post` не потрапляє під `withAction: "post"` (Задача 2).
4. **Перейменування кастомної дії** переписує `grant.actions` у кожній ролі й наборі; видалення об'єкта, на який посилається грант, блокується (Задача 4).
5. **Перейменування виду скоупу чи контейнера** не дає `identity.assigned-once-changed` для `assignedOn`, а зміна рівня — дає (Задача 3).

---

## Структура файлів

| Файл | Відповідальність |
| --- | --- |
| `packages/simetra/src/model/schemas/rights.ts` | `extentSchema`, `objectSelectorSchema`, `grantEntrySchema`, `setGrantEntrySchema`, `roleAssignedOnSchema`, `rightsSetSchema`, `roleSchema` |
| `packages/simetra/src/model/schemas/metadata-kind.ts` | `"RightsSet"`, `"Role"` у `METADATA_KINDS` |
| `packages/simetra/src/model/kinds/{rights-set,role}.ts` (нові), `registry.ts`, `standard.ts` | записи реєстру, факт `physicalName`, ролі посилань |
| `packages/simetra/src/model/named-elements.ts` | `ASSIGNED_ONCE` з `assignedOn` |
| `packages/simetra/src/compiler/rights/expand.ts` (новий) | розгортання грантів ролі в рядки проєкції |
| `packages/simetra/src/compiler/rights/role-checks.ts` (новий) | перевірки ролей і наборів |
| `packages/simetra/src/compiler/rights/contracts.ts`, `compiler/contracts.ts` | `RoleContract`, `RightsProjectionRow`, `Contracts.roles`, `Contracts.rightsProjection` |
| `packages/simetra/src/compiler/{assigned-once,explain,pipeline,diagnostics,messages}.ts`, `stages/{identity,integrity}.ts`, `operations/fix.ts` | підключення |
| `packages/simetra/src/compiler/__tests__/fixtures/rights.ts` | ролі й набори фікстури |
| `packages/designer/skills/simetra-metadata/SKILL.md` | опис `RightsSet` і `Role` |

Фікстура `fixtures/rights.ts` плану 1a отримує: набір `TaskReaders`
(`grant read@any` на `Task`), набір `TaskEditors` (`include: TaskReaders`,
`grant update@own`), роль `OrgAdmin` (`assignedOn: { scopeKind: "org" }`,
`fullAccess: true`), роль `OrgMember` рівня скоупу з `include: [TaskEditors]`,
роль `ProjectLead` (`assignedOn: { container: Project }`), глобальна роль
`Support` і роль `Everyone` (`"everyUser"`, `grant read@own` на `Users`), а
також нескоуплений документ `Announcement` (`scope: "none"`, отже з `post`);
експорти `ROLE_FILE(name)`, `SET_FILE(name)`. Як і в 1a, типові значення
фікстури мінімальні й стабільні: поля прав об'єктів 1a (`ownership`,
`access`, `containerBinding`, `rightsContainer`, `customActions`), ролі й
набори кожен тест задає явним перевизначенням `rightsFiles(...)`; гранти
ролей і наборів — лише з Задачі 2.

---

### Задача 0: правки спеки прав (вердикт розвилок 1b)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-rights-design.md` (Рх7, §3, §4.1)

- [ ] **Step 1:** Рх7 — «глобальна роль у проєкті з видами скоупу — лише нескоуплені об'єкти»; рівень «кожен дійсний користувач» — форма `assignedOn: "everyUser"`.
- [ ] **Step 2:** §3 — «`X@any ⇒ X@own`» → «`X@any ⇒ X@own` і `X@<вимір>`; вимога діє, коли є потрібна дія на тому самому чи ширшому обсязі».
- [ ] **Step 3:** §4.1 — у формі `assignedOn` додати `"everyUser"`; речення «`deny` — лише в ролі: набір — група грантів без віднімання»; речення «грант із кастомною дією — рівно на один явний об'єкт: ім'я кастомної дії в різних об'єктах — різні дії».
- [ ] **Step 4:** Run: `python3 scripts/check-doc-anchors.py && pnpm format:check` — код 0.
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-17-rights-design.md
git commit -m "docs(spec): рівень everyUser, порядок обсягів, deny лише в ролі, кастомна дія на один об'єкт"
```

---

### Задача 1: види `RightsSet` і `Role`, посилання, контракт ролі

**Files:**
- Modify: `packages/simetra/src/model/schemas/metadata-kind.ts`, `model/schemas/rights.ts`, `model/schemas/index.ts`
- Create: `packages/simetra/src/model/kinds/rights-set.ts`, `packages/simetra/src/model/kinds/role.ts`
- Modify: `model/kinds/registry.ts`, `model/kinds/standard.ts` (`physicalName?: false`; ролі `rights.include`, `role.scopeKind`, `role.container`, `role.sourceKey`)
- Modify: `compiler/stages/identity.ts` (без `physicalName` для виду з `physicalName: false`), `operations/fix.ts` (не призначати), `stages/integrity.ts` (ціль `rights.include` — лише `RightsSet`)
- Create: `packages/simetra/src/compiler/rights/role-checks.ts`
- Modify: `rights/contracts.ts`, `compiler/contracts.ts`, `pipeline.ts`, `diagnostics.ts`, `messages.ts`, `rights/checks.ts` (`rights.users-missing` враховує ролі й набори)
- Modify: `packages/simetra/schemas/*.schema.json` (нові `rights-sets.schema.json`, `roles.schema.json`)
- Test: `packages/simetra/src/model/__tests__/kind-schemas.test.ts` (закріплений перелік видів), `kind-registry.test.ts`, `rights-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/rights-roles.test.ts` (новий)

**Interfaces:**
- Produces (T0):

```ts
export const roleAssignedOnSchema = z.union([assignedOnSchema, z.literal("everyUser")])
export const rightsSetSchema = z.strictObject({
  ...objectHeaderShape.omit({ schema: true, scope: true, physicalName: true, title: true, description: true }).shape,
  kind: z.literal("RightsSet"),
  include: z.array(metadataRefSchema).default([]),
  grants: z.array(setGrantEntrySchema).default([]),   // з Задачі 2
})
export const roleSchema = z.strictObject({
  ...objectHeaderShape.omit({ schema: true, scope: true, physicalName: true, title: true, description: true }).shape,
  kind: z.literal("Role"),
  assignedOn: roleAssignedOnSchema,
  fullAccess: z.boolean().default(false),
  order: z.number().int().nonnegative().optional(),
  assignable: z.boolean().default(true),
  maxHolders: z.number().int().positive().optional(),
  rootCreator: z.boolean().default(false),
  sourceKeys: z.array(z.strictObject({ source: elementNameSchema, key: z.string().min(1) })).default([]),
  include: z.array(metadataRefSchema).default([]),
  grants: z.array(grantEntrySchema).default([]),       // з Задачі 2
})
```

  (Точна форма шапки — за `eventSubscriptionSchema`; якщо `objectHeaderShape`
  будується інакше, повторити той самий прийом.) Поле `grants` у Задачі 1 у
  схемах **відсутнє**: його споживач — розгортання Задачі 2, а ратчет полів
  червонів би на непрочитаному полі. Задача 2 додає `grants` разом зі
  споживачем; фікстури Задачі 1 гранти не задають.
- Produces (реєстр): `KindDefinition.physicalName?: false`; `rightsSetKind`, `roleKind` — `materializes: "none"`, `referenceable: false`, `writePattern: "none"`, `sqlModule` як у `EventSubscription`, `scope: "absent"`, `declared: false`, `columnFields: []`, `valueElements: false`, `actions: () => []`, `rightsExtents: []`, `physicalName: false`; `references(obj)` — `include[]` (роль `rights.include`), `assignedOn.container` (роль `role.container`); `projectReferences(obj)` — `assignedOn.scopeKind` (`scopeKinds`, `role.scopeKind`), `sourceKeys[].source` (`assignmentSources`, `role.sourceKey`).
- Produces (T1):

```ts
export type CompiledRoleLevel = CompiledAssignedOn | { level: "everyUser" }
export interface RoleContract {
  roleId: string
  name: string
  assignedOn: CompiledRoleLevel
  fullAccess: boolean
  order?: number
  assignable: boolean
  maxHolders?: number
  rootCreator: boolean
  sourceKeys: { sourceId: string; key: string }[]
  /** Транзитивне замикання включених наборів, за id. */
  sets: string[]
}
```

  `Contracts.roles: RoleContract[]` (за `roleId`).
- Коди: `rights.include-target` (`{ kind, name }`), `rights.include-cycle` (`{ chain }`), `rights.scope-without-membership` (`{ scopeKind }` — вид скоупу без довідника членства й без джерела, Рх7; читає `membershipOfScopeKind`), `rights.full-access-level` (`{ level }` — `fullAccess` на контейнерній ролі чи `everyUser`), `rights.root-creator-level`, `rights.root-creator-duplicate` (`{ scopeKind, firstFile }`), `rights.source-key-level` (`{ source }` — рівень джерела не дорівнює рівню ролі; `everyUser` з ключами), `rights.source-key-duplicate` (`{ source, key, firstFile }`).

- [ ] **Step 1: Write the failing tests**
  - `kind-schemas.test.ts`: закріплений перелік `METADATA_KINDS` доповнити `"RightsSet"`, `"Role"`; `roleSchema` приймає всі чотири форми `assignedOn`, відмовляє на `physicalName`, `title` і на `maxHolders: 0`; `rightsSetSchema` не має `assignedOn`.
  - `kind-registry.test.ts`: теки `rights-sets`, `roles`; `physicalName: false` в обох; `references` ролі дає `rights.include` і `role.container`.
  - `rights-roles.test.ts`:
    - `it("compiles roles into role contracts")` — `contracts.roles` для `OrgAdmin` дорівнює `{ roleId, name: "OrgAdmin", assignedOn: { level: "scope", scopeKindId: ORG_KIND_ID }, fullAccess: true, assignable: true, rootCreator: false, sourceKeys: [], sets: [] }`; `OrgMember.sets` — `[TASK_EDITORS_ID, TASK_READERS_ID]` (замикання).
    - `it("rejects broken role declarations")` — `[code, file, pointer]`: включення ролі замість набору → `rights.include-target` `/include/0`; цикл A → B → A → `rights.include-cycle`; роль рівня виду скоупу без членства → `rights.scope-without-membership` `/assignedOn/scopeKind`; `fullAccess` на `ProjectLead` → `rights.full-access-level` `/fullAccess`; `rootCreator` на глобальній ролі → `rights.root-creator-level`; дві `rootCreator` на `org` → `rights.root-creator-duplicate`; `sourceKeys` на джерело іншого рівня → `rights.source-key-level`; однаковий ключ у двох ролях → `rights.source-key-duplicate`; невідомий вид скоупу → `rights.scope-kind-unknown`.
    - `it("needs no physical name and gets an id from fix")` — `completeFiles` дає `id`, не дає `physicalName`; компіляція без `identity.physical-name-missing`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test kind-schemas kind-registry rights-schemas rights-roles`
Expected: FAIL.

- [ ] **Step 3: Implement** — за прецедентом `event-subscription.ts`; `kitchen-sink.ts` — набір і роль кожної форми `assignedOn`, з `order`, `maxHolders`, `rootCreator`, `sourceKeys`, `include` (без `title`/`description`, Р1b-14); регенерувати JSON Schema.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test && pnpm --filter @simetra/designer test`
Expected: PASS (зокрема `field-ratchet`, `reference-index-completeness`, `json-schema`, `creation-order`, `named-elements`).

- [ ] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(model): види RightsSet і Role з контрактом ролі"
```

---

### Задача 2: гранти, розгортання і проєкція

**Files:**
- Modify: `model/schemas/rights.ts` (`extentSchema`, `objectSelectorSchema`, `grantEntrySchema`, `setGrantEntrySchema`; поле `grants` у `rightsSetSchema` і `roleSchema`), `model/kinds/{role,rights-set}.ts` (посилання грантів), `model/kinds/standard.ts` (ролі `grant.object`, `grant.dimension`, `grant.customAction`)
- Create: `packages/simetra/src/compiler/rights/expand.ts`
- Modify: `rights/role-checks.ts`, `rights/contracts.ts`, `compiler/contracts.ts`, `pipeline.ts`, `diagnostics.ts`, `messages.ts`
- Test: `rights-schemas.test.ts`, `packages/simetra/src/compiler/__tests__/rights-expand.test.ts` (новий)

**Interfaces:**
- Produces (T0):

```ts
export const extentSchema = z.union([
  z.literal("any"), z.literal("own"),
  z.strictObject({ dimension: elementNameSchema }),
])
export const objectSelectorSchema = z.union([
  z.array(metadataRefSchema).min(1),
  z.strictObject({ withAction: elementNameSchema }),
])
const grant = z.strictObject({ objects: objectSelectorSchema,
  actions: z.array(elementNameSchema).min(1), extent: extentSchema })
const grantAll = z.strictObject({ extent: extentSchema })
const deny = z.strictObject({ objects: objectSelectorSchema,
  actions: z.array(elementNameSchema).min(1), extent: extentSchema.optional() })
export const setGrantEntrySchema = z.union([
  z.strictObject({ grantAll }), z.strictObject({ grant }) ])
export const grantEntrySchema = z.union([
  z.strictObject({ grantAll }), z.strictObject({ grant }), z.strictObject({ deny }) ])
```

- Produces (T1):

```ts
export type ProjectionExtent = "any" | "own" | { dimensionId: string }
export interface RightsProjectionRow {
  roleId: string
  objectId: string
  /** Слово словника або UUID кастомної дії (Рх18). */
  action: string
  extent: ProjectionExtent
  /** Роль і набори, через які рядок з'явився, за id. */
  sources: { kind: "Role" | "RightsSet"; id: string }[]
}
export function expandRole(role: RoleInput, ctx: ExpandContext): { rows: RightsProjectionRow[]; diagnostics: Diagnostic[] }
```

  `RoleInput` — розібрана роль з id наборів її замикання; `ExpandContext` — `contracts.rights` за `objectId`, `scopeKindId` кожного об'єкта, `binding.containerId`, розв'язані посилання ролі й наборів (об'єкти, виміри, кастомні дії за pointer). `Contracts.rightsProjection: RightsProjectionRow[]` — за `roleId`, `objectId`, `action`, ключем обсягу (`any` < `own` < `dim:<id>`).
- Коди: `rights.grant-level` (`{ object, action, level }`), `rights.extent-unsupported` (`{ object, extent }`), `rights.requires-missing` (`{ object, action, requires, extent }`), `rights.custom-table-no-contract` (`{ object }`), `rights.object-without-rights` (`{ object, kind }`), `rights.custom-action-multi-object` (`{ action }` — кастомна дія в гранті з `withAction` чи з кількома об'єктами); з 1a — `rights.action-unknown`, `rights.dimension-unknown`.

Алгоритм `expandRole` (сигнатура й тести його не визначають):

```text
L := об'єкти рівня ролі (лише з RightsContract):
  scope k     → об'єкти виду скоупу k (усі дії) + нескоуплені (лише read)
  global      → нескоуплені (у проєкті без видів скоупу — усі)
  container c → об'єкти з binding.containerId = c
  everyUser   → нескоуплені, лише обсяги own і вимір
для кожного запису grantAll/grant ролі та наборів її замикання (джерело — роль чи набір):
  grantAll{e}: для o ∈ L, кожна дія a, дозволена рівнем, якщо o підтримує e → рядок (o, a, e)
    (кастомні дії grantAll включає: об'єкт один, тож UUID однозначний)
  grant{objects, actions, e}: селектор → об'єкти (список: поза L → rights.grant-level;
    withAction: o ∈ L, чиї дії, ДОЗВОЛЕНІ РІВНЕМ ролі для o, мають цю дію — нескоуплений
    об'єкт на ролі рівня скоупу має лише read); кастомна дія в actions і селектор не з
    одного явного об'єкта → rights.custom-action-multi-object; кожна дія ∈ дій o
    (інакше action-unknown), дозволена рівнем (інакше grant-level), e підтримано
    (інакше extent-unsupported) → рядок
породження: (o, a, any) → (o, a, own), якщо own підтримано, і (o, a, dim d) для кожного виміру o
deny ролі (лише власні записи): спершу розв'язати й перевірити так само, як grant
  (селектор, action-unknown, extent-unsupported, grant-level, custom-action-multi-object),
  потім зняти (o, a, e); без обсягу — усі обсяги (o, a)
вимоги: для кожного (o, a, e) і кожної r ∈ requires(a) з контракту — має бути (o, r, e) або (o, r, any),
  інакше rights.requires-missing на pointer запису, що дав (o, a, e)
однакові рядки зливаються, `sources` — об'єднання
```

  Роль з `fullAccess: true` рядки має так само (її обхід перевірок — справа
  функцій Прав-2), а набір сам по собі рядків не дає: рівень має лише роль.
  Перевірки набору, що не залежать від рівня (невідома дія, непідтриманий
  обсяг, об'єкт без прав), звітуються на файлі набору один раз.

- [ ] **Step 1: Write the failing tests**
  - `rights-schemas.test.ts`: `rightsSetSchema` відмовляє на записі `deny`; `objectSelectorSchema` приймає список і `{ withAction: "post" }`.
  - `rights-expand.test.ts` (рядки порівнюються як `[roleName, objectName, action, extentKey]` через локальний помічник `rows(model)`):
    - `it("expands sets transitively and derives own from any")` — `OrgMember` дає `["OrgMember","Task","read","any"]`, `["OrgMember","Task","read","own"]`, `["OrgMember","Task","read","dim:region"]`, `["OrgMember","Task","update","own"]`.
    - `it("denies with extent precision")` — `deny read@any` на `Task` лишає `read@own` і `read@dim:region`; `deny read` без обсягу знімає всі три; `update@own` тоді дає `rights.requires-missing` (`requires: "read"`).
    - `it("merges a diamond of sets")` — роль включає A і B, обидва включають C з `read@any`: рядок один, `sources` — роль, A, B, C (за id).
    - `it("limits a scope role on unscoped objects to read")` — `grantAll any` на ролі `org` дає `Users` і `Announcement` лише `read` (точно: `[["OrgMember","Announcement","read","any"], ["OrgMember","Users","read","any"], …]` без інших дій цих об'єктів); `grant update` на `Users` → `rights.grant-level`; `grant { withAction: "post" }` дає рядки `post` для `Task` і жодного для `Announcement`.
    - `it("limits global, container and everyUser roles to their level")` — `Support` (`global`) з `grant read` на `Task` → `rights.grant-level`; `ProjectLead` отримує `Task` і `TaskComment` (прив'язані до `Project`) і не отримує `Region`; `Everyone` з `grant read@any` на `Users` → `rights.grant-level` (обсяг), з `read@own` — рядок.
    - `it("skips unsupported extents in grantAll and rejects them in grant")` — `grantAll own` пропускає `Region` (без власності); `grant read@own` на `Region` → `rights.extent-unsupported`.
    - `it("grants a custom action by name")` — `grant reassign` на `Task` → рядок з `action: REASSIGN_ID`, а запис індексу з роллю `grant.customAction` на `/grants/0/grant/actions/0` має `to.id === REASSIGN_ID` (UUID цілі, а не лише наявність вказівника); невідома дія → `rights.action-unknown` на `/grants/0/grant/actions/0`.
    - `it("refuses a custom action across several objects")` — `Task` і `TaskComment` обидва мають кастомну дію `reassign` з різними UUID; `grant { objects: [Task, TaskComment], actions: ["reassign"] }` і `grant { withAction: "reassign" }` → `rights.custom-action-multi-object` на `/grants/0/grant/actions/0`; гранти на кожен об'єкт окремо дають два рядки з різними `action`.
    - `it("checks deny before subtracting")` — `deny { objects: [Task], actions: ["approve"] }` → `rights.action-unknown`; `deny` з `extent: "own"` на `Region` → `rights.extent-unsupported`.
    - `it("refuses grants on objects without rights")` — `CustomTable` → `rights.custom-table-no-contract`; `Enumeration` → `rights.object-without-rights`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test rights-expand rights-schemas`
Expected: FAIL.

- [ ] **Step 3: Implement** — посилання: `grant.objects[i]` і `deny.objects[i]` → `references` (роль `grant.object`); обсяг-вимір → `projectReferences` (`accessDimensions`, роль `grant.dimension`); ім'я кастомної дії в `actions` — **окремий** резолвер `resolveCustomActionReferences` у `stages/identity.ts` (поруч із резолвером `customAction.requires` плану 1a): шукає ім'я серед `customActions` єдиного явного об'єкта гранту й пише `{ to: { kind: "Element", id: <UUID дії> }, role: "grant.customAction" }`; `elementReferences` для цього не годиться — він резолвить колонки. Слова словника посиланнями не є (виняток `NOT_REFERENCES` — Р1a-21). `kitchen-sink.ts` — усі гілки `grantEntrySchema`, `extentSchema` і `objectSelectorSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test rights field-ratchet reference-index-completeness json-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): розгортання грантів ролей у проєкцію прав"
```

---

### Задача 3: `assignedOn` призначається раз

**Files:**
- Modify: `packages/simetra/src/model/named-elements.ts` (`AssignedOnceField.field` + `"assignedOn"`, контекст `effective`), `packages/simetra/src/compiler/assigned-once.ts`
- Test: `packages/simetra/src/compiler/__tests__/assigned-once.test.ts`

**Interfaces:**
- Produces: контекст `effective(raw, ctx)` отримує `resolveScopeKind(name: string): string | undefined` і `resolveObject(ref: MetadataRef): string | undefined` — кожен над своїм станом (базовим чи поточним); ефективне значення `assignedOn` — `"global"`, `"everyUser"`, `scope:<id>`, `container:<id>`; нерозв'язане ім'я — `scope?:<ім'я>` / `container?:<kind>:<name>` (тоді зміна видна як зміна).
- Produces: `explicit(record, holder)` в `assigned-once.ts` — поле явне, коли `holder.element[record.field] !== undefined`, а не лише коли це рядок. Сьогодні він перевіряє `typeof … === "string"`, тож для значення-об'єкта (`{ scopeKind }`, `{ container }`) вважав би поле успадкованим і ставив діагностику на `defaultSchema` проєкту.

- [ ] **Step 1: Write the failing tests**
  - `it("reports a changed role level")` — `global` → `{ scopeKind: "org" }` → `identity.assigned-once-changed` (`field: "assignedOn"`, `before: "global"`, `after: "scope:<ORG_KIND_ID>"`) на `/assignedOn`.
  - `it("keeps a role level across a rename of its scope kind and container")` — перейменування `org` → `tenant` (з переписаним `assignedOn`) і `Project` → `Initiative` → без діагностик.
  - `it("reports object-to-object level changes in the role file")` — `{ scopeKind: "org" }` → `{ container: Project }` і `{ container: Project }` → `{ container: Board }` (інший контейнер) → `identity.assigned-once-changed` з `file: "roles/<Role>/<Role>.meta.json"` і `pointer: "/assignedOn"` (не `project.meta.json` `/defaultSchema`); `"global"` → `{ scopeKind }` — так само.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter simetra test assigned-once`
Expected: FAIL.

- [ ] **Step 3: Implement** — резолвери будуються з `project.meta.json` (`scopeKinds` за іменем → `id`) і файлів об'єктів (`{ kind, name }` → `id`) кожного стану; запис `{ on: "object", field: "assignedOn", effective }` у `ASSIGNED_ONCE` діє для кожного об'єкта, що має поле (без розгалуження за видом); виправлення `explicit` — у тому самому коміті (тест `schema` проєкту з явним і успадкованим значенням лишається зеленим).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter simetra test assigned-once kind-label`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simetra
git commit -m "feat(compiler): рівень призначення ролі призначається раз"
```

---

### Задача 4: designer над ролями й наборами, `explain`, скіл

**Files:**
- Modify: `packages/simetra/src/compiler/explain.ts` (роль: її `RoleContract` і рядки проєкції; об'єкт — рядки проєкції, де він `objectId`)
- Test: `packages/simetra/src/compiler/__tests__/operations-roles.test.ts` (новий), `explain.test.ts`
- Modify: `packages/designer/skills/simetra-metadata/SKILL.md` (розділи `rights-sets/` і `roles/`, англійською)

**Interfaces:**
- Consumes: `createObject`, `renameElement`, `deleteElement`, `explainObject`; ролі посилань Задач 1–2.

- [ ] **Step 1: Write the failing tests**
  - `operations-roles.test.ts`:
    - `it("creates a rights set and a role in their folders")` — `createObject({ kind: "Role", name: "Auditor", data: { assignedOn: "global", grants: [...] } })` → файл `roles/Auditor/Auditor.meta.json` з `id`, без `physicalName`; компіляція чиста.
    - `it("renames a set, an object, a scope kind, a dimension, a custom action and a source everywhere in roles")` — після кожного `renameElement` переписано відповідно `include`, `grant.objects`, `assignedOn.scopeKind`, `extent.dimension`, `grant.actions`, `sourceKeys[].source`; компіляція з базовим станом — без `identity.assigned-once-changed`.
    - `it("refuses to delete what a role refers to")` — видалення `TaskReaders`, `Task`, виду `org` і `Project` → `operation.delete-referenced` з ролями `rights.include`, `grant.object`, `role.scopeKind`, `role.container`.
  - `explain.test.ts`: `it("explains a role with its projection")` — `explainObject(model, { kind: "Role", name: "OrgMember" })` → `tables: []`, у `contracts` — `RoleContract` і рядки проєкції ролі; для `Task` — рядки, де він об'єкт.

- [ ] **Step 2: Run tests to verify they fail or pass**

Run: `pnpm --filter simetra test operations-roles explain`
Expected: `explain` — FAIL до зміни `explain.ts`; червоні тести операцій вказують на пропущене посилання — виправити в коді Задач 1–2 (не в операціях) і назвати у звіті.

- [ ] **Step 3: Implement** — блоки `explain`; розділи скілу: тека, форма файлу з плейсхолдерами, чотири рівні, `include`/`grantAll`/`grant`/`deny`, порядок обсягів, правила `rights.*`, без переказу спеки.

Run: `pnpm --filter @simetra/designer test && python3 scripts/check-doc-anchors.py`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages
git commit -m "feat(compiler): explain ролей і мутації designer над ролями й наборами"
```

---

### Задача 5: гейти

- [ ] **Step 1:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — усе зелене.
- [ ] **Step 2:** `pnpm metadata:check` — код 0.
- [ ] **Step 3:** `python3 scripts/check-doc-anchors.py` — код 0.
- [ ] **Step 4:** `.agents/skills/codebase-research/scripts/orient --plan docs/superpowers/plans/2026-10-18-rights-1b-sets-roles.md` — якорі відповідають коду.
- [ ] **Step 5:** повний `pnpm test:db` на одному SHA, дерево незмінне під час прогону; SHA — у звіт. Нових DB-тестів немає; прогін доводить, що нові види без сховища не змінюють рендер, тінь і застосування.
- [ ] **Step 6:** правки форматування — `pnpm format:fix` і коміт `style: форматування Права-1b`.

## Критерії приймання

- `RightsSet` і `Role` — записи реєстру; `create`, `rename`, `delete` і `explain` працюють з ними без нового коду операцій.
- `contracts.roles` і `contracts.rightsProjection` будуються для кожної ролі; рядки проєкції — розгорнуті (без `grantAll`, `deny`, `include`), з породженими обсягами й джерелами.
- Перевірки §4.1, Рх5, Рх7, Рх19 (оголошення), §4.7 (`sourceKeys`) і цикли `include` мають тести й тексти en/uk.
- `assignedOn` в `ASSIGNED_ONCE`, перейменування виду скоупу чи контейнера не є зміною.
- Гейти Задачі 5 зелені на одному SHA.
