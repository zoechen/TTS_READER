export interface Prosody {
  /** 使用者基本語速的倍率 */
  rateMul: number
  /** 音調變化百分比（0 = 不變） */
  pitchPct: number
  /** 這一句結束後、下一句開始前要留的靜默時間 */
  pauseAfterMs: number
}

/** 只由標點/符號組成的句子（……、「」、———）沒有可唸的內容，TTS 引擎會拒絕。 */
export const isSpeakable = (text: string) => /[\p{L}\p{N}]/u.test(text)

export const NEUTRAL: Prosody = { rateMul: 1, pitchPct: 0, pauseAfterMs: 0 }

const OPEN = '「『“"‘'
const CLOSE = '」』”"’'
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** 單句的語氣啟發式規則：問句上揚、驚嘆加快、省略號放慢、對話明亮。 */
export function analyzeProsody(text: string, ctx: { nextIsParaStart?: boolean } = {}): Prosody {
  const t = text.trim()
  if (!t) return NEUTRAL
  // Judge the ending ignoring closing quotes/brackets: 「真的嗎？」 still ends in a question
  const core = t.replace(new RegExp(`[${CLOSE})）\\s]+$`), '')
  const last = core.slice(-1)

  let rateMul = 1
  let pitchPct = 0
  let pause = 350

  if (/[？?]/.test(last)) { pitchPct += 8; rateMul *= 0.97; pause = 400 }
  else if (/[！!]/.test(last)) { pitchPct += 6; rateMul *= 1.06; pause = 400 }
  else if (/(…|\.{3}|——|—)$/.test(core)) { rateMul *= 0.92; pause = 600 }
  else if (/[,，、;；:：]/.test(last)) { pause = 180 }
  else if (!/[。.]/.test(last)) { pause = 220 } // 沒有句尾標點（被截斷的子句）

  // 對話：整句都在引號內
  if (OPEN.includes(t[0]!) && CLOSE.includes(t.slice(-1))) {
    pitchPct += 5; rateMul *= 1.03
  }

  if (ctx.nextIsParaStart) pause = Math.max(pause, 700)

  return {
    rateMul: clamp(rateMul, 0.8, 1.2),
    pitchPct: clamp(pitchPct, -15, 15),
    pauseAfterMs: pause
  }
}
