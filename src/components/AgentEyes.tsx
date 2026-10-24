import { useEffect, useRef } from "react"

import type { Agent } from "@/agent/Agent"

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
}

/** Canvas filling its container that draws the agent's eyes and feeds it pointer input. */
export function AgentEyes({ agent }: { agent: Agent }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext("2d")!

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const { left, top, width, height } = canvas.getBoundingClientRect()
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      agent.resize(width, height, left, top)
    }

    const onMove = (e: PointerEvent) => agent.pointerMove(e.clientX, e.clientY)
    const onDown = (e: PointerEvent) => {
      agent.pointerMove(e.clientX, e.clientY)
      // Only squish when the eyes themselves are pressed, not the chat.
      if (e.target === canvas) agent.press()
    }
    const onUp = () => agent.release()
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) agent.pointerLeave()
    }
    const onBlur = () => {
      agent.release()
      agent.pointerLeave()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTextField(e.target)) agent.blink()
    }

    resize()
    // The container can change size without the window doing so (e.g. the
    // sidebar appearing at a breakpoint), so watch the canvas itself.
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerdown", onDown)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    window.addEventListener("mouseout", onOut)
    window.addEventListener("blur", onBlur)
    window.addEventListener("keydown", onKey)

    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      // Cap the step so returning to a background tab doesn't jolt the springs.
      const dt = Math.min((now - last) / 1000, 1 / 20)
      last = now
      agent.update(dt)
      agent.render(ctx)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      window.removeEventListener("mouseout", onOut)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("keydown", onKey)
    }
  }, [agent])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="AI agent eyes"
      className="absolute inset-0 block size-full touch-none select-none"
    />
  )
}
