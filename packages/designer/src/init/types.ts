// Шляхи в `path` — абсолютні: план не залежить від теки, з якої його рендерять
export type InitAction =
  | {
      kind: "link"
      path: string
      target: string
      type: "dir" | "junction"
      replaces: boolean
    }
  | { kind: "unlink"; path: string }
  | { kind: "write"; path: string; content: string; creates: boolean }

export type InitNote =
  | { kind: "foreign-skill"; path: string }
  | { kind: "aliased-skill-dir"; path: string }
  | { kind: "foreign-mcp-entry"; path: string }

export type InitRefusalReason =
  | "invalid-json"
  | "not-an-object"
  | "servers-not-an-object"
  | "invalid-toml"
  | "ambiguous-toml"
  | "not-a-directory"
  | "not-a-file"
  | "skill-dir-is-a-link"
  | "unreadable"

export interface InitRefusal {
  path: string
  reason: InitRefusalReason
  code?: string
}

export interface InitPlan {
  actions: InitAction[]
  notes: InitNote[]
  refusals: InitRefusal[]
}
