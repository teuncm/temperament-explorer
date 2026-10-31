<script setup vapor>
import { computed, onBeforeUnmount, onMounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { Synth } from './synth.js'
import { createLissajous } from './lissajous.js'

const progress = ref(2 ** (5 / 12) - 1)
const keyboardOctave = ref(4)
const selectedMidi = ref(48)
const pressedMidi = ref(null)
let keyOwner = null
const rootFrequency = computed(() => 440 * 2 ** ((selectedMidi.value - 69) / 12))
const pitchNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const noteName = (midi) => `${pitchNames[midi % 12]}${Math.floor(midi / 12) - 1}`
const keyboardNotes = computed(() => {
  let white = 0
  return Array.from({ length: 24 }, (_, i) => {
    const midi = keyboardOctave.value * 12 + i
    const black = [1, 3, 6, 8, 10].includes(midi % 12)
    const position = white
    if (!black) white++
    return {
      midi,
      black,
      label: noteName(midi),
      style: { left: `${(position / 14) * 100}%`, width: `${((black ? 0.62 : 1) / 14) * 100}%` },
    }
  })
})
const settings = reactive({
  spacing: 'linear',
  temperament: 'equal',
  snap: true,
  waveform: 'soft-saw',
  equalSteps: 12,
  linearSteps: 12,
  fractionLimit: 4,
})
const audioError = ref('')
const visualError = ref('')
const scopeCanvas = useTemplateRef('scope-canvas')
const dialControl = useTemplateRef('dial-control')
const harmonicsPlot = useTemplateRef('harmonics-plot')
let scope
const synth = new Synth(() => {
  audioError.value = 'Audio unavailable. Try dragging again.'
})
synth.setWaveform(settings.waveform)
const controls = [
  {
    key: 'waveform',
    label: 'Waveform',
    options: [
      ['sine', 'Sine'],
      ['sawtooth', 'Saw'],
      ['soft-saw', 'Soft saw'],
      ['square', 'Square'],
      ['triangle', 'Triangle'],
    ],
  },
  {
    key: 'spacing',
    label: 'Spacing',
    options: [
      ['linear', 'Linear'],
      ['logarithmic', 'Logarithmic'],
    ],
  },
  {
    key: 'temperament',
    label: 'Tuning',
    options: [
      ['equal', 'Equal · 12-TET'],
      ['just', 'Just · 5-limit'],
      ['pythagorean', 'Pythagorean'],
      ['meantone', 'Meantone · ¼'],
      ['fractions', 'Fractions'],
      ['equal-linear', 'Equal linear'],
    ],
  },
  {
    key: 'snap',
    label: 'Snap to notes',
    options: [
      [false, 'Off'],
      [true, 'On'],
    ],
  },
]
// One fixed 5-limit chromatic scale; just intonation admits other ratio choices.
// https://math.ucr.edu/home/baez/tuning_talk/tuning_talk.pdf
const justRatios = [
  1,
  16 / 15,
  9 / 8,
  6 / 5,
  5 / 4,
  4 / 3,
  45 / 32,
  3 / 2,
  8 / 5,
  5 / 3,
  16 / 9,
  15 / 8,
  2,
]
const noteNames = [
  'Unison',
  'Minor second',
  'Major second',
  'Minor third',
  'Major third',
  'Perfect fourth',
  'Tritone',
  'Perfect fifth',
  'Minor sixth',
  'Major sixth',
  'Minor seventh',
  'Major seventh',
  'Octave',
]
// C-centered fifth chains from E-flat to G-sharp, folded into one octave.
const fifthSteps = [0, 7, 2, -3, 4, -1, 6, 1, 8, 3, -2, 5]
const fromFifths = (fifth) => [
  ...fifthSteps.map((step) => {
    const ratio = fifth ** step
    return ratio / 2 ** Math.floor(Math.log2(ratio))
  }),
  2,
]
const gcd = (a, b) => (b ? gcd(b, a % b) : a)
function fractionsThrough(limit) {
  const result = []
  for (let denominator = 1; denominator <= limit; denominator++) {
    for (let numerator = denominator; numerator <= denominator * 2; numerator++) {
      if (gcd(numerator, denominator) === 1 && numerator / denominator !== 2) {
        result.push({ numerator, denominator, ratio: numerator / denominator })
      }
    }
  }
  return result
}
const fractions = computed(() => fractionsThrough(settings.fractionLimit))
const fractionNotes = computed(() =>
  [...fractions.value, { numerator: 2, denominator: 1, ratio: 2 }].sort(
    (a, b) => a.ratio - b.ratio,
  ),
)
const tunings = {
  just: justRatios,
  pythagorean: fromFifths(3 / 2),
  // Narrow each fifth by 1/4 of the syntonic comma: four fifths give a pure 5:4 third.
  meantone: fromFifths(5 ** 0.25),
}
const variableTuning = computed(() =>
  ['equal', 'equal-linear', 'fractions'].includes(settings.temperament),
)
const parameterKey = computed(() =>
  settings.temperament === 'fractions'
    ? 'fractionLimit'
    : settings.temperament === 'equal-linear'
      ? 'linearSteps'
      : 'equalSteps',
)
const stepCount = computed(() => settings[parameterKey.value])
const parameterMax = computed(() => (settings.temperament === 'fractions' ? 32 : 256))
const notes = computed(() => {
  if (settings.temperament === 'fractions') return fractionNotes.value.map((note) => note.ratio)
  if (!variableTuning.value) return tunings[settings.temperament]
  return Array.from({ length: stepCount.value + 1 }, (_, i) =>
    settings.temperament === 'equal-linear' ? 1 + i / stepCount.value : 2 ** (i / stepCount.value),
  )
})
const positionForRatio = (ratio) => (settings.spacing === 'linear' ? ratio - 1 : Math.log2(ratio))
const ratioForPosition = (position) =>
  settings.spacing === 'linear' ? 1 + position : 2 ** position
const notePositions = computed(() => notes.value.map(positionForRatio))
const noteIndex = computed(() =>
  notePositions.value.reduce(
    (nearest, position, i, positions) =>
      Math.abs(position - progress.value) < Math.abs(positions[nearest] - progress.value)
        ? i
        : nearest,
    0,
  ),
)
const frequencyRatio = computed(() =>
  settings.snap ? notes.value[noteIndex.value] : ratioForPosition(progress.value),
)
watch([frequencyRatio, rootFrequency], ([ratio, root]) => {
  synth.setFrequency('reference', root)
  synth.setFrequency('interval', root * ratio)
  scope?.start()
})
const ratio = computed(() => frequencyRatio.value.toFixed(4))
const cents = computed(() => (Math.log2(frequencyRatio.value) * 1200).toFixed(1))
const displayedProgress = computed(() => positionForRatio(frequencyRatio.value))
const interval = computed(() =>
  settings.snap
    ? settings.temperament === 'fractions'
      ? `${fractionNotes.value[noteIndex.value].numerator}/${fractionNotes.value[noteIndex.value].denominator}`
      : settings.temperament === 'equal-linear' ||
          (settings.temperament === 'equal' && stepCount.value !== 12)
        ? noteIndex.value === 0
          ? 'Unison'
          : noteIndex.value === stepCount.value
            ? 'Octave'
            : `Step ${noteIndex.value} of ${stepCount.value}`
        : noteNames[noteIndex.value]
    : progress.value === 0
      ? 'Unison'
      : progress.value === 1
        ? 'Octave'
        : 'Frequency ratio',
)
const rotation = computed(() => ({
  transform: `rotate3d(0, 0, 1, ${displayedProgress.value * 360}deg)`,
}))
const noteDots = computed(() =>
  notePositions.value.slice(0, -1).map((position) => `rotate(${position * 360} 200 200)`),
)
const fractionGuides = computed(() =>
  fractions.value.map((fraction) => ({
    ...fraction,
    rotation: `rotate(${positionForRatio(fraction.ratio) * 360} 200 200)`,
  })),
)
const ratioMarkers = computed(() =>
  fractionNotes.value
    .filter((fraction) => fraction.denominator <= 5)
    .map(({ ratio, numerator, denominator }) => {
      const angle = positionForRatio(ratio) * 2 * Math.PI
      // Stagger the denser fractions inward to keep neighboring labels distinct.
      const radius = denominator <= 4 ? 171 : 171 - Math.ceil((denominator - 4) / 2) * 12
      return {
        ratio,
        label: denominator === 1 ? String(numerator) : `${numerator}/${denominator}`,
        denominator,
        x: 200 + Math.sin(angle) * radius + (ratio === 1 ? 6 : ratio === 2 ? -6 : 0),
        y: 200 - Math.cos(angle) * radius,
        anchor: ratio === 1 ? 'start' : ratio === 2 ? 'end' : 'middle',
      }
    }),
)

let pointerId = null
let dragTarget = null
let bounds
let previousAngle = null
let previousPoint = null
let dragLimit = null
let pending = progress.value
let frame = 0
const clamp = (value) => Math.min(1, Math.max(0, value))

function flush() {
  cancelAnimationFrame(frame)
  frame = 0
  progress.value = pending
}

function setOption(key, value) {
  flush()
  const currentRatio = frequencyRatio.value
  const currentNote = noteIndex.value
  const previousTuning = settings.temperament
  const previousCount = notes.value.length
  settings[key] = value
  if (key === 'waveform') {
    synth.setWaveform(value)
    scope?.start()
  }
  // Preserve scale degrees only between conventional 12-note tunings.
  const keepDegree =
    key === 'temperament' &&
    settings.snap &&
    previousTuning !== 'fractions' &&
    value !== 'fractions' &&
    previousTuning !== 'equal-linear' &&
    value !== 'equal-linear' &&
    previousCount === 13 &&
    notes.value.length === 13
  pending = positionForRatio(keepDegree ? notes.value[currentNote] : currentRatio)
  progress.value = pending
}

function setSteps(value) {
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1 || count > parameterMax.value) return
  flush()
  const currentRatio = frequencyRatio.value
  settings[parameterKey.value] = count
  pending = positionForRatio(currentRatio)
  progress.value = pending
}

