import type { ReactNode } from "react"
import { BotIcon, UsersIcon } from "lucide-react"

import type { ChatUser } from "@/chat/api"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
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

interface PeopleProps {
  me: ChatUser | null
  agent: ChatUser | null
  /** Connected now, in the order they arrived. */
  online: ChatUser[]
  /** Everyone who has ever joined, most recently seen first. */
  users: ChatUser[]
}

/** Me first, then everyone else online in the order they arrived. */
function onlinePeople({ me, online }: PeopleProps): ChatUser[] {
  const mine = online.filter((u) => u.id === me?.id)
  return [...mine, ...online.filter((u) => u.id !== me?.id)]
}

/** Everyone not connected right now, most recently seen first. */
function offlinePeople({ online, users }: PeopleProps): ChatUser[] {
  const here = new Set(online.map((u) => u.id))
  return users.filter((u) => !here.has(u.id))
}

function initials(name: string): string {
  return name.replace(/^anon-/, "").slice(0, 2).toUpperCase()
}

function UserRow({
  user,
  you,
  agent,
  offline,
}: {
  user: ChatUser
  you?: boolean
  agent?: boolean
  offline?: boolean
}) {
  return (
    <li className={cn("flex items-center gap-3 rounded-lg px-2 py-1.5", offline && "text-muted-foreground")}>
      <Avatar size="sm" className={cn(offline && "opacity-50")}>
        <AvatarFallback className={cn(agent && "bg-foreground text-background")}>
          {agent ? <BotIcon className="size-3.5" /> : initials(user.name)}
        </AvatarFallback>
        {!offline && <AvatarBadge className="bg-emerald-500" />}
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm">
        {user.name}
        {you && <span className="text-muted-foreground"> (you)</span>}
      </span>
      {agent && <span className="text-xs text-muted-foreground">AI</span>}
    </li>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h3 className="flex h-8 items-center px-2 text-xs font-medium text-muted-foreground">
        {title}
        <span className="ml-auto tabular-nums">{count}</span>
      </h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  )
}

function PeopleList(props: PeopleProps) {
  const online = onlinePeople(props)
  const offline = offlinePeople(props)
  return (
    <div className="flex flex-col gap-3">
      <Section title="Online" count={online.length}>
        {props.agent && <UserRow user={props.agent} agent />}
        {online.map((u) => (
          <UserRow key={u.id} user={u} you={u.id === props.me?.id} />
        ))}
      </Section>
      {offline.length > 0 && (
        <Section title="Offline" count={offline.length}>
          {offline.map((u) => (
            <UserRow key={u.id} user={u} offline />
          ))}
        </Section>
      )}
    </div>
  )
}

/**
 * Desktop: the list stays open on the left, floating over the eyes with no
 * background. Only the list itself takes pointer input, so the rest of the
 * strip still reaches the canvas.
 */
export function PeopleSidebar(props: PeopleProps & { className?: string }) {
  return (
    <aside className={cn("pointer-events-none flex w-56 flex-col", props.className)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 *:pointer-events-auto">
        <PeopleList {...props} />
      </div>
    </aside>
  )
}

/** Mobile: a navbar button that opens the list in a dialog. */
export function PeopleDialogButton(props: PeopleProps) {
  const online = props.online.length
  const offline = offlinePeople(props).length
  return (
    <Dialog>
      <DialogTrigger
        render={<Button variant="ghost" size="sm" aria-label={`People (${online} online)`} />}
      >
        <UsersIcon />
        <span className="tabular-nums">{online}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>People</DialogTitle>
          <DialogDescription>
            {online} online · {offline} offline
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-2 max-h-[60vh] overflow-y-auto">
          <PeopleList {...props} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
