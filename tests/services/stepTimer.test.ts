import { describe, it, expect } from 'vitest'
import { createStepTimer } from '../../services/stepTimer'

describe('step timer', () => {
  it('the time of each step since the one before, and the total, in one line', () => {
    let t = 1000
    const timer = createStepTimer(() => t)
    t = 3100; timer.lap('prepare')
    t = 4000; timer.lap('compose up')
    t = 7250; timer.lap('inner stack', '2 tries')
    expect(timer.summary()).toBe('6.3 s: prepare 2.1 s, compose up 0.9 s, inner stack 3.3 s (2 tries)')
  })

  it('the total in ms, up to the last step', () => {
    let t = 1000
    const timer = createStepTimer(() => t)
    t = 3100; timer.lap('prepare')
    t = 43400; timer.lap('router')
    t = 99999
    expect(timer.totalMs()).toBe(42400)
  })
})