function pointAt(event) {
  return {
    x: event.clientX - bounds.left - bounds.width / 2,
    y: event.clientY - bounds.top - bounds.height / 2,
  }
}

function angleAt({ x, y }) {
  // Only the center itself has no defined angle.
  if (Math.hypot(x, y) < 1) return null
  return ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360
}

function startDrag(event) {
  if (pointerId !== null || event.button !== 0) return
  bounds = event.currentTarget.getBoundingClientRect()
  pointerId = event.pointerId
  dragTarget = event.currentTarget
  pending = displayedProgress.value
  previousPoint = pointAt(event)
  previousAngle = angleAt(previousPoint)
  dragLimit = null
  if (previousAngle !== null) {
    // Grabbing the handle near the shared top must preserve its endpoint.
    if ((pending === 1 && previousAngle < 12) || (previousAngle === 0 && pending > 0.5)) {
      dragLimit = 1
    } else if (pending === 0 && previousAngle > 348) {
      dragLimit = 0
    }
    pending = dragLimit ?? previousAngle / 360
    progress.value = pending
  }
  event.currentTarget.focus({ preventScroll: true })
  event.currentTarget.setPointerCapture(pointerId)
  playInterval()
}

function playInterval() {
  audioError.value = ''
  try {
    synth.startInterval(frequencyRatio.value, rootFrequency.value)
    scope?.start()
  } catch {
    synth.allNotesOff()
    audioError.value = 'Audio unavailable. Try dragging again.'
  }
}

