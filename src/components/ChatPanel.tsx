import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { ArrowRightIcon, EyeOffIcon } from "lucide-react"

import type { Chat } from "@/chat/useChat"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
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
  const { me, agent, agentTyping, status, messages, hasMore, send, loadOlder } = chat
  const [draft, setDraft] = useState("")
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

  // Scrolled near the top of the history: load the page before it.
  const onHistoryScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport && viewport.scrollTop < LOAD_OLDER_THRESHOLD) void loadOlder()
  }, [loadOlder])

  // History doesn't fill the area yet (so it can't be scrolled): load more.
  useEffect(() => {
    if (!hasMore) return
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current
      if (viewport && viewport.scrollHeight <= viewport.clientHeight) void loadOlder()
    })
    return () => cancelAnimationFrame(frame)
  }, [hasMore, messages.length, loadOlder])

  const trackCaret = (input: HTMLInputElement) => {
    if (!onCaretMove) return
    const p = caretPoint(input)
    onCaretMove(p.x, p.y)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !send(text)) return
    setDraft("")
    onSend?.(text)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[56%] bottom-0 flex justify-center px-4 pb-[max(1rem,8vh)]">
      <div className="flex min-h-0 w-full max-w-137 flex-col gap-3">
        {messages.length > 0 && (
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
                        <Message>
                          <ToolCallMarker tool={m.tool} />
                        </Message>
                      </MessageScrollerItem>
                    )
                  }
                  return (
                    <MessageScrollerItem key={m.key} messageId={m.key}>
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
                    </MessageScrollerItem>
                  )
                })}
                {agentTyping && (
                  <MessageScrollerItem key="agent-typing" messageId="agent-typing">
                    <TypingIndicator name={typingFollowsAgent ? undefined : agent?.name} />
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
        </form>
      </div>
    </div>
  )
}
