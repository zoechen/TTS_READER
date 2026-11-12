import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePdf } from '../app/utils/pdf'

it('parses a real PDF into tokenized chapters', async () => {
  const buf = readFileSync(new URL('./sample.pdf', import.meta.url))
  const book = await parsePdf(new Blob([buf]))
  expect(book.chapters).toHaveLength(1)
  expect(book.chapters[0]!.sentences.map(s => s.text)).toEqual(
    ['Hello world.', 'This is a PDF test.', 'Second line here.'])
})
