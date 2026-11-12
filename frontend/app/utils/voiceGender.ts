export type Gender = 'female' | 'male'
export type GenderPref = 'any' | Gender

// The Web Speech API exposes no gender, so infer it from well-known voice names.
const FEMALE = [
  'female', 'woman', 'meijia', 'mei-jia', 'sinji', 'sin-ji', 'tingting', 'ting-ting', 'yushu', 'yu-shu',
  'hsiaochen', 'hsiaoyu', 'hanhan', 'yating', 'xiaoxiao', 'xiaoyi', 'xiaohan', 'xiaomeng', 'xiaomo',
  'xiaoxuan', 'xiaorui', 'xiaoshuang', 'huihui', 'tracy', 'hiujaan', 'sasha',
  'sandy', 'shelley', 'grandma', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'kate', 'serena', 'zira', 'hazel',
  'susan', 'aria', 'jenny', 'ava', 'emma', 'sonia', 'libby', 'allison', 'amelie', 'kyoko', 'yuna'
]
const MALE = [
  'male', ' man', 'limu', 'li-mu', 'yunjhe', 'yunxi', 'yunjian', 'yunyang', 'yunfeng', 'yunhao', 'yunze',
  'zhiwei', 'kangkang', 'danny', 'wanlung', 'yaoyao_m',
  'eddy', 'reed', 'rocko', 'grandpa', 'alex', 'daniel', 'fred', 'david', 'mark', 'guy', 'tom', 'oliver', 'thomas', 'george', 'ryan',
  'james', 'rishi', 'eric', 'christopher', 'otoya', 'jorge', 'diego'
]

export function inferGender(name: string): Gender | null {
  const n = ` ${name.toLowerCase()}`
  // "female" contains "male": test it first
  if (/\bfemale\b|\bwoman\b/.test(n)) return 'female'
  if (/\bmale\b|\bman\b/.test(n)) return 'male'
  if (/\bflo\b/.test(n)) return 'female' // short name: whole-word only
  if (FEMALE.some(k => n.includes(k))) return 'female'
  if (MALE.some(k => n.includes(k))) return 'male'
  return null
}

interface V { name: string; lang: string; voiceURI: string }

const langRank = (lang: string) => (lang === 'zh-TW' ? 0 : lang.startsWith('zh') ? 1 : 2)

/** Voices matching the preference. Voices of unknown gender are kept only for 'any'. */
export function filterByGender<T extends V>(voices: readonly T[], pref: GenderPref): T[] {
  if (pref === 'any') return [...voices]
  return voices.filter(v => inferGender(v.name) === pref)
}

/**
 * Pick the voiceURI to use. `key` is the voice assigned to this gender slot (URI or name).
 * An assigned voice that exists always wins (explicit assignment beats name-based inference);
 * otherwise fall back to the best inferred match (zh-TW first). Returns '' when nothing fits,
 * letting the engine use its default.
 */
export function resolveVoiceURI<T extends V>(voices: readonly T[], key: string, pref: GenderPref): string {
  const assigned = key ? voices.find(v => v.voiceURI === key || v.name === key) : undefined
  if (assigned) return assigned.voiceURI
  if (pref === 'any') return ''
  const matches = filterByGender(voices, pref).sort((a, b) => langRank(a.lang) - langRank(b.lang))
  return matches[0]?.voiceURI ?? ''
}
