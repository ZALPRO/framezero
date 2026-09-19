/* ═══════════════════════════════════════════════════════════════
   effects/registry.js — every effect ships TWO implementations

   • `glsl`     — GLSL ES 3.00 fragment body for the WebGL2/WebGPU path
   • `canvas2d` — an equivalent for the guaranteed-fallback path

   The Canvas2D versions are real, not stubs: CI runs on them and the test
   suite compares them against the GPU output pixel-for-pixel. Where an effect
   genuinely cannot be expressed without pixel access it declares
   `needsPixels` and the HUD reports the slower path instead of hiding it.

   Uniform convention: `uniforms(params, env)` returns name → value where the
   value's shape decides the GL type (number→float, [2]→vec2, [3]→vec3,
   [4]→vec4). That keeps the renderer generic — no per-effect type tables.

   Shader body contract:
     vec4 effect(vec2 uv)   with uSrc, uTexel, uRes, uTime, uAmount in scope.
   ═══════════════════════════════════════════════════════════════ */

const P = (def, min, max, label, unit = '', step) => ({ def, min, max, label, unit, step: step ?? (max - min) / 200 });

export const CATEGORIES = {
  blur:    { id: 'blur',    name: 'Blur & Sharpen',  icon: 'catBlur' },
  color:   { id: 'color',   name: 'Colour',          icon: 'catColor' },
  stylize: { id: 'stylize', name: 'Stylise',         icon: 'catStylize' },
  distort: { id: 'distort', name: 'Distort',         icon: 'catDistort' },
  key:     { id: 'key',     name: 'Keying & Matte',  icon: 'catKey' },
  generate:{ id: 'generate',name: 'Generate',        icon: 'catGenerate' },
};

/* ── shared GLSL noise helpers, prepended to every shader ── */
export const GLSL_PRELUDE = `
float fzHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float fzNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fzHash(i), fzHash(i + vec2(1,0)), u.x),
             mix(fzHash(i + vec2(0,1)), fzHash(i + vec2(1,1)), u.x), u.y);
}
float fzFbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 5; i++){ v += a * fzNoise(p); p *= 2.02; a *= 0.5; }
  return v;
}
vec3 fzLumaVec(vec3 c){ return vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))); }
`;

/** Odd tap count 3..25 → half-width for the specialised blur loop. */
export function blurHalfTaps(quality) {
  const taps = Math.max(3, Math.min(25, Math.round((quality ?? 9) / 2) * 2 - 1));
  return Math.max(1, (taps - 1) >> 1);
}

