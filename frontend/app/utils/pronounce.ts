export interface PronunciationRule { from: string; to: string }

/**
 * Parse the user's rule text. One rule per line: `原文=讀成` (also `＝`, `→`, `=>`).
 * Blank lines and lines starting with `#` are ignored.
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
 * Built-in clean-up of symbols TTS engines read out by name ("/" -> "斜線"): turn slashes into a
 * short pause. Runs after the user's rules, so a rule such as `w/o=without` still wins.
 */
export function cleanForSpeech(text: string): string {
  return text.replace(/\s*[/／\\＼]+\s*/g, '，')
}

/**
 * Replace words with the text the TTS should actually read (e.g. a homophone that gets the
 * right reading of a polyphonic character). Longest match wins; replaced text is never
 * re-scanned, so rules cannot cascade. The text shown on screen is not touched.
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
