export interface Prosody {
  /** multiplier on the user's base speaking rate */
  rateMul: number
  /** pitch change in percent (0 = unchanged) */
  pitchPct: number
  /** silence to leave after this sentence before the next one starts */
  pauseAfterMs: number
}

/** A sentence made only of punctuation/symbols (……, 「」, ———) has nothing to say; TTS engines reject it. */
export const isSpeakable = (text: string) => /[\p{L}\p{N}]/u.test(text)

export const NEUTRAL: Prosody = { rateMul: 1, pitchPct: 0, pauseAfterMs: 0 }

const OPEN = '「『“"‘'
const CLOSE = '」』”"’'
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Heuristic delivery for one sentence: questions lift, exclamations speed up, ellipses slow down, dialogue brightens. */
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
  else if (!/[。.]/.test(last)) { pause = 220 } // no terminal punctuation (cut-off clause)

  // Dialogue: the whole sentence sits inside quotes
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
