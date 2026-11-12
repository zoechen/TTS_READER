import { describe, it, expect } from 'vitest'
import { inferGender, filterByGender, resolveVoiceURI } from '../app/utils/voiceGender'

const v = (name: string, lang: string) => ({ name, lang, voiceURI: name })

describe('inferGender', () => {
  it('knows common voices', () => {
    expect(inferGender('Mei-Jia')).toBe('female')
    expect(inferGender('Microsoft HsiaoChen Online (Natural) - Chinese (Taiwan)')).toBe('female')
    expect(inferGender('Microsoft Yunjhe Online')).toBe('male')
    expect(inferGender('Alex')).toBe('male')
    expect(inferGender('Samantha')).toBe('female')
  })
  it('knows macOS zh-TW voices', () => {
    expect(inferGender('Eddy (中文（台灣）)')).toBe('male')
    expect(inferGender('Flo (中文（台灣）)')).toBe('female')
    expect(inferGender('Shelley (中文（台灣）)')).toBe('female')
  })
  it('handles explicit words without confusing female/male', () => {
    expect(inferGender('Google UK English Female')).toBe('female')
    expect(inferGender('Google UK English Male')).toBe('male')
  })
  it('returns null for unknown names', () => {
    expect(inferGender('Google 國語（臺灣）')).toBeNull()
  })
})

describe('resolveVoiceURI', () => {
  const voices = [v('Samantha', 'en-US'), v('Yunjhe', 'zh-TW'), v('HsiaoChen', 'zh-TW'), v('Li-mu', 'zh-CN'), v('Google 國語（臺灣）', 'zh-TW')]
  it('assigned voice wins even if its gender is unknown', () => {
    expect(resolveVoiceURI(voices, 'Google 國語（臺灣）', 'female')).toBe('Google 國語（臺灣）')
  })
  it('assigned voice wins over inference', () => expect(resolveVoiceURI(voices, 'Li-mu', 'male')).toBe('Li-mu'))
  it('matches by name as well as voiceURI', () => {
    const vs = [{ name: 'Rocko (中文（台灣）)', lang: 'zh-TW', voiceURI: 'com.apple.voice.rocko' }]
    expect(resolveVoiceURI(vs, 'Rocko (中文（台灣）)', 'male')).toBe('com.apple.voice.rocko')
  })
  it('falls back to best zh-TW voice of the gender when assignment is missing', () => {
    expect(resolveVoiceURI(voices, 'Nope', 'male')).toBe('Yunjhe')
    expect(resolveVoiceURI(voices, '', 'female')).toBe('HsiaoChen')
  })
  it('any with a missing assignment returns empty (engine default)', () => {
    expect(resolveVoiceURI(voices, 'Nope', 'any')).toBe('')
  })
  it('returns empty when none match', () => expect(resolveVoiceURI([v('Mystery', 'zh-TW')], '', 'male')).toBe(''))
  it('filter excludes unknown for specific gender', () => {
    expect(filterByGender(voices, 'female').map(x => x.name)).toEqual(['Samantha', 'HsiaoChen'])
    expect(filterByGender(voices, 'any')).toHaveLength(5)
  })
})