function moveDrag(event) {
  if (event.pointerId !== pointerId) return
  const point = pointAt(event)
  const angle = angleAt(point)
  const crossesCenter =
    previousPoint &&
    previousPoint.x * point.x + previousPoint.y * point.y < 0 &&
    Math.abs(previousPoint.x * point.y - previousPoint.y * point.x) /
      Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y) <
      bounds.width * 0.12
  previousPoint = point
  if (angle === null) {
    previousAngle = null
    return
  }
  if (previousAngle === null || crossesCenter) {
    dragLimit = null
  } else {
    // Only crossing the top seam changes the endpoint lock. Reversing through
    // that seam unlocks it; ordinary movements always use the absolute angle.
    const delta = angle - previousAngle
    if (delta < -180) dragLimit = dragLimit === 0 ? null : 1
    else if (delta > 180) dragLimit = dragLimit === 1 ? null : 0
  }
  pending = dragLimit ?? angle / 360
  if (!frame) frame = requestAnimationFrame(flush)
  previousAngle = angle
}

function endDrag(event) {
  if (event.pointerId !== pointerId) return
  if (event.type === 'pointerup') moveDrag(event)
  stopDrag()
}

function stopDrag() {
  flush()
  const releasedId = pointerId
  pointerId = null
  previousAngle = null
  previousPoint = null
  dragLimit = null
  if (dragTarget?.hasPointerCapture(releasedId)) {
    dragTarget.releasePointerCapture(releasedId)
  }
  dragTarget = null
  if (pressedMidi.value === null) synth.allNotesOff()
}

