export const ROOT_FREQUENCY = 440 * 2 ** ((48 - 69) / 12) // C3
export const MAX_VOICES = 16
const WAVEFORMS = ['sine', 'sawtooth', 'soft-saw', 'square', 'triangle']
const RELEASE_SECONDS = 0.09
const RELEASE_CURVE = Float32Array.from(
  { length: 129 },
  (_, i) => (1 + Math.cos((Math.PI * i) / 128)) * 0.5,
)

// A small fundamental projection recovers actual oscillator phase without an FFT.
// Cached Hann-weighted taps reject upper harmonics over up to four cycles.
export class HarmonicPhase {
  constructor() {
    this.cosine = new Float64Array(0)
    this.sine = new Float64Array(0)
    this.frequency = 0
    this.sampleRate = 0
  }

  read(samples, frequency, sampleRate) {
    if (samples.length < 2) return 0
    const count = Math.min(samples.length, Math.ceil((sampleRate * 4) / frequency) + 1)
    if (frequency !== this.frequency || sampleRate !== this.sampleRate || this.count !== count) {
      this.frequency = frequency
      this.sampleRate = sampleRate
      this.count = count
      if (this.cosine.length < this.count) {
        const capacity = 2 ** Math.ceil(Math.log2(this.count))
        this.cosine = new Float64Array(capacity)
        this.sine = new Float64Array(capacity)
      }
      for (let i = 0; i < this.count; i++) {
        const angle = (Math.PI * 2 * frequency * i) / sampleRate
        const weight = 0.5 - 0.5 * Math.cos((Math.PI * 2 * i) / (this.count - 1))
        this.cosine[i] = Math.cos(angle) * weight
        this.sine[i] = Math.sin(angle) * weight
      }
    }
    let cosine = 0,
      sine = 0
    if (samples.length < this.count) return 0
    // Decimating without a low-pass filter aliases upper harmonics into phase.
    for (let i = 0; i < this.count; i++) {
      const sample = samples[samples.length - 1 - i]
      cosine += sample * this.cosine[i]
      sine += sample * this.sine[i]
    }
    return Math.atan2(cosine, -sine)
  }
}

// Native audio nodes render off the UI thread. Allocate only the voices in use.
export class Synth {
  constructor(onError = () => {}) {
    this.onError = onError
    this.waveform = 'sine'
    this.rootFrequency = ROOT_FREQUENCY
    this.context = null
    this.slots = []
    this.active = new Map()
    this.retired = new Map()
    this.idleTimer = null
    this.resuming = null
    this.suspending = null
    this.scope = { x: null, y: null, time: 0, sampleRate: 0 }
    this.xPhase = new HarmonicPhase()
    this.yPhase = new HarmonicPhase()
  }

  wake() {
    clearTimeout(this.idleTimer)
    if (!this.context) {
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext
      if (!Audio) throw new Error('Web Audio is unavailable')
      this.context = new Audio({ latencyHint: 'interactive' })
      this.output = this.context.createGain()
      this.output.gain.value = 0.5
      this.output.connect(this.context.destination)
    }
    if (
      (this.context.state === 'suspended' ||
        this.context.state === 'interrupted' ||
        this.suspending) &&
      !this.resuming
    ) {
      // Call resume inside the pointer gesture; never start voices in its callback.
      this.resuming = this.context
        .resume()
        .catch((error) => {
          this.allNotesOff()
          this.onError(error)
        })
        .finally(() => {
          this.resuming = null
        })
    }
  }

