import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  canonicalSnapshot,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  buildPlan,
  engineScope,
  executePlan,
  rehearsalReport,
  type PlanArtifact,
} from "simetra/schema"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  COMMENT_FILE,
  COMMENT_TABLE,
  policyDomain,
  promotableTaskNote,
  refAttribute,
  TASK_FILE,
  TASK_NOTE_ADOPTED_TABLE,
  taskNoteMapping,
  uuid,
} from "../../../../simetra/test/support"
import { inTarget, query } from "../../__tests__/support/db"
import {
  dbs,
  engine,
  EMPTY,
  establish,
  planned,
  promoted,
  rehearsalOf,
  writer,
} from "./build-plan.support"

/**
 * Кроки копій носіїв на живих рядках (Р2b2-1…Р2b2-6, Р2b2-10). DB-рівень, бо
 * що двигун створить колонку копії до кроку, що тригери носіїв, механіки,
 * підписок і ефектів зроблять на `UPDATE` кроку і що промоція перейменує
 * таблицю до нього — вирішує Postgres на живих рядках, а не текст плану.
 * Це перший наскрізний план і перша промоція моделі з правами на базі.
 */

const ref = (kind: string, name: string) => ({ kind, name })

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/**
 * Вихідна модель звичайного плану: `policyDomain()` без носіїв на `Task` і
 * без власності коментаря — тож у цільовій `task_checklist` отримує три копії
 * на одному зв'язку, а коментар і вкладення — копію шляху. Колонки з іменами
 * копій уже є з чужими значеннями (Р2b2-8): реквізит `legacyOwner` коментаря
 * й `assignee` рядка ТЧ, яких цільова модель не має.
 */
function sourceFiles(): Map<string, string> {
  const files = policyDomain({
    [TASK_FILE]: {
      ownership: undefined,
      access: undefined,
      containerBinding: undefined,
    },
    [COMMENT_FILE]: {
      ownership: undefined,
      attributes: [
        refAttribute(6051, "task", "task_id", ref("Document", "Task")),
        refAttribute(
          6901,
          "legacyOwner",
          "task_id_assignee_id",
          ref("Catalog", "OrgMember")
        ),
      ],
    },
  })
  // Рядок ТЧ `checklist` дописано у файл домену: шар зливає лише верхні ключі,
  // а повторювати всю ТЧ тут означало б копіювати фікстуру
  const task = JSON.parse(files.get(TASK_FILE)!) as {
    tabularSections: { attributes: unknown[] }[]
  }
  task.tabularSections[0]!.attributes.push(
    refAttribute(6902, "assignee", "assignee_id", ref("Catalog", "OrgMember"))
  )
  files.set(TASK_FILE, JSON.stringify(task))
  return files
}

/** Нова ТЧ коментаря в цільовій моделі: її таблицю план створює. */
const LINKS_TABLE = "task_comment_links"

/**
 * Цільова модель звичайного плану: `policyDomain()` і нова ТЧ `links`
 * коментаря, чия копія читає копію шляху коментаря. Таблицю створює двигун,
 * рядків у ній немає, тож кроку копій їй не належить — без неї вибір
 * створених таблиць у плані ніщо б не тримало.
 */
function targetFiles(): Map<string, string> {
  const files = policyDomain()
  const comment = JSON.parse(files.get(COMMENT_FILE)!) as {
    tabularSections: unknown[]
  }
  comment.tabularSections.push({
    id: uuid(6903),
    name: "links",
    physicalName: LINKS_TABLE,
    attributes: [
      {
        id: uuid(6904),
        name: "url",
        physicalName: "url",
        type: "String",
        length: 200,
      },
    ],
  })
  files.set(COMMENT_FILE, JSON.stringify(comment))
  return files
}

/** Ціль у межах схем моделі: `policyDomain()` живе в `public`. */
async function inModelTarget<T>(
  model: CompiledModel,
  fn: (url: string) => Promise<T>
): Promise<T> {
  return inTarget(EMPTY, (await engineScope(model)).scope, fn)
}

