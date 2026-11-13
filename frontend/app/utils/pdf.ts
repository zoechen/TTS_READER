import type { Chapter } from '../types/reader'
import { tokenizeText } from './tokenizer'

export interface OutlineEntry { title: string; pageIndex: number }

const PAGES_PER_CHAPTER = 5
const CJK = /[　-鿿＀-￯]/

/** 合併 PDF 的文字行：中日韓字元之間不加空格，並接回被連字號斷開的單字。 */
export function joinLines(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!out) { out = line; continue }
    const prev = out.slice(-1)
    if (CJK.test(prev) || CJK.test(line[0]!)) out += line
    else if (prev === '-' && /[a-z]/i.test(out.slice(-2, -1)) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line
    else out += ' ' + line
  }
  return out.replace(/\s+/g, ' ').trim()
}

export interface PdfLine { text: string; x: number; endX: number; y: number; size: number }

const TERMINAL = /[。！？.!?…」』”"’)）]\s*$/

/** 把一頁的行切成段落（依垂直間距、首行縮排、較短的末行），段落間以空行連接。 */
export function linesToParagraphs(lines: PdfLine[]): string {
  const ls = lines.filter(l => l.text.trim())
  if (!ls.length) return ''
  const gaps = ls.slice(1).map((l, i) => ls[i]!.y - l.y).filter(g => g > 0).sort((a, b) => a - b)
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0
  const left = Math.min(...ls.map(l => l.x))
  const right = Math.max(...ls.map(l => l.endX))

  const paras: PdfLine[][] = [[ls[0]!]]
  for (let i = 1; i < ls.length; i++) {
    const prev = ls[i - 1]!, cur = ls[i]!
    const gap = prev.y - cur.y
    const ended = TERMINAL.test(prev.text)
    const bigGap = typical > 0 && gap > typical * 1.45
    const columnJump = gap < 0
    const indented = ended && cur.x - left > cur.size * 1.2 && cur.x - prev.x > cur.size * 0.8
    const shortPrev = ended && right - prev.endX > cur.size * 3
    if (bigGap || columnJump || indented || shortPrev) paras.push([])
    paras[paras.length - 1]!.push(cur)
  }
  return paras.map(p => joinLines(p.map(l => l.text))).filter(Boolean).join('\n\n')
}

/** 把逐頁文字分成章節：有大綱就依大綱，否則用固定頁數區塊。 */
export function groupPages(pages: string[], outline: OutlineEntry[], fallbackTitle = '第 {n} 頁起'): Chapter[] {
  const starts = [...new Map(
    outline.filter(o => o.pageIndex >= 0 && o.pageIndex < pages.length).map(o => [o.pageIndex, o.title])
  )].sort((a, b) => a[0] - b[0])

  const ranges: { title: string; from: number; to: number }[] = []
  if (starts.length) {
    if (starts[0]![0] > 0) ranges.push({ title: '前言', from: 0, to: starts[0]![0] })
    starts.forEach(([from, title], i) => ranges.push({ title, from, to: starts[i + 1]?.[0] ?? pages.length }))
  } else {
    for (let from = 0; from < pages.length; from += PAGES_PER_CHAPTER) {
      ranges.push({ title: fallbackTitle.replace('{n}', String(from + 1)), from, to: Math.min(from + PAGES_PER_CHAPTER, pages.length) })
    }
  }

  const chapters: Chapter[] = []
  for (const r of ranges) {
    let text = ''
    for (const pg of pages.slice(r.from, r.to)) {
      if (!pg) continue
      // 頁面結束在句子中間時，下一頁會接續同一段
      text += text ? (TERMINAL.test(text) ? '\n\n' : '\n') + pg : pg
    }
    if (!text.trim()) continue
    const order = chapters.length
    const id = `chap_${order}`
    chapters.push({ id, title: r.title, order, rawContent: text, sentences: tokenizeText(text, id) })
  }
  return chapters
}

export async function parsePdf(blob: Blob): Promise<{ title: string; author: string; chapters: Chapter[] }> {
  const pdfjs = await import('pdfjs-dist')
  if (typeof window !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) })
  const doc = await task.promise

  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const lines: PdfLine[] = []
    let cur: PdfLine | null = null
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue
      const x = item.transform?.[4] ?? 0
      const y = item.transform?.[5] ?? 0
      const size = Math.abs(item.transform?.[3] ?? item.height ?? 12) || 12
      if (!cur) cur = { text: '', x, endX: x, y, size }
      cur.text += item.str
      if (item.str.trim()) cur.endX = x + (item.width ?? 0)
      if (item.hasEOL) { lines.push(cur); cur = null }
    }
    if (cur) lines.push(cur)
    pages.push(linesToParagraphs(lines))
    page.cleanup()
  }

  const outline: OutlineEntry[] = []
  try {
    for (const o of (await doc.getOutline()) ?? []) {
      let dest = o.dest
      if (typeof dest === 'string') dest = await doc.getDestination(dest)
      if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object') {
        outline.push({ title: o.title.trim(), pageIndex: await doc.getPageIndex(dest[0]) })
      }
    }
  } catch { /* outline is optional */ }

  const info: any = (await doc.getMetadata().catch(() => null))?.info ?? {}
  const chapters = groupPages(pages, outline)
  await task.destroy()
  return { title: info.Title?.trim() || 'Untitled', author: info.Author?.trim() || '', chapters }
}
