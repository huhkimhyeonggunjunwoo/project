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

/** Something the agent did, posted to the room so everyone can see it. */
export interface ToolCall {
  name: string
  input: Record<string, unknown>
  /** What happened, in words. */
  output: string
  isError: boolean
  /** Pages a web search returned. */
  results?: { title: string; url: string }[]
  /** recommend_people: id of the person the recommendation is for. */
  for?: string
  /** recommend_people: who the agent recommended, best fit first. */
  people?: RecommendedPerson[]
}

/** Someone the agent recommended, as the server filled them in. */
export interface RecommendedPerson {
  id: string
  name: string
  /** Who they are, in a few words. */
  headline: string
  /** Why they fit, written to the person they were recommended to. */
  reason: string
  /** Their profiles: the ones they shared first. */
  links: string[]
  /** Whether they were online when recommended. */
  online: boolean
}

export interface ServerMessage {
  id: number
  userId: string
  userName: string
  text: string
  createdAt: string
  /** Set when this is a record of an agent tool call rather than a chat line. */
  tool?: ToolCall | null
  /** Agent messages: ids of the people it was answering. */
  replyTo?: string[] | null
}

/** A note only this client gets. Not stored, so it has no id. */
export interface PrivateMessage extends Omit<ServerMessage, "id"> {
  /** Identifies the note, so a reconnect doesn't show it twice. */
  key: string
  /** Suggested replies to show under it. */
  hints?: string[]
}

/** Suggested next messages for me, shown under the agent's reply #messageId. */
export interface AgentHints {
  messageId: number
  hints: string[]
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
      /** Everyone who has ever joined, most recently seen first. */
      users: ChatUser[]
      agent: ChatUser | null
      /** Whether the agent is working on a reply right now. */
      agentTyping: boolean
      /** Ids of the people that reply is for. */
      agentReplyTo: string[]
      /** The latest hints, if they're for me. */
      hints: AgentHints | null
      /** Keys of the achievements I've earned. */
      achievements?: string[]
    }
  | { type: "presence"; users: ChatUser[] }
  | { type: "private"; message: PrivateMessage }
  | { type: "rename"; user: ChatUser }
  | { type: "typing"; typing: boolean; replyTo: string[] }
  | ({ type: "hints" } & AgentHints)
  | { type: "achievement"; key: string }
  | { type: "message"; message: ServerMessage; clientId?: string }
  | { type: "error"; message: string }

/**
 * A page of history: the newest messages, or those before `before`. With
 * `forUser`, only their messages and the agent's replies to them.
 */
export async function fetchMessages({
  before,
  forUser,
}: { before?: number; forUser?: string } = {}): Promise<MessagePage> {
  const params = new URLSearchParams()
  if (before !== undefined) params.set("before", String(before))
  if (forUser !== undefined) params.set("for", forUser)
  const res = await fetch(apiUrl(`/messages?${params}`))
  if (!res.ok) throw new Error(`Failed to load messages (${res.status})`)
  return res.json()
}
