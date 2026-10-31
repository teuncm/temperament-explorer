const SCREEN_VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FADE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D image;
uniform float decay;
in vec2 uv;
out vec4 color;
void main() {
  // The small subtraction prevents RGBA8 rounding from retaining faint pixels forever.
  color = max(texture(image, uv) * decay - vec4(1.0 / 255.0), vec4(0.0));
}`

const COPY_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D image;
in vec2 uv;
out vec4 color;
void main() { color = texture(image, uv); }
`

const TRACE_VERTEX = `#version 300 es
precision highp float;
uniform sampler2D xSamples;
uniform sampler2D ySamples;
uniform vec2 resolution;
uniform int offset;
uniform int lastSample;
uniform float thickness;
uniform float pointSize;
uniform bool head;
out float side;
vec2 sampleAt(int index) {
  // x = voice 2; y = voice 1. Positive y points up in clip space.
  ivec2 address = ivec2(index % 2048, index / 2048);
  return clamp(vec2(texelFetch(xSamples, address, 0).r,
                    texelFetch(ySamples, address, 0).r), -1.0, 1.0) * 0.68;
}
void main() {
  if (head) {
    side = 0.0;
    gl_Position = vec4(sampleAt(lastSample), 0.0, 1.0);
    gl_PointSize = pointSize;
    return;
  }
  const vec2 corners[6] = vec2[6](vec2(0,-1), vec2(1,-1), vec2(0,1),
                                vec2(0,1), vec2(1,-1), vec2(1,1));
  vec2 corner = corners[gl_VertexID];
  int index = offset + gl_InstanceID;
  vec2 a = sampleAt(index), b = sampleAt(index + 1);
  vec2 direction = (b - a) * resolution * 0.5;
  vec2 normal = vec2(-direction.y, direction.x) / max(length(direction), 0.001);
  vec2 position = mix(a, b, corner.x) + normal * corner.y * thickness * 2.0 / resolution;
  side = corner.y;
  gl_Position = vec4(position, 0.0, 1.0);
}`

const TRACE_FRAGMENT = `#version 300 es
precision highp float;
uniform bool head;
uniform float brightness;
in float side;
out vec4 color;
void main() {
  vec3 neon = vec3(0.54, 1.0, 0.40);
  if (head) {
    float r = length(gl_PointCoord * 2.0 - 1.0);
    if (r > 1.0) discard;
    float core = 1.0 - smoothstep(0.10, 0.28, r);
    float alpha = core + (1.0 - core) * exp(-r * r * 5.0) * 0.22;
    color = vec4(mix(neon, vec3(0.88, 1.0, 0.78), core) * alpha, alpha);
  } else {
    float alpha = min(1.0, (exp(-side * side * 24.0) * 0.38 + exp(-side * side * 3.5) * 0.045) * brightness);
    color = vec4(neon * alpha, alpha);
  }
}`

