import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"

const DELAYS = ["0ms", "150ms", "300ms"]

/** The agent is writing: three dots bouncing in a reply bubble. */
export function TypingIndicator({ name }: { name?: string }) {
  return (
    <Message align="start" role="status" aria-label={`${name ?? "The agent"} is typing`}>
      <MessageContent className="gap-1">
        {name && <MessageHeader>{name}</MessageHeader>}
        <Bubble variant="secondary">
          <BubbleContent className="flex h-9.5 flex-row items-center gap-1 rounded-2xl px-4">
            {DELAYS.map((delay) => (
              <span
                key={delay}
                className="size-1.5 animate-typing-dot rounded-full bg-current"
                style={{ animationDelay: delay }}
              />
            ))}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}
