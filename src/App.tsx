import { useState } from "react"

import { Agent } from "@/agent/Agent"
import { AgentEyes } from "@/components/AgentEyes"
import { ChatPanel } from "@/components/ChatPanel"

export function App() {
  const [agent] = useState(() => new Agent())

  return (
    <>
      <AgentEyes agent={agent} />
      <ChatPanel
        onCaretMove={(x, y) => agent.pointerMove(x, y)}
        onSend={() => agent.acknowledge()}
      />
    </>
  )
}