function pressKey(event, midi) {
  if (event.type === 'pointerdown' && event.button !== 0) return
  event.preventDefault()
  if (keyOwner || event.repeat) return
  keyOwner = {
    type: event.type === 'pointerdown' ? 'pointer' : 'keyboard',
    id: event.pointerId ?? event.code,
    target: event.currentTarget,
  }
  selectedMidi.value = midi
  pressedMidi.value = midi
  event.currentTarget.focus({ preventScroll: true })
  if (keyOwner.type === 'pointer') event.currentTarget.setPointerCapture(event.pointerId)
  playInterval()
}

function releaseKey(event) {
  if (!keyOwner) return
  if (event && keyOwner.id !== (event.pointerId ?? event.code)) return
  const owner = keyOwner
  keyOwner = null
  pressedMidi.value = null
  if (owner.type === 'pointer' && owner.target.hasPointerCapture(owner.id))
    owner.target.releasePointerCapture(owner.id)
  if (pointerId === null) synth.allNotesOff()
}

function slideKey(event) {
  if (keyOwner?.type !== 'pointer' || event.pointerId !== keyOwner.id) return
  const key = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-midi]')
  if (!key) return
  const midi = Number(key.dataset.midi)
  if (midi === pressedMidi.value) return
  selectedMidi.value = midi
  pressedMidi.value = midi
  playInterval()
}

function changeOctave(delta) {
  const next = Math.max(0, Math.min(5, keyboardOctave.value + delta))
  releaseKey()
  selectedMidi.value += (next - keyboardOctave.value) * 12
  keyboardOctave.value = next
}

function stopAll() {
  releaseKey()
  stopDrag()
}

function onKeydown(event) {
  const step = (event.shiftKey ? 10 : 1) / 1200
  const changes = {
    ArrowRight: step,
    ArrowUp: step,
    ArrowLeft: -step,
    ArrowDown: -step,
    PageUp: 1 / 12,
    PageDown: -1 / 12,
  }
  if (event.key !== 'Home' && event.key !== 'End' && !(event.key in changes)) return
  event.preventDefault()
  flush()
  if (event.key === 'Home' || event.key === 'End') {
    pending = event.key === 'Home' ? 0 : 1
  } else if (settings.snap) {
    const index = Math.max(
      0,
      Math.min(notes.value.length - 1, noteIndex.value + Math.sign(changes[event.key])),
    )
    pending = notePositions.value[index]
  } else {
    pending = positionForRatio(2 ** clamp(Math.log2(frequencyRatio.value) + changes[event.key]))
  }
  progress.value = pending
}

function onVisibilityChange() {
  if (document.hidden) stopAll()
}