const carrierTables = (artifact: PlanArtifact) =>
  artifact.steps
    .filter((s) => s.origin === "carriers")
    .map((s) => s.lockedTables[0]!.name)

/** Тригери ефектів 2b1 на таблицях, за іменами. */
const effectsTriggers = (url: string, tables: string[]) =>
  query<{ table: string; trigger: string }>(
    url,
    `select c.relname as table, t.tgname as trigger
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1)
        and t.tgname like '%simetra_effects%'
      order by 1, 2`,
    [tables]
  )

const one = async <R extends Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[]
): Promise<R> => (await query<R>(url, sql, params))[0]!

describe.concurrent("carrier copy steps on live rows", () => {
  it("a plain plan backfills a path copy and the tabular copy reading it", async () => {
    const before = await compiled(sourceFiles())
    const after = await compiled(targetFiles())
    const id = {
      org: randomUUID(),
      u1: randomUUID(),
      u2: randomUUID(),
      region: randomUUID(),
      project: randomUUID(),
      task: randomUUID(),
      line: randomUUID(),
      comment: randomUUID(),
      attachment: randomUUID(),
      orphan: randomUUID(),
    }
    await inModelTarget(after, async (url) => {
      await establish(url, before)
      // Кілька операторів в одному запиті не приймають параметрів, а id —
      // згенеровані uuid, тож літерали безпечні
      await query(
        url,
        `insert into public.organization (id) values ('${id.org}');
         insert into public.org_member (id, org_id)
           values ('${id.u1}', '${id.org}'), ('${id.u2}', '${id.org}');
         insert into public.region (id, org_id) values ('${id.region}', '${id.org}');
         insert into public.project (id, org_id) values ('${id.project}', '${id.org}');
         insert into public.task (id, org_id, date, assignee_id, region_id, project_id)
           values ('${id.task}', '${id.org}', now(), '${id.u1}', '${id.region}', '${id.project}');
         insert into public.${CHECKLIST_TABLE} (id, org_id, parent_id, line_number, note, assignee_id)
           values ('${id.line}', '${id.org}', '${id.task}', 1, 'a', '${id.u2}');
         insert into public.${COMMENT_TABLE} (id, org_id, task_id)
           values ('${id.comment}', '${id.org}', '${id.task}');
         insert into public.${ATTACHMENTS_TABLE} (id, org_id, parent_id, line_number, label)
           values ('${id.attachment}', '${id.org}', '${id.comment}', 1, 'a');
         insert into public.${COMMENT_TABLE} (id, org_id, task_id, task_id_assignee_id)
           values ('${id.orphan}', '${id.org}', null, '${id.u2}');`
      )
      const commentVersion = () =>
        one<{ version: string }>(
          url,
          `select version::text from public.${COMMENT_TABLE} where id = $1`,
          [id.comment]
        )
      const counter = () =>
        one<{ n: number }>(
          url,
          "select count(*)::int as n from public.comment_counter",
          []
        )
      const versionBefore = await commentVersion()
      const counterBefore = await counter()
      // Позитивний контроль: підписка `onWrite` спрацювала на кожній вставці
      // коментаря, тож «лічильник не зріс» нижче — не порожній висновок
      expect(counterBefore).toEqual({ n: 2 })

      const artifact = planned(
        await buildPlan(engine, dbs, after, { target: { url } }, [])
      )
      // Id кроків наскрізні: кроки копій продовжують нумерацію двигуна
      expect(artifact.steps.map((s) => s.id)).toEqual(
        artifact.steps.map((_, i) => `s${i + 1}`)
      )
      // Р2b2-3: копія вкладення читає копію коментаря — її оператор пізніше;
      // створена планом таблиця `links` кроку не має
      expect(carrierTables(artifact)).toEqual([
        CHECKLIST_TABLE,
        COMMENT_TABLE,
        ATTACHMENTS_TABLE,
      ])
      const outcome = await executePlan(writer, { url }, artifact, {
        mode: "apply",
        planHash: artifact.planHash,
        allow: artifact.requiredPermissions,
        snapshot: canonicalSnapshot(after),
      })
      expect(outcome.diagnostics).toEqual([])
      expect(outcome.status).toBe("committed")

      // Створена таблиця теж несе копію: без неї відсутність її кроку вище
      // нічого б не доводила
      expect(
        await query(
          url,
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1
              and column_name = 'task_id_assignee_id'`,
          [LINKS_TABLE]
        )
      ).toEqual([{ column_name: "task_id_assignee_id" }])

      // Р2b2-10: тригери ефектів є на кожній таблиці кроку — інакше висновок
      // «тригер мовчить» нижче доводився б порожньо
      const tables = [CHECKLIST_TABLE, COMMENT_TABLE, ATTACHMENTS_TABLE]
      expect(await effectsTriggers(url, tables)).toEqual(
        tables.flatMap((table) => [
          { table, trigger: `${table}_simetra_effects` },
          { table, trigger: `${table}_simetra_effects_update` },
        ])
      )

      expect(
        await query(
          url,
          `select id, task_id_assignee_id as copy from public.${COMMENT_TABLE} order by id = $1 desc`,
          [id.comment]
        )
      ).toEqual([
        { id: id.comment, copy: id.u1 },
        // Рядок без задачі отримує NULL, а не старе значення під іменем копії
        { id: id.orphan, copy: null },
      ])
      expect(
        await one(
          url,
          `select task_id_assignee_id as copy from public.${ATTACHMENTS_TABLE} where id = $1`,
          [id.attachment]
        )
      ).toEqual({ copy: id.u1 })
      expect(
        await one(
          url,
          `select assignee_id, region_id, project_id from public.${CHECKLIST_TABLE} where id = $1`,
          [id.line]
        )
      ).toEqual({
        assignee_id: id.u1,
        region_id: id.region,
        project_id: id.project,
      })
      // Зміна лише копій — не зміна змісту: механіка й підписка мовчать
      expect(await commentVersion()).toEqual(versionBefore)
      expect(await counter()).toEqual(counterBefore)
    })
  })

  it("a promotion backfills the copy of the renamed table", async () => {
    const p = await promoted(
      policyDomain(promotableTaskNote()),
      taskNoteMapping()
    )
    const id = {
      org: randomUUID(),
      u1: randomUUID(),
      task: randomUUID(),
      note: randomUUID(),
    }
    await inModelTarget(p.after, async (url) => {
      await establish(url, p.before)
      await query(
        url,
        `insert into public.organization (id) values ('${id.org}');
         insert into public.org_member (id, org_id) values ('${id.u1}', '${id.org}');
         insert into public.task (id, org_id, date, assignee_id)
           values ('${id.task}', '${id.org}', now(), '${id.u1}');
         insert into public.${TASK_NOTE_ADOPTED_TABLE} (id, name, task_id, org_id)
           values ('${id.note}', 'n', '${id.task}', '${id.org}');`
      )
      const artifact = planned(
        await buildPlan(engine, dbs, p.after, { target: { url } }, [p.input])
      )
      expect(carrierTables(artifact)).toEqual(["task_note"])
      const base = {
        planHash: artifact.planHash,
        allow: artifact.requiredPermissions,
        snapshot: canonicalSnapshot(p.after),
      }
      const rehearsed = await executePlan(writer, { url }, artifact, {
        ...base,
        mode: "rehearse",
        rehearsal: await rehearsalOf(p.after, artifact),
      })
      if (rehearsed.status !== "rolledBack")
        throw new Error(
          `rehearsal ${rehearsed.status}: ${JSON.stringify(rehearsed.diagnostics)}`
        )
      expect(rehearsed.diagnostics).toEqual([])
      const outcome = await executePlan(writer, { url }, artifact, {
        ...base,
        mode: "apply",
        report: rehearsalReport(artifact.planHash, rehearsed.evidence),
      })
      expect(outcome.diagnostics).toEqual([])
      expect(outcome.status).toBe("committed")
      expect(
        await one(
          url,
          "select task_id_assignee_id as copy from public.task_note where id = $1",
          [id.note]
        )
      ).toEqual({ copy: id.u1 })
    })
  })
})
