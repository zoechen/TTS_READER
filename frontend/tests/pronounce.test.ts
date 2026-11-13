import { describe, it, expect } from 'vitest'
import { parsePronunciations, applyPronunciations, cleanForSpeech } from '../app/utils/pronounce'
import { DEFAULT_PRONUNCIATION_RULES as DEFAULTS } from '../app/utils/defaultPronunciations'

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

describe('built-in 行 dictionary', () => {
  const say = (t: string, user = '') => applyPronunciations(t, [...parsePronunciations(user), ...DEFAULTS])
  it('fixes háng and xìng readings', () => {
    expect(say('他在銀行工作，品行端正。')).toBe('他在銀航工作，品幸端正。')
    expect(say('各行各業的行列')).toBe('各航各業的航列')
    expect(say('行行出狀元')).toBe('航航出狀元')
  })
  it('leaves normal xíng words alone', () => {
    for (const t of ['行走', '旅行', '行為', '人行道', '大行其道', '執行長', '流行歌曲']) expect(say(t)).toBe(t)
  })
  it('guards compounds that contain a háng word', () => {
    expect(say('我們進行業務討論')).toBe('我們進行業務討論')
    expect(say('請進行列印')).toBe('請進行列印')
    expect(say('這是本行為')).toBe('這是本行為')
    expect(say('商行為')).toBe('商行為')
  })
  it('user rules win ties, so a built-in rule can be opted out', () => {
    expect(say('他的罪行', '罪行=罪行')).toBe('他的罪行')
    expect(say('他的罪行')).toBe('他的罪幸')
  })
  it('every rule is well-formed and no replacement is empty', () => {
    expect(DEFAULTS.length).toBeGreaterThan(50)
    for (const r of DEFAULTS) { expect(r.from.length).toBeGreaterThan(0); expect(r.to.length).toBe(r.from.length) }
  })
})

describe('built-in 長 / 了 dictionary', () => {
  const say = (x: string, user = '') => applyPronunciations(x, [...parsePronunciations(user), ...DEFAULTS])
  it('長: zhǎng words are replaced, cháng words are not', () => {
    expect(say('他從小長大，後來當了校長，成長的過程。')).toBe('他從小掌大，後來當了校掌，成掌的過程。')
    expect(say('長輩與家長都來了')).toBe('掌輩與家掌都來了')
    for (const x of ['這條路很長', '漫長的夜晚', '他擅長大量計算', '專家長期研究', '大家長大了', '長度與長城']) {
      expect(say(x)).toBe(x === '大家長大了' ? '大家掌大了' : x)
    }
  })
  it('了: liǎo words are replaced, particle 了 is left alone', () => {
    expect(say('我了解，他受不了，真了不起，一目了然')).toBe('我瞭解，他受不瞭，真瞭不起，一目瞭然')
    for (const x of ['吃了飯', '完成了解釋', '他走了解決問題', '看了然後走', '好了，我們走吧']) expect(say(x)).toBe(x)
  })
  it('combined with 行 and opt-out', () => {
    expect(say('銀行行長')).toBe('銀航航掌')
    expect(say('校長', '校長=校長')).toBe('校長')
  })
})
