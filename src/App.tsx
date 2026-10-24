import { useEffect, useState } from "react"

import { Agent } from "@/agent/Agent"
import { useChat } from "@/chat/useChat"
import { AchievementsDialogButton, AchievementsHoverButton } from "@/components/Achievements"
import { AgentEyes } from "@/components/AgentEyes"
import { ChatPanel } from "@/components/ChatPanel"
import { PeopleDialogButton, PeopleSidebar } from "@/components/People"
import { FloatingPeople, useSpotlight } from "@/components/FloatingPeople"

export function App() {
  const [agent] = useState(() => new Agent())
  const chat = useChat()
  const people = { me: chat.me, agent: chat.agent, online: chat.online, users: chat.users }
  const spotlight = useSpotlight(chat.messages, chat.me)

  useEffect(() => agent.setThinking(chat.agentTyping), [agent, chat.agentTyping])

  return (
    <main className="relative h-full overflow-hidden">
      <AgentEyes agent={agent} />
      {/* Above the eyes (whose top sits at about a third of the height), clear of the navbar. */}
      <FloatingPeople
        people={spotlight.people}
        version={spotlight.version}
        leaving={spotlight.leaving}
        onArrive={(x, y) => agent.glance(x, y)}
        className="absolute inset-x-0 top-12 bottom-[69%]"
      />
      <PeopleSidebar {...people} className="absolute inset-y-0 left-0 hidden lg:flex" />
      <AchievementsHoverButton earned={chat.achievements} className="absolute top-2 right-2 hidden lg:block" />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex h-12 items-center justify-between px-2 *:pointer-events-auto lg:hidden">
        <PeopleDialogButton {...people} />
        <AchievementsDialogButton earned={chat.achievements} />
      </header>
      <ChatPanel
        chat={chat}
        onCaretMove={(x, y) => agent.pointerMove(x, y)}
        onSend={() => agent.acknowledge()}
        onShowPeople={spotlight.show}
      />
    </main>
  )
}
