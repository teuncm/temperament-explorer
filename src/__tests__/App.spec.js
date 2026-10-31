import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createVaporApp, nextTick } from 'vue'
import App from '../App.vue'
import { ROOT_FREQUENCY, MAX_VOICES, HarmonicPhase, Synth } from '../synth.js'

describe('harmonic phase', () => {
  it('rejects upper harmonics that would alias into a subsampled phase estimate', () => {
    const tracker = new HarmonicPhase(),
      sampleRate = 48000
    for (const phase of [-2.4, -1.1, -0.6, 0.7, 1.3, 2.2]) {
      const signal = Float32Array.from({ length: 8192 }, (_, i) => {
        const angle = phase - (2 * Math.PI * ROOT_FREQUENCY * (8191 - i)) / sampleRate
        return Math.sin(angle) + Math.sin(255 * angle) / 255 + Math.sin(257 * angle) / 257
      })
      expect(tracker.read(signal, ROOT_FREQUENCY, sampleRate)).toBeCloseTo(phase, 5)
    }
  })
  function samples(frequency, phase, sampleRate, waveform = 'sine') {
    const length = Math.max(8192, Math.ceil((sampleRate * 4) / frequency) + 1)
    return Float32Array.from({ length }, (_, i) => {
      const angle = phase - (2 * Math.PI * frequency * (length - 1 - i)) / sampleRate
      let value = Math.sin(angle)
      for (let n = 2; n <= 16; n++) {
        if (waveform === 'saw') value += ((-1) ** (n + 1) * Math.sin(n * angle)) / n
        if (waveform === 'square' && n % 2) value += Math.sin(n * angle) / n
        if (waveform === 'triangle' && n % 2)
          value += ((-1) ** ((n - 1) / 2) * Math.sin(n * angle)) / n ** 2
      }
      return value
    })
  }

  it.each(['sine', 'saw', 'square', 'triangle'])(
    'extracts the fundamental phase from %s',
    (waveform) => {
      const tracker = new HarmonicPhase()
      for (const sampleRate of [44100, 48000, 96000]) {
        for (const ratio of [1, 1.25, 1.5, 2]) {
          for (const phase of [-2.4, -0.6, 0.7, 2.2]) {
            const measured = tracker.read(
              samples(ROOT_FREQUENCY * ratio, phase, sampleRate, waveform),
              ROOT_FREQUENCY * ratio,
              sampleRate,
            )
            expect(measured).toBeCloseTo(phase, 2)
          }
        }
      }
    },
  )

  it('follows a nearby harmonic pair at its actual beat rate', () => {
    const reference = new HarmonicPhase(),
      interval = new HarmonicPhase()
    const sampleRate = 48000,
      frequency = ROOT_FREQUENCY * 1.5 + 0.5
    const pulses = []
    for (const time of [0, 0.25, 0.5, 0.75, 1]) {
      const first = reference.read(
        samples(ROOT_FREQUENCY, 2 * Math.PI * ROOT_FREQUENCY * time, sampleRate),
        ROOT_FREQUENCY,
        sampleRate,
      )
      const second = interval.read(
        samples(frequency, 2 * Math.PI * frequency * time, sampleRate),
        frequency,
        sampleRate,
      )
      pulses.push(0.5 + 0.5 * Math.cos(3 * first - 2 * second))
    }
    // The third and second harmonics differ by 1 Hz.
    for (const [index, expected] of [1, 0.5, 0, 0.5, 1].entries())
      expect(pulses[index]).toBeCloseTo(expected, 3)
  })

  it('resolves the slow 17:9 beat at the 12-TET major seventh', () => {
    const reference = new HarmonicPhase(),
      interval = new HarmonicPhase()
    const frequency = ROOT_FREQUENCY * 2 ** (11 / 12)
    const beatRate = Math.abs(17 * ROOT_FREQUENCY - 9 * frequency)
    expect(beatRate).toBeGreaterThan(1)
    expect(beatRate).toBeLessThan(2)
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const time = fraction / beatRate
      const first = reference.read(
        samples(ROOT_FREQUENCY, 2 * Math.PI * ROOT_FREQUENCY * time, 48000, 'square'),
        ROOT_FREQUENCY,
        48000,
      )
      const second = interval.read(
        samples(frequency, 2 * Math.PI * frequency * time, 48000, 'square'),
        frequency,
        48000,
      )
      const pulse = 0.5 + 0.5 * Math.cos(17 * first - 9 * second)
      expect(pulse).toBeCloseTo(0.5 + 0.5 * Math.cos(2 * Math.PI * fraction), 2)
    }
  })
})
function mockAudio() {
  function parameter(value = 0) {
    const param = { value, cancelAndHoldAtTime: vi.fn(), cancelScheduledValues: vi.fn() }
    for (const method of ['setValueAtTime', 'linearRampToValueAtTime', 'setTargetAtTime']) {
      param[method] = vi.fn((value) => {
        param.value = value
      })
    }
    param.setValueCurveAtTime = vi.fn((curve) => {
      param.value = curve[curve.length - 1]
    })
    return param
  }
  const oscillators = [],
    gains = []
  const context = {
    state: 'suspended',
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    createGain: vi.fn(() => {
      const node = { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() }
      gains.push(node)
      return node
    }),
    createOscillator: vi.fn(() => {
      const node = {
        type: 'sine',
        frequency: parameter(440),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        setPeriodicWave: vi.fn(() => {
          node.type = 'custom'
        }),
      }
      oscillators.push(node)
      return node
    }),
    createPeriodicWave: vi.fn((real, imaginary) => ({ real, imaginary })),
    createAnalyser: vi.fn(() => ({
      fftSize: 2048,
      getFloatTimeDomainData: vi.fn((samples) => samples.fill(0.25)),
      disconnect: vi.fn(),
    })),
    resume: vi.fn(async () => {
      context.state = 'running'
    }),
    suspend: vi.fn(async () => {
      context.state = 'suspended'
    }),
    close: vi.fn(async () => {
      context.state = 'closed'
    }),
  }
  const Audio = vi.fn(function () {
    return context
  })
  vi.stubGlobal('AudioContext', Audio)
  return { context, Audio, oscillators, gains }
}

