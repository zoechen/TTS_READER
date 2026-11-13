// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { extractText } from '../app/utils/parsers'

// 最小化的 DOM 替身（這裡 vitest 在 node 環境執行）
const T = (t: string) => ({ nodeType: 3, textContent: t }) as any
const E = (tagName: string, ...kids: any[]) => ({ nodeType: 1, tagName, childNodes: { forEach: (f: any) => kids.forEach(f) } }) as any

describe('extractText', () => {
  it('separates block elements with blank lines', () => {
    const body = E('BODY', E('H2', T('Title')), E('P', T('一。二。')), E('P', T('三。'), E('BR'), T('四。')))
    expect(extractText(body)).toBe('Title\n\n一。二。\n\n三。\n四。')
  })
})
