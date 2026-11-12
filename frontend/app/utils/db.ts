import Dexie, { type Table } from 'dexie'
import type { BookMetadata, ReadProgress } from '../types/reader'

export interface BookRecord extends BookMetadata {
  fileBlob: Blob
}

export class ReaderDatabase extends Dexie {
  books!: Table<BookRecord, string>
  progress!: Table<ReadProgress, string>
  constructor() {
    super('TTSReaderDB')
    this.version(1).stores({
      books: 'id, title, format, lastReadAt',
      progress: 'bookId, updatedAt'
    })
  }
}

export const db = new ReaderDatabase()
