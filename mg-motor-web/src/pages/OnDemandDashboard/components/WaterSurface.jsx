import { useEffect, useRef } from "react";

/**
 * WaterSurface
 * -------------------------------------------------------------
 * Pure visual overlay. Renders a single fixed <canvas> behind the
 * app's content and simulates a dark water surface that ripples
 * where the cursor / a touch point moves across it.
 *
 * Physics: classic two-tap heightfield wave equation ("ripple tank"),
 * run on the GPU via a ping-ponged WebGL2 texture pair. Disturbance
 * is injected as soft additive "splats" wherever the pointer moves;
 * everything else (propagation, damping, decay back to calm) happens
 * automatically in the update shader.
 *
 * Rendering: the height field is turned into a normal map (finite
 * differences), which refracts a very dark procedural background and
 * adds a faint specular highlight in the app's existing accent color.
 * Output alpha is close to zero on calm water, so on an idle page the
 * canvas is nearly invisible - it only reveals itself where the
 * surface is actually disturbed.
 *
 * Nothing here touches app state, layout, or interactive elements:
 * `pointer-events: none` on the canvas, and it never reads from or
 * writes to the DOM outside of itself.
 *
 * Usage: render once, near the root of the page shell, e.g.
 *   <div className="odd-root">
 *     <WaterSurface />
 *     ...rest of the existing UI...
 *   </div>
 */

// ---- shaders --------------------------------------------------

const VERT = `#version 300 es
  layout(location = 0) in vec2 aPos;
  out vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

// Propagates the heightfield one step. Packs (current, previous)
// height into the R and G channels of a single texture so only one
// ping-ponged pair is needed instead of three separate buffers.
const UPDATE_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uState; // R = height(t), G = height(t-1)
  uniform vec2 uTexel;
  uniform float uDamping;

  float h(vec2 uv) { return texture(uState, uv).r; }

  void main() {
    float left  = h(vUv - vec2(uTexel.x, 0.0));
    float right = h(vUv + vec2(uTexel.x, 0.0));
    float up    = h(vUv + vec2(0.0, uTexel.y));
    float down  = h(vUv - vec2(0.0, uTexel.y));

    float current  = texture(uState, vUv).r;
    float previous = texture(uState, vUv).g;

    float next = ((left + right + up + down) * 0.5 - previous) * uDamping;

    // Encode: new R = next height, new G = the height that was current.
    fragColor = vec4(next, current, 0.0, 1.0);
  }
`;

// Additive circular "splat" - disturbs the surface at the pointer.
const SPLAT_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform vec2 uPoint;    // 0-1 space
  uniform float uRadius;  // 0-1 space
  uniform float uStrength;
  uniform float uAspect;

  void main() {
    vec2 d = vUv - uPoint;
    d.x *= uAspect;
    float dist = length(d);
    float falloff = smoothstep(uRadius, 0.0, dist);
    // Raised-cosine bump reads as a soft push into the surface,
    // not a hard glowing disc.
    float bump = falloff * falloff * (0.5 - 0.5 * cos(falloff * 3.14159265));
    float delta = bump * uStrength;
    fragColor = vec4(delta, 0.0, 0.0, 0.0);
  }
`;

// Turns the heightfield into a subtle lit/refracted surface.
const RENDER_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform vec3 uAccent;

  float h(vec2 uv) { return texture(uState, uv).r; }

  // Cheap value noise for a faint film-grain / liquid shimmer.
  float noise(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    // Surface normal from the heightfield via central differences.
    float hl = h(vUv - vec2(uTexel.x, 0.0));
    float hr = h(vUv + vec2(uTexel.x, 0.0));
    float hd = h(vUv - vec2(0.0, uTexel.y));
    float hu = h(vUv + vec2(0.0, uTexel.y));
    vec3 normal = normalize(vec3((hl - hr) * 6.0, (hd - hu) * 6.0, 1.0));

    float height = h(vUv);

    // Very slow ambient drift so the surface never feels perfectly
    // static, independent of pointer interaction.
    vec2 driftUv = vUv * vec2(uResolution.x / uResolution.y, 1.0);
    float drift = sin(driftUv.x * 2.2 + uTime * 0.05) * cos(driftUv.y * 2.4 - uTime * 0.04);

    // Light comes from upper-left, like a soft studio key light.
    vec3 lightDir = normalize(vec3(-0.35, 0.5, 0.78));
    float diffuse = max(dot(normal, lightDir), 0.0);
    float spec = pow(diffuse, 40.0);

    // Fresnel-ish rim so tilted patches of the ripple read as glassy.
    float rim = pow(1.0 - max(normal.z, 0.0), 3.0);

    float grain = (noise(vUv * uResolution * 0.75 + uTime * 0.6) - 0.5) * 0.02;

    // Base tint: near-black / charcoal, never blue.
    vec3 base = mix(vec3(0.0), vec3(0.06, 0.06, 0.065), rim * 0.6 + 0.15);
    vec3 highlight = mix(vec3(1.0), uAccent, 0.55) * (spec * 0.9 + rim * 0.06);
    vec3 color = base + highlight + grain;

    // Alpha stays near-zero on calm water and rises with the amount
    // of local disturbance, so idle areas of the page are untouched.
    float energy = clamp(abs(height) * 5.0 + rim * 0.12 + spec * 0.5, 0.0, 1.0);
    float alpha = energy * 0.55 + abs(drift) * 0.008;

    fragColor = vec4(color, clamp(alpha, 0.0, 0.9));
  }
`;

