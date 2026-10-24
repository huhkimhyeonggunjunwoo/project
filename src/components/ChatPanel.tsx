import { useLayoutEffect, useRef, useState, type FormEvent } from "react"
import { ArrowRightIcon } from "lucide-react"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"

export interface ChatMessage {
  id: string
  role: "user" | "agent"
  text: string
}

interface ChatPanelProps {
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
 * Chat overlay pinned to the bottom center. Past messages stack above the
 * input, stay below the eyes, and fade out at the top when there's more to
 * scroll back to.
 */
export function ChatPanel(props: ChatPanelProps) {
  return (
    <MessageScrollerProvider autoScroll>
      <ChatPanelBody {...props} />
    </MessageScrollerProvider>
  )
}

function ChatPanelBody({ onCaretMove, onSend }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const nextId = useRef(0)
  const { scrollToEnd } = useMessageScroller()

  // Jump to the newest message as soon as it's sent, even if scrolled up.
  const lastMessage = messages[messages.length - 1]
  useLayoutEffect(() => {
    if (lastMessage?.role === "user") scrollToEnd()
  }, [lastMessage, scrollToEnd])

  const trackCaret = (input: HTMLInputElement) => {
    if (!onCaretMove) return
    const p = caretPoint(input)
    onCaretMove(p.x, p.y)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setMessages((prev) => [...prev, { id: `m${nextId.current++}`, role: "user", text }])
    setDraft("")
    onSend?.(text)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[56%] bottom-0 flex justify-center px-4 pb-[max(1rem,8vh)]">
      <div className="flex min-h-0 w-full max-w-137 flex-col gap-3">
        {messages.length > 0 && (
          <MessageScroller className="pointer-events-auto flex-1">
            <MessageScrollerViewport className="scroll-fade-18">
              <MessageScrollerContent className="justify-end gap-2.5 px-1 pb-1">
                {messages.map((m) => (
                  <MessageScrollerItem key={m.id} messageId={m.id}>
                    <Message align={m.role === "user" ? "end" : "start"}>
                      <MessageContent>
                        <Bubble
                          variant={m.role === "user" ? "default" : "ghost"}
                          // My messages: white bubble with dark text.
                          className="[--primary:oklch(1_0_0)] [--primary-foreground:oklch(0.145_0_0)]"
                        >
                          <BubbleContent className="rounded-2xl px-4 py-2 text-[15px]">
                            {m.text}
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton className="rounded-full" />
          </MessageScroller>
        )}

        <form onSubmit={submit} className="pointer-events-auto mt-auto shrink-0">
          <InputGroup className="h-12.5 rounded-full border-[3px] dark:bg-black">
            <InputGroupInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onSelect={(e) => trackCaret(e.currentTarget)}
              onFocus={(e) => trackCaret(e.currentTarget)}
              placeholder="type something to ask..."
              aria-label="Message"
              autoComplete="off"
              className="h-full pl-5 text-[15px] md:text-[15px] placeholder:text-neutral-600"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                aria-label="Send"
                className="size-8.5 rounded-full [&_svg:not([class*='size-'])]:size-4.5"
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
