import { describe, it, expect } from 'vitest'
import { analyzeProsody, isSpeakable, NEUTRAL } from '../app/utils/prosody'

describe('analyzeProsody', () => {
  it('plain statement is neutral with a normal pause', () => {
    expect(analyzeProsody('今天天氣很好。')).toEqual({ rateMul: 1, pitchPct: 0, pauseAfterMs: 350 })
  })
  it('question raises pitch', () => {
    const p = analyzeProsody('你真的要走嗎？')
    expect(p.pitchPct).toBeGreaterThan(0)
    expect(p.rateMul).toBeLessThan(1)
  })
  it('exclamation raises pitch and speeds up', () => {
    const p = analyzeProsody('快跑！')
    expect(p.pitchPct).toBeGreaterThan(0)
    expect(p.rateMul).toBeGreaterThan(1)
  })
  it('ellipsis slows down and pauses longer', () => {
    const p = analyzeProsody('我也不知道……')
    expect(p.rateMul).toBeLessThan(1)
    expect(p.pauseAfterMs).toBeGreaterThan(350)
  })
  it('dialogue is brighter, and quotes do not hide the question mark', () => {
    const d = analyzeProsody('「你好。」')
    expect(d.pitchPct).toBeGreaterThan(0)
    const q = analyzeProsody('「真的嗎？」')
    expect(q.pitchPct).toBeGreaterThan(d.pitchPct)
  })
  it('clause end gets a short pause; paragraph end gets the longest', () => {
    expect(analyzeProsody('他說，').pauseAfterMs).toBeLessThan(350)
    expect(analyzeProsody('結束了。', { nextIsParaStart: true }).pauseAfterMs).toBeGreaterThanOrEqual(700)
  })
  it('stays within safe bounds and handles empty text', () => {
    const p = analyzeProsody('「天哪！？！」')
    expect(p.rateMul).toBeGreaterThanOrEqual(0.8); expect(p.rateMul).toBeLessThanOrEqual(1.2)
    expect(Math.abs(p.pitchPct)).toBeLessThanOrEqual(15)
    expect(analyzeProsody('  ')).toEqual(NEUTRAL)
  })
})

describe('isSpeakable', () => {
  it('rejects punctuation/symbol-only text and accepts anything with letters or digits', () => {
    for (const t of ['……', '「」', '———', '。', '***', '  ']) expect(isSpeakable(t)).toBe(false)
    for (const t of ['第二章', 'Hi.', '2.', '「好」']) expect(isSpeakable(t)).toBe(true)
  })
})
