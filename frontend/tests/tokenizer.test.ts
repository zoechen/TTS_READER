import { describe, it, expect } from 'vitest'
import { tokenizeText } from '../app/utils/tokenizer'

describe('tokenizeText', () => {
  it('splits on CJK punctuation', () => {
    const s = tokenizeText('這是第一句話。這是第二句話！這是第三句？', 'c')
    expect(s.map(x => x.text)).toEqual(['這是第一句話。', '這是第二句話！', '這是第三句？'])
    expect(s[1]).toMatchObject({ id: 'c_sent_1', order: 1, chapterId: 'c' })
  })
  it('splits English and newlines', () => {
    expect(tokenizeText('Hello world. How are you?\nFine.', 'c')).toHaveLength(3)
  })
  it('splits long sentences by commas, each <=120', () => {
    const s = tokenizeText('A'.repeat(70) + '，' + 'B'.repeat(70) + '。', 'c')
    expect(s.length).toBeGreaterThanOrEqual(2)
    s.forEach(x => expect(x.text.length).toBeLessThanOrEqual(120))
  })
  it('hard-cuts long text without any punctuation', () => {
    const s = tokenizeText('字'.repeat(300), 'c')
    expect(s).toHaveLength(3)
  })
  it('returns [] for blank', () => {
    expect(tokenizeText('  \n ', 'c')).toEqual([])
  })
})
