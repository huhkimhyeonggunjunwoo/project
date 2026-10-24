import type { CSSProperties } from "react"
import type { LucideIcon } from "lucide-react"
import { LinkIcon, PencilLineIcon, SparklesIcon, TrophyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface AchievementsProps {
  /** Keys of the ones I've earned (see server/achievements.py). */
  earned: string[]
}

const ACHIEVEMENTS: { key: string; title: string; description: string; icon: LucideIcon }[] = [
  {
    key: "profile",
    title: "Share your profile",
    description: "Send a link to your LinkedIn, GitHub, or another profile.",
    icon: LinkIcon,
  },
  {
    key: "match",
    title: "Get matched",
    description: "Ask to meet people who fit your profile.",
    icon: SparklesIcon,
  },
  {
    key: "rename",
    title: "Change your name",
    description: "Ask to go by a new name in the room.",
    icon: PencilLineIcon,
  },
]

/**
 * One piece of the hover list (see AchievementsHoverButton). Each floats in
 * the way chat bubbles arrive, one after another by `i`, and leaves the same
 * way in reverse: the last one in is the first one out.
 */
const REVEAL = cn(
  "origin-top-left translate-y-2 scale-[0.92] opacity-0 blur-[6px] motion-reduce:transition-none",
  "transition-[translate,scale,opacity,filter] duration-500 ease-[cubic-bezier(0.34,1.4,0.64,1)]",
  "delay-[calc((var(--n)-1-var(--i))*70ms)] revealed:delay-[calc(var(--i)*70ms)]",
  "revealed:translate-y-0 revealed:scale-100 revealed:opacity-100 revealed:blur-none"
)

// The header and the progress bar, then a row for each.
const PIECES = ACHIEVEMENTS.length + 2

/** Props for the `i`th piece of the list, when it's revealed on hover. */
function reveal(on: boolean | undefined, i: number): { className?: string; style?: CSSProperties } {
  return on ? { className: REVEAL, style: { "--i": i, "--n": PIECES } as CSSProperties } : {}
}

function progress(earned: string[]): number {
  return ACHIEVEMENTS.filter((a) => earned.includes(a.key)).length
}

function AchievementRow({
  title,
  description,
  icon: Icon,
  done,
  className,
  style,
}: {
  title: string
  description: string
  icon: LucideIcon
  done: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <li className={cn("flex gap-3 rounded-lg px-2 py-2", className)} style={style}>
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-300",
          done ? "bg-emerald-500/15 text-emerald-400" : "bg-muted/60 text-muted-foreground"
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm leading-5 font-medium", done && "text-muted-foreground")}>{title}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
      </div>
    </li>
  )
}

function AchievementList({ earned, revealing }: AchievementsProps & { revealing?: boolean }) {
  const done = progress(earned)
  const header = reveal(revealing, 0)
  const bar = reveal(revealing, 1)
  return (
    <section>
      <h3
        className={cn("flex h-8 items-center px-2 text-xs font-medium text-muted-foreground", header.className)}
        style={header.style}
      >
        Achievements
        <span className="ml-auto tabular-nums">
          {done}/{ACHIEVEMENTS.length}
        </span>
      </h3>
      <div className={cn("mx-2 mb-1.5 h-1 overflow-hidden rounded-full bg-muted/60", bar.className)} style={bar.style}>
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-[cubic-bezier(0.2,0,0,1)]"
          style={{ width: `${(done / ACHIEVEMENTS.length) * 100}%` }}
        />
      </div>
      <ul className="flex flex-col gap-0.5">
        {ACHIEVEMENTS.map(({ key, ...a }, i) => (
          <AchievementRow key={key} {...a} done={earned.includes(key)} {...reveal(revealing, i + 2)} />
        ))}
      </ul>
    </section>
  )
}

/** The trophy and how many are done, for the navbar buttons. */
function Tally({ earned }: AchievementsProps) {
  return (
    <>
      <TrophyIcon />
      <span className="tabular-nums">
        {progress(earned)}/{ACHIEVEMENTS.length}
      </span>
    </>
  )
}

function label(earned: string[]): string {
  return `Achievements (${progress(earned)} of ${ACHIEVEMENTS.length})`
}

/**
 * Desktop: a navbar button. Hovering it (or tabbing to it) brings the list in
 * below, floating over the eyes like the people list, piece by piece. The
 * padding above the list keeps the hover alive on the way down to it.
 */
export function AchievementsHoverButton(props: AchievementsProps & { className?: string }) {
  return (
    <div data-reveal className={cn("relative", props.className)}>
      <Button variant="ghost" size="sm" aria-label={label(props.earned)}>
        <Tally {...props} />
      </Button>
      <div className="pointer-events-none absolute top-full right-0 w-56 pt-2 revealed:pointer-events-auto">
        <AchievementList {...props} revealing />
      </div>
    </div>
  )
}

/** Mobile: a navbar button that opens the list in a dialog. */
export function AchievementsDialogButton(props: AchievementsProps) {
  const done = progress(props.earned)
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="sm" aria-label={label(props.earned)} />}>
        <Tally {...props} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Achievements</DialogTitle>
          <DialogDescription>
            {done} of {ACHIEVEMENTS.length} done
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-2 max-h-[60vh] scrollbar-thin overflow-y-auto">
          <AchievementList {...props} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
