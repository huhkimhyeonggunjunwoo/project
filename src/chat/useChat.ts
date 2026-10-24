import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react"

import {
  fetchMessagesBefore,
  wsUrl,
  type ChatUser,
  type MessagePage,
  type ServerEvent,
  type ServerMessage,
} from "@/chat/api"

const TOKEN_KEY = "onehouse.token"

export type ConnectionStatus = "connecting" | "open" | "closed"

export interface ChatMessage extends Omit<ServerMessage, "id"> {
  /** Stable React key: the clientId while pending, kept after confirmation. */
  key: string
  /** Server id; null until the server has stored it. */
  id: number | null
  pending: boolean
}

interface State {
  me: ChatUser | null
  /** The room's AI agent; always around, so it isn't in `online`. */
  agent: ChatUser | null
  /** People connected right now, in the order they arrived. */
  online: ChatUser[]
  status: ConnectionStatus
  /** Stored messages sorted by id, then this client's pending ones. */
  messages: ChatMessage[]
  hasMore: boolean
}

type Action =
  | { type: "status"; status: ConnectionStatus }
  | { type: "welcome"; user: ChatUser; history: MessagePage; online: ChatUser[]; agent: ChatUser | null }
  | { type: "presence"; users: ChatUser[] }
  | { type: "received"; message: ServerMessage; clientId?: string }
  | { type: "pending"; message: ChatMessage }
  | { type: "older"; page: MessagePage }

const initialState: State = {
  me: null,
  agent: null,
  online: [],
  status: "connecting",
  messages: [],
  hasMore: false,
}

const fromServer = (m: ServerMessage, key = `m${m.id}`): ChatMessage => ({ ...m, key, pending: false })

function split(messages: ChatMessage[]) {
  return {
    stored: messages.filter((m) => !m.pending),
    pending: messages.filter((m) => m.pending),
  }
}

/** Union by id, sorted by id. Keeps the first copy so React keys stay put. */
function mergeById(...lists: ChatMessage[][]): ChatMessage[] {
  const byId = new Map<number, ChatMessage>()
  for (const list of lists) {
    for (const m of list) if (m.id !== null && !byId.has(m.id)) byId.set(m.id, m)
  }
  return [...byId.values()].sort((a, b) => a.id! - b.id!)
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status }

    case "welcome": {
      const page = action.history.messages.map((m) => fromServer(m))
      const { stored, pending } = split(state.messages)
      const newestKnown = stored.at(-1)?.id ?? 0
      const oldestInPage = page[0]?.id ?? Infinity
      // First load, or we missed more than a page while offline: start over
      // from the latest page instead of leaving a hole in the history.
      const reset = stored.length === 0 || (newestKnown < oldestInPage && action.history.hasMore)
      return {
        me: action.user,
        agent: action.agent,
        online: action.online,
        status: "open",
        messages: [...(reset ? page : mergeById(stored, page)), ...pending],
        hasMore: reset ? action.history.hasMore : state.hasMore,
      }
    }

    case "received": {
      const { clientId } = action
      const matched = clientId !== undefined && state.messages.some((m) => m.key === clientId)
      const { stored, pending } = split(
        matched ? state.messages.filter((m) => m.key !== clientId) : state.messages
      )
      const incoming = fromServer(action.message, matched ? clientId : undefined)
      return { ...state, messages: [...mergeById(stored, [incoming]), ...pending] }
    }

    case "presence":
      return { ...state, online: action.users }

    case "pending":
      return { ...state, messages: [...state.messages, action.message] }

    case "older": {
      const { stored, pending } = split(state.messages)
      const page = action.page.messages.map((m) => fromServer(m))
      return { ...state, messages: [...mergeById(stored, page), ...pending], hasMore: action.page.hasMore }
    }
  }
}

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Private mode etc.: the user just gets a new anonymous id next time.
  }
}

/**
 * Connects to the shared chat room. Keeps the anonymous identity across
 * visits, reconnects on its own, and pages in older history on demand.
 */
export function useChat() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  const wsRef = useRef<WebSocket | null>(null)
  const loadingOlderRef = useRef(false)
  const nextClientId = useRef(0)

  useLayoutEffect(() => {
    stateRef.current = state
  })

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let retryTimer: number | undefined

    const connect = () => {
      dispatch({ type: "status", status: "connecting" })
      const ws = new WebSocket(wsUrl("/ws"))
      wsRef.current = ws

      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: loadToken() }))

      ws.onmessage = (e) => {
        let event: ServerEvent
        try {
          event = JSON.parse(e.data)
        } catch {
          return
        }
        if (event.type === "welcome") {
          attempt = 0
          saveToken(event.token)
          dispatch({
            type: "welcome",
            user: event.user,
            history: event.history,
            online: event.online,
            agent: event.agent,
          })
          // Resend anything typed while we were offline.
          for (const m of stateRef.current.messages) {
            if (m.pending) ws.send(JSON.stringify({ type: "send", text: m.text, clientId: m.key }))
          }
        } else if (event.type === "presence") {
          dispatch({ type: "presence", users: event.users })
        } else if (event.type === "message") {
          dispatch({ type: "received", message: event.message, clientId: event.clientId })
        } else if (event.type === "error") {
          console.warn("[chat]", event.message)
        }
      }

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        if (disposed) return
        dispatch({ type: "status", status: "closed" })
        const delay = Math.min(10_000, 500 * 2 ** attempt++)
        retryTimer = window.setTimeout(connect, delay)
      }
    }

    connect()

    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      const ws = wsRef.current
      wsRef.current = null
      if (!ws) return
      // Closing mid-handshake logs a browser warning; wait for open instead.
      if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close()
      else ws.close()
    }
  }, [])

  /** Sends a message; it shows right away as pending until the server confirms. */
  const send = useCallback((text: string): boolean => {
    const ws = wsRef.current
    const { me } = stateRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !me) return false

    const key = `c${Date.now().toString(36)}-${nextClientId.current++}`
    dispatch({
      type: "pending",
      message: {
        key,
        id: null,
        userId: me.id,
        userName: me.name,
        text,
        createdAt: new Date().toISOString(),
        pending: true,
      },
    })
    ws.send(JSON.stringify({ type: "send", text, clientId: key }))
    return true
  }, [])

  /** Loads the page just before the oldest message we have. */
  const loadOlder = useCallback(async () => {
    const { messages, hasMore } = stateRef.current
    const oldest = messages.find((m) => m.id !== null)?.id
    if (loadingOlderRef.current || !hasMore || oldest == null) return
    loadingOlderRef.current = true
    try {
      dispatch({ type: "older", page: await fetchMessagesBefore(oldest) })
    } catch (err) {
      console.warn("[chat]", err)
    } finally {
      loadingOlderRef.current = false
    }
  }, [])

  return { ...state, send, loadOlder }
}

export type Chat = ReturnType<typeof useChat>
