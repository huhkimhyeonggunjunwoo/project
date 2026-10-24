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

interface OnlineUsersProps {
  me: ChatUser | null
  agent: ChatUser | null
  online: ChatUser[]
}

/** Me first, then everyone else in the order they arrived. */
function people({ me, online }: OnlineUsersProps): ChatUser[] {
  const mine = online.filter((u) => u.id === me?.id)
  return [...mine, ...online.filter((u) => u.id !== me?.id)]
}

function initials(name: string): string {
  return name.replace(/^anon-/, "").slice(0, 2).toUpperCase()
}

function UserRow({ user, you, agent }: { user: ChatUser; you?: boolean; agent?: boolean }) {
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-1.5">
      <Avatar size="sm">
        <AvatarFallback className={cn(agent && "bg-foreground text-background")}>
          {agent ? <BotIcon className="size-3.5" /> : initials(user.name)}
        </AvatarFallback>
        <AvatarBadge className="bg-emerald-500" />
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm">
        {user.name}
        {you && <span className="text-muted-foreground"> (you)</span>}
      </span>
      {agent && <span className="text-xs text-muted-foreground">AI</span>}
    </li>
  )
}

function UserList(props: OnlineUsersProps) {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.agent && <UserRow user={props.agent} agent />}
      {people(props).map((u) => (
        <UserRow key={u.id} user={u} you={u.id === props.me?.id} />
      ))}
    </ul>
  )
}

/**
 * Desktop: the list stays open on the left, floating over the eyes with no
 * background. Only the list itself takes pointer input, so the rest of the
 * strip still reaches the canvas.
 */
export function OnlineSidebar(props: OnlineUsersProps & { className?: string }) {
  return (
    <aside className={cn("pointer-events-none flex w-56 flex-col", props.className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 text-sm font-medium">
        Online
        <span className="ml-auto text-muted-foreground tabular-nums">{props.online.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 *:pointer-events-auto">
        <UserList {...props} />
      </div>
    </aside>
  )
}

/** Mobile: a navbar button that opens the list in a dialog. */
export function OnlineDialogButton(props: OnlineUsersProps) {
  const count = props.online.length
  return (
    <Dialog>
      <DialogTrigger
        render={<Button variant="ghost" size="sm" aria-label={`Online users (${count})`} />}
      >
        <UsersIcon />
        <span className="tabular-nums">{count}</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Online</DialogTitle>
          <DialogDescription>
            {count === 1 ? "1 person" : `${count} people`} in the room
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-2 max-h-[60vh] overflow-y-auto">
          <UserList {...props} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