  hold(param) {
    const now = this.context.currentTime
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now)
    else {
      const value = param.value
      param.cancelScheduledValues(now)
      param.setValueAtTime(value, now)
    }
  }

  applyWaveform(oscillator) {
    if (this.waveform !== 'soft-saw') {
      oscillator.type = this.waveform
      return
    }
    if (!this.softSaw) {
      const real = new Float32Array(33)
      const imaginary = new Float32Array(33)
      // Saw harmonics with a gentle exponential rolloff, normalized by Web Audio.
      for (let n = 1; n < imaginary.length; n++) {
        imaginary[n] = ((-1) ** (n + 1) / n) * Math.exp(-(n - 1) / 6)
      }
      this.softSaw = this.context.createPeriodicWave(real, imaginary)
    }
    oscillator.setPeriodicWave(this.softSaw)
  }

  setWaveform(waveform) {
    if (!WAVEFORMS.includes(waveform)) throw new RangeError('Unknown waveform')
    this.waveform = waveform
    for (const { oscillator } of this.slots) this.applyWaveform(oscillator)
  }

  startInterval(ratio, rootFrequency = ROOT_FREQUENCY) {
    if (!Number.isFinite(ratio) || ratio <= 0) throw new RangeError('Invalid ratio')
    if (!Number.isFinite(rootFrequency) || rootFrequency <= 0) throw new RangeError('Invalid root')
    this.rootFrequency = rootFrequency
    this.wake()
    const startAt = this.context.currentTime + 0.008
    this.noteOn('reference', rootFrequency, startAt)
    this.noteOn('interval', rootFrequency * ratio, startAt)
  }

  noteOn(id, frequency, startAt = null) {
    if (!Number.isFinite(frequency) || frequency <= 0) throw new RangeError('Invalid frequency')
    this.wake()
    if (this.active.has(id) && startAt === null) {
      this.setFrequency(id, frequency)
      return
    }
    const now = this.context.currentTime
    if (this.active.has(id)) {
      this.active.get(id).id = null
      this.active.delete(id)
    }
    let slot = this.slots.find((slot) => slot.id === null)
    if (slot && startAt !== null) {
      // Native oscillator phase resets only by creating a new source. Fade the
      // previous source to zero before the shared start time to avoid clicks.
      const previous = slot.oscillator
      this.hold(slot.gain.gain)
      slot.gain.gain.linearRampToValueAtTime(0, startAt)
      previous.stop(startAt)
      this.retired.set(
        previous,
        setTimeout(() => {
          previous.disconnect()
          this.retired.delete(previous)
        }, 50),
      )
      slot.analyser?.disconnect()
      slot.analyser = null
      slot.samples = null
      const oscillator = this.context.createOscillator()
      oscillator.frequency.value = frequency
      oscillator.connect(slot.gain)
      this.applyWaveform(oscillator)
      oscillator.start(startAt)
      slot.oscillator = oscillator
    }
    if (!slot && this.slots.length < MAX_VOICES) {
      const oscillator = this.context.createOscillator()
      const gain = this.context.createGain()
      gain.gain.value = 0
      oscillator.connect(gain)
      gain.connect(this.output)
      this.applyWaveform(oscillator)
      oscillator.frequency.value = frequency
      oscillator.start(startAt ?? now)
      slot = { oscillator, gain, id: null }
      this.slots.push(slot)
      // Headroom for every allocated voice, including release tails.
      this.hold(this.output.gain)
      this.output.gain.linearRampToValueAtTime(0.5 / this.slots.length, now + 0.003)
    }
    if (!slot) {
      const oldest = this.active.keys().next().value
      slot = this.active.get(oldest)
      this.active.delete(oldest)
    }
    slot.id = id
    this.active.set(id, slot)
    this.hold(slot.gain.gain)
    slot.gain.gain.linearRampToValueAtTime(0, startAt ?? now + 0.004)
    slot.oscillator.frequency.cancelScheduledValues(now)
    slot.oscillator.frequency.setValueAtTime(frequency, startAt ?? now + 0.004)
    slot.gain.gain.linearRampToValueAtTime(1, (startAt ?? now + 0.004) + 0.008)
  }

  setFrequency(id, frequency) {
    if (!Number.isFinite(frequency) || frequency <= 0) throw new RangeError('Invalid frequency')
    const slot = this.active.get(id)
    if (!slot) return
    this.hold(slot.oscillator.frequency)
    slot.oscillator.frequency.setTargetAtTime(frequency, this.context.currentTime, 0.004)
  }

  noteOff(id) {
    const slot = this.active.get(id)
    if (!slot) return
    this.hold(slot.gain.gain)
    // A cosine fade has zero slope at both ends, avoiding a sharp envelope
    // corner at an arbitrary waveform phase, especially at the low C1 root.
    const level = slot.gain.gain.value
    const release = Float32Array.from(RELEASE_CURVE, (value) => value * level)
    slot.gain.gain.setValueCurveAtTime(release, this.context.currentTime, RELEASE_SECONDS)
    slot.id = null
    this.active.delete(id)
    if (!this.active.size) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => {
        if (!this.active.size && this.context?.state === 'running') {
          this.suspending = this.context
            .suspend()
            .catch(this.onError)
            .finally(() => {
              this.suspending = null
            })
        }
      }, 250)
    }
  }

  allNotesOff() {
    for (const id of this.active.keys()) this.noteOff(id)
  }

  readScope(xId, yId, ratio = 1, rootFrequency = this.rootFrequency) {
    if (this.context?.state !== 'running') return null
    const x = this.active.get(xId),
      y = this.active.get(yId)
    if (!x || !y) return null
    for (const slot of [x, y]) {
      if (!slot.analyser) {
        slot.analyser = this.context.createAnalyser()
        slot.oscillator.connect(slot.analyser)
      }
      const size = Math.min(
        32768,
        Math.max(
          4096,
          2 ** Math.ceil(Math.log2((this.context.sampleRate / rootFrequency) * 4 + 1)),
        ),
      )
      if (slot.samples?.length !== size) {
        slot.analyser.fftSize = size
        slot.samples = new Float32Array(size)
      }
      slot.analyser.getFloatTimeDomainData(slot.samples)
    }
    Object.assign(this.scope, {
      x: x.samples,
      y: y.samples,
      time: this.context.currentTime,
      sampleRate: this.context.sampleRate,
      phase1: this.yPhase.read(y.samples, rootFrequency, this.context.sampleRate),
      phase2: this.xPhase.read(x.samples, rootFrequency * ratio, this.context.sampleRate),
    })
    return this.scope
  }

  dispose() {
    clearTimeout(this.idleTimer)
    this.active.clear()
    for (const [oscillator, timer] of this.retired) {
      clearTimeout(timer)
      oscillator.stop()
      oscillator.disconnect()
    }
    this.retired.clear()
    for (const { oscillator, gain, analyser } of this.slots) {
      oscillator.stop()
      oscillator.disconnect()
      gain.disconnect()
      analyser?.disconnect()
    }
    this.slots = []
    this.output?.disconnect()
    if (this.context && this.context.state !== 'closed')
      void this.context.close().catch(this.onError)
  }
}
