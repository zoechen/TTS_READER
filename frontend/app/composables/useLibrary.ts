import { db, type BookRecord } from '../utils/db'
import { detectFormat, parseBook } from '../utils/parsers'
import { useReaderStore } from '../stores/reader'

export function useLibrary() {
  const store = useReaderStore()
  const config = useRuntimeConfig()
  const status = ref('')
  const error = ref('')
  const books = ref<BookRecord[]>([])

  async function refresh() {
    books.value = await db.books.orderBy('lastReadAt').reverse().toArray()
  }

  /**
   * 【前後端對接點 ②】.acsm 兌換流程（對應後端 backend/main.py 的 fulfill_acsm）
   *
   * 完整流程：
   *  1. 前端以 multipart/form-data 把 .acsm 檔 POST 到 /api/v1/acsm/fulfill
   *  2. 後端驗證 XML → 呼叫 libgourou 的 acsmdownloader 向 Adobe 下載加密書
   *     → adept_remove 解密 → 以 FileResponse 回傳 EPUB/PDF 二進位內容
   *  3. 前端收到 blob 後，與一般 EPUB/PDF 走同一條解析路徑（parseBook），並存入 IndexedDB
   *
   * 錯誤格式：後端失敗時回 HTTP 4xx/5xx，body 為 {"detail":{"code":"ERR_xxx","message":"..."}}，
   * 這裡組成「ERR_xxx: 訊息」丟出，最後顯示在畫面上的 error。
   */
  async function fulfillAcsm(file: File): Promise<{ blob: Blob; name: string; title?: string; author?: string }> {
    status.value = '正在連線 Adobe 履約伺服器兌換並解密書籍...'
    const form = new FormData()
    form.append('file', file) // 欄位名 "file" 必須與後端 fulfill_acsm(file: UploadFile) 的參數名一致
    const res = await fetch(`${config.public.acsmApiBase}/api/v1/acsm/fulfill`, { method: 'POST', body: form })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      const d = body?.detail
      throw new Error(d?.code ? `${d.code}: ${d.message}` : `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    // 書名/作者放在回應標頭（URL 編碼以容納中文）；後端 CORS 的 expose_headers 有開放這兩個標頭，
    // 否則瀏覽器的跨網域請求讀不到它們。
    const dec = (v: string | null) => (v ? decodeURIComponent(v) : undefined)
    // 後端依檔頭是否為 %PDF 決定副檔名，並以 Content-Type 告知；前端據此判斷格式
    const ext = blob.type.includes('pdf') ? 'pdf' : 'epub'
    return { blob, name: `book.${ext}`, title: dec(res.headers.get('X-Book-Title')), author: dec(res.headers.get('X-Book-Author')) }
  }

  async function importFile(file: File) {
    error.value = ''
    try {
      let fmt = detectFormat(file.name)
      if (!fmt) throw new Error('不支援的檔案格式')
      let blob: Blob = file
      let name = file.name
      let hint: { title?: string; author?: string } = {}
      if (fmt === 'acsm') {
        const r = await fulfillAcsm(file)
        blob = r.blob; name = r.name; hint = r
        fmt = detectFormat(name)!
      }
      status.value = '解析書籍中...'
      const parsed = await parseBook(blob, name, fmt)
      const total = parsed.chapters.reduce((n, c) => n + c.sentences.length, 0)
      if (!total) throw new Error('書中沒有可朗讀的文字')

      const now = Date.now()
      const record: BookRecord = {
        id: crypto.randomUUID(),
        title: hint.title || parsed.title,
        author: hint.author || parsed.author,
        format: fmt, fileSize: blob.size, totalChapters: parsed.chapters.length,
        createdAt: now, lastReadAt: now, fileBlob: blob
      }
      await db.books.add(record)
      store.openBook(record.id, record.title, record.author, parsed.chapters)
      await refresh()
    } catch (e: any) {
      error.value = e?.message ?? String(e)
    } finally {
      status.value = ''
    }
  }

  async function openSaved(id: string) {
    error.value = ''
    try {
      const rec = await db.books.get(id)
      if (!rec) throw new Error('找不到書籍')
      status.value = '載入書籍中...'
      const parsed = await parseBook(rec.fileBlob, `${rec.title}.${rec.format}`, rec.format)
      const prog = await db.progress.get(id)
      const ci = Math.max(parsed.chapters.findIndex(c => c.id === prog?.chapterId), 0)
      store.openBook(id, rec.title, rec.author, parsed.chapters, ci, prog?.sentenceIndex ?? 0)
      await db.books.update(id, { lastReadAt: Date.now() })
      await refresh()
    } catch (e: any) {
      error.value = e?.message ?? String(e)
    } finally {
      status.value = ''
    }
  }

  async function remove(id: string) {
    await db.books.delete(id)
    await db.progress.delete(id)
    await refresh()
  }

  async function saveProgress() {
    if (!store.currentBookId || !store.chapter) return
    await db.progress.put({
      bookId: store.currentBookId,
      chapterId: store.chapter.id,
      sentenceIndex: store.sentenceIndex,
      percentage: store.percentage,
      updatedAt: Date.now()
    })
  }

  return { status, error, books, refresh, importFile, openSaved, remove, saveProgress }
}
