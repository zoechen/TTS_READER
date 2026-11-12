import type { BookFormat, Chapter } from '../types/reader'
import { tokenizeText } from './tokenizer'

export interface ParsedBook {
  title: string
  author: string
  chapters: Chapter[]
}

export function detectFormat(name: string): BookFormat | null {
  const ext = name.split('.').pop()?.toLowerCase()
  return (['epub', 'pdf', 'txt', 'md', 'acsm'] as const).find(f => f === ext) ?? null
}

function chapterFrom(index: number, title: string, text: string): Chapter {
  const id = `chap_${index}`
  return { id, title, order: index, rawContent: text, sentences: tokenizeText(text, id) }
}

export async function parseText(blob: Blob, fileName: string): Promise<ParsedBook> {
  const text = await blob.text()
  const title = fileName.replace(/\.[^.]+$/, '')
  return { title, author: '', chapters: [chapterFrom(0, title, text)] }
}

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'TR', 'PRE', 'DT', 'DD', 'FIGCAPTION'])

/** Text of an element with paragraph breaks ("\n\n") between block elements; works on unrendered documents. */
export function extractText(root: Node): string {
  let out = ''
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out += (n.textContent ?? '').replace(/\s+/g, ' '); return }
    if (n.nodeType !== 1) return
    const el = n as Element
    const tag = el.tagName.toUpperCase()
    if (tag === 'SCRIPT' || tag === 'STYLE') return
    if (tag === 'BR') { out += '\n'; return }
    const block = BLOCK.has(tag)
    if (block) out += '\n\n'
    el.childNodes.forEach(walk)
    if (block) out += '\n\n'
  }
  walk(root)
  return out.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function parseEpub(blob: Blob): Promise<ParsedBook> {
  const { default: ePub } = await import('epubjs')
  const book = ePub(await blob.arrayBuffer())
  await book.ready
  const meta = await book.loaded.metadata
  const chapters: Chapter[] = []
  const items: any[] = (book.spine as any).spineItems ?? (book.spine as any).items ?? []
  const toc = (await book.loaded.navigation).toc
  const titleFor = (href: string) =>
    toc.find(t => t.href.split('#')[0] === href)?.label.trim()

  for (const item of items) {
    await item.load(book.load.bind(book))
    const doc: Document | undefined = item.document
    const text = doc?.body ? extractText(doc.body) : ''
    item.unload()
    if (!text) continue
    chapters.push(chapterFrom(chapters.length, titleFor(item.href) ?? `Chapter ${chapters.length + 1}`, text))
  }
  book.destroy()
  return { title: meta.title || 'Untitled', author: meta.creator || '', chapters }
}

export async function parseBook(blob: Blob, fileName: string, format: BookFormat): Promise<ParsedBook> {
  switch (format) {
    case 'epub': return parseEpub(blob)
    case 'txt':
    case 'md': return parseText(blob, fileName)
    case 'pdf': return (await import('./pdf')).parsePdf(blob).then(b => b.title === 'Untitled' ? { ...b, title: fileName.replace(/\.[^.]+$/, '') } : b)
    default: throw new Error(`Unsupported format: ${format}`)
  }
}