// ---- gl helpers -------------------------------------------------

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return program;
}

function createSimTexture(gl, size) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    size,
    size,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createFbo(gl, texture) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

// Simulation resolution: deliberately low-res. The heightfield is
// smooth by nature, so this upsamples beautifully via LINEAR
// filtering while keeping the per-frame cost tiny.
const SIM_SIZE = 160;
// How long (ms) to keep simulating after the last interaction before
// the ripples have visibly settled, so the rAF loop can be paused.
const IDLE_TIMEOUT = 3200;

export default function WaterSurface() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    if (prefersReducedMotion) {
      canvas.style.display = "none";
      return undefined;
    }

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      // No WebGL2 available - fail silently, the CSS-only ambient
      // background gradient (see OnDemandDashboard.css) still gives
      // a faint liquid feel with zero JS cost.
      canvas.style.display = "none";
      return undefined;
    }

    let destroyed = false;

    // -- accent color, read from the app's own CSS variable so this
    // component never hard-codes a color that could drift from the
    // rest of the UI.
    const root = canvas.closest(".odd-root") || document.documentElement;
    const accentHex =
      getComputedStyle(root).getPropertyValue("--odd-red").trim() || "#b7081c";
    const accent = hexToRgbFloat(accentHex);

    // -- programs
    const updateProgram = createProgram(gl, VERT, UPDATE_FRAG);
    const splatProgram = createProgram(gl, VERT, SPLAT_FRAG);
    const renderProgram = createProgram(gl, VERT, RENDER_FRAG);

    // -- fullscreen triangle-strip quad
    const quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // -- ping-pong sim buffers
    let texA = createSimTexture(gl, SIM_SIZE);
    let texB = createSimTexture(gl, SIM_SIZE);
    let fboA = createFbo(gl, texA);
    let fboB = createFbo(gl, texB);

    const clearSim = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    clearSim();

    // -- sizing
    const state = {
      width: 0,
      height: 0,
      dpr: Math.min(window.devicePixelRatio || 1, 1.75),
    };

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      state.width = w;
      state.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * state.dpr);
      canvas.height = Math.round(h * state.dpr);
    }
    resize();

    let resizeRaf = null;
    const onResize = () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(resize);
    };
    window.addEventListener("resize", onResize);

    // -- pointer tracking → queued splats
    const pending = [];
    let lastPointer = null;
    let lastInteraction = performance.now();

    function queueSplat(clientX, clientY, strength) {
      const u = clientX / state.width;
      const v = 1 - clientY / state.height;
      if (u < 0 || u > 1 || v < 0 || v > 1) return;
      pending.push({ u, v, strength });
      lastInteraction = performance.now();
    }

    function onPointerMove(e) {
      const x = e.clientX;
      const y = e.clientY;
      if (lastPointer) {
        const dx = x - lastPointer.x;
        const dy = y - lastPointer.y;
        const speed = Math.sqrt(dx * dx + dy * dy);
        const strength = Math.min(0.12 + speed * 0.01, 0.85);
        queueSplat(x, y, strength);
      }
      lastPointer = { x, y };
    }

    function onPointerDown(e) {
      queueSplat(e.clientX, e.clientY, 1.4);
      lastPointer = { x: e.clientX, y: e.clientY };
    }

    function onPointerLeave() {
      lastPointer = null;
    }

    function onTouchMove(e) {
      if (!e.touches || !e.touches.length) return;
      const t = e.touches[0];
      if (lastPointer) {
        const dx = t.clientX - lastPointer.x;
        const dy = t.clientY - lastPointer.y;
        const speed = Math.sqrt(dx * dx + dy * dy);
        queueSplat(t.clientX, t.clientY, Math.min(0.16 + speed * 0.012, 0.9));
      } else {
        queueSplat(t.clientX, t.clientY, 0.5);
      }
      lastPointer = { x: t.clientX, y: t.clientY };
    }

    function onTouchStart(e) {
      if (!e.touches || !e.touches.length) return;
      const t = e.touches[0];
      queueSplat(t.clientX, t.clientY, 1.1);
      lastPointer = { x: t.clientX, y: t.clientY };
    }

    function onTouchEnd() {
      lastPointer = null;
    }

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    // -- animation loop
    let rafId = null;
    let running = false;
    const start = performance.now();

    function step(now) {
      rafId = null;
      if (destroyed) return;

      const elapsed = (now - start) / 1000;

      // 1. propagate the wave equation: read A, write B.
      gl.viewport(0, 0, SIM_SIZE, SIM_SIZE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.useProgram(updateProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(updateProgram, "uState"), 0);
      gl.uniform2f(
        gl.getUniformLocation(updateProgram, "uTexel"),
        1 / SIM_SIZE,
        1 / SIM_SIZE
      );
      gl.uniform1f(gl.getUniformLocation(updateProgram, "uDamping"), 0.986);
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2. inject any queued pointer splats into B, red-channel only.
      if (pending.length) {
        gl.useProgram(splatProgram);
        gl.colorMask(true, false, false, false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const aspect = state.width / state.height;
        const uPoint = gl.getUniformLocation(splatProgram, "uPoint");
        const uRadius = gl.getUniformLocation(splatProgram, "uRadius");
        const uStrength = gl.getUniformLocation(splatProgram, "uStrength");
        const uAspect = gl.getUniformLocation(splatProgram, "uAspect");
        gl.uniform1f(uRadius, 0.045);
        gl.uniform1f(uAspect, aspect);
        for (const s of pending) {
          gl.uniform2f(uPoint, s.u, s.v);
          gl.uniform1f(uStrength, s.strength);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        pending.length = 0;
      }

      // swap
      [texA, texB] = [texB, texA];
      [fboA, fboB] = [fboB, fboA];

      // 3. render the surface to the visible canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(renderProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(renderProgram, "uState"), 0);
      gl.uniform2f(
        gl.getUniformLocation(renderProgram, "uTexel"),
        1 / SIM_SIZE,
        1 / SIM_SIZE
      );
      gl.uniform2f(
        gl.getUniformLocation(renderProgram, "uResolution"),
        canvas.width,
        canvas.height
      );
      gl.uniform1f(gl.getUniformLocation(renderProgram, "uTime"), elapsed);
      gl.uniform3f(
        gl.getUniformLocation(renderProgram, "uAccent"),
        accent[0],
        accent[1],
        accent[2]
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);

      const idleFor = now - lastInteraction;
      if (idleFor < IDLE_TIMEOUT) {
        rafId = requestAnimationFrame(step);
      } else {
        running = false;
      }
    }

    function ensureRunning() {
      if (!running) {
        running = true;
        rafId = requestAnimationFrame(step);
      }
    }

    // Wake the loop back up on interaction if it had gone idle.
    const wake = () => ensureRunning();
    window.addEventListener("pointermove", wake, { passive: true });
    window.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("touchstart", wake, { passive: true });
    window.addEventListener("touchmove", wake, { passive: true });

    ensureRunning();

    return () => {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("touchmove", wake);

      gl.deleteTexture(texA);
      gl.deleteTexture(texB);
      gl.deleteFramebuffer(fboA);
      gl.deleteFramebuffer(fboB);
      gl.deleteBuffer(quadBuffer);
      gl.deleteVertexArray(quad);
      gl.deleteProgram(updateProgram);
      gl.deleteProgram(splatProgram);
      gl.deleteProgram(renderProgram);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="odd-water-canvas"
      aria-hidden="true"
    />
  );
}

function hexToRgbFloat(hex) {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const int = parseInt(full, 16);
  if (Number.isNaN(int)) return [0.72, 0.03, 0.11];
  return [
    ((int >> 16) & 255) / 255,
    ((int >> 8) & 255) / 255,
    (int & 255) / 255,
  ];
}