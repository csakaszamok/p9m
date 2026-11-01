/** Times the steps of something slow (a create): each step since the one before, for one log line. */
// performance.now: Date.now can jump back with the clock (a container's clock was seen to)
export function createStepTimer(now: () => number = () => performance.now()) {
  const start = now()
  let last = start
  const steps: string[] = []
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  return {
    lap(name: string, note?: string): void {
      const t = now()
      steps.push(`${name} ${s(t - last)}${note ? ` (${note})` : ''}`)
      last = t
    },
    /** From the start to the last step, in ms. */
    totalMs(): number {
      return Math.round(last - start)
    },
    summary(): string {
      return `${s(last - start)}: ${steps.join(', ')}`
    },
  }
}