const HARMONICS_VERTEX = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform float ratio;
uniform float rootFrequency;
uniform float nyquist;
uniform float thickness;
uniform int waveform;
uniform vec2 phases;
uniform float beating;
uniform float frameDuration;
out float side;
out float strength;
float amplitudeAt(float harmonic, float base) {
  bool even = mod(harmonic, 2.0) == 0.0;
  if (harmonic < 1.0 || harmonic > 32.0 || harmonic * base >= nyquist || (waveform == 0 && harmonic > 1.0) ||
      ((waveform == 3 || waveform == 4) && even)) return 0.0;
  float amplitude = waveform == 0 ? 1.0 : 1.0 / harmonic;
  if (waveform == 2) amplitude *= exp(-(harmonic - 1.0) / 6.0);
  if (waveform == 4) amplitude /= harmonic;
  return amplitude;
}
float harmonicPhase(float harmonic) {
  if ((waveform == 1 || waveform == 2) && mod(harmonic, 2.0) == 0.0) return 3.14159265;
  if (waveform == 4 && mod(harmonic, 4.0) == 3.0) return 3.14159265;
  return 0.0;
}
float xAt(float frequency) {
  float padding = thickness * 2.0;
  return padding + log2(frequency) / 5.0 * (resolution.x - padding * 2.0);
}
void main() {
  const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(-1,1),
                                vec2(-1,1), vec2(1,-1), vec2(1,1));
  vec2 corner = corners[gl_VertexID];
  side = corner.x;
  strength = 0.0;
  int row = gl_InstanceID / 32;
  float harmonic = float(gl_InstanceID % 32 + 1);
  side = corner.x;
  strength = 0.0;
  float amplitude = amplitudeAt(harmonic, rootFrequency * (row == 0 ? 1.0 : ratio));
  float frequency = harmonic * (row == 0 ? 1.0 : ratio);
  if (amplitude == 0.0 || frequency > 32.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  // Relative harmonic levels on a 60 dB brightness range, matching the synth.
  strength = pow(clamp(1.0 + log(amplitude) / log(10.0) / 3.0, 0.0, 1.0), 0.7);
  float n = row == 0 ? harmonic : floor(harmonic * ratio + 0.5);
  float m = row == 0 ? floor(harmonic / ratio + 0.5) : harmonic;
  if (amplitudeAt(n, rootFrequency) > 0.0 && amplitudeAt(m, rootFrequency * ratio) > 0.0 && abs(n - m * ratio) > 0.000001) {
    float difference = abs(n - m * ratio) * rootFrequency;
    // Nearby upper partials can beat even when their gap exceeds 12 Hz.
    float proximity = 1.0 - smoothstep(0.03, 0.06, abs(n - m * ratio) / max(n, m * ratio));
    // Fade motion before the display's Nyquist limit to avoid false slow flicker.
    proximity *= 1.0 - smoothstep(0.25, 0.5, difference * max(frameDuration, 1.0 / 60.0));
    float phase = n * phases.x - m * phases.y + harmonicPhase(n) - harmonicPhase(m);
    float pulse = 0.5 + 0.5 * cos(phase);
    strength *= 1.0 - beating * proximity * 0.8 * (1.0 - pulse);
  }
  // Both rows share a fixed logarithmic axis from 1x to 32x the reference.
  float x = xAt(frequency);
  float y = (row == 0 ? 0.75 : 0.25) * resolution.y;
  vec2 pixel = vec2(x + corner.x * thickness, y + corner.y * resolution.y * 0.22);
  side = corner.x;
  gl_Position = vec4(pixel / resolution * 2.0 - 1.0, 0.0, 1.0);
}`

const HARMONICS_FRAGMENT = `#version 300 es
precision highp float;
in float side;
in float strength;
out vec4 color;
void main() {
  float alpha = (1.0 - smoothstep(0.35, 1.0, abs(side))) * strength;
  color = vec4(vec3(0.54, 1.0, 0.40) * alpha, alpha);
}`

// Only audio samples cross the CPU/GPU boundary. Geometry, glow and persistence
// stay in shaders; two framebuffer textures retain the fading trace.
export function createLissajous(canvas, readSamples, isActive, onError = () => {}, layout) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  })
  if (!gl) {
    onError()
    return { start() {}, dispose() {} }
  }
  let programs = [],
    textures = [],
    framebuffers = []
  let fade, copy, trace, harmonics, targets, xTexture, yTexture
  let circleViewport, harmonicsViewport, circleClipBottom
  let layoutDirty = true
  let frame = 0,
    lastFrame = 0,
    lastSignal = -Infinity,
    lastAudioTime = null
  let front = 0,
    size = 0,
    pixelRatio = 1,
    maxPointSize = 1,
    ready = false,
    disposed = false

  function program(vertexSource, fragmentSource, uniforms) {
    const result = gl.createProgram()
    programs.push(result)
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ]) {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader)
        throw new Error(message)
      }
      gl.attachShader(result, shader)
      gl.deleteShader(shader)
    }
    gl.linkProgram(result)
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(result))
    return {
      program: result,
      ...Object.fromEntries(uniforms.map((name) => [name, gl.getUniformLocation(result, name)])),
    }
  }

  function texture() {
    const result = gl.createTexture()
    textures.push(result)
    gl.bindTexture(gl.TEXTURE_2D, result)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return result
  }

  function release() {
    for (const item of programs) gl.deleteProgram(item)
    for (const item of textures) gl.deleteTexture(item)
    for (const item of framebuffers) gl.deleteFramebuffer(item)
    programs = []
    textures = []
    framebuffers = []
    ready = false
  }

  function resize(width, height) {
    pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2, 2048 / Math.max(width, height, 1))
    const canvasBounds = canvas.getBoundingClientRect()
    const circle = layout.circle.getBoundingClientRect()
    const plot = layout.harmonics.getBoundingClientRect()
    const nextSize = Math.max(1, Math.round(circle.width * 0.96 * pixelRatio))
    const fullWidth = Math.max(1, Math.round(width * pixelRatio))
    const fullHeight = Math.max(1, Math.round(height * pixelRatio))
    circleViewport = [
      Math.round((circle.left - canvasBounds.left + circle.width * 0.02) * pixelRatio),
      Math.round((canvasBounds.bottom - circle.bottom + circle.width * 0.02) * pixelRatio),
      nextSize,
      nextSize,
    ]
    harmonicsViewport = [
      Math.round((plot.left - canvasBounds.left) * pixelRatio),
      Math.round((canvasBounds.bottom - plot.bottom) * pixelRatio),
      Math.max(1, Math.round(plot.width * pixelRatio)),
      Math.max(1, Math.round(plot.height * pixelRatio)),
    ]
    circleClipBottom = Math.max(0, Math.round((canvasBounds.bottom - plot.top + 2) * pixelRatio))
    if ((nextSize === size && canvas.width === fullWidth && canvas.height === fullHeight) || !ready)
      return
    size = nextSize
    canvas.width = fullWidth
    canvas.height = fullHeight
    gl.viewport(0, 0, size, size)
    for (const target of targets) {
      gl.bindTexture(gl.TEXTURE_2D, target.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        target.texture,
        0,
      )
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Incomplete trace framebuffer')
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  function initialize() {
    fade = program(SCREEN_VERTEX, FADE_FRAGMENT, ['image', 'decay'])
    copy = program(SCREEN_VERTEX, COPY_FRAGMENT, ['image'])
    trace = program(TRACE_VERTEX, TRACE_FRAGMENT, [
      'xSamples',
      'ySamples',
      'resolution',
      'offset',
      'lastSample',
      'thickness',
      'pointSize',
      'head',
      'brightness',
    ])
    harmonics = program(HARMONICS_VERTEX, HARMONICS_FRAGMENT, [
      'resolution',
      'ratio',
      'rootFrequency',
      'nyquist',
      'thickness',
      'waveform',
      'phases',
      'beating',
      'frameDuration',
    ])
    xTexture = texture()
    yTexture = texture()
    for (const item of [xTexture, yTexture]) {
      gl.bindTexture(gl.TEXTURE_2D, item)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 2048, 16, 0, gl.RED, gl.FLOAT, null)
    }
    targets = [0, 1].map(() => {
      const framebuffer = gl.createFramebuffer()
      framebuffers.push(framebuffer)
      return { texture: texture(), framebuffer }
    })
    gl.clearColor(0, 0, 0, 0)
    gl.disable(gl.DEPTH_TEST)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]
    ready = true
    size = 0
    front = 0
    lastAudioTime = null
    const bounds = canvas.getBoundingClientRect()
    resize(bounds.width, bounds.height)
  }

  function screenPass(pass, image) {
    gl.useProgram(pass.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, image)
    gl.uniform1i(pass.image, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function drawHarmonics(samples, delta = 1 / 60) {
    gl.viewport(...harmonicsViewport)
    gl.useProgram(harmonics.program)
    gl.uniform2f(harmonics.resolution, harmonicsViewport[2], harmonicsViewport[3])
    gl.uniform1f(harmonics.ratio, layout.ratio())
    gl.uniform1f(harmonics.rootFrequency, layout.rootFrequency())
    gl.uniform1f(harmonics.nyquist, (samples?.sampleRate || layout.sampleRate()) / 2)
    gl.uniform1f(harmonics.thickness, 1.5 * pixelRatio)
    gl.uniform2f(harmonics.phases, samples?.phase1 || 0, samples?.phase2 || 0)
    gl.uniform1f(harmonics.beating, samples ? 1 : 0)
    gl.uniform1f(harmonics.frameDuration, Math.max(1 / 240, delta))
    gl.uniform1i(
      harmonics.waveform,
      ['sine', 'sawtooth', 'soft-saw', 'square', 'triangle'].indexOf(layout.waveform()),
    )
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 64)
  }

  function draw(now) {
    frame = 0
    if (!ready || disposed || document.hidden) return
    try {
      if (layoutDirty) {
        const bounds = canvas.getBoundingClientRect()
        resize(bounds.width, bounds.height)
        layoutDirty = false
      }
      const delta = Math.max(0, Math.min((now - lastFrame) / 1000, 0.1))
      lastFrame = now
      const samples = readSamples()
      const destination = 1 - front
      gl.disable(gl.BLEND)
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[destination].framebuffer)
      gl.viewport(0, 0, size, size)
      gl.useProgram(fade.program)
      gl.uniform1f(fade.decay, Math.exp(-delta / 0.7))
      screenPass(fade, targets[front].texture)

      if (samples) {
        lastSignal = now
        const count =
          lastAudioTime === null
            ? Math.min(samples.x.length, Math.ceil(samples.sampleRate / 30) + 1)
            : Math.min(
                samples.x.length,
                Math.max(1, Math.ceil((samples.time - lastAudioTime) * samples.sampleRate) + 1),
              )
        lastAudioTime = samples.time
        gl.useProgram(trace.program)
        for (const [unit, image, data, uniform] of [
          [0, xTexture, samples.x, trace.xSamples],
          [1, yTexture, samples.y, trace.ySamples],
        ]) {
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, image)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, data.length / 2048, gl.RED, gl.FLOAT, data)
          gl.uniform1i(uniform, unit)
        }
        gl.uniform2f(trace.resolution, size, size)
        gl.uniform1f(trace.thickness, 3.5 * pixelRatio)
        gl.uniform1f(trace.pointSize, Math.min(24 * pixelRatio, maxPointSize))
        gl.uniform1i(trace.offset, samples.x.length - count)
        gl.uniform1i(trace.lastSample, samples.x.length - 1)
        gl.uniform1i(trace.head, 0)
        gl.uniform1f(trace.brightness, 1)
        gl.enable(gl.BLEND)
        if (count > 1) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count - 1)
      } else lastAudioTime = null

      gl.disable(gl.BLEND)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.viewport(...circleViewport)
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(0, circleClipBottom, canvas.width, Math.max(0, canvas.height - circleClipBottom))
      screenPass(copy, targets[destination].texture)
      if (samples) {
        gl.useProgram(trace.program)
        // The presentation pass changes texture unit zero; restore its sample input.
        gl.bindTexture(gl.TEXTURE_2D, xTexture)
        gl.uniform1i(trace.head, 1)
        gl.enable(gl.BLEND)
        gl.drawArrays(gl.POINTS, 0, 1)
      }
      gl.disable(gl.SCISSOR_TEST)
      gl.enable(gl.BLEND)
      drawHarmonics(samples, delta)
      front = destination
      if (isActive() || now - lastSignal < 2500) frame = requestAnimationFrame(draw)
      else {
        for (const target of targets) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
          gl.clear(gl.COLOR_BUFFER_BIT)
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.clear(gl.COLOR_BUFFER_BIT)
        drawHarmonics()
      }
    } catch {
      release()
      onError()
    }
  }

  function start() {
    if (!ready || disposed || frame || document.hidden) return
    lastFrame = performance.now()
    frame = requestAnimationFrame(draw)
  }
  function onLost(event) {
    event.preventDefault()
    cancelAnimationFrame(frame)
    frame = 0
    ready = false
    // Context loss already invalidates these objects; deleting their stale
    // handles after restoration would itself generate WebGL errors.
    programs = []
    textures = []
    framebuffers = []
  }
  function onRestored() {
    try {
      release()
      initialize()
      start()
    } catch {
      release()
      onError()
    }
  }
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      frame = 0
    } else start()
  }
  function onScroll() {
    layoutDirty = true
    start()
  }

  try {
    initialize()
  } catch {
    release()
    onError()
    return { start() {}, dispose() {} }
  }
  const observer = new ResizeObserver(([entry]) => {
    try {
      resize(entry.contentRect.width, entry.contentRect.height)
      start()
    } catch {
      release()
      onError()
    }
  })
  observer.observe(canvas)
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  return {
    start,
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('scroll', onScroll, true)
      release()
    },
  }
}
