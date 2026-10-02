import { useEffect, useState } from "react"
import { useDdlStore } from "@/stores/ddl-store"
import { codeToHtml } from "shiki"

export function SqlViewer() {
  const output = useDdlStore((s) => s.output)
  const selectedFilePath = useDdlStore((s) => s.selectedFilePath)
  const [html, setHtml] = useState("")

  const selectedFile = output?.files.find((f) => f.path === selectedFilePath)
  const content = selectedFile?.content ?? ""

  useEffect(() => {
    let cancelled = false
    if (!content) {
      // Micro-task щоб уникнути setState напряму в ефекті
      queueMicrotask(() => {
        if (!cancelled) setHtml("")
      })
      return () => {
        cancelled = true
      }
    }
    codeToHtml(content, {
      lang: "sql",
      theme: "github-dark",
    }).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [content])

  if (!content) {
    return null
  }

  // dangerouslySetInnerHTML безпечний — content генерується нашим генератором,
  // а shiki виконує proper HTML escaping
  return (
    <div
      className="sql-viewer min-h-full p-4 text-sm [&_code]:text-xs [&_pre]:!bg-transparent"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
