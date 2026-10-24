import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { ArrowRightIcon, EyeIcon, EyeOffIcon } from "lucide-react"

import type { ChatUser } from "@/chat/api"
import type { Chat, ChatMessage } from "@/chat/useChat"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { ToolCallMarker } from "@/components/ToolCallMarker"
import { TypingIndicator } from "@/components/TypingIndicator"
import { cn } from "@/lib/utils"

/** How close to the top (px) the history has to be before older pages load. */
const LOAD_OLDER_THRESHOLD = 48

const HIDE_OTHERS_KEY = "onehouse.hideOthers"

/**
 * Whether to hide everyone else's conversations, remembered across visits.
 * This only changes what I see: the room stays public either way.
 */
function useHideOthers() {
  const [hide, setHide] = useState(() => {
    try {
      return localStorage.getItem(HIDE_OTHERS_KEY) === "1"
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(HIDE_OTHERS_KEY, hide ? "1" : "0")
    } catch {
      // Private mode etc.: it just isn't remembered.
    }
  }, [hide])
  return [hide, setHide] as const
}

/**
 * Animates a message in when it arrives live (sent or received while I'm
 * here): earlier messages slide up to make room, and the bubble springs up
 * from its corner. History loads in place, without the animation.
 */
function Arrival({ live, align, children }: { live?: boolean; align: "start" | "end"; children: ReactNode }) {
  if (!live) return children
  return (
    <div className="grid motion-safe:animate-message-in">
      <div
        className={cn(
          "min-h-0 motion-safe:animate-bubble-in",
          align === "end" ? "origin-bottom-right" : "origin-bottom-left"
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Suggested next messages under the agent's last reply, each asking it to
 * find someone. They make room and pop in one after another; tapping one
 * sends it.
 */
function Hints({ hints, disabled, onPick }: { hints: string[]; disabled: boolean; onPick: (hint: string) => void }) {
  return (
    <div className="grid motion-safe:animate-message-in">
      <div className="flex min-h-0 flex-wrap gap-2 pt-0.5" role="group" aria-label="Suggestions">
        {hints.map((hint, i) => (
          <button
            key={hint}
            type="button"
            disabled={disabled}
            onClick={() => onPick(hint)}
            style={{ animationDelay: `${120 + i * 70}ms` }}
            className="origin-bottom-left cursor-pointer rounded-full border border-white/25 bg-black px-3.5 py-1.5 text-[13px] text-white/85 transition-[color,border-color,transform] hover:border-white/50 hover:text-white active:scale-95 disabled:pointer-events-none disabled:opacity-50 motion-safe:animate-bubble-in"
          >
            {hint}
          </button>
        ))}
      </div>
    </div>
  )
}

/** What I still see with others hidden: my messages, notes only I get, and
 * whatever the agent posted while answering me. */
function isMine(m: ChatMessage, me: ChatUser | null): boolean {
  return m.private || (me !== null && (m.userId === me.id || !!m.replyTo?.includes(me.id)))
}

interface ChatPanelProps {
  chat: Chat
  /** Screen position of the text caret, so the eyes can follow what's typed. */
  onCaretMove?: (x: number, y: number) => void
  onSend?: (text: string) => void
}

let measureCtx: CanvasRenderingContext2D | null = null

function caretPoint(input: HTMLInputElement): { x: number; y: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d")
  const style = getComputedStyle(input)
  const rect = input.getBoundingClientRect()
  let width = 0
  if (measureCtx) {
    measureCtx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    width = measureCtx.measureText(input.value.slice(0, input.selectionStart ?? 0)).width
  }
  const x = rect.left + parseFloat(style.paddingLeft) + width - input.scrollLeft
  return { x: Math.min(x, rect.right), y: rect.top + rect.height / 2 }
}

/**
 * Open chat overlay pinned to the bottom center of its container: one room
 * shared by everyone.
 * Past messages stack above the input, stay below the eyes, fade out at the
 * top when there's more to scroll back to, and older pages load on scroll.
 */
export function ChatPanel(props: ChatPanelProps) {
  return (
    <MessageScrollerProvider autoScroll>
      <ChatPanelBody {...props} />
    </MessageScrollerProvider>
  )
}

function ChatPanelBody({ chat, onCaretMove, onSend }: ChatPanelProps) {
  const { me, agent, agentTyping, agentReplyTo, status, hasMore, send, loadOlder } = chat
  const [draft, setDraft] = useState("")
  const [hideOthers, setHideOthers] = useHideOthers()
  const messages = hideOthers ? chat.messages.filter((m) => isMine(m, me)) : chat.messages
  // With others hidden, only show the agent typing when it's answering me.
  const showTyping = agentTyping && (!hideOthers || (me !== null && agentReplyTo.includes(me.id)))
  const { scrollToEnd } = useMessageScroller()
  const viewportRef = useRef<HTMLDivElement>(null)
  const connected = status === "open"

  // Jump to the newest message as soon as I send one, even if scrolled up.
  const lastMessage = messages[messages.length - 1]
  // Name the typing bubble unless it directly follows the agent's own bubble.
  const typingFollowsAgent =
    lastMessage?.userId === agent?.id && !lastMessage?.private && !lastMessage?.tool
  useLayoutEffect(() => {
    if (lastMessage?.pending) scrollToEnd()
  }, [lastMessage, scrollToEnd])
  // Once the agent is done, under its reply if that's still the last thing I see.
  const hints = !showTyping && lastMessage?.id === chat.hints?.messageId ? chat.hints : null
  // Hints come a moment after the reply, often after I've nudged the scroll
  // while reading it, which stops the scroller following the bottom. If I'm
  // still within a screen of the end, bring them into view (and keep following
  // as they grow in); if I've scrolled back into history, leave me there.
  const hintsFor = hints?.messageId
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (hintsFor === undefined || !viewport) return
    const belowView = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    if (belowView < viewport.clientHeight) scrollToEnd()
  }, [hintsFor, scrollToEnd])

  // Scrolled near the top of the history: load the page before it.
  const onHistoryScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport && viewport.scrollTop < LOAD_OLDER_THRESHOLD) void loadOlder()
  }, [loadOlder])

  // History doesn't fill the area yet (so it can't be scrolled): load more.
  // Counts every message, not just the shown ones, so with others hidden a
  // page with nothing of mine still leads on to the next.
  const loaded = chat.messages.length
  useEffect(() => {
    if (!hasMore) return
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current
      if (viewport && viewport.scrollHeight <= viewport.clientHeight) void loadOlder()
    })
    return () => cancelAnimationFrame(frame)
  }, [hasMore, loaded, loadOlder])

  const trackCaret = (input: HTMLInputElement) => {
    if (!onCaretMove) return
    const p = caretPoint(input)
    onCaretMove(p.x, p.y)
  }

  const sendText = (text: string): boolean => {
    if (!send(text)) return false
    onSend?.(text)
    return true
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (text && sendText(text)) setDraft("")
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[56%] bottom-0 flex justify-center px-4 pb-[max(1rem,8vh)]">
      <div className="flex min-h-0 w-full max-w-137 flex-col gap-3">
        {loaded > 0 && (
          <MessageScroller className="pointer-events-auto flex-1">
            <MessageScrollerViewport ref={viewportRef} onScroll={onHistoryScroll} className="scroll-fade-18">
              <MessageScrollerContent className="justify-end gap-2.5 px-1 pb-1">
                {messages.map((m, i) => {
                  const mine = m.userId === me?.id
                  const prev = messages[i - 1]
                  const showName =
                    !mine && !m.private && !m.tool && (prev?.userId !== m.userId || prev.private || !!prev.tool)
                  if (m.tool) {
                    return (
                      <MessageScrollerItem key={m.key} messageId={m.key}>
                        <Arrival live={m.live} align="start">
                          <Message>
                            <ToolCallMarker tool={m.tool} />
                          </Message>
                        </Arrival>
                      </MessageScrollerItem>
                    )
                  }
                  return (
                    <MessageScrollerItem key={m.key} messageId={m.key}>
                      <Arrival live={m.live} align={mine ? "end" : "start"}>
                        <Message align={mine ? "end" : "start"}>
                          <MessageContent className="gap-1">
                            {showName && <MessageHeader>{m.userName}</MessageHeader>}
                            {m.private && (
                              <MessageHeader className="gap-1">
                                <EyeOffIcon className="size-3" />
                                Only visible to you
                              </MessageHeader>
                            )}
                            <Bubble
                              variant={mine || m.private ? "default" : "secondary"}
                              className={cn(
                                "transition-opacity duration-300",
                                // My messages: white bubble with dark text.
                                mine && "[--primary:oklch(1_0_0)] [--primary-foreground:oklch(0.145_0_0)]",
                                // Only-me notes: yellow bubble with dark text.
                                m.private && "[--primary:oklch(0.852_0.199_91.936)] [--primary-foreground:oklch(0.145_0_0)]",
                                m.pending && "opacity-60"
                              )}
                            >
                              <BubbleContent className="rounded-2xl px-4 py-2 text-[15px]">
                                {m.text}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </Arrival>
                    </MessageScrollerItem>
                  )
                })}
                {hints && (
                  <MessageScrollerItem key={`hints-${hints.messageId}`} messageId="agent-hints">
                    <Hints hints={hints.hints} disabled={!connected} onPick={sendText} />
                  </MessageScrollerItem>
                )}
                {showTyping && (
                  <MessageScrollerItem key="agent-typing" messageId="agent-typing">
                    <Arrival live align="start">
                      <TypingIndicator name={typingFollowsAgent ? undefined : agent?.name} />
                    </Arrival>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton className="rounded-full" />
          </MessageScroller>
        )}

        <form onSubmit={submit} className="pointer-events-auto mt-auto shrink-0">
          <InputGroup className="h-10">
            <InputGroupInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onSelect={(e) => trackCaret(e.currentTarget)}
              onFocus={(e) => trackCaret(e.currentTarget)}
              placeholder={connected ? "Ask something..." : "Connecting..."}
              aria-label="Message"
              autoComplete="off"
              maxLength={1000}
              className="pl-3"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                aria-label="Send"
                disabled={!connected || !draft.trim()}
                // White button with a dark arrow, like my message bubbles.
                className="[--primary:oklch(1_0_0)] [--primary-foreground:oklch(0.145_0_0)]"
              >
                <ArrowRightIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <div className="mt-1.5 flex items-center justify-end gap-2 px-1">
            {hideOthers && (
              <span className="text-xs text-muted-foreground">Everyone can still see your chats</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={hideOthers}
              onClick={() => setHideOthers((h) => !h)}
              className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
            >
              {hideOthers ? <EyeOffIcon /> : <EyeIcon />}
              Hide others
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
