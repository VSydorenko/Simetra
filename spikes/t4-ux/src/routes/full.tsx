// Вигляд `full` на 5000 рядків: вимір «побудова знімка ядра + рендер React».
import { createFileRoute, redirect } from "@tanstack/react-router"
import { Profiler, useState } from "react"
import { ITEM, ORDER, type ViewSpec } from "../core"
import { useView } from "../t4/hooks"
import { ROW_H, VIEW_H } from "../ui/styles"
import { onRegionRender } from "./index"

export const FULL: ViewSpec = { kind: "full", object: ITEM, orderBy: ORDER }

export const Route = createFileRoute("/full")({
  loader: async ({ context }) => {
    const core = context.holder.core
    if (!core) throw redirect({ to: "/login" })
    if (core.view(FULL).getSnapshot().status === "loading")
      await core.preload(FULL)
  },
  component: () => (
    <Profiler id="full" onRender={onRegionRender}>
      <FullPage />
    </Profiler>
  ),
})

function FullPage() {
  const [snap] = useView(FULL)
  const [top, setTop] = useState(0)
  const first = Math.max(0, Math.floor(top / ROW_H) - 5)
  const last = Math.min(snap.rows.length, Math.ceil((top + VIEW_H) / ROW_H) + 5)
  return (
    <div data-region="full">
      <div className="toolbar">
        <strong data-count={snap.rows.length}>Full: {snap.rows.length}</strong>
      </div>
      <div
        className="list"
        data-scroll="full"
        onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: snap.rows.length * ROW_H, position: "relative" }}>
          {snap.rows.slice(first, last).map((v, i) => (
            <div
              key={v.key}
              className="row"
              data-row-key={v.key}
              style={{ top: (first + i) * ROW_H }}
            >
              <span data-field="num">{String(v.values.num)}</span>
              <span data-field="name">{String(v.values.name)}</span>
              <span>{String(v.values.amount)}</span>
              <span>{String(v.values.status)}</span>
              <span data-state={v.status.state}>
                {v.status.state === "synced" ? "" : v.status.state}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
