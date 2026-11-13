import { describe, it, expect } from 'vitest'
import { parsePronunciations, applyPronunciations, cleanForSpeech } from '../app/utils/pronounce'

describe('parsePronunciations', () => {
  it('parses lines, ignores comments/blank lines, accepts several separators', () => {
    const rules = parsePronunciations('# 註解\n\n長大=掌大\n行走 ＝ 形走\nA→B\nC => D\n沒有分隔符\n=無來源')
    expect(rules).toEqual([
      { from: '長大', to: '掌大' }, { from: '行走', to: '形走' },
      { from: 'A', to: 'B' }, { from: 'C', to: 'D' }
    ])
  })
  it('allows an empty replacement (read nothing)', () => {
    expect(parsePronunciations('★=')).toEqual([{ from: '★', to: '' }])
  })
})

describe('applyPronunciations', () => {
  const rules = parsePronunciations('長大=掌大\n長=常\n銀行=銀航')
  it('replaces every occurrence and leaves other text alone', () => {
    expect(applyPronunciations('他長大了，銀行很長。', rules)).toBe('他掌大了，銀航很常。')
  })
  it('prefers the longest match regardless of rule order', () => {
    expect(applyPronunciations('長大', rules)).toBe('掌大')
  })
  it('does not re-scan replaced text (no cascading)', () => {
    expect(applyPronunciations('甲乙', parsePronunciations('甲=乙\n乙=丙'))).toBe('乙丙')
  })
  it('treats rules literally, not as regex', () => {
    expect(applyPronunciations('a.b axb', parsePronunciations('a.b=X'))).toBe('X axb')
  })
  it('is a no-op without rules', () => {
    expect(applyPronunciations('原文', [])).toBe('原文')
  })
})

describe('cleanForSpeech', () => {
  it('turns slashes into a pause instead of reading "斜線"', () => {
    expect(cleanForSpeech('和/或')).toBe('和，或')
    expect(cleanForSpeech('2026/11/13')).toBe('2026，11，13')
    expect(cleanForSpeech('A / B')).toBe('A，B')
    expect(cleanForSpeech('他說／她說＼好')).toBe('他說，她說，好')
  })
  it('leaves text without slashes untouched', () => {
    expect(cleanForSpeech('你好，世界。')).toBe('你好，世界。')
  })
  it('user rules run first so they can override', () => {
    const rules = parsePronunciations('w/o=without')
    expect(cleanForSpeech(applyPronunciations('w/o sugar a/b', rules))).toBe('without sugar a，b')
  })
})
