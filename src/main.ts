import './style.css';
import { Agent } from './agent/Agent';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const ctx = canvas.getContext('2d')!;
const agent = new Agent();

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  agent.resize(width, height);
}

window.addEventListener('resize', resize);
resize();

window.addEventListener('pointermove', (e) => agent.pointerMove(e.clientX, e.clientY));
window.addEventListener('pointerdown', (e) => {
  agent.pointerMove(e.clientX, e.clientY);
  agent.press();
});
window.addEventListener('pointerup', () => agent.release());
window.addEventListener('pointercancel', () => agent.release());
window.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget) agent.pointerLeave();
});
window.addEventListener('blur', () => {
  agent.release();
  agent.pointerLeave();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) agent.blink();
});

let last = performance.now();
function frame(now: number): void {
  // Cap the step so returning to a background tab doesn't jolt the springs.
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  agent.update(dt);
  agent.render(ctx);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
