export interface PronunciationRule { from: string; to: string }

/**
 * 解析使用者的規則文字。每行一條規則：`原文=讀成`（也可用 `＝`、`→`、`=>`）。
 * 空行與以 `#` 開頭的行會被忽略。
 */
export function parsePronunciations(raw: string): PronunciationRule[] {
  const rules: PronunciationRule[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^(.+?)\s*(?:=>|＝|=|→)\s*(.*)$/)
    if (!m) continue
    const from = m[1]!.trim()
    if (from) rules.push({ from, to: m[2]!.trim() })
  }
  return rules
}

/**
 * 內建清理：TTS 引擎會把某些符號照名稱唸出來（"/" → 「斜線」），這裡把斜線改成
 * 短暫停頓。在使用者規則之後才執行，所以像 `w/o=without` 這樣的規則仍然有效。
 */
export function cleanForSpeech(text: string): string {
  return text.replace(/\s*[/／\\＼]+\s*/g, '，')
}

/**
 * 把詞換成 TTS 實際要唸的文字（例如用同音字讓破音字唸對）。
 * 最長比對優先；替換後的文字不會再被掃描，所以規則不會連鎖套用。畫面上顯示的文字不受影響。
 */
export function applyPronunciations(text: string, rules: PronunciationRule[]): string {
  if (!rules.length || !text) return text
  const sorted = [...rules].sort((a, b) => b.from.length - a.from.length)
  let out = ''
  let i = 0
  outer: while (i < text.length) {
    for (const r of sorted) {
      if (text.startsWith(r.from, i)) { out += r.to; i += r.from.length; continue outer }
    }
    out += text[i++]
  }
  return out
}
