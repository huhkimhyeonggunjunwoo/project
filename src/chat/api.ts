const API_URL = (import.meta.env.VITE_API_URL || "/api").replace(/\/+$/, "")

export function apiUrl(path: string): string {
  return `${API_URL}${path}`
}

/** Same base as the HTTP API, with ws:// or wss:// to match. */
export function wsUrl(path: string): string {
  const url = new URL(apiUrl(path), window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export interface ChatUser {
  id: string
  name: string
}

export interface ServerMessage {
  id: number
  userId: string
  userName: string
  text: string
  createdAt: string
}

/** A note only this client gets. Not stored, so it has no id. */
export interface PrivateMessage extends Omit<ServerMessage, "id"> {
  /** Identifies the note, so a reconnect doesn't show it twice. */
  key: string
}

export interface MessagePage {
  /** Oldest first. */
  messages: ServerMessage[]
  /** Whether older messages exist before this page. */
  hasMore: boolean
}

export type ServerEvent =
  | {
      type: "welcome"
      user: ChatUser
      token: string
      history: MessagePage
      /** Connected people, in the order they arrived. */
      online: ChatUser[]
      agent: ChatUser | null
    }
  | { type: "presence"; users: ChatUser[] }
  | { type: "private"; message: PrivateMessage }
  | { type: "message"; message: ServerMessage; clientId?: string }
  | { type: "error"; message: string }

export async function fetchMessagesBefore(before: number): Promise<MessagePage> {
  const res = await fetch(apiUrl(`/messages?before=${before}`))
  if (!res.ok) throw new Error(`Failed to load messages (${res.status})`)
  return res.json()
}
