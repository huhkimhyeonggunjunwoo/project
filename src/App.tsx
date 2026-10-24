import { useState } from "react"

import { Agent } from "@/agent/Agent"
import { useChat } from "@/chat/useChat"
import { AgentEyes } from "@/components/AgentEyes"
import { ChatPanel } from "@/components/ChatPanel"
import { PeopleDialogButton, PeopleSidebar } from "@/components/People"

export function App() {
  const [agent] = useState(() => new Agent())
  const chat = useChat()
  const people = { me: chat.me, agent: chat.agent, online: chat.online, users: chat.users }

  return (
    <main className="relative h-full overflow-hidden">
      <AgentEyes agent={agent} />
      <PeopleSidebar {...people} className="absolute inset-y-0 left-0 hidden lg:flex" />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center px-2 *:pointer-events-auto lg:hidden">
        <PeopleDialogButton {...people} />
      </header>
      <ChatPanel
        chat={chat}
        onCaretMove={(x, y) => agent.pointerMove(x, y)}
        onSend={() => agent.acknowledge()}
      />
    </main>
  )
}