describe('interval dial', () => {
  let app, host, dial, audio

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    audio = mockAudio()
    host = document.createElement('div')
    document.body.append(host)
    app = createVaporApp(App)
    app.mount(host)
    dial = host.querySelector('[role="slider"]')
    dial.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 })
    dial.setPointerCapture = vi.fn()
    dial.hasPointerCapture = () => true
    dial.releasePointerCapture = vi.fn()
  })

  afterEach(() => {
    app.unmount()
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function pointer(type, angle, pointerId = 1, radius = 164) {
    const radians = (angle * Math.PI) / 180
    const event = new Event(type, { bubbles: true })
    Object.assign(event, {
      clientX: 200 + Math.sin(radians) * radius,
      clientY: 200 - Math.cos(radians) * radius,
      pointerId,
      button: 0,
    })
    dial.dispatchEvent(event)
  }

  async function key(value, shiftKey = false) {
    dial.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true }))
    await nextTick()
  }

  const value = () => Number(dial.getAttribute('aria-valuenow'))
  const ratio = () => Number(dial.getAttribute('aria-valuetext').match(/([\d.]+) times/)[1])
  const rotation = () =>
    Number(host.querySelector('.dial-rotor').style.transform.match(/, ([\d.e+-]+)deg/)[1])

  async function option(control, label) {
    const group = host.querySelector(`[aria-labelledby="${control}-label"]`)
    const button = [...group.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === label,
    )
    button.click()
    await nextTick()
    expect(button.getAttribute('aria-pressed')).toBe('true')
  }

  it('starts at the 12-TET perfect fourth with a fixed reference', () => {
    expect(value()).toBe(500)
    expect(ratio()).toBeCloseTo(2 ** (5 / 12), 4)
    expect(dial.getAttribute('aria-valuetext')).toContain('Perfect fourth')
    expect(rotation()).toBeCloseTo((2 ** (5 / 12) - 1) * 360, 6)
    expect(
      host
        .querySelector('[aria-labelledby="spacing-label"] [aria-pressed="true"]')
        .textContent.trim(),
    ).toBe('Linear')
    expect(
      host.querySelector('[aria-labelledby="snap-label"] [aria-pressed="true"]').textContent.trim(),
    ).toBe('On')
    expect(dial.querySelectorAll('.ratio-guide')).toHaveLength(6)
    expect(dial.querySelectorAll('.ratio-marker')).toHaveLength(7)
    expect(dial.querySelectorAll('.snap-point')).toHaveLength(12)
  })

  async function steps(count) {
    const input = host.querySelector('#tuning-steps')
    input.value = String(count)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  function pianoPointer(type, midi, pointerId = 10) {
    const button = host.querySelector(`[data-midi="${midi}"]`)
    button.setPointerCapture = vi.fn()
    button.hasPointerCapture = () => true
    button.releasePointerCapture = vi.fn()
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { pointerId, button: 0 })
    button.dispatchEvent(event)
    return button
  }

  it('shows two octaves and plays the selected root with the current interval', async () => {
    const keys = [...host.querySelectorAll('[data-midi]')]
    expect(keys).toHaveLength(24)
    expect(keys.filter((key) => key.classList.contains('piano-black'))).toHaveLength(10)
    expect(keys[0].getAttribute('aria-label')).toBe('C3')
    expect(keys.at(-1).getAttribute('aria-label')).toBe('B4')
    await option('temperament', 'Just · 5-limit')
    const selected = pianoPointer('pointerdown', 52)
    await nextTick()
    const frequency = 440 * 2 ** ((52 - 69) / 12)
    expect(audio.oscillators[0].frequency.value).toBeCloseTo(frequency, 7)
    expect(audio.oscillators[1].frequency.value).toBeCloseTo((frequency * 4) / 3, 7)
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(selected.getAttribute('aria-current')).toBe('true')
    pianoPointer('pointerup', 52)
    await nextTick()
    expect(selected.getAttribute('aria-pressed')).toBe('false')
    expect(selected.getAttribute('aria-current')).toBe('true')
    pointer('pointerdown', 180)
    expect(audio.oscillators[2].frequency.value).toBeCloseTo(frequency, 7)
    pointer('pointerup', 180)
  })

  it('shifts the keyboard and caps the highest range at C4–B5', async () => {
    host.querySelector('[aria-label="Octave up"]').click()
    await nextTick()
    expect(host.querySelector('[data-midi="60"]').getAttribute('aria-current')).toBe('true')
    expect(host.querySelector('[data-midi="83"]')).not.toBeNull()
    for (let i = 0; i < 12; i++) {
      host.querySelector('[aria-label="Octave down"]').click()
      await nextTick()
    }
    expect(host.querySelector('[data-midi="0"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Octave down"]').disabled).toBe(true)
    for (let i = 0; i < 12; i++) {
      host.querySelector('[aria-label="Octave up"]').click()
      await nextTick()
    }
    expect(host.querySelector('[data-midi="60"]').getAttribute('aria-label')).toBe('C4')
    expect(host.querySelector('[data-midi="83"]').getAttribute('aria-label')).toBe('B5')
    expect(host.querySelector('[data-midi="84"]')).toBeNull()
    expect(host.querySelector('[aria-label="Octave up"]').disabled).toBe(true)
  })

  it('keeps playing until both the dial and keyboard are released', async () => {
    pianoPointer('pointerdown', 48)
    pointer('pointerdown', 180)
    pointer('pointerup', 180)
    await nextTick()
    expect(audio.gains[1].gain.value).toBe(1)
    pianoPointer('pointerup', 48)
    expect(audio.gains[1].gain.value).toBe(0)
    pointer('pointerdown', 180)
    pianoPointer('pointerdown', 50)
    pianoPointer('pointerup', 50)
    expect(audio.gains[1].gain.value).toBe(1)
    pointer('pointerup', 180)
    expect(audio.gains[1].gain.value).toBe(0)
  })

  it('supports Space playback, ignores repeats, and releases on blur', async () => {
    const button = host.querySelector('[data-midi="49"]')
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true }),
    )
    await nextTick()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(audio.oscillators).toHaveLength(2)
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
    await nextTick()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    pianoPointer('pointerdown', 48)
    window.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(host.querySelector('[data-midi="48"]').getAttribute('aria-pressed')).toBe('false')
    expect(audio.gains[1].gain.value).toBe(0)
  })

  it.each([
    ['equal', 'Linear'],
    ['equal', 'Logarithmic'],
    ['linear', 'Linear'],
    ['linear', 'Logarithmic'],
  ])('supports configurable %s steps with %s dial spacing', async (tuning, spacing) => {
    if (tuning === 'linear') await option('temperament', 'Equal linear (12)')
    await option('spacing', spacing)
    await steps(7)
    expect(dial.querySelectorAll('.snap-point')).toHaveLength(7)
    await key('Home')
    pointer('pointerdown', 0)
    for (let i = 0; i <= 7; i++) {
      const expected = tuning === 'linear' ? 1 + i / 7 : 2 ** (i / 7)
      expect(ratio()).toBeCloseTo(expected, 4)
      expect(audio.oscillators[1].frequency.value).toBeCloseTo(ROOT_FREQUENCY * expected, 6)
      expect(dial.getAttribute('aria-valuetext')).not.toContain('undefined')
      await key('ArrowRight')
    }
    expect(ratio()).toBe(2)
    await key('Home')
    expect(ratio()).toBe(1)
    pointer('pointerup', 0)
  })

  it('remembers each step count and safely switches between different scale sizes', async () => {
    await steps(53)
    await key('End')
    await key('ArrowLeft')
    expect(ratio()).toBeCloseTo(2 ** (52 / 53), 4)
    await option('temperament', 'Just · 5-limit')
    expect(host.querySelector('#tuning-steps')).toBeNull()
    expect(ratio()).toBe(2)
    await option('temperament', 'Equal linear (12)')
    expect(host.querySelector('#tuning-steps').value).toBe('12')
    await steps(5)
    await option('temperament', 'Equal · 53-TET')
    expect(host.querySelector('#tuning-steps').value).toBe('53')
    await steps(1)
    expect(ratio()).toBe(2)
    expect(host.querySelector('[aria-label="Decrease steps"]').disabled).toBe(true)
    await steps(256)
    expect(host.querySelector('[aria-label="Increase steps"]').disabled).toBe(true)
    await option('temperament', 'Equal linear (5)')
    expect(host.querySelector('#tuning-steps').value).toBe('5')
  })

  it('supports step buttons and rejects invalid step counts without changing unsnapped pitch', async () => {
    await option('snap', 'Off')
    pointer('pointerdown', 140)
    pointer('pointerup', 140)
    await nextTick()
    const initial = ratio()
    host.querySelector('[aria-label="Increase steps"]').click()
    await nextTick()
    expect(host.querySelector('#tuning-steps').value).toBe('13')
    host.querySelector('[aria-label="Decrease steps"]').click()
    await nextTick()
    expect(host.querySelector('#tuning-steps').value).toBe('12')
    for (const invalid of ['', 0, -3, 2.5, 257]) {
      await steps(invalid)
      const input = host.querySelector('#tuning-steps')
      input.dispatchEvent(new Event('change', { bubbles: true }))
      expect(input.value).toBe('12')
    }
    await steps(19)
    expect(ratio()).toBe(initial)
    await option('temperament', 'Equal linear (12)')
    expect(ratio()).toBe(initial)
  })

  it('updates fraction pitches, guides and the button count together', async () => {
    await option('temperament', 'Fractions (4)')
    expect(host.querySelector('#tuning-steps').value).toBe('4')
    await steps(3)
    expect(
      host
        .querySelector('[aria-labelledby="temperament-label"] [aria-pressed="true"]')
        .textContent.trim(),
    ).toBe('Fractions (3)')
    expect(dial.querySelectorAll('.ratio-guide')).toHaveLength(4)
    expect(dial.querySelectorAll('.snap-point')).toHaveLength(4)
    await key('Home')
    for (const expected of [1, 4 / 3, 3 / 2, 5 / 3, 2]) {
      expect(ratio()).toBeCloseTo(expected, 4)
      await key('ArrowRight')
    }
    await key('ArrowLeft')
    expect(ratio()).toBeCloseTo(5 / 3, 4)
    host.querySelector('[aria-label="Decrease denominator"]').click()
    await nextTick()
    expect(ratio()).toBe(1.5)
    expect(dial.querySelectorAll('.ratio-guide')).toHaveLength(2)
    expect(dial.querySelectorAll('.ratio-guide')[1].getAttribute('y2')).toBe('104')
    await option('temperament', 'Equal linear (12)')
    await steps(7)
    await option('temperament', 'Fractions (2)')
    expect(host.querySelector('#tuning-steps').value).toBe('2')
    await option('temperament', 'Equal linear (7)')
    expect(host.querySelector('#tuning-steps').value).toBe('7')
  })

  it('bounds fraction density and preserves unsnapped pitch when it changes', async () => {
    await option('temperament', 'Fractions (4)')
    await steps(9)
    await steps(1)
    expect(dial.querySelectorAll('.snap-point')).toHaveLength(1)
    expect(host.querySelector('[aria-label="Decrease denominator"]').disabled).toBe(true)
    await option('snap', 'Off')
    pointer('pointerdown', 150)
    pointer('pointerup', 150)
    await nextTick()
    const initial = ratio()
    await steps(32)
    expect(host.querySelector('[aria-label="Increase denominator"]').disabled).toBe(true)
    expect(ratio()).toBe(initial)
    await steps(33)
    const input = host.querySelector('#tuning-steps')
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(input.value).toBe('32')
  })

  it('adds fraction labels progressively through fifths and caps labels above that', async () => {
    await option('temperament', 'Fractions (4)')
    await steps(9)
    for (const [limit, count] of [
      [1, 2],
      [2, 3],
      [3, 5],
      [4, 7],
      [5, 11],
      [6, 11],
      [7, 11],
      [8, 11],
      [9, 11],
      [10, 11],
    ]) {
      await steps(limit)
      const labels = [...dial.querySelectorAll('.ratio-marker')].map((marker) =>
        marker.textContent.trim(),
      )
      expect(labels).toHaveLength(count)
      expect(new Set(labels).size).toBe(count)
      expect(labels).toContain('1×')
      expect(labels).toContain('2×')
    }
    expect(
      [...dial.querySelectorAll('.ratio-marker')].map((marker) => marker.textContent.trim()),
    ).toContain('9/5×')
  })

  describe('configured dial interaction', () => {
    beforeEach(async () => {
      await key('Home')
      await option('snap', 'Off')
      await option('spacing', 'Logarithmic')
    })

    it.each([
      [90, 300, '1.1892'],
      [180, 600, '1.4142'],
      [270, 900, '1.6818'],
    ])('maps %i degrees to %i cents and ratio %s', async (angle, cents, ratio) => {
      pointer('pointerdown', angle)
      pointer('pointerup', angle)
      await nextTick()
      expect(value()).toBe(cents)
      expect(dial.getAttribute('aria-valuetext')).toContain(`${ratio} times`)
    })

    it('caps clockwise at the octave across repeated turns and re-aligns across the seam', async () => {
      pointer('pointerdown', 0)
      for (const angle of [90, 180, 270, 350, 10, 90, 180, 270, 0]) pointer('pointermove', angle)
      pointer('pointerup', 0)
      await nextTick()
      expect(value()).toBe(1200)
      expect(ratio()).toBe(2)
      // Picking up the dot slightly clockwise of the seam must retain 2x.
      pointer('pointerdown', 2)
      pointer('pointermove', 353)
      pointer('pointerup', 353)
      await nextTick()
      expect(value()).toBe(1176.7)
      expect(rotation()).toBeCloseTo(353, 8)
    })

    it('caps counterclockwise at unison and preserves it when grabbing near the seam', async () => {
      pointer('pointerdown', 358)
      for (const angle of [350, 270, 180, 90, 0]) pointer('pointermove', angle)
      pointer('pointerup', 0)
      await nextTick()
      expect(value()).toBe(0)
    })

    it.each(['Linear', 'Logarithmic'])(
      'uses exact uncapped cursor angles with %s spacing',
      async (spacing) => {
        await option('spacing', spacing)
        const frames = []
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
          frames.push(callback)
          return 1
        })
        pointer('pointerdown', 20)
        for (const angle of [60, 120, 200, 250, 170, 90, 270, 220, 140, 30]) {
          pointer('pointermove', angle)
          frames.shift()()
          await nextTick()
          expect(rotation()).toBeCloseTo(angle, 8)
        }
        pointer('pointerup', 30)
      },
    )

    it.each([
      [
        'Linear',
        300,
        [
          [350, 350],
          [5, 360],
          [80, 360],
          [40, 360],
          [2, 360],
          [355, 355],
          [340, 340],
        ],
      ],
      [
        'Logarithmic',
        300,
        [
          [350, 350],
          [5, 360],
          [80, 360],
          [40, 360],
          [2, 360],
          [355, 355],
          [340, 340],
        ],
      ],
      [
        'Linear',
        60,
        [
          [10, 10],
          [355, 0],
          [280, 0],
          [320, 0],
          [358, 0],
          [5, 5],
          [20, 20],
        ],
      ],
      [
        'Logarithmic',
        60,
        [
          [10, 10],
          [355, 0],
          [280, 0],
          [320, 0],
          [358, 0],
          [5, 5],
          [20, 20],
        ],
      ],
    ])(
      'holds the endpoint until crossing back, then aligns exactly (%s, start %i)',
      async (spacing, start, samples) => {
        await option('spacing', spacing)
        const frames = []
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
          frames.push(callback)
          return 1
        })
        pointer('pointerdown', start)
        for (const [angle, expected] of samples) {
          pointer('pointermove', angle)
          frames.shift()()
          await nextTick()
          expect(rotation()).toBeCloseTo(expected, 8)
        }
        pointer('pointerup', samples.at(-1)[0])
      },
    )

    it('releases the endpoint lock when crossing through the center', async () => {
      pointer('pointerdown', 350)
      pointer('pointermove', 10)
      pointer('pointermove', 10, 1, 0)
      pointer('pointermove', 240)
      pointer('pointerup', 240)
      await nextTick()
      expect(rotation()).toBeCloseTo(240, 8)
    })

    it('ignores secondary pointers, re-anchors after the center, and releases capture', async () => {
      pointer('pointerdown', 90)
      pointer('pointermove', 180, 2)
      pointer('pointerup', 180, 2)
      pointer('pointermove', 180, 1, 0)
      pointer('pointermove', 270)
      pointer('pointercancel', 270)
      await nextTick()
      expect(value()).toBe(900)
      expect(dial.setPointerCapture).toHaveBeenCalledWith(1)
      expect(dial.releasePointerCapture).toHaveBeenCalledWith(1)
    })

    it.each([
      [90, 270, 900],
      [270, 90, 300],
      [180, 0, 0],
    ])(
      'tracks the pointer through the center from %i to %i degrees',
      async (start, end, expected) => {
        pointer('pointerdown', start)
        pointer('pointermove', start, 1, 10)
        pointer('pointermove', start, 1, 0)
        pointer('pointermove', end, 1, 10)
        pointer('pointermove', end)
        pointer('pointerup', end)
        await nextTick()
        expect(value()).toBe(expected)
      },
    )

    it('tracks a center crossing between pointer samples without accumulating an offset', async () => {
      pointer('pointerdown', 90)
      pointer('pointermove', 270)
      pointer('pointermove', 280)
      pointer('pointerup', 280)
      await nextTick()
      expect(value()).toBe(933.3)
    })

    it('batches pointer movement into one animation frame and flushes on release', async () => {
      const scheduled = vi.spyOn(window, 'requestAnimationFrame')
      pointer('pointerdown', 0)
      pointer('pointermove', 90)
      pointer('pointermove', 180)
      expect(scheduled).toHaveBeenCalledTimes(1)
      pointer('pointerup', 180)
      await nextTick()
      expect(value()).toBe(600)
    })

    it('supports keyboard increments and both endpoints', async () => {
      await key('ArrowRight')
      expect(value()).toBe(1)
      await key('ArrowUp', true)
      expect(value()).toBe(11)
      await key('PageUp')
      expect(value()).toBe(111)
      await key('End')
      await key('ArrowRight')
      expect(value()).toBe(1200)
      expect(host.querySelector('[data-reset]')).toBeNull()
      await key('Home')
      expect(value()).toBe(0)
      await key('ArrowLeft')
      expect(value()).toBe(0)
      await key('PageUp')
      await key('Home')
      expect(value()).toBe(0)
    })

    it('preserves the ratio when spacing changes and maps linear dragging to frequency', async () => {
      pointer('pointerdown', 180)
      pointer('pointerup', 180)
      await nextTick()
      await option('spacing', 'Linear')
      expect(ratio()).toBe(1.4142)
      expect(rotation()).toBeCloseTo((Math.SQRT2 - 1) * 360)
      pointer('pointerdown', 180)
      pointer('pointerup', 180)
      await nextTick()
      expect(ratio()).toBe(1.5)
      expect(value()).toBe(702)
      await key('ArrowRight')
      expect(value()).toBe(703)
      await option('spacing', 'Logarithmic')
      expect(value()).toBe(703)
    })

    it.each([
      ['Logarithmic', 'Equal · 12-TET', 'Off', 1.2599],
      ['Logarithmic', 'Equal · 12-TET', 'On', 1.2599],
      ['Logarithmic', 'Just · 5-limit', 'Off', 1.2599],
      ['Logarithmic', 'Just · 5-limit', 'On', 1.25],
      ['Linear', 'Equal · 12-TET', 'Off', 1.3333],
      ['Linear', 'Equal · 12-TET', 'On', 1.3348],
      ['Linear', 'Just · 5-limit', 'Off', 1.3333],
      ['Linear', 'Just · 5-limit', 'On', 1.3333],
    ])(
      'combines %s spacing, %s tuning, and snapping %s',
      async (spacing, tuning, snap, expected) => {
        await option('spacing', spacing)
        await option('temperament', tuning)
        await option('snap', snap)
        pointer('pointerdown', 120)
        pointer('pointerup', 120)
        await nextTick()
        expect(ratio()).toBe(expected)
        if (snap === 'On') {
          expect(rotation()).toBeCloseTo(
            spacing === 'Linear' ? (expected - 1) * 360 : Math.log2(expected) * 360,
            0,
          )
        }
        pointer('pointerdown', 0)
        for (const angle of [90, 180, 270, 350, 10]) pointer('pointermove', angle)
        pointer('pointerup', 10)
        await nextTick()
        expect(ratio()).toBe(2)
      },
    )

    it('retunes a snapped interval and holds pitch when snapping is disabled', async () => {
      pointer('pointerdown', 210)
      pointer('pointerup', 210)
      await option('snap', 'On')
      expect(ratio()).toBe(1.4983)
      await option('temperament', 'Just · 5-limit')
      expect(ratio()).toBe(1.5)
      expect(dial.getAttribute('aria-valuetext')).toContain('Perfect fifth')
      await option('spacing', 'Linear')
      expect(rotation()).toBeCloseTo(180)
      await option('snap', 'Off')
      expect(ratio()).toBe(1.5)
      await option('temperament', 'Equal · 12-TET')
      expect(ratio()).toBe(1.5)
    })

    it('moves one note at a time with the keyboard when snapping is enabled', async () => {
      await option('snap', 'On')
      await option('temperament', 'Just · 5-limit')
      await option('spacing', 'Linear')
      await key('ArrowRight')
      expect(ratio()).toBe(1.0667)
      await key('ArrowRight')
      expect(ratio()).toBe(1.125)
      await key('ArrowLeft')
      expect(ratio()).toBe(1.0667)
      await key('End')
      await key('ArrowUp')
      expect(ratio()).toBe(2)
      await key('Home')
      await key('ArrowDown')
      expect(ratio()).toBe(1)
    })

    it.each([
      ['Pythagorean', 'Linear'],
      ['Pythagorean', 'Logarithmic'],
      ['Meantone · ¼', 'Linear'],
      ['Meantone · ¼', 'Logarithmic'],
    ])('uses %s pitches, snap points, and audio with %s spacing', async (tuning, spacing) => {
      const pythagorean = [
        1,
        2187 / 2048,
        9 / 8,
        32 / 27,
        81 / 64,
        4 / 3,
        729 / 512,
        3 / 2,
        6561 / 4096,
        27 / 16,
        16 / 9,
        243 / 128,
        2,
      ]
      const expectedCents =
        tuning === 'Pythagorean'
          ? pythagorean.map((ratio) => 1200 * Math.log2(ratio))
          : [
              0, 76.049, 193.157, 310.265, 386.314, 503.422, 579.471, 696.578, 772.627, 889.735,
              1006.843, 1082.892, 1200,
            ]
      await option('temperament', tuning)
      await option('spacing', spacing)
      await option('snap', 'On')
      pointer('pointerdown', 0)
      for (let i = 0; i < expectedCents.length; i++) {
        if (i) await key('ArrowRight')
        const expectedRatio = 2 ** (expectedCents[i] / 1200)
        expect(value()).toBeCloseTo(expectedCents[i], 0)
        expect(audio.oscillators[0].frequency.value).toBeCloseTo(ROOT_FREQUENCY)
        expect(audio.oscillators[1].frequency.value).toBeCloseTo(ROOT_FREQUENCY * expectedRatio, 3)
        if (i < 12) {
          const point = dial.querySelectorAll('.snap-point')[i]
          const angle = Number(point.getAttribute('transform').match(/rotate\(([\d.e+-]+)/)[1])
          expect(angle).toBeCloseTo(
            spacing === 'Linear' ? (expectedRatio - 1) * 360 : expectedCents[i] * 0.3,
            2,
          )
        }
      }
      pointer('pointercancel', 0)
    })

    it.each(['Linear', 'Logarithmic'])(
      'snaps Fractions to every guide with %s spacing',
      async (spacing) => {
        const expected = [
          1,
          10 / 9,
          9 / 8,
          8 / 7,
          7 / 6,
          6 / 5,
          11 / 9,
          5 / 4,
          9 / 7,
          4 / 3,
          11 / 8,
          7 / 5,
          10 / 7,
          13 / 9,
          3 / 2,
          14 / 9,
          11 / 7,
          8 / 5,
          13 / 8,
          5 / 3,
          12 / 7,
          7 / 4,
          16 / 9,
          9 / 5,
          11 / 6,
          13 / 7,
          15 / 8,
          17 / 9,
          2,
        ]
        await option('temperament', 'Fractions (4)')
        await steps(9)
        await option('spacing', spacing)
        await option('snap', 'On')
        const guides = new Set(
          [...dial.querySelectorAll('.ratio-guide')].map((line) => line.getAttribute('transform')),
        )
        const points = [...dial.querySelectorAll('.snap-point')]
        expect(points).toHaveLength(28)
        for (const point of points) expect(guides.has(point.getAttribute('transform'))).toBe(true)
        pointer('pointerdown', 0)
        for (let i = 0; i < expected.length; i++) {
          if (i) await key('ArrowRight')
          expect(ratio()).toBeCloseTo(expected[i], 4)
          expect(audio.oscillators[1].frequency.value).toBeCloseTo(ROOT_FREQUENCY * expected[i], 6)
          expect(dial.getAttribute('aria-valuetext')).not.toContain('undefined')
        }
        await key('ArrowRight')
        expect(ratio()).toBe(2)
        await key('Home')
        await key('ArrowLeft')
        expect(ratio()).toBe(1)
        pointer('pointercancel', 0)
      },
    )

    it('switches between Fractions and twelve-note tunings by nearest pitch', async () => {
      await option('temperament', 'Fractions (4)')
      await steps(9)
      await option('snap', 'On')
      await key('End')
      await key('ArrowLeft')
      expect(ratio()).toBeCloseTo(17 / 9, 4)
      await option('temperament', 'Equal · 12-TET')
      expect(ratio()).toBeCloseTo(2 ** (11 / 12), 4)
      await option('temperament', 'Fractions (9)')
      expect(ratio()).toBeCloseTo(17 / 9, 4)
      await option('temperament', 'Just · 5-limit')
      expect(ratio()).toBe(1.875)
      await option('snap', 'Off')
      await option('temperament', 'Fractions (9)')
      expect(ratio()).toBe(1.875)
    })

    it('starts only two voices on a gesture and tracks the ratio while the root stays fixed', async () => {
      expect(audio.Audio).not.toHaveBeenCalled()
      pointer('pointerdown', 0)
      expect(audio.oscillators).toHaveLength(2)
      expect(audio.oscillators[0].frequency.value).toBeCloseTo(130.8128, 4)
      pointer('pointermove', 180)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await nextTick()
      expect(audio.oscillators[0].frequency.value).toBeCloseTo(ROOT_FREQUENCY)
      expect(audio.oscillators[1].frequency.value).toBeCloseTo(ROOT_FREQUENCY * Math.SQRT2)
      await option('snap', 'On')
      await option('temperament', 'Just · 5-limit')
      expect(audio.oscillators[1].frequency.value).toBeCloseTo((ROOT_FREQUENCY * 45) / 32)
      pointer('pointerup', 180)
      for (const gain of audio.gains.slice(1)) {
        const [curve, start, duration] = gain.gain.setValueCurveAtTime.mock.calls.at(-1)
        expect(curve.at(-1)).toBe(0)
        expect(start).toBe(0)
        expect(duration).toBe(0.09)
      }
    })

    it.each(['Sine', 'Saw', 'Soft saw', 'Square', 'Triangle'])(
      'applies %s to both voices',
      async (label) => {
        pointer('pointerdown', 90)
        await option('waveform', label)
        const expected = {
          Sine: 'sine',
          Saw: 'sawtooth',
          'Soft saw': 'custom',
          Square: 'square',
          Triangle: 'triangle',
        }[label]
        expect(audio.oscillators.map((oscillator) => oscillator.type)).toEqual([expected, expected])
        pointer('pointercancel', 90)
      },
    )

    it.each(['pointercancel', 'lostpointercapture', 'blur', 'hidden'])(
      'stops voices on %s',
      async (reason) => {
        pointer('pointerdown', 180)
        if (reason === 'blur') window.dispatchEvent(new Event('blur'))
        else if (reason === 'hidden') {
          vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
          document.dispatchEvent(new Event('visibilitychange'))
        } else pointer(reason, 180)
        for (const gain of audio.gains.slice(1)) expect(gain.gain.value).toBe(0)
        pointer('pointerdown', 90)
        expect(audio.oscillators).toHaveLength(4)
        expect(audio.oscillators[2].start.mock.calls[0]).toEqual(
          audio.oscillators[3].start.mock.calls[0],
        )
        expect(audio.gains[1].gain.value).toBe(1)
        pointer('pointerup', 90)
      },
    )

    it('does not revive released notes after a delayed audio unlock', async () => {
      let unlock
      audio.context.resume.mockImplementation(
        () =>
          new Promise((resolve) => {
            unlock = resolve
          }),
      )
      pointer('pointerdown', 180)
      pointer('pointerup', 180)
      unlock()
      await nextTick()
      expect(audio.context.resume).toHaveBeenCalledTimes(1)
      for (const gain of audio.gains.slice(1)) expect(gain.gain.value).toBe(0)
    })

    it('keeps the dial usable when Web Audio is unavailable', async () => {
      vi.stubGlobal('AudioContext', undefined)
      pointer('pointerdown', 180)
      pointer('pointerup', 180)
      await nextTick()
      expect(value()).toBe(600)
      expect(host.querySelector('[role="status"]').textContent).toContain('Audio unavailable')
    })
  })
})

