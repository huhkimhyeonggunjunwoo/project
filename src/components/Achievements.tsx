import type { LucideIcon } from "lucide-react"
import { CheckIcon, LinkIcon, PencilLineIcon, SparklesIcon, TrophyIcon } from "lucide-react"

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

function progress(earned: string[]): number {
  return ACHIEVEMENTS.filter((a) => earned.includes(a.key)).length
}

function AchievementRow({
  title,
  description,
  icon: Icon,
  done,
}: {
  title: string
  description: string
  icon: LucideIcon
  done: boolean
}) {
  return (
    <li className="flex gap-3 rounded-lg px-2 py-1.5">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
          done ? "border-transparent bg-emerald-500 text-white" : "border-border bg-muted text-muted-foreground"
        )}
      >
        {done ? <CheckIcon className="size-3.5" strokeWidth={2.5} /> : <Icon className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm leading-7", done && "text-muted-foreground")}>{title}</p>
        <p className="text-xs leading-snug text-muted-foreground">{description}</p>
      </div>
    </li>
  )
}

function AchievementList({ earned }: AchievementsProps) {
  const done = progress(earned)
  return (
    <section>
      <h3 className="flex h-8 items-center px-2 text-xs font-medium text-muted-foreground">
        Achievements
        <span className="ml-auto tabular-nums">
          {done}/{ACHIEVEMENTS.length}
        </span>
      </h3>
      <div className="mx-2 mb-2 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-[cubic-bezier(0.2,0,0,1)]"
          style={{ width: `${(done / ACHIEVEMENTS.length) * 100}%` }}
        />
      </div>
      <ul className="flex flex-col gap-0.5">
        {ACHIEVEMENTS.map(({ key, ...a }) => (
          <AchievementRow key={key} {...a} done={earned.includes(key)} />
        ))}
      </ul>
    </section>
  )
}

/** Desktop: stays open on the right, floating over the eyes like the people list. */
export function AchievementsSidebar(props: AchievementsProps & { className?: string }) {
  return (
    <aside className={cn("pointer-events-none flex w-56 flex-col", props.className)}>
      <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-2 py-2 *:pointer-events-auto">
        <AchievementList {...props} />
      </div>
    </aside>
  )
}

/** Mobile: a navbar button that opens the list in a dialog. */
export function AchievementsDialogButton(props: AchievementsProps) {
  const done = progress(props.earned)
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={`Achievements (${done} of ${ACHIEVEMENTS.length})`} />
        }
      >
        <TrophyIcon />
        <span className="tabular-nums">
          {done}/{ACHIEVEMENTS.length}
        </span>
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
