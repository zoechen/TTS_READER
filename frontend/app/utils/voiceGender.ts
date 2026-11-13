export type Gender = 'female' | 'male'
export type GenderPref = 'any' | Gender

// Web Speech API 不提供性別資訊，所以從常見的語音名稱推斷。
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
  // "female" 包含 "male"：要先測 female
  if (/\bfemale\b|\bwoman\b/.test(n)) return 'female'
  if (/\bmale\b|\bman\b/.test(n)) return 'male'
  if (/\bflo\b/.test(n)) return 'female' // 名稱很短：只比對整個單字
  if (FEMALE.some(k => n.includes(k))) return 'female'
  if (MALE.some(k => n.includes(k))) return 'male'
  return null
}

interface V { name: string; lang: string; voiceURI: string }

const langRank = (lang: string) => (lang === 'zh-TW' ? 0 : lang.startsWith('zh') ? 1 : 2)

/** 符合偏好的語音。性別不明的語音只在偏好為 'any' 時保留。 */
export function filterByGender<T extends V>(voices: readonly T[], pref: GenderPref): T[] {
  if (pref === 'any') return [...voices]
  return voices.filter(v => inferGender(v.name) === pref)
}

/**
 * 挑選要使用的 voiceURI。`key` 是指定給這個性別欄位的語音（URI 或名稱）。
 * 只要指定的語音存在就一律優先（明確指定勝過依名稱推斷）；
 * 否則退回推斷出的最佳符合項（zh-TW 優先）。都不合適時回傳 ''，
 * 讓引擎使用預設語音。
 */
export function resolveVoiceURI<T extends V>(voices: readonly T[], key: string, pref: GenderPref): string {
  const assigned = key ? voices.find(v => v.voiceURI === key || v.name === key) : undefined
  if (assigned) return assigned.voiceURI
  if (pref === 'any') return ''
  const matches = filterByGender(voices, pref).sort((a, b) => langRank(a.lang) - langRank(b.lang))
  return matches[0]?.voiceURI ?? ''
}
