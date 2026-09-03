import { useEffect, useRef } from "react";

/**
 * CarbonSurface
 * -------------------------------------------------------------
 * Pure visual overlay, themed for MG Motors: the page background
 * reads as a woven carbon-fiber panel (a real automotive material —
 * trim, spoilers, interior accents), and the cursor / a touch point
 * behaves like a light source moving across it — the weave catches
 * a brighter, warmer sheen wherever it's been touched recently, the
 * way real carbon fiber shifts sheen as the viewing/light angle
 * changes. Rendered as a single fixed <canvas> behind the app's
 * content.
 *
 * Mechanics: the twill weave pattern is fully procedural (no image
 * asset), computed per-pixel in the render shader. A separate, very
 * low-res "influence" texture tracks where the pointer has recently
 * been, decaying exponentially every frame via a ping-ponged WebGL2
 * texture pair — this modulates how bright/warm the weave's
 * specular sheen gets in that area, instead of drawing a literal
 * glowing shape on top of the material.
 *
 * Nothing here touches app state, layout, or interactive elements:
 * `pointer-events: none` on the canvas, and it never reads from or
 * writes to the DOM outside of itself.
 *
 * Usage: render once, near the root of the page shell, e.g.
 *   <div className="odd-root">
 *     <CarbonSurface />
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

// Exponential fade of the accumulated pointer-influence field.
// Premultiplied, so a plain scalar multiply keeps it valid.
const FADE_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uState;
  uniform float uDecay;
  void main() {
    fragColor = texture(uState, vUv) * uDecay;
  }
`;

// Additive soft-circle splat, pure white intensity - this is only
// ever used as an influence mask, not a visible color, so it stays
// deliberately simple.
const SPLAT_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform vec2 uPoint;
  uniform float uRadius;
  uniform float uStrength;
  uniform float uAspect;

  void main() {
    vec2 d = vUv - uPoint;
    d.x *= uAspect;
    float dist = length(d);
    float falloff = smoothstep(uRadius, 0.0, dist);
    float bump = falloff * falloff * (0.5 - 0.5 * cos(falloff * 3.14159265));
    float alpha = bump * uStrength;
    fragColor = vec4(vec3(1.0) * alpha, alpha);
  }
`;

// Procedural carbon-fiber twill weave, lit by a specular sheen that
// brightens and warms toward the app's accent color wherever the
// pointer-influence field is strongest.
const RENDER_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uTrail;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform vec3 uAccent;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  // 2x2 twill weave: tiles alternate which diagonal thread sits on
  // top, the classic carbon-fiber over/under look.
  float weave(vec2 px, out float dir) {
    float tileSize = 13.0;
    vec2 tile = floor(px / tileSize);
    float checker = mod(tile.x + tile.y, 2.0);
    vec2 local = fract(px / tileSize);
    float diagA = abs(fract(local.x + local.y) - 0.5) * 2.0;
    float diagB = abs(fract(local.x - local.y) - 0.5) * 2.0;
    float threadA = 1.0 - smoothstep(0.05, 0.62, diagA);
    float threadB = 1.0 - smoothstep(0.05, 0.62, diagB);
    dir = checker < 0.5 ? 1.0 : -1.0;
    return checker < 0.5 ? threadA : threadB;
  }

  void main() {
    vec2 px = vUv * uResolution;

    float dir;
    float shade = weave(px, dir);

    // Faint per-tile tone variation so the weave doesn't look like a
    // perfectly regular printed pattern.
    vec2 tile = floor(px / 13.0);
    float variance = hash(tile) * 0.5;

    // Ambient sheen: a very slow diagonal sweep, biased by thread
    // direction so it reads as light traveling along the fiber
    // rather than a flat gradient - this is the "resting" material
    // shimmer, independent of the cursor.
    float sweepAxis = (px.x * dir + px.y) * 0.02;
    float ambientSheen = pow(sin(sweepAxis + uTime * 0.06) * 0.5 + 0.5, 5.0);

    vec4 trail = texture(uTrail, vUv); // premultiplied white intensity
    float influence = clamp(trail.a, 0.0, 1.0);

    float spec = shade * (0.09 + ambientSheen * 0.05 + influence * 0.85);

    vec3 ambientTint = vec3(0.82, 0.85, 0.9);
    vec3 activeTint = mix(vec3(1.0, 0.97, 0.9), uAccent, 0.5);
    vec3 specColor = mix(ambientTint, activeTint, clamp(influence * 1.5, 0.0, 1.0));

    vec3 base = mix(vec3(0.014, 0.014, 0.016), vec3(0.045, 0.046, 0.05), shade * 0.4 + variance * 0.15);
    vec3 color = base + specColor * spec;

    float alpha = clamp(0.15 + shade * 0.06 + spec * 0.55 + influence * 0.22, 0.0, 0.94);

    fragColor = vec4(color, alpha);
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

function createTrailTexture(gl, size) {
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

// Influence-field resolution - deliberately low-res; it's only ever
// sampled as a soft mask, so LINEAR filtering upsamples it cleanly
// while keeping the per-frame cost tiny.
const TRAIL_SIZE = 192;
// Roughly how long (ms) the influence field takes to fully decay,
// used to decide how long to keep the rAF loop alive after the
// pointer stops moving.
const IDLE_TIMEOUT = 3200;

export default function CarbonSurface() {
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
      // No WebGL2 - fail silently. The CSS-only ambient carbon
      // backdrop (see OnDemandDashboard.css) still reads fine with
      // zero JS cost.
      canvas.style.display = "none";
      return undefined;
    }

    let destroyed = false;

    // Accent color, read live from the app's own CSS variable so
    // this component never hard-codes a color that could drift.
    const root = canvas.closest(".odd-root") || document.documentElement;
    const accentHex =
      getComputedStyle(root).getPropertyValue("--odd-red").trim() || "#b7081c";
    const accent = hexToRgbFloat(accentHex);

    // -- programs
    const fadeProgram = createProgram(gl, VERT, FADE_FRAG);
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

    // -- ping-pong influence buffers
    let texA = createTrailTexture(gl, TRAIL_SIZE);
    let texB = createTrailTexture(gl, TRAIL_SIZE);
    let fboA = createFbo(gl, texA);
    let fboB = createFbo(gl, texB);

    const clearTrail = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    clearTrail();

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
        // Faster movement -> the weave catches a slightly stronger
        // sheen, like light sweeping quickly across the panel.
        const strength = Math.min(0.14 + speed * 0.01, 0.85);
        queueSplat(x, y, strength);
      }
      lastPointer = { x, y };
    }

    function onPointerDown(e) {
      // A brief brighter catch of light on click, like a camera
      // flash glinting off the fiber.
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

      // 1. fade the existing influence field: read A, write B.
      gl.viewport(0, 0, TRAIL_SIZE, TRAIL_SIZE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.disable(gl.BLEND);
      gl.useProgram(fadeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(fadeProgram, "uState"), 0);
      gl.uniform1f(gl.getUniformLocation(fadeProgram, "uDecay"), 0.965);
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2. inject any queued pointer splats into B, additively.
      if (pending.length) {
        gl.useProgram(splatProgram);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const aspect = state.width / state.height;
        const uPoint = gl.getUniformLocation(splatProgram, "uPoint");
        const uRadius = gl.getUniformLocation(splatProgram, "uRadius");
        const uStrength = gl.getUniformLocation(splatProgram, "uStrength");
        const uAspect = gl.getUniformLocation(splatProgram, "uAspect");
        gl.uniform1f(uRadius, 0.065);
        gl.uniform1f(uAspect, aspect);
        for (const s of pending) {
          gl.uniform2f(uPoint, s.u, s.v);
          gl.uniform1f(uStrength, s.strength);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        gl.disable(gl.BLEND);
        pending.length = 0;
      }

      // swap
      [texA, texB] = [texB, texA];
      [fboA, fboB] = [fboB, fboA];

      // 3. render the woven panel + specular sheen to the canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(renderProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(renderProgram, "uTrail"), 0);
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
      gl.deleteProgram(fadeProgram);
      gl.deleteProgram(splatProgram);
      gl.deleteProgram(renderProgram);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="odd-carbon-canvas"
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