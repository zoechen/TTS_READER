import type { SentenceItem } from '../types/reader'

const MAX_LEN = 120
const SENTENCE_SPLIT = /(?<=[。！？；.!?:…\n])\s*/
const CLAUSE_SPLIT = /(?<=[,，])\s*/

function splitLong(text: string): string[] {
  if (text.length <= MAX_LEN) return [text]
  let parts = text.split(CLAUSE_SPLIT).filter(Boolean)
  if (parts.length === 1) parts = text.split(/(?<=\s)/).filter(Boolean)
  // merge tiny pieces back up to MAX_LEN, hard-cut anything still too long
  const out: string[] = []
  let buf = ''
  for (const p of parts) {
    if ((buf + p).length > MAX_LEN && buf) { out.push(buf); buf = '' }
    buf += p
  }
  if (buf) out.push(buf)
  return out.flatMap(s => {
    const cuts: string[] = []
    for (let i = 0; i < s.length; i += MAX_LEN) cuts.push(s.slice(i, i + MAX_LEN))
    return cuts
  })
}

export function tokenizeText(rawText: string, chapterId: string): SentenceItem[] {
  if (!rawText?.trim()) return []
  const clean = rawText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  const result: SentenceItem[] = []
  // Paragraphs: blank-line separated if the text has any, otherwise one per line
  const paragraphs = /\n[ \t]*\n/.test(clean) ? clean.split(/\n[ \t]*\n+/) : clean.split(/\n+/)
  for (const para of paragraphs) {
    let first = true
    for (const seg of para.split(SENTENCE_SPLIT)) {
      for (const piece of splitLong(seg)) {
        const text = piece.trim()
        if (!text) continue
        const order = result.length
        result.push({ id: `${chapterId}_sent_${order}`, order, text, chapterId, ...(first && { paraStart: true }) })
        first = false
      }
    }
  }
  return result
}