describe('polyphonic synthesizer', () => {
  let audio, synth
  beforeEach(() => {
    audio = mockAudio()
    synth = new Synth()
  })
  afterEach(() => {
    synth.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['sine', 'sawtooth', 'soft-saw', 'square', 'triangle'])(
    'restarts both %s sources at one shared audio time on each interval press',
    async (waveform) => {
      vi.useFakeTimers()
      synth.setWaveform(waveform)
      audio.context.currentTime = 0.5
      synth.startInterval(1.25)
      const first = audio.oscillators.slice()
      expect(first[0].start).toHaveBeenCalledWith(0.508)
      expect(first[1].start).toHaveBeenCalledWith(0.508)
      synth.readScope('interval', 'reference', 1.25)
      const analysers = audio.context.createAnalyser.mock.results.map((result) => result.value)
      synth.allNotesOff()
      audio.context.currentTime = 0.75
      synth.startInterval(1.5)
      const next = audio.oscillators.slice(2)
      expect(next).toHaveLength(2)
      expect(next[0].start).toHaveBeenCalledWith(0.758)
      expect(next[1].start).toHaveBeenCalledWith(0.758)
      expect(next[0].frequency.value).toBe(ROOT_FREQUENCY)
      expect(next[1].frequency.value).toBe(ROOT_FREQUENCY * 1.5)
      expect(synth.slots).toHaveLength(2)
      expect(synth.active.size).toBe(2)
      for (const oscillator of first) expect(oscillator.stop).toHaveBeenCalledWith(0.758)
      for (const analyser of analysers) expect(analyser.disconnect).toHaveBeenCalledOnce()
      synth.readScope('interval', 'reference', 1.5)
      expect(audio.context.createAnalyser).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(50)
      for (const oscillator of first) expect(oscillator.disconnect).toHaveBeenCalledOnce()
      expect(synth.retired.size).toBe(0)
    },
  )

  it('supports 16 voices and steals the oldest without creating a seventeenth oscillator', () => {
    for (let i = 0; i < MAX_VOICES; i++) synth.noteOn(`note-${i}`, 130 + i)
    expect(synth.active.size).toBe(16)
    synth.noteOn('extra', 300)
    expect(synth.active.size).toBe(16)
    expect(synth.active.has('note-0')).toBe(false)
    expect(synth.active.has('extra')).toBe(true)
    expect(audio.oscillators).toHaveLength(16)
    expect(audio.oscillators[0].frequency.value).toBe(300)
    synth.noteOff('note-5')
    synth.noteOn('reused', 400)
    expect(audio.oscillators).toHaveLength(16)
    expect(audio.oscillators[5].frequency.value).toBe(400)
    expect(audio.gains[0].gain.value).toBeCloseTo(0.5 / 16)
  })

  it('caches a softened saw spectrum and applies a preselected waveform to new voices', () => {
    synth.setWaveform('soft-saw')
    expect(audio.Audio).not.toHaveBeenCalled()
    synth.noteOn('a', ROOT_FREQUENCY)
    synth.noteOn('b', ROOT_FREQUENCY * 1.5)
    const [, imaginary] = audio.context.createPeriodicWave.mock.calls[0]
    expect(imaginary[0]).toBe(0)
    expect(imaginary[1]).toBe(1)
    expect(Math.abs(imaginary[10])).toBeLessThan(1 / 10)
    expect(audio.context.createPeriodicWave).toHaveBeenCalledTimes(1)
    expect(audio.oscillators.map((oscillator) => oscillator.type)).toEqual(['custom', 'custom'])
  })

  it.each([0, 0.4, 1])('releases smoothly from gain %s to exact silence', (level) => {
    synth.noteOn('a', ROOT_FREQUENCY)
    const gain = audio.gains[1].gain
    gain.value = level
    audio.context.currentTime = 0.2
    synth.noteOff('a')
    const [curve, start, duration] = gain.setValueCurveAtTime.mock.calls.at(-1)
    expect(start).toBe(0.2)
    expect(duration).toBe(0.09)
    expect(curve[0]).toBeCloseTo(level, 7)
    expect(curve.at(-1)).toBe(0)
    expect(curve[64]).toBeCloseTo(level / 2, 7)
    expect(Math.abs(curve[1] - curve[0])).toBeLessThan(0.0002)
    expect(Math.abs(curve.at(-1) - curve.at(-2))).toBeLessThan(0.0002)
    expect(curve.every((value, i) => value >= 0 && (i === 0 || value <= curve[i - 1]))).toBe(true)
  })

  it('suspends after release, cancels idle suspension on new notes, and disposes resources', async () => {
    vi.useFakeTimers()
    synth.noteOn('a', ROOT_FREQUENCY)
    synth.noteOff('a')
    await vi.advanceTimersByTimeAsync(40)
    synth.noteOn('b', ROOT_FREQUENCY)
    await vi.advanceTimersByTimeAsync(250)
    expect(audio.context.suspend).not.toHaveBeenCalled()
    synth.allNotesOff()
    await vi.advanceTimersByTimeAsync(250)
    expect(audio.context.suspend).toHaveBeenCalledTimes(1)
    synth.dispose()
    expect(audio.context.close).toHaveBeenCalledTimes(1)
    expect(audio.oscillators[0].stop).toHaveBeenCalledTimes(1)
    expect(audio.oscillators[0].disconnect).toHaveBeenCalledTimes(1)
  })

  it('releases voices and reports audio-unlock failure', async () => {
    const onError = vi.fn()
    synth.onError = onError
    const error = new Error('Audio blocked')
    audio.context.resume.mockRejectedValue(error)
    synth.noteOn('a', ROOT_FREQUENCY)
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(error)
    expect(synth.active.size).toBe(0)
    expect(audio.gains[1].gain.value).toBe(0)
  })

  it('queues a new resume when a gesture arrives during an unfinished suspension', async () => {
    vi.useFakeTimers()
    let finishSuspension
    audio.context.suspend.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSuspension = resolve
        }),
    )
    synth.noteOn('a', ROOT_FREQUENCY)
    synth.noteOff('a')
    await vi.advanceTimersByTimeAsync(250)
    synth.noteOn('b', ROOT_FREQUENCY)
    expect(audio.context.resume).toHaveBeenCalledTimes(2)
    finishSuspension()
    await Promise.resolve()
    expect(synth.active.has('b')).toBe(true)
  })

  it('reads voice 2 as x and voice 1 as y, reusing sample buffers and analysers', () => {
    expect(synth.readScope('interval', 'reference')).toBeNull()
    synth.noteOn('reference', ROOT_FREQUENCY)
    synth.noteOn('interval', ROOT_FREQUENCY * 1.5)
    const first = synth.readScope('interval', 'reference')
    const [x, y] = audio.context.createAnalyser.mock.results.map((result) => result.value)
    x.getFloatTimeDomainData.mockImplementation((samples) => samples.fill(0.75))
    y.getFloatTimeDomainData.mockImplementation((samples) => samples.fill(-0.25))
    const next = synth.readScope('interval', 'reference')
    expect(next).toBe(first)
    expect(next.x[0]).toBe(0.75)
    expect(next.y[0]).toBe(-0.25)
    expect(next.sampleRate).toBe(48000)
    expect(audio.oscillators[1].connect).toHaveBeenCalledWith(x)
    expect(audio.oscillators[0].connect).toHaveBeenCalledWith(y)
    expect(audio.context.createAnalyser).toHaveBeenCalledTimes(2)
    synth.noteOff('interval')
    expect(synth.readScope('interval', 'reference')).toBeNull()
    synth.dispose()
    expect(x.disconnect).toHaveBeenCalledTimes(1)
    expect(y.disconnect).toHaveBeenCalledTimes(1)
  })
})