onMounted(() => {
  scope = createLissajous(
    scopeCanvas.value,
    () => synth.readScope('interval', 'reference', frequencyRatio.value, rootFrequency.value),
    () => pointerId !== null || pressedMidi.value !== null,
    (message) => {
      visualError.value = message || 'GPU visualization unavailable.'
    },
    {
      circle: dialControl.value,
      harmonics: harmonicsPlot.value,
      ratio: () => frequencyRatio.value,
      rootFrequency: () => rootFrequency.value,
      sampleRate: () => synth.context?.sampleRate || 48000,
      waveform: () => settings.waveform,
    },
  )
  window.addEventListener('blur', stopAll)
  document.addEventListener('visibilitychange', onVisibilityChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', stopAll)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  stopAll()
  scope?.dispose()
  synth.dispose()
})
</script>

<template>
  <div class="mx-auto flex min-h-svh max-w-6xl flex-col px-1 sm:px-8">
    <canvas
      ref="scope-canvas"
      class="pointer-events-none fixed inset-0 z-30 h-dvh w-screen"
      aria-hidden="true"
    ></canvas>
    <header class="px-1 py-2 sm:px-0 sm:py-4">
      <h1 class="text-sm font-semibold tracking-tight"><a href="./">Temperament</a></h1>
    </header>

    <main class="flex flex-1 flex-col items-center pb-[calc(5rem+env(safe-area-inset-bottom))]">
      <section class="relative w-full max-w-[38rem] text-center" aria-label="Interval exploration">
        <div
          ref="dial-control"
          class="dial relative aspect-square w-full rounded-full outline-none"
          role="slider"
          tabindex="0"
          aria-label="Interval in cents"
          aria-orientation="horizontal"
          aria-valuemin="0"
          aria-valuemax="1200"
          :aria-valuenow="Number(cents)"
          :aria-valuetext="`${interval}, ${ratio} times the reference, ${cents} cents`"
          aria-describedby="dial-help"
          @pointerdown="startDrag"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
          @lostpointercapture="endDrag"
          @keydown="onKeydown"
        >
          <svg
            class="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 400 400"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="200" cy="200" r="192" stroke="#35543f" stroke-width="1.25" />
            <circle
              v-for="(position, i) in noteDots"
              :key="i"
              class="snap-point"
              cx="200"
              cy="8"
              r="2.4"
              :transform="position"
              fill="#8aff66"
              fill-opacity="0.4"
            />
            <line
              v-for="marker in fractionGuides"
              :key="marker.ratio"
              class="ratio-guide"
              x1="200"
              y1="8"
              x2="200"
              :y2="
                8 +
                (192 * (settings.fractionLimit + 1 - marker.denominator)) / settings.fractionLimit
              "
              :transform="marker.rotation"
              stroke="#8aff66"
              stroke-width="0.65"
              stroke-opacity="0.23"
            />
            <line
              v-for="marker in fractionGuides"
              :key="marker.ratio"
              class="ratio-tick"
              x1="200"
              y1="13"
              x2="200"
              y2="3"
              :transform="marker.rotation"
              stroke="#8aff66"
              stroke-width="0.65"
              stroke-opacity="0.4"
            />
            <text
              v-for="marker in ratioMarkers"
              :key="marker.ratio"
              class="ratio-marker"
              :x="marker.x"
              :y="marker.y"
              :text-anchor="marker.anchor"
              dominant-baseline="middle"
              :font-size="marker.denominator > 4 ? 9 : 10"
              font-weight="500"
              fill="#8aff66"
              fill-opacity="0.65"
            >
              {{ marker.label }}×
            </text>
          </svg>
          <div class="dial-rotor pointer-events-none absolute" :style="rotation" aria-hidden="true">
            <span class="dial-dot absolute left-1/2 top-0 rounded-full bg-green-400"></span>
          </div>
        </div>
        <p id="dial-help" class="sr-only">Drag the dot clockwise to increase the ratio.</p>
      </section>

      <section class="mt-1 w-full max-w-lg" aria-label="Root note keyboard">
        <div class="mb-1 flex items-center justify-between px-1 text-xs">
          <span class="text-stone-400"
            >Root
            <strong class="ml-1 font-medium text-green-300">{{
              noteName(selectedMidi)
            }}</strong></span
          >
          <div class="flex items-center gap-2">
            <button
              aria-label="Octave down"
              class="min-h-10 w-10 rounded-md border border-white/10 text-green-300 disabled:opacity-30"
              :disabled="keyboardOctave === 0"
              @click="changeOctave(-1)"
            >
              −
            </button>
            <span class="min-w-16 text-center text-stone-400" aria-live="polite"
              >{{ noteName(keyboardOctave * 12) }}–{{ noteName(keyboardOctave * 12 + 23) }}</span
            >
            <button
              aria-label="Octave up"
              class="min-h-10 w-10 rounded-md border border-white/10 text-green-300 disabled:opacity-30"
              :disabled="keyboardOctave === 5"
              @click="changeOctave(1)"
            >
              +
            </button>
          </div>
        </div>
        <div class="piano" role="group" aria-label="Piano keys">
          <button
            v-for="key in keyboardNotes"
            :key="key.midi"
            class="piano-key"
            :class="{
              'piano-black': key.black,
              'piano-selected': selectedMidi === key.midi,
              'piano-pressed': pressedMidi === key.midi,
            }"
            :style="key.style"
            :data-midi="key.midi"
            :aria-label="key.label"
            :aria-pressed="pressedMidi === key.midi"
            :aria-current="selectedMidi === key.midi ? 'true' : undefined"
            @pointerdown="pressKey($event, key.midi)"
            @pointermove="slideKey"
            @pointerup="releaseKey"
            @pointercancel="releaseKey"
            @lostpointercapture="releaseKey"
            @keydown="($event.key === ' ' || $event.key === 'Enter') && pressKey($event, key.midi)"
            @keyup="($event.key === ' ' || $event.key === 'Enter') && releaseKey($event)"
            @blur="keyOwner?.type === 'keyboard' && releaseKey()"
          >
            <span v-if="!key.black">{{
              key.midi % 12 === 0 ? key.label : pitchNames[key.midi % 12]
            }}</span>
          </button>
        </div>
      </section>

      <div class="mt-2 w-full max-w-sm space-y-1.5" aria-label="Dial settings">
        <div
          v-for="control in controls"
          :key="control.key"
          class="grid grid-cols-[auto_1fr] items-center gap-2"
        >
          <span :id="`${control.key}-label`" class="shrink-0 text-xs text-stone-300">{{
            control.label
          }}</span>
          <div
            class="min-w-0 justify-self-end rounded-md border border-white/10 p-0.5"
            :class="control.key === 'temperament' ? 'grid grid-cols-2' : 'flex'"
            role="group"
            :aria-labelledby="`${control.key}-label`"
          >
            <button
              v-for="[value, label] in control.options"
              :key="String(value)"
              class="min-h-10 whitespace-nowrap rounded-md font-medium focus-visible:outline-2 focus-visible:outline-green-400"
              :class="[
                control.key === 'waveform' ? 'px-1 text-[11px] sm:px-2 sm:text-xs' : 'px-3 text-xs',
                settings[control.key] === value
                  ? 'bg-green-400/15 text-green-300'
                  : 'text-stone-400 hover:text-green-300',
              ]"
              :aria-pressed="settings[control.key] === value"
              @click="setOption(control.key, value)"
            >
              {{
                control.key === 'temperament' && value === 'equal'
                  ? `Equal · ${settings.equalSteps}-TET`
                  : control.key === 'temperament' && value === 'equal-linear'
                    ? `Equal linear (${settings.linearSteps})`
                    : control.key === 'temperament' && value === 'fractions'
                      ? `Fractions (${settings.fractionLimit})`
                      : label
              }}
            </button>
          </div>
          <div
            v-if="control.key === 'temperament' && variableTuning"
            class="col-span-2 flex items-center justify-end gap-2 text-xs"
          >
            <label for="tuning-steps" class="text-stone-400">{{
              settings.temperament === 'fractions' ? 'Max denominator' : 'Steps per octave'
            }}</label>
            <div class="flex rounded-md border border-white/10">
              <button
                class="min-h-10 w-10 text-green-300 disabled:opacity-30"
                :aria-label="
                  settings.temperament === 'fractions' ? 'Decrease denominator' : 'Decrease steps'
                "
                :disabled="stepCount <= 1"
                @click="setSteps(stepCount - 1)"
              >
                −
              </button>
              <input
                id="tuning-steps"
                type="number"
                min="1"
                :max="parameterMax"
                step="1"
                inputmode="numeric"
                class="min-h-10 w-14 bg-transparent text-center text-green-300 focus-visible:outline-2 focus-visible:outline-green-400"
                :value="stepCount"
                @input="setSteps($event.target.value)"
                @change="$event.target.value = stepCount"
              />
              <button
                class="min-h-10 w-10 text-green-300 disabled:opacity-30"
                :aria-label="
                  settings.temperament === 'fractions' ? 'Increase denominator' : 'Increase steps'
                "
                :disabled="stepCount >= parameterMax"
                @click="setSteps(stepCount + 1)"
              >
                +
              </button>
            </div>
          </div>
        </div>
      </div>
      <p v-if="audioError" role="status" class="mt-3 text-xs text-green-400">{{ audioError }}</p>
      <p v-if="visualError" role="status" class="mt-3 text-xs text-green-400">{{ visualError }}</p>
    </main>
    <div
      class="harmonics-dock pointer-events-none fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-[#080d0a]/95 backdrop-blur-sm"
    >
      <div
        ref="harmonics-plot"
        class="absolute left-9 right-2 top-0.5 h-14"
        role="img"
        :aria-label="`Harmonic alignment: oscillator 1 above, oscillator 2 below, ${settings.waveform} harmonics up to 32 times the reference frequency on a shared logarithmic scale. Frequency ratio ${ratio}.`"
      ></div>
      <div
        aria-hidden="true"
        class="absolute left-1 top-0.5 flex h-14 flex-col justify-around text-[9px] text-green-400/60"
      >
        <span>Osc 1</span><span>Osc 2</span>
      </div>
      <div
        aria-hidden="true"
        class="absolute left-9 right-2 bottom-[calc(2px+env(safe-area-inset-bottom,0px))] h-3 text-[9px] text-green-400/50"
      >
        <div class="absolute inset-y-0 inset-x-[3px]">
          <span
            v-for="(multiple, i) in [1, 2, 4, 8, 16, 32]"
            :key="multiple"
            class="absolute -translate-x-1/2"
            :style="{ left: `${i * 20}%` }"
            >{{ multiple }}×</span
          >
        </div>
      </div>
    </div>
  </div>
</template>
