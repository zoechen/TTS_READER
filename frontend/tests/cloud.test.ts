import { describe, it, expect, vi } from 'vitest'
import { CloudEngine, renderBody, defaultCloudConfig } from '../app/engines/cloud'

describe('renderBody', () => {
  it('JSON-escapes text and voice, leaves rate numeric', () => {
    const out = renderBody('{"t":{{text}},"v":{{ voice }},"r":{{rate}}}', { text: 'He said "hi"\n你好', voice: 'a', rate: 1.2 })
    expect(JSON.parse(out)).toEqual({ t: 'He said "hi"\n你好', v: 'a', r: 1.2 })
  })
  it('does not interpret $ patterns in text', () => {
    expect(JSON.parse(renderBody('{{text}}', { text: "$& $1 $'", voice: '', rate: 1 }))).toBe("$& $1 $'")
  })
})

function setup(fetchImpl: any, cfg = {}) {
  const config = { ...defaultCloudConfig(), endpoint: 'https://tts.example/v1', apiKey: 'k', ...cfg }
  const audio: any = { play: vi.fn(async () => { audio.onplaying?.() }), pause: vi.fn() }
  const eng = new CloudEngine(() => config, {
    fetch: fetchImpl, createAudio: () => audio,
    createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn()
  })
  return { eng, audio }
}
const okFetch = () => vi.fn(async () => new Response(new Blob(['abc']), { status: 200 }))
const opts = { rate: 1.5, pitch: 1, voice: 'v1' }

describe('renderBody pitch', () => {
  it('fills {{pitch}} and defaults to 0', () => {
    expect(JSON.parse(renderBody('{"p":{{pitch}}}', { text: 'x', voice: 'v', rate: 1, pitch: 8 }))).toEqual({ p: 8 })
    expect(JSON.parse(renderBody('{"p":{{pitch}}}', { text: 'x', voice: 'v', rate: 1 }))).toEqual({ p: 0 })
  })
})

describe('CloudEngine', () => {
  it('posts with auth header, plays audio, fires onEnd', async () => {
    const f = okFetch()
    const { eng, audio } = setup(f)
    const onEnd = vi.fn(), onStart = vi.fn()
    eng.speak('你好', opts, { onStart, onEnd, onError: vi.fn() })
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled())
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe('https://tts.example/v1')
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body)).toEqual({ input: '你好', voice: 'v1' })
    expect(audio.playbackRate).toBe(1.5)
    expect(onStart).toHaveBeenCalled()
    expect(eng.isActive()).toBe(true)
    audio.onended()
    expect(onEnd).toHaveBeenCalledOnce()
    expect(eng.isActive()).toBe(false)
  })

  it('reports HTTP errors via onError', async () => {
    const { eng } = setup(vi.fn(async () => new Response('no', { status: 401 })))
    const onError = vi.fn()
    eng.speak('x', opts, { onEnd: vi.fn(), onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('TTS HTTP 401'))
  })

  it('cancel() suppresses callbacks from an in-flight request', async () => {
    const { eng, audio } = setup(okFetch())
    const h = { onEnd: vi.fn(), onError: vi.fn() }
    eng.speak('x', opts, h)
    eng.cancel()
    await new Promise(r => setTimeout(r, 10))
    expect(audio.play).not.toHaveBeenCalled()
    expect(h.onEnd).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('prefetch reuses the cached request', async () => {
    const f = okFetch()
    const { eng, audio } = setup(f)
    eng.prefetch('next', opts)
    eng.speak('next', opts, { onEnd: vi.fn(), onError: vi.fn() })
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled())
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('invalid extraHeaders JSON surfaces as onError', async () => {
    const { eng } = setup(okFetch(), { extraHeaders: '{bad' })
    const onError = vi.fn()
    eng.speak('x', opts, { onEnd: vi.fn(), onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
  })

  it('is unsupported until an endpoint is set', () => {
    expect(setup(okFetch(), { endpoint: '' }).eng.isSupported()).toBe(false)
  })

  it('re-fetches when pitch or rate changes (cache key includes prosody)', async () => {
    const f = okFetch()
    const { eng } = setup(f)
    const h = { onEnd: vi.fn(), onError: vi.fn() }
    eng.prefetch('同一句', { ...opts, pitchPct: 0 })
    eng.prefetch('同一句', { ...opts, pitchPct: 8 })
    eng.prefetch('同一句', { ...opts, pitchPct: 8 })
    expect(f).toHaveBeenCalledTimes(2)
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).voice).toBe('v1')
  })

  it('keeps playbackRate at 1 when the server applies prosody', async () => {
    const { eng, audio } = setup(okFetch())
    eng.serverProsody = true
    eng.speak('hi', { ...opts, rate: 1.3 }, { onEnd: vi.fn(), onError: vi.fn() })
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled())
    expect(audio.playbackRate).toBe(1)
  })
})