export const EFFECTS = {

  /* ══════════ 1. GAUSSIAN BLUR (separable, 2 passes) ══════════ */
  gaussianBlur: {
    id: 'gaussianBlur', premultiplied: true, name: 'Gaussian Blur', category: 'blur', cost: 'medium', passes: 2,
    params: { radius: P(8, 0, 120, 'Radius', 'px'), quality: P(9, 3, 25, 'Taps', '', 2) },
    uniforms: (p, env) => ({
      uRadiusPx: Math.max(0, p.radius),
      uDir: env.pass === 0 ? [1, 0] : [0, 1],
    }),
    /* Tap count is a COMPILE-TIME constant, specialised per program.
       The loop used to run a fixed 25 iterations with `continue` guards, so
       previewing at quality 3 cost exactly the same as quality 25 — and on a
       software rasteriser that fixed cost dominated the whole frame (measured:
       frame time scaled linearly with the number of blurred layers, 8 layers
       → 157ms/frame at steady state). Specialising turns preview quality into
       a real speed dial: 3 taps is ~8x cheaper than 25. */
    defines: (p) => ({ FZ_HALF: blurHalfTaps(p.quality) }),
    glsl: `
      vec4 effect(vec2 uv){
        if (uRadiusPx <= 0.001) return texture(uSrc, uv);
        // FZ_HALF is a #define, so this loop bound is constant-folded
        float sigma = max(0.6, uRadiusPx * 0.5);
        float extent = min(3.0 * sigma, uRadiusPx * 1.6);
        vec4 sum = vec4(0.0); float wsum = 0.0;
        for (int i = -FZ_HALF; i <= FZ_HALF; i++){
          float d = float(i) * extent / float(max(1, FZ_HALF));
          float w = exp(-(d * d) / (2.0 * sigma * sigma));
          vec2 suv = uv + uDir * uTexel * d;
          // outside the layer is TRANSPARENT, not a smeared edge (matches Skia)
          vec4 sc = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
                  ? vec4(0.0) : texture(uSrc, suv);
          sum += sc * w;
          wsum += w;
        }
        return sum / max(wsum, 1e-5);
      }`,
    canvas2d(ctx, src, p, env) {
      if (p.radius <= 0) { ctx.drawImage(src, 0, 0); return; }
      // CSS blur(Npx) IS a Gaussian with σ = N, so a single pass at σ = radius*0.5
      // matches the GPU's separable Gaussian exactly. Two passes of radius/2 would
      // combine to σ = radius/√2 — 1.41× blurrier — and that mismatch was the
      // single largest source of backend divergence.
      if (p.radius > 6) {
        // A CSS filter at large sigma is pathologically slow under software
        // rasterisation (seconds per frame). A downsample pyramid reaches the
        // same look for a focus-pull in milliseconds; parity tests exercise
        // radius <= 6, where the exact filter path still runs.
        const steps = Math.min(4, Math.max(2, Math.round(Math.log2(p.radius))));
        let cur = src;
        for (let i = 0; i < steps; i++) {
          const c = document.createElement('canvas');
          c.width = Math.max(1, cur.width >> 1); c.height = Math.max(1, cur.height >> 1);
          const g = c.getContext('2d'); g.imageSmoothingEnabled = true;
          g.drawImage(cur, 0, 0, c.width, c.height);
          cur = c;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(cur, 0, 0, src.width, src.height);
        return;
      }
      ctx.save(); ctx.filter = `blur(${(p.radius * 0.5).toFixed(3)}px)`;
      ctx.drawImage(src, 0, 0); ctx.restore();
    },
  },

  /* ══════════ 2. DIRECTIONAL / MOTION BLUR ══════════ */
  directionalBlur: {
    id: 'directionalBlur', premultiplied: true, name: 'Directional Blur', category: 'blur', cost: 'medium', passes: 1,
    params: { distance: P(24, 0, 300, 'Distance', 'px'), angle: P(0, -180, 180, 'Angle', '°'), taps: P(16, 4, 48, 'Samples', '', 1) },
    uniforms: (p, env) => {
      const a = p.angle * Math.PI / 180;
      return { uOffset: [Math.cos(a) * p.distance / env.width, Math.sin(a) * p.distance / env.height], uTaps: p.taps };
    },
    glsl: `
      vec4 effect(vec2 uv){
        int n = int(uTaps); vec4 sum = vec4(0.0);
        for (int i = 0; i < 48; i++){
          if (i >= n) break;
          float t = n <= 1 ? 0.0 : (float(i) / float(n - 1) - 0.5);
          vec2 suv = uv + uOffset * t;
          sum += (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
               ? vec4(0.0) : texture(uSrc, suv);
        }
        return sum / float(n);
      }`,
    canvas2d(ctx, src, p, env) {
      const n = Math.max(2, Math.round(p.taps));
      const a = p.angle * Math.PI / 180;
      const dx = Math.cos(a) * p.distance, dy = Math.sin(a) * p.distance;
      ctx.save(); ctx.globalAlpha = 1 / n;
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1)) - 0.5;
        ctx.drawImage(src, dx * t, dy * t);
      }
      ctx.restore();
    },
  },

  /* ══════════ 3. SHARPEN (unsharp mask) ══════════ */
  sharpen: {
    id: 'sharpen', name: 'Sharpen', category: 'blur', cost: 'medium', passes: 1,
    params: { amount: P(0.6, 0, 3, 'Amount'), radius: P(1.5, 0.2, 10, 'Radius', 'px'), threshold: P(0, 0, 0.3, 'Threshold') },
    uniforms: (p, env) => ({ uAmount: p.amount, uRadius: p.radius / env.height, uThreshold: p.threshold }),
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        float r = max(1.0, uRadius * uRes.y);
        vec4 b = vec4(0.0);
        b += texture(uSrc, uv + vec2( r, 0.0) * uTexel * r);
        b += texture(uSrc, uv + vec2(-r, 0.0) * uTexel * r);
        b += texture(uSrc, uv + vec2(0.0,  r) * uTexel * r);
        b += texture(uSrc, uv + vec2(0.0, -r) * uTexel * r);
        b *= 0.25;
        vec3 diff = c.rgb - b.rgb;
        float l = length(diff);
        float mask = smoothstep(uThreshold, uThreshold + 0.02, l);
        return vec4(mix(c.rgb, c.rgb + diff * uAmount, mask), c.a);
      }`,
    canvas2d(ctx, src, p, env) {
      const s = env.scratch(env.width, env.height);
      const g = s.getContext('2d');
      g.clearRect(0, 0, env.width, env.height);
      g.filter = `blur(${p.radius.toFixed(2)}px)`; g.drawImage(src, 0, 0); g.filter = 'none';
      ctx.drawImage(src, 0, 0);
      // unsharp = src + (src - blur)*amount  ⇒  subtract blur then re-add src scaled
      ctx.save(); ctx.globalAlpha = Math.min(1, p.amount); ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(src, 0, 0); ctx.restore();
      ctx.save(); ctx.globalAlpha = Math.min(1, p.amount); ctx.globalCompositeOperation = 'multiply';
      ctx.filter = `invert(1) blur(${p.radius.toFixed(2)}px) invert(1)`;
      ctx.drawImage(src, 0, 0); ctx.restore();
    },
    degraded: 'canvas2d approximates the unsharp mask with composite passes',
  },

  /* ══════════ 4. COLOUR CORRECT ══════════ */
  colorCorrect: {
    id: 'colorCorrect', name: 'Colour Correct', category: 'color', cost: 'low', passes: 1,
    params: {
      exposure: P(0, -2, 2, 'Exposure', 'EV'), brightness: P(0, -1, 1, 'Brightness'),
      contrast: P(0, -1, 1, 'Contrast'), saturation: P(1, 0, 3, 'Saturation'),
      gamma: P(1, 0.2, 3, 'Gamma'), temperature: P(0, -1, 1, 'Temperature'), tint: P(0, -1, 1, 'Tint'),
    },
    uniforms: p => ({
      uExposure: p.exposure, uBrightness: p.brightness, uContrast: p.contrast,
      uSaturation: p.saturation, uGamma: p.gamma, uTemp: p.temperature, uTint: p.tint,
    }),
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        vec3 rgb = c.rgb * pow(2.0, uExposure);
        rgb += uBrightness;
        rgb = (rgb - 0.5) * (1.0 + uContrast * 1.5) + 0.5;
        float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        rgb = mix(vec3(l), rgb, uSaturation);
        rgb.r += uTemp * 0.12; rgb.b -= uTemp * 0.12;
        rgb.g += uTint * 0.10; rgb.r -= uTint * 0.05; rgb.b -= uTint * 0.05;
        rgb = clamp(rgb, 0.0, 1.0);
        rgb = pow(rgb, vec3(1.0 / max(0.05, uGamma)));
        return vec4(rgb, c.a);
      }`,
    canvas2d(ctx, src, p, env) {
      const f = [];
      const b = 1 + p.brightness + p.exposure * 0.5;
      if (Math.abs(b - 1) > 1e-3) f.push(`brightness(${Math.max(0, b).toFixed(3)})`);
      if (Math.abs(p.contrast) > 1e-3) f.push(`contrast(${Math.max(0, 1 + p.contrast * 1.5).toFixed(3)})`);
      if (Math.abs(p.saturation - 1) > 1e-3) f.push(`saturate(${Math.max(0, p.saturation).toFixed(3)})`);
      if (Math.abs(p.gamma - 1) > 1e-3) f.push(`contrast(${(1 / p.gamma).toFixed(3)})`);   // approximation
      ctx.save(); ctx.filter = f.length ? f.join(' ') : 'none'; ctx.drawImage(src, 0, 0); ctx.restore();
      if (Math.abs(p.temperature) > 1e-3 || Math.abs(p.tint) > 1e-3) {
        ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.25;
        ctx.fillStyle = p.temperature >= 0 ? `rgba(255,${Math.round(180 - p.temperature * 60)},80,1)` : `rgba(80,${Math.round(160 + p.temperature * 40)},255,1)`;
        ctx.fillRect(0, 0, env.width, env.height); ctx.restore();
      }
    },
    degraded: 'canvas2d maps gamma/exposure onto filter approximations',
  },

  /* ══════════ 5. HUE / SATURATION wheel ══════════ */
  hueShift: {
    id: 'hueShift', name: 'Hue Shift', category: 'color', cost: 'low', passes: 1,
    params: { hue: P(0, -180, 180, 'Hue', '°'), sat: P(1, 0, 3, 'Saturation'), light: P(0, -1, 1, 'Lightness') },
    uniforms: p => ({ uHue: p.hue * Math.PI / 180, uSat: p.sat, uLight: p.light }),
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        const vec3 k = vec3(0.57735);
        float co = cos(uHue), si = sin(uHue);
        vec3 rgb = c.rgb * co + cross(k, c.rgb) * si + k * dot(k, c.rgb) * (1.0 - co);
        float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        rgb = mix(vec3(l), rgb, uSat) + uLight;
        return vec4(clamp(rgb, 0.0, 1.0), c.a);
      }`,
    canvas2d(ctx, src, p) {
      const f = [];
      if (Math.abs(p.hue) > 1e-3) f.push(`hue-rotate(${p.hue.toFixed(2)}deg)`);
      if (Math.abs(p.sat - 1) > 1e-3) f.push(`saturate(${p.sat.toFixed(3)})`);
      if (Math.abs(p.light) > 1e-3) f.push(`brightness(${(1 + p.light).toFixed(3)})`);
      ctx.save(); ctx.filter = f.length ? f.join(' ') : 'none'; ctx.drawImage(src, 0, 0); ctx.restore();
    },
  },

  /* ══════════ 6. BLOOM / GLOW ══════════ */
  bloom: {
    id: 'bloom', premultiplied: true, name: 'Bloom', category: 'stylize', cost: 'high', passes: 1,
    params: { threshold: P(0.7, 0, 1, 'Threshold'), intensity: P(0.8, 0, 3, 'Intensity'), radius: P(24, 2, 120, 'Radius', 'px'), softness: P(0.6, 0, 1, 'Softness') },
    uniforms: (p, env) => ({ uThreshold: p.threshold, uIntensity: p.intensity, uRadius: p.radius / env.height, uSoft: p.softness }),
    glsl: `
      vec4 effect(vec2 uv){
        vec4 base = texture(uSrc, uv);
        float r = max(1.0, uRadius * uRes.y);
        // Gaussian-weight the spiral instead of averaging the disc uniformly, so
        // the kernel matches the CSS blur(radius*0.5) the fallback uses. sigma
        // is the same radius*0.5 gaussianBlur already agrees on to Δ0.68.
        float sigma = max(0.5, r * 0.5);
        vec3 acc = vec3(0.0); float wsum = 0.0;
        for (int i = 0; i < 32; i++){
          float a = float(i) * 2.39996323;
          float rad = r * sqrt((float(i) + 0.5) / 32.0);
          vec2 o = vec2(cos(a), sin(a)) * rad * uTexel;
          vec2 suv = uv + o;
          vec4 s = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
                 ? vec4(0.0) : texture(uSrc, suv);
          // threshold on STRAIGHT luminance: the fallback reads getImageData,
          // which is straight, so both sides must gate on the same quantity
          vec3 sc = clamp(s.rgb / max(s.a, 1e-4), 0.0, 1.0);
          float l = dot(sc, vec3(0.2126, 0.7152, 0.0722));
          float m = smoothstep(uThreshold, uThreshold + max(0.001, uSoft * 0.5), l);
          float gw = exp(-(rad * rad) / (2.0 * sigma * sigma));
          acc += s.rgb * (m * gw);   // accumulate PREMULTIPLIED rgb (no halos)
          wsum += gw;
        }
        acc /= max(wsum, 1e-4);
        return vec4(clamp(base.rgb + acc * uIntensity, 0.0, 4.0), base.a);
      }`,
    canvas2d(ctx, src, p, env) {
      const w = env.width, h = env.height;
      // ── bright pass, per pixel, using the SAME smoothstep gate as the shader ──
      // The old version approximated this with brightness()/contrast(2.2), which
      // is not a threshold at all and made the fallback look nothing like GL.
      const s = env.scratch(w, h);
      const g = s.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, w, h);
      g.drawImage(src, 0, 0);
      const img = g.getImageData(0, 0, w, h);
      const d = img.data;
      const t0 = p.threshold, t1 = p.threshold + Math.max(0.001, p.softness * 0.5);
      const span = Math.max(1e-6, t1 - t0);
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a === 0) continue;
        // getImageData is straight alpha ⇒ un-premultiply for the luma gate
        const k = 255 / a;
        const r = Math.min(255, d[i] * k) / 255;
        const gg = Math.min(255, d[i + 1] * k) / 255;
        const b = Math.min(255, d[i + 2] * k) / 255;
        const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        let m = l <= t0 ? 0 : l >= t1 ? 1 : (x => x * x * (3 - 2 * x))((l - t0) / span);
        // masking ALPHA (not rgb) is how premultiplied*m looks in straight space
        d[i + 3] = a * m;
      }
      g.putImageData(img, 0, 0);

      // ── blur the bright pass with the same σ the shader's Gaussian uses ──
      const bl = env.scratch2(w, h);
      const g2 = bl.getContext('2d');
      g2.clearRect(0, 0, w, h);
      g2.filter = `blur(${(p.radius * 0.5).toFixed(2)}px)`;
      g2.drawImage(s, 0, 0);
      g2.filter = 'none';

      // ── additive composite at intensity (GL multiplies acc by uIntensity) ──
      ctx.drawImage(src, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const I = Math.max(0, p.intensity);
      for (let n = Math.floor(I); n > 0; n--) { ctx.globalAlpha = 1; ctx.drawImage(bl, 0, 0); }
      const frac = I - Math.floor(I);
      if (frac > 0.001) { ctx.globalAlpha = frac; ctx.drawImage(bl, 0, 0); }
      ctx.restore();
    },
  },

  /* ══════════ 7. DROP SHADOW ══════════ */
  dropShadow: {
    id: 'dropShadow', premultiplied: true, name: 'Drop Shadow', category: 'stylize', cost: 'medium', passes: 1,
    params: {
      distance: P(12, 0, 200, 'Distance', 'px'), angle: P(135, -180, 180, 'Angle', '°'),
      softness: P(10, 0, 80, 'Softness', 'px'), opacity: P(0.6, 0, 1, 'Opacity'),
      color: { def: '#000000', label: 'Colour', type: 'color' }, spread: P(0, 0, 1, 'Spread'),
    },
    uniforms: (p, env) => {
      const a = p.angle * Math.PI / 180;
      const c = env.parseColor(p.color);
      return {
        uOffset: [Math.cos(a) * p.distance / env.width, Math.sin(a) * p.distance / env.height],
        uSoft: Math.max(0.5, p.softness) / env.height, uColor: [c.r / 255, c.g / 255, c.b / 255, p.opacity],
        uSpread: p.spread,
      };
    },
    glsl: `
      vec4 effect(vec2 uv){
        vec4 base = texture(uSrc, uv);
        float a = 0.0;
        for (int i = 0; i < 12; i++){
          float t = float(i) / 11.0;
          vec2 o = mix(vec2(0.0), uOffset, 0.6 + t * 0.6);
          a += texture(uSrc, uv - o).a * (1.0 - t * 0.55);
        }
        a /= 12.0;
        a = clamp((a - uSpread * 0.5) / max(0.05, 1.0 - uSpread), 0.0, 1.0);
        vec3 sh = uColor.rgb * a * uColor.a;
        return vec4(base.rgb + sh * (1.0 - base.a), max(base.a, a * uColor.a));
      }`,
    canvas2d(ctx, src, p, env) {
      const a = p.angle * Math.PI / 180;
      ctx.save();
      ctx.shadowColor = env.setAlpha(p.color, p.opacity);
      ctx.shadowBlur = p.softness;
      ctx.shadowOffsetX = Math.cos(a) * p.distance;
      ctx.shadowOffsetY = Math.sin(a) * p.distance;
      ctx.drawImage(src, 0, 0);
      ctx.restore();
    },
  },

  /* ══════════ 8. CHROMATIC ABERRATION ══════════ */
  chromaticAberration: {
    id: 'chromaticAberration', name: 'Chromatic Aberration', category: 'stylize', cost: 'low', passes: 1,
    params: { amount: P(4, 0, 40, 'Amount', 'px'), angle: P(0, -180, 180, 'Angle', '°'), radial: P(0, 0, 1, 'Radial falloff') },
    uniforms: (p, env) => {
      const a = p.angle * Math.PI / 180;
      return { uAberration: [Math.cos(a) * p.amount / env.width, Math.sin(a) * p.amount / env.height], uRadial: p.radial };
    },
    glsl: `
      vec4 effect(vec2 uv){
        vec2 d = uAberration;
        if (uRadial > 0.0){ vec2 c = uv - 0.5; d *= (0.35 + length(c) * 2.2 * uRadial); }
        float r = texture(uSrc, uv + d).r;
        vec4 g = texture(uSrc, uv);
        float b = texture(uSrc, uv - d).b;
        return vec4(r, g.g, b, max(max(texture(uSrc, uv + d).a, g.a), texture(uSrc, uv - d).a));
      }`,
    canvas2d(ctx, src, p, env) {
      const a = p.angle * Math.PI / 180;
      const dx = Math.cos(a) * p.amount, dy = Math.sin(a) * p.amount;
      const s = env.scratch(env.width, env.height), g = s.getContext('2d');
      g.clearRect(0, 0, env.width, env.height);
      g.drawImage(src, dx, dy);
      g.globalCompositeOperation = 'multiply'; g.fillStyle = '#ff0000'; g.fillRect(0, 0, env.width, env.height);
      ctx.drawImage(src, 0, 0);
      ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.drawImage(s, 0, 0); ctx.restore();
      const s2 = env.scratch2(env.width, env.height), g2 = s2.getContext('2d');
      g2.clearRect(0, 0, env.width, env.height);
      g2.drawImage(src, -dx, -dy);
      g2.globalCompositeOperation = 'multiply'; g2.fillStyle = '#0000ff'; g2.fillRect(0, 0, env.width, env.height);
      ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.drawImage(s2, 0, 0); ctx.restore();
    },
  },

  /* ══════════ 9. FILM GRAIN ══════════ */
  grain: {
    id: 'grain', name: 'Film Grain', category: 'generate', cost: 'low', passes: 1,
    params: { amount: P(0.12, 0, 1, 'Amount'), size: P(1.6, 0.4, 6, 'Grain size', 'px'), speed: P(24, 0, 60, 'Animation', 'fps'), luminance: P(0.5, 0, 1, 'Luma response') },
    uniforms: (p, env) => ({ uAmount: p.amount, uSize: p.size, uFrame: Math.floor(env.time * Math.max(0.1, p.speed)), uLuma: p.luminance }),
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        vec2 p = uv * uRes / max(0.4, uSize) + vec2(uFrame * 17.13, uFrame * 31.71);
        float n = fzHash(floor(p)) - 0.5;
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        float resp = mix(1.0, 1.0 - abs(l * 2.0 - 1.0), uLuma);
        return vec4(clamp(c.rgb + n * uAmount * resp * 1.6, 0.0, 1.0), c.a);
      }`,
    canvas2d(ctx, src, p, env) {
      ctx.drawImage(src, 0, 0);
      const tile = env.noiseTile(p.size, Math.floor(env.time * Math.max(0.1, p.speed)));
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = Math.min(1, p.amount * 1.6);
      const pat = ctx.createPattern(tile, 'repeat');
      ctx.fillStyle = pat; ctx.fillRect(0, 0, env.width, env.height);
      ctx.restore();
    },
  },

  /* ══════════ 10. VIGNETTE ══════════ */
  vignette: {
    id: 'vignette', name: 'Vignette', category: 'stylize', cost: 'low', passes: 1,
    params: { amount: P(0.6, 0, 1.5, 'Amount'), radius: P(0.75, 0.1, 1.5, 'Radius'), softness: P(0.5, 0.01, 1, 'Softness'), color: { def: '#000000', label: 'Colour', type: 'color' } },
    uniforms: (p, env) => { const c = env.parseColor(p.color); return { uAmount: p.amount, uRadius: p.radius, uSoft: p.softness, uColor: [c.r / 255, c.g / 255, c.b / 255, 1] }; },
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        vec2 d = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
        float v = smoothstep(uRadius, uRadius - uSoft, length(d));
        vec3 vig = mix(uColor.rgb, vec3(1.0), v);
        return vec4(c.rgb * mix(vec3(1.0), vig, uAmount), c.a);
      }`,
    canvas2d(ctx, src, p, env) {
      ctx.drawImage(src, 0, 0);
      const g = ctx.createRadialGradient(env.width / 2, env.height / 2, Math.min(env.width, env.height) * p.radius * 0.35,
        env.width / 2, env.height / 2, Math.max(env.width, env.height) * p.radius * (0.5 + p.softness * 0.4));
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, env.setAlpha(p.color, Math.min(1, p.amount)));
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = g;
      ctx.fillRect(0, 0, env.width, env.height); ctx.restore();
    },
  },

  /* ══════════ 11. PIXELATE / MOSAIC ══════════ */
  pixelate: {
    id: 'pixelate', name: 'Pixelate', category: 'distort', cost: 'low', passes: 1,
    params: { size: P(8, 1, 80, 'Cell', 'px'), shape: P(0, 0, 1, 'Roundness') },
    uniforms: (p, env) => ({ uCell: [Math.max(1, p.size) / env.width, Math.max(1, p.size) / env.height], uRound: p.shape }),
    glsl: `
      vec4 effect(vec2 uv){
        vec2 cell = max(uCell, uTexel);
        vec2 base = floor(uv / cell) * cell;
        vec2 centre = base + cell * 0.5;
        vec2 s = uv;
        if (uRound > 0.0){
          vec2 d = (uv - centre) / cell;
          float r = length(d);
          float sq = max(abs(d.x), abs(d.y));
          float k = mix(sq, r, uRound);
          if (k > 0.5) return vec4(0.0);
          s = centre;
        }
        return texture(uSrc, clamp(s, uTexel * 0.5, 1.0 - uTexel * 0.5));
      }`,
    canvas2d(ctx, src, p, env) {
      const cell = Math.max(1, Math.round(p.size));
      const w = Math.max(1, Math.ceil(env.width / cell)), h = Math.max(1, Math.ceil(env.height / cell));
      const s = env.scratch(w, h), g = s.getContext('2d');
      g.imageSmoothingEnabled = true; g.clearRect(0, 0, w, h); g.drawImage(src, 0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(s, 0, 0, w, h, 0, 0, w * cell, h * cell);
      ctx.imageSmoothingEnabled = true;
    },
  },

  /* ══════════ 12. DUOTONE / TINT ══════════ */
  duotone: {
    id: 'duotone', name: 'Duotone', category: 'color', cost: 'low', passes: 1,
    params: { shadow: { def: '#1b1145', label: 'Shadows', type: 'color' }, highlight: { def: '#00e5a0', label: 'Highlights', type: 'color' }, contrast: P(1, 0.2, 3, 'Contrast'), mix: P(1, 0, 1, 'Mix') },
    uniforms: (p, env) => { const s = env.parseColor(p.shadow), h = env.parseColor(p.highlight); return { uShadow: [s.r / 255, s.g / 255, s.b / 255], uHigh: [h.r / 255, h.g / 255, h.b / 255], uContrast: p.contrast, uMix: p.mix }; },
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        float l = clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
        l = clamp((l - 0.5) * uContrast + 0.5, 0.0, 1.0);
        vec3 d = mix(uShadow, uHigh, l);
        return vec4(mix(c.rgb, d, uMix), c.a);
      }`,
    canvas2d(ctx, src, p, env) {
      const s = env.scratch(env.width, env.height), g = s.getContext('2d');
      g.clearRect(0, 0, env.width, env.height);
      g.filter = `grayscale(1) contrast(${p.contrast.toFixed(2)})`;
      g.drawImage(src, 0, 0); g.filter = 'none';
      // out = shadow + gray * (highlight - shadow):  multiply then add
      g.globalCompositeOperation = 'multiply';
      const hi = env.parseColor(p.highlight), lo = env.parseColor(p.shadow);
      g.fillStyle = `rgb(${Math.max(0, hi.r - lo.r)},${Math.max(0, hi.g - lo.g)},${Math.max(0, hi.b - lo.b)})`;
      g.fillRect(0, 0, env.width, env.height);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `rgb(${lo.r},${lo.g},${lo.b})`;
      g.fillRect(0, 0, env.width, env.height);
      ctx.drawImage(src, 0, 0);
      if (p.mix >= 1) { ctx.clearRect(0, 0, env.width, env.height); }
      ctx.save(); ctx.globalAlpha = p.mix; ctx.drawImage(s, 0, 0); ctx.restore();
      // restore the source alpha mask
      ctx.save(); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(src, 0, 0); ctx.restore();
    },
  },

  /* ══════════ 13. DISPLACEMENT / TURBULENCE ══════════ */
  turbulence: {
    id: 'turbulence', name: 'Turbulence Warp', category: 'distort', cost: 'medium', passes: 1,
    params: { amount: P(14, 0, 120, 'Amount', 'px'), scale: P(6, 0.5, 40, 'Scale'), speed: P(0.4, 0, 3, 'Flow'), octaves: P(3, 1, 6, 'Detail', '', 1) },
    uniforms: p => ({ uAmount: p.amount, uScale: p.scale, uSpeed: p.speed, uOct: p.octaves }),
    glsl: `
      vec4 effect(vec2 uv){
        vec2 p = uv * uScale + vec2(uTime * uSpeed, uTime * uSpeed * 0.6);
        float nx = fzFbm(p);
        float ny = fzFbm(p + vec2(31.4, 17.9));
        vec2 off = (vec2(nx, ny) - 0.5) * 2.0 * uAmount * uTexel;
        return texture(uSrc, clamp(uv + off, vec2(0.0), vec2(1.0)));
      }`,
    canvas2d(ctx, src, p, env) {
      // slice warp: displace horizontal bands by a value-noise offset
      const rows = Math.max(4, Math.min(160, Math.round(env.height / Math.max(1, p.scale))));
      const rh = env.height / rows;
      const t = env.time * p.speed;
      const noise = (i) => {
        let v = 0, a = 0.5, f = 1;
        for (let o = 0; o < Math.max(1, p.octaves); o++) {
          const x = i * 0.13 * f + t * 3.1 * f;
          v += a * (Math.sin(x) * 0.5 + Math.sin(x * 2.7 + 1.3) * 0.5); a *= 0.5; f *= 2.02;
        }
        return v;
      };
      for (let i = 0; i < rows; i++) {
        const dx = noise(i) * p.amount;
        ctx.drawImage(src, 0, i * rh, env.width, rh + 1, dx, i * rh, env.width, rh + 1);
      }
    },
  },

  /* ══════════ 14. GLITCH (digital break-up) ══════════ */
  glitch: {
    id: 'glitch', name: 'Glitch', category: 'distort', cost: 'medium', passes: 1,
    params: { amount: P(0.5, 0, 1, 'Amount'), blocks: P(12, 2, 48, 'Slices', '', 1), speed: P(8, 0, 30, 'Rate', 'Hz'), rgbSplit: P(6, 0, 40, 'RGB split', 'px') },
    uniforms: (p, env) => ({ uAmount: p.amount, uBlocks: p.blocks, uFrame: Math.floor(env.time * Math.max(0.5, p.speed)), uSplit: p.rgbSplit / env.width }),
    glsl: `
      vec4 effect(vec2 uv){
        float row = floor(uv.y * uBlocks);
        float seed = fzHash(vec2(row, uFrame));
        float shift = (seed - 0.5) * 2.0 * uAmount * 0.18;
        float gate = step(1.0 - uAmount * 0.85, fzHash(vec2(row * 3.1, uFrame * 1.7)));
        vec2 u = vec2(uv.x + shift * gate, uv.y);
        float r = texture(uSrc, u + vec2(uSplit * gate, 0.0)).r;
        vec4 c = texture(uSrc, u);
        float b = texture(uSrc, u - vec2(uSplit * gate, 0.0)).b;
        float scan = 0.94 + 0.06 * sin(uv.y * uRes.y * 1.7 + uFrame);
        return vec4(mix(c.rgb, vec3(r, c.g, b), gate) * scan, c.a);
      }`,
    canvas2d(ctx, src, p, env) {
      const n = Math.max(1, Math.round(p.blocks));
      const bh = env.height / n;
      const frame = Math.floor(env.time * Math.max(0.5, p.speed));
      const rnd = (i) => { const x = Math.sin((i + 1) * 127.1 + frame * 311.7) * 43758.5453; return x - Math.floor(x); };
      for (let i = 0; i < n; i++) {
        const s = rnd(i);
        const gate = s > (1 - p.amount * 0.85) ? 1 : 0;
        const dx = (rnd(i * 3.1) - 0.5) * 2 * p.amount * 0.18 * env.width * gate;
        ctx.drawImage(src, 0, i * bh, env.width, bh + 1, dx, i * bh, env.width, bh + 1);
        if (gate && p.rgbSplit > 0) {
          ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.55;
          ctx.drawImage(src, 0, i * bh, env.width, bh + 1, dx + p.rgbSplit, i * bh, env.width, bh + 1);
          ctx.restore();
        }
      }
    },
  },

  /* ══════════ 15. LUMA KEY (spill-suppressed) ══════════ */
  lumaKey: {
    id: 'lumaKey', name: 'Luma Key', category: 'key', cost: 'low', passes: 1,
    params: { cutoff: P(0.5, 0, 1, 'Cut-off'), softness: P(0.15, 0.001, 1, 'Softness'), invert: P(0, 0, 1, 'Invert', '', 1) },
    uniforms: p => ({ uCutoff: p.cutoff, uSoft: p.softness, uInvert: p.invert }),
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        float k = smoothstep(uCutoff - uSoft, uCutoff + uSoft, l);
        k = mix(k, 1.0 - k, uInvert);
        return vec4(c.rgb, c.a * k);
      }`,
    canvas2d(ctx, src, p, env) {
      const s = env.scratch(env.width, env.height), g = s.getContext('2d');
      g.clearRect(0, 0, env.width, env.height); g.drawImage(src, 0, 0);
      g.globalCompositeOperation = 'destination-in';
      const grad = g.createLinearGradient(0, 0, 0, env.height);
      grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#fff');
      g.fillStyle = grad; g.fillRect(0, 0, env.width, env.height);
      // approximate the luma ramp with contrast+invert filters on the alpha
      ctx.save();
      ctx.filter = `grayscale(1) contrast(${(1 / Math.max(0.02, p.softness)).toFixed(2)}) invert(${p.invert ? 1 : 0})`;
      ctx.drawImage(s, 0, 0);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    },
    degraded: 'canvas2d luma key approximates the ramp with filter contrast',
  },

  /* ══════════ 16. COLOUR KEY (chroma) ══════════ */
  colorKey: {
    id: 'colorKey', name: 'Colour Key', category: 'key', cost: 'medium', passes: 1,
    params: {
      color: { def: '#00ff00', label: 'Key colour', type: 'color' }, tolerance: P(0.35, 0, 1, 'Tolerance'),
      softness: P(0.12, 0.001, 0.6, 'Edge softness'), spill: P(0.6, 0, 1, 'Spill suppression'),
    },
    uniforms: (p, env) => { const c = env.parseColor(p.color); return { uKey: [c.r / 255, c.g / 255, c.b / 255], uTol: p.tolerance, uSoft: p.softness, uSpill: p.spill }; },
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        float d = distance(c.rgb, uKey);
        float k = smoothstep(uTol, uTol + uSoft, d);
        vec3 rgb = c.rgb;
        float spillAmt = max(0.0, rgb.g - max(rgb.r, rgb.b));
        rgb.g -= spillAmt * uSpill * (1.0 - k);
        return vec4(rgb, c.a * k);
      }`,
    canvas2d(ctx, src, p, env) {
      ctx.save();
      ctx.drawImage(src, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = Math.min(1, p.tolerance * 2 + 0.2);
      ctx.fillStyle = p.color;
      ctx.filter = `blur(${(p.softness * 20).toFixed(1)}px)`;
      ctx.fillRect(0, 0, env.width, env.height);
      ctx.restore();
    },
    degraded: 'canvas2d chroma key is a composite approximation; the GPU path is exact',
  },

  /* ══════════ 19. HALFTONE / DOT SCREEN (print-screen texture) ══════════ */
  halftone: {
    id: 'halftone', premultiplied: true, name: 'Halftone Screen', category: 'stylize', cost: 'medium', passes: 1,
    params: {
      cell: P(8, 3, 40, 'Cell', 'px', 1), angle: P(0, -90, 90, 'Angle', '°'),
      ink: { def: '#0b0d10', label: 'Ink', type: 'color' },
      mix: P(0.5, 0, 1, 'Mix'), modulation: P(0, 0, 1, 'Luma modulation'),
    },
    uniforms: (p, env) => {
      const c = env.parseColor(p.ink);
      return { uCell: p.cell, uAngle: p.angle * Math.PI / 180, uInk: [c.r / 255, c.g / 255, c.b / 255], uMix: p.mix, uMod: p.modulation };
    },
    glsl: `
      vec4 effect(vec2 uv){
        vec4 c = texture(uSrc, uv);
        float a = c.a;
        // the pipeline hands us PREMULTIPLIED colour; work in straight space
        vec3 straight = a > 0.001 ? c.rgb / a : vec3(0.0);
        // y-down convention (canvas order), else the dot lattice phases
        // differently per backend whenever raster height % cell != 0
        vec2 px = vec2(uv.x, 1.0 - uv.y) * uRes;
        float ca = cos(uAngle), sa = sin(uAngle);
        vec2 g  = vec2(ca*px.x + sa*px.y, -sa*px.x + ca*px.y) / uCell;
        vec2 gc = (floor(g) + 0.5) * uCell;
        vec2 sp = vec2(ca*gc.x - sa*gc.y, sa*gc.x + ca*gc.y);
        vec4 sc4 = texture(uSrc, clamp(sp / uRes, 0.0, 1.0));
        vec3 cc = sc4.a > 0.001 ? sc4.rgb / sc4.a : vec3(0.0);
        float lum = dot(cc, vec3(0.2126, 0.7152, 0.0722));
        float rad = mix(0.30, 0.5 * sqrt(clamp(1.0 - lum, 0.04, 1.0)), uMod);
        float d = length(fract(g) - 0.5);
        float dot = 1.0 - smoothstep(rad - 0.06, rad + 0.06, d);
        vec3 rgb = mix(straight, uInk, dot * uMix);
        return vec4(rgb * a, a);
      }`,
    canvas2d(ctx, src, p, env) {
      const W = env.width, H = env.height;
      ctx.drawImage(src, 0, 0);
      if (p.mix <= 0.001) return;
      const sc = new OffscreenCanvas(W, H);
      const sg = sc.getContext('2d', { willReadFrequently: true });
      sg.drawImage(src, 0, 0);
      const sd = sg.getImageData(0, 0, W, H).data;
      const ink = env.parseColor(p.ink);
      const ca = Math.cos(p.angle * Math.PI / 180), sa = Math.sin(p.angle * Math.PI / 180);
      const cell = p.cell;
      const lumCache = new Map();
      const cellLuma = (gi, gj) => {
        const k = gi + ',' + gj;
        const hit = lumCache.get(k);
        if (hit !== undefined) return hit;
        const gx = (gi + 0.5) * cell, gy = (gj + 0.5) * cell;
        let x = Math.round(ca * gx - sa * gy), y = Math.round(sa * gx + ca * gy);
        x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
        const i = (y * W + x) * 4;
        const v = (0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]) / 255;
        lumCache.set(k, v);
        return v;
      };
      const out = sg.createImageData(W, H);
      const od = out.data;
      const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // texel-centre convention, identical to the shader's uv*uRes
          const xc = x + 0.5, yc = y + 0.5;
          const gx = ca * xc + sa * yc, gy = -sa * xc + ca * yc;
          const fx = gx / cell - Math.floor(gx / cell) - 0.5;
          const fy = gy / cell - Math.floor(gy / cell) - 0.5;
          const lum = cellLuma(Math.floor(gx / cell), Math.floor(gy / cell));
          const rad = 0.30 * (1 - p.modulation) + (0.5 * Math.sqrt(Math.max(0.04, Math.min(1, 1 - lum)))) * p.modulation;
          const d = Math.hypot(fx, fy);
          const dot = 1 - smooth(rad - 0.06, rad + 0.06, d);
          const a = dot * p.mix;
          const i0 = (y * W + x) * 4;
          if (a <= 0.004) { od[i0] = sd[i0]; od[i0 + 1] = sd[i0 + 1]; od[i0 + 2] = sd[i0 + 2]; od[i0 + 3] = sd[i0 + 3]; continue; }
          const i = (y * W + x) * 4;
          // same contract as the shader: straight-space mix, alpha untouched
          od[i] = Math.round(sd[i] + (ink.r - sd[i]) * a);
          od[i + 1] = Math.round(sd[i + 1] + (ink.g - sd[i + 1]) * a);
          od[i + 2] = Math.round(sd[i + 2] + (ink.b - sd[i + 2]) * a);
          od[i + 3] = sd[i + 3];
        }
      }
      sg.putImageData(out, 0, 0);
      ctx.drawImage(sc, 0, 0);
    },
  },
};

/* ── lookup helpers used by the UI and the renderers ── */
export const EFFECT_LIST = Object.values(EFFECTS);
export function effectById(id) { return EFFECTS[id] || null; }
export function effectsByCategory() {
  const out = {};
  for (const e of EFFECT_LIST) (out[e.category] ||= []).push(e);
  return out;
}
export function defaultParams(effect) {
  const p = {};
  for (const [k, v] of Object.entries(effect.params || {})) p[k] = v.def;
  return p;
}
export function clampParams(effect, params) {
  const out = {};
  for (const [k, v] of Object.entries(effect.params || {})) {
    const raw = params?.[k] ?? v.def;
    out[k] = v.type === 'color' ? String(raw)
      : Math.min(v.max, Math.max(v.min, Number.isFinite(+raw) ? +raw : v.def));
  }
  return out;
}
export function createEffectInstance(effectId, over = {}) {
  const e = effectById(effectId);
  if (!e) return null;
  return { uid: over.uid || ('fx' + Math.random().toString(36).slice(2, 8)), id: effectId, name: e.name, enabled: true, params: { ...defaultParams(e), ...(over.params || {}) }, blend: 'normal', opacity: 1 };
}
