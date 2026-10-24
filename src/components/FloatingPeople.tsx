import { useCallback, useEffect, useRef, useState } from "react"

import type { ChatUser, RecommendedPerson } from "@/chat/api"
import type { ChatMessage } from "@/chat/useChat"
import { initials } from "@/components/People"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

/** How long the float-out animation takes, so they're removed after it. */
const LEAVE_MS = 900

/**
 * The people the agent recommends to me, floated up as they arrive. Only
 * recommendations that come in live do this, not ones loaded as history,
 * and each one only once. They stay until the next one, or until Esc.
 */
export function useSpotlight(messages: ChatMessage[], me: ChatUser | null) {
  const [people, setPeople] = useState<RecommendedPerson[]>([])
  // Bumped each time they're shown, so showing the same people again replays their arrival.
  const [version, setVersion] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const seen = useRef(new Set<string>())
  const leaveTimer = useRef<number | undefined>(undefined)

  const show = useCallback((people: RecommendedPerson[]) => {
    window.clearTimeout(leaveTimer.current)
    setPeople(people)
    setLeaving(false)
    setVersion((v) => v + 1)
  }, [])

  const dismiss = useCallback(() => {
    setLeaving(true)
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setPeople([]), LEAVE_MS)
  }, [])

  useEffect(() => {
    let newest: RecommendedPerson[] | null = null
    // Live messages are always the newest ones.
    for (let i = messages.length - 1; i >= 0 && messages[i].live; i--) {
      const { key, tool } = messages[i]
      if (tool?.name !== "recommend_people" || tool.isError || tool.for !== me?.id || !tool.people?.length) continue
      if (seen.current.has(key)) continue
      seen.current.add(key)
      newest ??= tool.people
    }
    if (newest) show(newest)
  }, [messages, me, show])

  useEffect(() => {
    if (people.length === 0 || leaving) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [people, leaving, dismiss])

  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])

  return { people, version, leaving, show, dismiss }
}

function Person({ person, index }: { person: RecommendedPerson; index: number }) {
  const link = person.links[0]
  const face = (
    <>
      <Avatar className="size-14 transition-transform duration-300 group-hover/person:scale-105">
        <AvatarFallback className="text-base font-medium text-foreground">{initials(person.name)}</AvatarFallback>
        {person.online && <AvatarBadge className="size-3! bg-emerald-500" />}
      </Avatar>
      <span className="max-w-28 truncate text-sm text-foreground/90">{person.name}</span>
    </>
  )
  return (
    // Surfaces first, then drifts; each a little after and out of step with the last.
    <li className="pointer-events-auto motion-safe:animate-float-in" style={{ animationDelay: `${index * 280}ms` }}>
      <div className="motion-safe:animate-drift" style={{ animationDelay: `${-index * 2.1}s` }}>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            title={link}
            className="group/person flex flex-col items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {face}
          </a>
        ) : (
          <div className="flex flex-col items-center gap-2">{face}</div>
        )}
      </div>
    </li>
  )
}

/**
 * The recommended people, floating above the eyes like they do: no
 * background, just each one's avatar and name. Clicking one opens their
 * first profile link. `onArrive` gets the screen point they float in at.
 */
export function FloatingPeople({
  people,
  version,
  leaving,
  onArrive,
  className,
}: {
  people: RecommendedPerson[]
  version: number
  leaving: boolean
  onArrive?: (x: number, y: number) => void
  className?: string
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const arrived = people.length > 0

  useEffect(() => {
    const list = listRef.current
    if (!arrived || !list) return
    const { left, top, width, height } = list.getBoundingClientRect()
    onArrive?.(left + width / 2, top + height / 2)
    // Only when a new set arrives, not when the callback changes.
  }, [version, arrived])

  if (!arrived) return null
  return (
    <div className={cn("pointer-events-none flex items-end justify-center px-4", className)}>
      <ul
        key={version}
        ref={listRef}
        aria-label="People picked for you"
        className={cn(
          "flex flex-wrap items-end justify-center gap-x-10 gap-y-4",
          leaving && "motion-safe:animate-float-out motion-reduce:hidden"
        )}
      >
        {people.map((person, i) => (
          <Person key={person.id} person={person} index={i} />
        ))}
      </ul>
    </div>
  )
}
