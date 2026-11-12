import { describe, it, expect } from 'vitest'
import { joinLines, groupPages, linesToParagraphs } from '../app/utils/pdf'

describe('joinLines', () => {
  it('joins English lines with spaces and rejoins hyphenation', () => {
    expect(joinLines(['Hello wor-', 'ld this is', 'text.'])).toBe('Hello world this is text.')
  })
  it('does not insert spaces between CJK lines', () => {
    expect(joinLines(['這是第一', '句話。'])).toBe('這是第一句話。')
  })
})

describe('groupPages', () => {
  const pages = ['p1.', 'p2.', 'p3.', 'p4.', 'p5.', 'p6.', 'p7.']
  it('uses fixed blocks without outline', () => {
    const c = groupPages(pages, [])
    expect(c).toHaveLength(2)
    expect(c[1]!.title).toBe('第 6 頁起')
    expect(c[0]!.sentences.length).toBeGreaterThan(0)
  })
  it('uses outline with a preface for leading pages', () => {
    const c = groupPages(pages, [{ title: 'A', pageIndex: 2 }, { title: 'B', pageIndex: 5 }])
    expect(c.map(x => x.title)).toEqual(['前言', 'A', 'B'])
    expect(c[1]!.rawContent).toBe('p3.\n\np4.\n\np5.')
  })
  it('skips empty chapters and renumbers', () => {
    const c = groupPages(['', '', 'x.'], [{ title: 'A', pageIndex: 0 }, { title: 'B', pageIndex: 2 }])
    expect(c.map(x => x.id)).toEqual(['chap_0'])
  })
})

describe('linesToParagraphs', () => {
  const L = (text: string, y: number, x = 50, endX = 500) => ({ text, x, endX, y, size: 12 })
  it('splits on larger vertical gaps', () => {
    const out = linesToParagraphs([L('第一段第一行', 700), L('第一段第二行。', 686), L('第二段開頭', 660), L('結束。', 646, 50, 300)])
    expect(out).toBe('第一段第一行第一段第二行。\n\n第二段開頭結束。')
  })
  it('splits on first-line indent after a finished sentence', () => {
    const out = linesToParagraphs([L('Para one ends here.', 700), L('Para two starts.', 686, 74)])
    expect(out).toBe('Para one ends here.\n\nPara two starts.')
  })
  it('does not split a wrapped sentence', () => {
    expect(linesToParagraphs([L('Wrapped', 700), L('sentence.', 686)])).toBe('Wrapped sentence.')
  })
})
