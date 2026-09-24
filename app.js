// 볼 꼬집기
// 사진을 WebGL로 그리고, CPU 격자에서 스프링-댐퍼 물리를 돌린 뒤, 화면은 픽셀 단위 역방향 워프로 그린다.
// 좌표계: 이미지 공간. 가로 = 1, 세로 = A(세로/가로 비율). 원본 사진은 절대 수정하지 않는다.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const canvas = $('#gl');
  const regionsEl = $('#regions');
  const hintEl = $('#hint');
  const toastEl = $('#toast');

  // 의존성 없는 치명 오류 안내 (WebGL 없음 등). 아래 toast/showCoach보다 먼저 쓸 수 있어야 한다.
  function fatal(msg) {
    $('#coachText').textContent = msg;
    $('#coachBtns').innerHTML = '';
    $('#coach').hidden = false;
    for (const id of ['#btnPhoto', '#btnEdit', '#btnFeel']) $(id).disabled = true;
  }

  // ---------- 설정 ----------
  // 의견 보내기 버튼이 여는 주소(구글 폼 등). 비어 있으면 버튼을 숨기고 의견 부탁 카드도 띄우지 않는다.
  const FEEDBACK_URL = '';
  // 구글 폼 "미리 채우기" 항목 id. 예: { releases: 'entry.123', faces: 'entry.456', ua: 'entry.789' }. 사진은 절대 포함하지 않는다.
  const FEEDBACK_PREFILL = {};
  const NUDGE_AFTER = 12; // 이만큼 당기고 놓으면 한 번 의견을 부탁한다
  const DEV = new URLSearchParams(location.search).has('dev');

  const DEFAULTS = { freq: 4, wobble: 0.75, stretch: 0.6, grab: 1.0, mask: true, show: false, haptic: true };
  const RANGES = { freq: [2, 8], wobble: [0, 1], stretch: [0.3, 1], grab: [0.6, 1.4] };
  const PRESETS = { soft: { freq: 3, wobble: 0.9 }, chewy: { freq: 4, wobble: 0.75 }, bouncy: { freq: 6, wobble: 0.4 } };
  const settings = loadSettings();

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ }
  }
  function flag(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
  function setFlag(key) { try { localStorage.setItem(key, '1'); } catch { /* 무시 */ } }
  // 저장된 값은 믿지 않는다: 범위 밖·타입 오류는 기본값으로
  function loadSettings() {
    const raw = loadJSON('cheek.settings');
    const s = { ...DEFAULTS };
    for (const k of Object.keys(RANGES)) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v)) s[k] = Math.min(RANGES[k][1], Math.max(RANGES[k][0], v));
    }
    for (const k of ['mask', 'show', 'haptic']) if (typeof raw[k] === 'boolean') s[k] = raw[k];
    if (!DEV) s.mask = true; // 배경까지 늘어나는 모드는 개발용
    return s;
  }
  function saveSettings() { saveJSON('cheek.settings', settings); }

  // ---------- WebGL ----------
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
  if (!gl) {
    fatal('이 브라우저에서는 사진을 움직일 수 없어요. 크롬이나 사파리에서 열어주세요.');
    return;
  }

  // 화면에는 사진 전체를 덮는 사각형 하나만 그린다. 변형은 프래그먼트 셰이더가 픽셀마다 계산한다.
  // 물리는 "원본의 점 r이 r + d(r)로 간다"(전진). 화면 픽셀 p에는 r + d(r) = p 인 r의 색을 보여야 하므로
  // 그 r을 감쇠 고정점 반복으로 찾는다. 삼각형 메시로 그리면 실루엣이 다각형처럼 보이고 세게 당기면 접히는데,
  // 이 방식은 격자와 무관하게 매끈하고 접히지 않는다.
  const VS = `
    attribute vec2 aPos; attribute vec2 aUV;
    uniform vec2 uO; uniform vec2 uS;
    varying vec2 vUV;
    void main() {
      vUV = aUV;
      gl_Position = vec4(uO.x + aPos.x * uS.x, uO.y - aPos.y * uS.y, 0.0, 1.0);
    }`;
  const FS = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D uTex;   // 사진
    uniform sampler2D uDisp;  // 격자 변위장 (RGBA8에 16비트씩 인코딩: xy)
    uniform sampler2D uMask;  // 보호할 얼굴(앞사람) 마스크
    uniform vec2 uGrid;       // 격자 점 개수 (cols+1, rows+1)
    uniform float uA;         // 세로/가로
    uniform float uUseMask;

    // 16비트 정수 인코딩: 값 = (hi*256 + lo - 32768) / 32767. 정지(0)가 정확히 0으로 복원되어야 조기 종료가 된다.
    vec2 fetchDisp(vec2 ij) {
      vec4 t = texture2D(uDisp, (ij + 0.5) / uGrid);
      float hx = floor(t.r * 255.0 + 0.5), lx = floor(t.g * 255.0 + 0.5);
      float hy = floor(t.b * 255.0 + 0.5), ly = floor(t.a * 255.0 + 0.5);
      return vec2(hx * 256.0 + lx - 32768.0, hy * 256.0 + ly - 32768.0) / 32767.0;
    }
    // Catmull-Rom 가중치
    vec4 cubicW(float f) {
      float f2 = f * f, f3 = f2 * f;
      return vec4(-0.5*f3 + f2 - 0.5*f, 1.5*f3 - 2.5*f2 + 1.0, -1.5*f3 + 2.0*f2 + 0.5*f, 0.5*f3 - 0.5*f2);
    }
    vec2 dispAt(vec2 uv) {
      vec2 g = uv * (uGrid - 1.0);          // 격자 좌표
      vec2 i0 = floor(g);
      vec2 f = g - i0;
      vec4 wx = cubicW(f.x), wy = cubicW(f.y);
      vec2 acc = vec2(0.0);
      for (int j = -1; j <= 2; j++) {
        float wyj = j == -1 ? wy.x : (j == 0 ? wy.y : (j == 1 ? wy.z : wy.w));
        vec2 row = vec2(0.0);
        for (int i = -1; i <= 2; i++) {
          float wxi = i == -1 ? wx.x : (i == 0 ? wx.y : (i == 1 ? wx.z : wx.w));
          vec2 ij = clamp(i0 + vec2(float(i), float(j)), vec2(0.0), uGrid - 1.0);
          row += wxi * fetchDisp(ij);
        }
        acc += wyj * row;
      }
      return acc;
    }
    // 빠른 쌍선형 보간 (반복 중간 단계용)
    vec2 dispBilin(vec2 uv) {
      vec2 g = uv * (uGrid - 1.0);
      vec2 i0 = floor(g);
      vec2 f = g - i0;
      vec2 a = fetchDisp(clamp(i0, vec2(0.0), uGrid - 1.0));
      vec2 b = fetchDisp(clamp(i0 + vec2(1.0, 0.0), vec2(0.0), uGrid - 1.0));
      vec2 c = fetchDisp(clamp(i0 + vec2(0.0, 1.0), vec2(0.0), uGrid - 1.0));
      vec2 d = fetchDisp(clamp(i0 + vec2(1.0, 1.0), vec2(0.0), uGrid - 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    // 원본 위치의 변위 배율. 보호할 얼굴(앞사람) 안쪽이면 0.
    float freeAt(vec2 uv) { return uUseMask > 0.5 ? 1.0 - texture2D(uMask, uv).a : 1.0; }
    vec2 toUV(vec2 r) { return vec2(r.x, r.y / uA); }

    void main() {
      vec2 p = vec2(vUV.x, vUV.y * uA);
      vec2 r = p;
      vec2 d = dispAt(vUV) * freeAt(vUV);
      if (dot(d, d) < 1e-9) { gl_FragColor = texture2D(uTex, vUV); return; } // 안 움직이는 픽셀은 바로
      // 감쇠(0.7) 고정점 반복: 당김의 안쪽(진동하는 쪽)에서도 안정적으로 수렴한다.
      // 한 번만 p - d(p)로 계산하면 반대편(입 쪽) 내용이 볼 중심으로 끌려오는 엉뚱한 느낌이 난다(실제로 겪음).
      r = p - d;
      for (int k = 0; k < 6; k++) {
        d = dispBilin(toUV(r)) * freeAt(toUV(r));
        r += 0.7 * (p - d - r);
      }
      d = dispAt(toUV(r)) * freeAt(toUV(r));
      r += 0.7 * (p - d - r);
      gl_FragColor = texture2D(uTex, clamp(toUV(r), 0.0, 1.0));
    }`;

  let prog, locPos, locUV, locO, locS, locUseMask, locGrid, locA, posBuf, uvBuf, tex, maskTex, dispTex;
  let MAX_TEX = 2048;
  let curO = [-1, 1], curS = [2, 2]; // 마지막으로 올린 화면 변환 (캡처 뒤 복구용)

  function initGL() {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    locPos = gl.getAttribLocation(prog, 'aPos');
    locUV = gl.getAttribLocation(prog, 'aUV');
    locO = gl.getUniformLocation(prog, 'uO');
    locS = gl.getUniformLocation(prog, 'uS');
    locUseMask = gl.getUniformLocation(prog, 'uUseMask');
    locGrid = gl.getUniformLocation(prog, 'uGrid');
    locA = gl.getUniformLocation(prog, 'uA');
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uMask'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'uDisp'), 2);
    posBuf = gl.createBuffer(); uvBuf = gl.createBuffer();
    tex = gl.createTexture(); maskTex = gl.createTexture(); dispTex = gl.createTexture();
    MAX_TEX = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048; // 컨텍스트 손실 중엔 null이 온다
    // 마스크 텍스처는 쓰기 전에도 완전한 상태여야 한다(1×1 투명)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    texParams(gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    // 사진을 덮는 사각형 하나 (위치는 buildMesh에서 A에 맞춰 채움)
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(locPos);
    gl.enableVertexAttribArray(locUV);
    gl.clearColor(0xff / 255, 0xec / 255, 0xef / 255, 1); // = CSS --stage
    maskActive = false; maskKey = '';
    cap = null;
  }
  function texParams(filter) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  }

  // ---------- 메시 + 물리 상태 ----------
  const GRID_LONG = 128; // 긴 변 기준 물리 격자 칸 수. 화면은 픽셀 단위로 보간하므로 이 값이 실루엣 품질을 정하지 않는다.
  let A = 1;            // 이미지 세로/가로 비율
  let cols, rows, n, stride;
  let restX, restY, dx, dy, vx, vy, tgtX, tgtY, held, free, owner, dispBytes;
  let srcCanvas = null; // 텍스처 원본(컨텍스트 복구·캡처용)

  function buildMesh() {
    if (A >= 1) { rows = GRID_LONG; cols = Math.max(8, Math.round(GRID_LONG / A)); }
    else { cols = GRID_LONG; rows = Math.max(8, Math.round(GRID_LONG * A)); }
    stride = cols + 1;
    n = stride * (rows + 1);
    restX = new Float32Array(n); restY = new Float32Array(n);
    dx = new Float32Array(n); dy = new Float32Array(n);
    vx = new Float32Array(n); vy = new Float32Array(n);
    tgtX = new Float32Array(n); tgtY = new Float32Array(n); held = new Float32Array(n);
    free = new Uint8Array(n); owner = new Int16Array(n);
    dispBytes = new Uint8Array(n * 4);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      restX[k] = i / cols; restY[k] = (j / rows) * A;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, A, 1, A]), gl.STATIC_DRAW);
    gl.uniform2f(locGrid, cols + 1, rows + 1);
    gl.uniform1f(locA, A);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, dispTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols + 1, rows + 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    texParams(gl.NEAREST); // 보간은 셰이더가 직접 한다
    gl.activeTexture(gl.TEXTURE0);
    updateFree();
  }

  // ---------- 볼 영역 ----------
  // cx, cy, r 모두 이미지 가로 = 1 기준. face: 어느 얼굴 것인지(자동 인식), W: 그 얼굴 폭. 수동 원은 face -1.
  let regions = [];
  function defaultRegions() {
    return [
      { cx: 0.33, cy: 0.55 * A, r: 0.12, face: -1, W: Infinity },
      { cx: 0.67, cy: 0.55 * A, r: 0.12, face: -1, W: Infinity },
    ];
  }

  // 영역 반지름 대비 비율. 원 안쪽은 100% 움직이고, 원 밖 주변 피부는 점점 줄어 MASK_OUTER에서 완전히 고정된다.
  const MASK_INNER = 0.7, MASK_OUTER = 1.5;
  const GRAB_HIT = 1.1;  // 원의 이 배율 안을 눌러야 잡힌다
  const MIN_HIT_PX = 28; // 단, 화면에서 손가락 크기만큼은 항상 잡힌다
  const GRAB_BASE = 1.3; // 잡는 범위(반지름) = 원 반지름 × 이 값 × 설정값
  function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function regionMask(reg, x, y) {
    const d = Math.hypot(x - reg.cx, y - reg.cy);
    return 1 - smoothstep(reg.r * MASK_INNER, reg.r * MASK_OUTER, d);
  }

  // 얼굴 타원·윤곽. 자동 인식 때만 채워진다. { id, cx, cy, rx, ry, W, box, poly }
  // 얼굴이 겹치면 앞에 있는 얼굴의 안쪽은 뒷사람 볼을 당겨도 움직이지 않게 보호한다.
  // 앞/뒤는 "윤곽 상자가 겹치고, 폭이 1.5배 이상 큰 쪽이 앞"일 때만 판정한다. 어른+아기처럼 비율이 애매하면
  // 판정하지 않는다(틀린 보호는 얼굴 안에 고정 조각을 만들어 더 눈에 띈다).
  let faceOvals = [];
  const movingFaces = new Map(); // 잡혔거나 놓았지만 아직 출렁이는 얼굴 id → 마지막으로 잡은 볼. settle()에서 비운다.
  const FRONT_RATIO = 1.5;
  const ovalById = (id) => faceOvals.find((o) => o.id === id);
  function boxesOverlap(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }
  // 타원 o가 얼굴 f(볼 reg의 얼굴)보다 앞에 있나: 폭이 1.5배 이상이고, 얼굴 상자끼리 겹치거나 볼 영향권이 o에 닿을 때
  function inFrontOf(o, f, reg) {
    if (o.id === f.id || o.W < f.W * FRONT_RATIO) return false;
    if (boxesOverlap(o.box, f.box)) return true;
    if (!reg) return false;
    const R = reg.r * MASK_OUTER;
    return reg.cx + R > o.box.x0 && reg.cx - R < o.box.x1 && reg.cy + R > o.box.y0 && reg.cy - R < o.box.y1;
  }
  function protection(reg, x, y) {
    if (reg.face === undefined || reg.face < 0) return 1;
    const f = ovalById(reg.face);
    if (!f) return 1;
    let p = 1;
    for (const o of faceOvals) {
      if (!inFrontOf(o, f, reg)) continue;
      const e = Math.hypot((x - o.cx) / o.rx, (y - o.cy) / o.ry);
      p *= smoothstep(0.7, 1.2, e); // 타원 안 0 → 경계 밖 1. 띠를 넓게 잡아 변위가 급하게 꺾이지 않게(정확한 경계는 픽셀 마스크가 맡음)
      if (p === 0) break;
    }
    return p;
  }
  function effMask(reg, x, y) {
    const m = regionMask(reg, x, y);
    return m > 0 && faceOvals.length ? m * protection(reg, x, y) : m;
  }

  // 정점마다 움직일 수 있는지(free)와 주인 볼(owner)을 정한다.
  // 테두리는 항상 고정. 마스크 모드에서는 어느 볼 영역에도 안 들면 고정.
  // 주인이 다른 이웃끼리는 물리 결합을 끊어서, 한 사람 볼을 놓았을 때의 출렁임이 옆 사람 볼로 번지지 않는다.
  function updateFree() {
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      let f = i > 0 && i < cols && j > 0 && j < rows;
      let best = 0, bi = -1;
      if (f && settings.mask) {
        for (let r = 0; r < regions.length; r++) {
          const m = effMask(regions[r], restX[k], restY[k]);
          if (m > best) { best = m; bi = r; }
        }
        f = bi >= 0;
      }
      free[k] = f ? 1 : 0;
      owner[k] = bi;
      if (!f) { dx[k] = dy[k] = vx[k] = vy[k] = 0; }
    }
  }

  // ---------- 잡기 (손가락마다 독립) ----------
  // pointerId -> { sx, sy, Dx, Dy, limit, w, face }. w는 그 손가락이 각 정점을 끌고 가는 비율(0~1).
  const grabs = new Map();
  const MAX_GRABS = 4;
  const DEMO_ID = -1;
  const userGrabCount = () => grabs.size - (grabs.has(DEMO_ID) ? 1 : 0);

  function beginGrab(id, x, y) {
    if (grabs.size >= MAX_GRABS || grabs.has(id)) return false;
    const fx = x, fy = y; // 손가락 실제 위치 = 당김 기준점. 아래 x, y는 가중치 중심(작은 볼이면 중심 쪽으로 당김)
    let reg = null, regIdx = -1, Rg;
    if (settings.mask) {
      const hitR = (r) => Math.max(r.r * GRAB_HIT, MIN_HIT_PX / imgRect.w);
      // 앞사람에게 가려진 볼(보호 때문에 안 움직일 볼)은 뒤로 미룬다
      const pick = (skipCovered) => {
        let best = Infinity, b = null, bi = -1;
        for (let i = 0; i < regions.length; i++) {
          const r = regions[i];
          const d = Math.hypot(x - r.cx, y - r.cy);
          if (d >= hitR(r) || d >= best) continue;
          if (skipCovered && faceOvals.length && protection(r, x, y) < 0.3) continue;
          best = d; b = r; bi = i;
        }
        return [b, bi];
      };
      [reg, regIdx] = pick(true);
      if (!reg) [reg, regIdx] = pick(false);
      if (!reg) return false;
      // 작은 볼을 손가락 크기 범위로 잡았으면, 손가락 위치를 볼 중심 쪽으로 당겨 실제로 늘어나게 한다
      const d = Math.hypot(x - reg.cx, y - reg.cy);
      if (d > reg.r * 0.7) { const s = (reg.r * 0.7) / d; x = reg.cx + (x - reg.cx) * s; y = reg.cy + (y - reg.cy) * s; }
      Rg = Math.max(reg.r, MIN_HIT_PX / imgRect.w) * GRAB_BASE * settings.grab;
    } else {
      const avg = regions.reduce((s, r) => s + r.r, 0) / (regions.length || 1) || 0.12;
      Rg = avg * GRAB_BASE * settings.grab;
    }
    const w = new Float32Array(n);
    let wsum = 0;
    for (let k = 0; k < n; k++) {
      // 주인 볼과 상관없이 이 볼의 영향권(effMask) 안이면 전부 부드럽게 따라온다.
      // 주인으로 걸러내면 두 사람 볼 영역이 겹치는 경계에서 한 칸씩 어긋난 톱니가 생긴다(실제로 겪음).
      if (!free[k]) continue;
      const q = Math.hypot(restX[k] - x, restY[k] - y) / Rg;
      let g = q < 1 ? (1 - q * q) * (1 - q * q) : 0;
      if (reg) g *= effMask(reg, restX[k], restY[k]);
      w[k] = g; wsum += g;
    }
    if (wsum < 0.05) return false; // 움직일 수 있는 점이 없다(전부 보호 안) → 잡지 않은 것으로
    // 접힘 방지용 가중치 기울기(부호 있음). 변위 d = w·D·u 의 야코비안 행렬식은 1 + D·(u·∇w) 이므로
    // 당기는 방향 u에 대해 D < 1 / max(−u·∇w) 이어야 접히지 않는다. 한계는 moveGrab에서 방향마다 계산한다.
    const gX = new Float32Array(n), gY = new Float32Array(n);
    for (let j = 0; j < rows; j++) for (let i = 0, k = j * stride; i < cols; i++, k++) {
      gX[k] = (w[k + 1] - w[k]) * cols; gY[k] = (w[k + stride] - w[k]) * rows / A;
    }
    grabs.set(id, { sx: fx, sy: fy, Dx: 0, Dy: 0, Rg, limit: Rg * settings.stretch, w, gX, gY, face: reg ? reg.face : -1, reg });
    if (reg && reg.face >= 0) movingFaces.set(reg.face, reg);
    updateTargets();
    updateProtectMask();
    wake();
    return true;
  }

  function moveGrab(id, x, y) {
    const g = grabs.get(id);
    if (!g) return;
    // 당긴 거리에 부드러운 한계를 둔다(tanh). 한계를 넘기면 사진이 접혀 찢어져 보인다.
    const mx = x - g.sx, my = y - g.sy;
    const len = Math.hypot(mx, my);
    if (len < 1e-6) { g.Dx = g.Dy = 0; }
    else {
      // 이 방향으로 눌리는 쪽의 최대 압축률 m → 접힘 한계 0.9/m (여유 10%). 슬라이더 한계와 작은 쪽.
      const ux = mx / len, uy = my / len;
      let m = 0;
      const gX = g.gX, gY = g.gY;
      for (let k = 0; k < n; k++) { const c = -(ux * gX[k] + uy * gY[k]); if (c > m) m = c; }
      g.limit = Math.min(g.Rg * settings.stretch, m > 0 ? 0.9 / m : Infinity);
      const s = (g.limit * Math.tanh(len / g.limit)) / len;
      g.Dx = mx * s; g.Dy = my * s;
    }
    updateTargets();
    wake();
  }

  function endGrab(id) {
    if (!grabs.delete(id)) return false;
    updateTargets();
    updateProtectMask();
    wake();
    return true;
  }

  function clearGrabs() {
    grabs.clear();
    if (n) { updateTargets(); updateProtectMask(); }
  }

  // 모든 손가락의 당김을 합쳐 정점별 목표 변위(tgtX, tgtY)와 "잡혀 있는 정도"(held)를 만든다.
  // 같은 볼을 두 손가락으로 같은 방향으로 당기면 단순 합산으로 한계의 2배가 되어 접힌다 →
  // 손가락마다 자기 영향권 안의 held 최댓값으로 나눈다(같은 자리 두 손가락 = 한 손가락, 마주 집기는 그대로).
  function updateTargets() {
    tgtX.fill(0); tgtY.fill(0); held.fill(0);
    for (const g of grabs.values()) {
      const w = g.w;
      for (let k = 0; k < n; k++) if (w[k] !== 0) held[k] += w[k];
    }
    for (const g of grabs.values()) {
      const w = g.w;
      let hmax = 0;
      for (let k = 0; k < n; k++) if (w[k] !== 0 && held[k] > hmax) hmax = held[k];
      const s = 1 / Math.max(1, hmax);
      for (let k = 0; k < n; k++) {
        const wk = w[k];
        if (wk === 0) continue;
        tgtX[k] += wk * g.Dx * s; tgtY[k] += wk * g.Dy * s;
      }
    }
  }

  // ---------- 물리 ----------
  const DT = 1 / 180;
  const K_HOLD = 1600, ZETA_HOLD = 0.7; // 잡고 있을 때: 손가락을 빠르게 따라오되 살짝 끌려오는 느낌

  function step() {
    const om = 2 * Math.PI * settings.freq;
    const kRel = om * om;
    const kc = kRel * 1.5; // 이웃 정점끼리의 결합. 가운데와 가장자리가 어긋나게 흔들려 젤리처럼 보인다.
    const zetaRel = 0.6 - 0.52 * settings.wobble;
    const cRel = 2 * zetaRel * om, cHold = 2 * ZETA_HOLD * Math.sqrt(K_HOLD);
    let energy = 0;
    for (let j = 1; j < rows; j++) {
      for (let i = 1, k0 = j * stride + 1; i < cols; i++, k0++) {
        if (!free[k0]) continue;
        // 잡힌 정점만 단단한 스프링으로 손가락을 따라가고, 나머지는 놓임 상태로 출렁인다
        const isHeld = held[k0] > 0.002;
        const k = isHeld ? K_HOLD : kRel, c = isHeld ? cHold : cRel;
        const tx = tgtX[k0], ty = tgtY[k0];
        const o = owner[k0];
        const a = k0 - 1, b = k0 + 1, u = k0 - stride, d = k0 + stride;
        const lx = (owner[a] === o ? dx[a] : 0) + (owner[b] === o ? dx[b] : 0) + (owner[u] === o ? dx[u] : 0) + (owner[d] === o ? dx[d] : 0) - 4 * dx[k0];
        const ly = (owner[a] === o ? dy[a] : 0) + (owner[b] === o ? dy[b] : 0) + (owner[u] === o ? dy[u] : 0) + (owner[d] === o ? dy[d] : 0) - 4 * dy[k0];
        vx[k0] += (-k * (dx[k0] - tx) - c * vx[k0] + kc * lx) * DT;
        vy[k0] += (-k * (dy[k0] - ty) - c * vy[k0] + kc * ly) * DT;
      }
    }
    // 위치는 속도를 전부 구한 뒤에 옮긴다. 한 루프에서 같이 옮기면 이웃 결합이 비대칭이 되어 진동이 커진다.
    for (let k0 = 0; k0 < n; k0++) {
      if (!free[k0]) continue;
      dx[k0] += vx[k0] * DT;
      dy[k0] += vy[k0] * DT;
      const e = Math.abs(dx[k0]) + Math.abs(dy[k0]) + (Math.abs(vx[k0]) + Math.abs(vy[k0])) * 0.02;
      if (e > energy) energy = e;
    }
    return energy;
  }

  function settle() {
    if (!n) return;
    dx.fill(0); dy.fill(0); vx.fill(0); vy.fill(0);
    maskActive = false; maskKey = '';
    movingFaces.clear();
  }

  // ---------- 루프 ----------
  let running = false, lastT = 0, acc = 0;
  function wake() {
    if (running) return;
    running = true; lastT = performance.now(); acc = 0;
    requestAnimationFrame(frame);
  }
  function frame(t) {
    acc += Math.min(0.05, (t - lastT) / 1000); lastT = t;
    let energy = 1;
    while (acc >= DT) { energy = step(); acc -= DT; }
    if (grabs.size === 0 && energy < 2e-5) {
      settle(); running = false;
      if (capSnap) { const snap = capSnap; capSnap = null; captureFrame(snap); } // 놓는 순간의 장면은 멈춘 뒤에 찍는다(첫 출렁임을 안 끊게)
      applyPendingFaces();
    }
    render();
    if (running) requestAnimationFrame(frame);
  }

  // ---------- 그리기 ----------
  let imgRect = { x: 0, y: 0, w: 1, h: 1 }; // 스테이지 안에서 사진이 차지하는 CSS 픽셀 영역
  // 사용자가 조절하는 보기: z = 화면에 꽉 맞춘 크기 대비 배율, (cx, cy) = 화면 중앙에 오는 이미지 좌표
  const view = { z: 1, cx: 0.5, cy: 0.5 };
  const ZOOM_MAX = 6;
  let fitW = 1;
  function resetView() { view.z = 1; view.cx = 0.5; view.cy = A / 2; layout(); }
  function viewChanged() { return view.z > 1.01 || Math.abs(view.cx - 0.5) > 0.01 || Math.abs(view.cy - A / 2) > 0.01; }

  function layout() {
    const r = stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    fitW = A > r.height / r.width ? r.height / A : r.width;
    const W = fitW * view.z, H = W * A;
    let x = r.width / 2 - view.cx * W, y = r.height / 2 - view.cy * W;
    // 사진이 화면보다 작으면 가운데, 크면 가장자리를 넘어가지 않게
    x = W <= r.width ? (r.width - W) / 2 : Math.min(0, Math.max(r.width - W, x));
    y = H <= r.height ? (r.height - H) / 2 : Math.min(0, Math.max(r.height - H, y));
    view.cx = (r.width / 2 - x) / W; view.cy = (r.height / 2 - y) / W;
    imgRect = { x, y, w: W, h: H };
    $('#resetView').hidden = !viewChanged();
    curO = [-1 + (2 * imgRect.x) / r.width, 1 - (2 * imgRect.y) / r.height];
    curS = [(2 * imgRect.w) / r.width, (2 * imgRect.h) / r.height / A];
    gl.uniform2f(locO, curO[0], curO[1]);
    gl.uniform2f(locS, curS[0], curS[1]);
    placeRegions();
    if (demo && demo.last) showFinger(demo.last.x, demo.last.y, demo.last.down);
    render();
  }

  function uploadDisp(ax = dx, ay = dy) {
    // 변위장을 16비트 정수×2로 인코딩해 텍스처에 올린다. 0은 정확히 32768 → 셰이더에서 정확히 0.
    for (let k = 0, o = 0; k < n; k++, o += 4) {
      const ex = 32768 + Math.round(Math.max(-32767, Math.min(32767, ax[k] * 32767)));
      const ey = 32768 + Math.round(Math.max(-32767, Math.min(32767, ay[k] * 32767)));
      dispBytes[o] = ex >> 8; dispBytes[o + 1] = ex & 255;
      dispBytes[o + 2] = ey >> 8; dispBytes[o + 3] = ey & 255;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, dispTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols + 1, rows + 1, gl.RGBA, gl.UNSIGNED_BYTE, dispBytes);
    gl.activeTexture(gl.TEXTURE0);
  }
  function drawQuad(useMask = maskActive) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(locUseMask, useMask ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.vertexAttribPointer(locUV, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function render() {
    if (!n) return;
    uploadDisp();
    drawQuad();
  }

  // ---------- 픽셀 단위 얼굴 보호 마스크 ----------
  // 잡힌 볼의 얼굴보다 앞에 있는 얼굴들의 윤곽 폴리곤을 캔버스에 칠해 텍스처로 올린다.
  // 이 마스크가 있는 동안 셰이더가 그 얼굴 픽셀의 변위를 0으로 만들어 원본 그대로 보여준다.
  let maskActive = false, maskKey = '';
  const MASK_PX = 768;
  function updateProtectMask() {
    // 움직이는 얼굴(잡힘 + 놓았지만 출렁이는 중)보다 앞에 있는 얼굴만 보호한다. 움직이는 얼굴 자신은 보호 대상에서 뺀다
    // (두 얼굴을 같이 잡았을 때 앞 얼굴의 당긴 볼이 원본으로 되돌아가던 회귀 방지).
    const moving = [];
    for (const [id, reg] of movingFaces) { const f = ovalById(id); if (f) moving.push({ f, reg }); }
    const front = moving.length ? faceOvals.filter((o) => o.poly && !movingFaces.has(o.id) && moving.some(({ f, reg }) => inFrontOf(o, f, reg))) : [];
    const key = front.map((o) => o.id).join(',');
    if (!front.length) { maskActive = false; maskKey = ''; return; }
    if (key === maskKey && maskActive) return;
    maskKey = key;
    const c = document.createElement('canvas');
    c.width = MASK_PX; c.height = Math.round(MASK_PX * A);
    const g = c.getContext('2d');
    // 이미지 공간(가로 1, 세로 A) → 캔버스 픽셀: 가로·세로 모두 MASK_PX 배 (세로를 /A 하면 마스크가 위로 찌그러진다 — 실제로 겪은 버그)
    const S = MASK_PX;
    g.fillStyle = '#fff';
    try { g.filter = 'blur(1.5px)'; } catch { /* 지원 안 하면 딱딱한 경계 */ }
    for (const o of front) {
      g.beginPath();
      o.poly.forEach(([x, y], i) => { if (i) g.lineTo(x * S, y * S); else g.moveTo(x * S, y * S); });
      g.closePath(); g.fill();
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    texParams(gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    maskActive = true;
  }

  function uploadTexture() {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    texParams(gl.LINEAR); // 2의 거듭제곱이 아닌 텍스처는 WebGL1에서 CLAMP + 밉맵 없음이어야 한다
  }

  // drawable: HTMLImageElement | ImageBitmap | HTMLCanvasElement
  function setImage(drawable, sw, sh, newRegions) {
    ++detectToken; setDetecting(false); // 진행 중이던 인식 결과는 버린다(사진 세대가 바뀜)
    const maxSide = Math.min(2048, MAX_TEX);
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
    const g = c.getContext('2d');
    g.fillStyle = '#FFECEF'; g.fillRect(0, 0, c.width, c.height); // 투명 PNG는 배경색 위에
    g.drawImage(drawable, 0, 0, c.width, c.height);
    srcCanvas = c;
    A = c.height / c.width;
    regions = newRegions || defaultRegions();
    faceOvals = []; // 자동 인식이 끝나면 다시 채운다
    grabs.clear(); nav.clear();
    missCount = 0; shareBlob = null; capSnap = null; pendingFaces = null; clearTimeout(shareTimer); $('#shareChip').hidden = true;
    movingFaces.clear();
    view.z = 1; view.cx = 0.5; view.cy = A / 2;
    uploadTexture();
    buildMesh();
    buildRegionEls();
    layout();
  }

  // ---------- 사진 불러오기 (기기 안에서만 처리) ----------
  // Blob/File → <img>로 디코드. 브라우저가 EXIF 회전을 적용한 크기가 naturalWidth/Height로 온다.
  // img.decode()는 백그라운드 탭에서 영원히 안 끝날 수 있어(실제로 겪음) onload를 쓴다. 디코드는 drawImage 때 된다.
  async function decodeImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const im = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error('image load failed'));
        el.src = url;
      });
      return { drawable: im, sw: im.naturalWidth, sh: im.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  }

  async function loadFile(file) {
    try {
      const { drawable, sw, sh } = await decodeImage(file);
      setImage(drawable, sw, sh, null);
    } catch (e) {
      console.error(e);
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const heic = /heic|heif/.test(ext) || /heic|heif/.test(file.type || '');
      showCoach(heic
        ? '고효율(HEIC) 사진이라 이 브라우저가 열지 못해요. 갤러리에서 JPG로 저장하거나 다른 사진을 골라주세요.'
        : '이 사진을 열 수 없어요. 다른 사진을 골라보세요.', [
        { label: '다른 사진 고르기', primary: true, onClick: () => { hideCoach(); openSheet('pick'); } },
        { label: '괜찮아요', onClick: hideCoach },
      ], true);
      return;
    }
    if (editing) setEditing(false);
    stopDemo();
    await autoPlaceCheeks();
  }

  // ---------- 샘플 사진 (AI로 만든 가상의 아기. 실존 인물 아님) ----------
  // 볼 위치는 detectFaces로 미리 계산해 두었다. 덕분에 첫 화면에서 인식 모델(약 7MB 전송)을 내려받지 않는다.
  // 사진을 바꾸면 이 좌표도 다시 계산할 것 (브라우저 콘솔에서 __cheek.detectFaces).
  const SAMPLES = [
    { src: 'samples/baby1.jpg', regions: [{ cx: 0.3516, cy: 0.7302, r: 0.117 }, { cx: 0.6851, cy: 0.6989, r: 0.117 }] },
    { src: 'samples/baby2.jpg', regions: [{ cx: 0.3380, cy: 0.7270, r: 0.117 }, { cx: 0.6640, cy: 0.7574, r: 0.117 }] },
    { src: 'samples/baby3.jpg', regions: [{ cx: 0.3451, cy: 0.6601, r: 0.117 }, { cx: 0.6823, cy: 0.6098, r: 0.117 }] },
  ];
  async function loadSample(i) {
    const smp = SAMPLES[i];
    const blob = await (await fetch(smp.src)).blob();
    const { drawable, sw, sh } = await decodeImage(blob);
    setImage(drawable, sw, sh, smp.regions.map((r) => ({ ...r, face: -1, W: Infinity })));
  }

  // ---------- 자동 볼 인식 (MediaPipe Face Landmarker, 기기 안에서만 실행) ----------
  // 모델과 wasm은 vendor/mediapipe에 자체 호스팅한다. 번들의 진단 로그 전송은 index.html의 CSP가 막는다.
  const MP = './vendor/mediapipe/';
  const MAX_FACES = 6;
  let landmarkerP = null, landmarkerReady = false, landmarkerBroken = false;
  // wasm SIMD가 없는 기기(iOS 16.3 이하 등)는 받아 봐야 실패하므로 미리 판정한다
  const SIMD_OK = (() => {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); }
    catch { return false; }
  })();
  function getLandmarker() {
    if (!SIMD_OK || landmarkerBroken) return Promise.reject(new Error('unsupported'));
    if (!landmarkerP) {
      landmarkerP = (async () => {
        const { FaceLandmarker } = await import(MP + 'vision_bundle.mjs');
        const lm = await FaceLandmarker.createFromOptions(
          { wasmLoaderPath: MP + 'vision_wasm_internal.js', wasmBinaryPath: MP + 'vision_wasm_internal.wasm' },
          {
            baseOptions: { modelAssetPath: MP + 'face_landmarker.task', delegate: 'CPU' }, // GPU delegate는 iOS에서 불안정. CPU 고정.
            runningMode: 'IMAGE',
            numFaces: MAX_FACES,
          },
        );
        landmarkerReady = true;
        return lm;
      })();
      landmarkerP.catch((e) => {
        landmarkerP = null;
        if (e && /CompileError|LinkError/.test(String(e.name || e))) landmarkerBroken = true; // 이 기기에선 안 됨. 재시도 낭비 방지
      });
    }
    return landmarkerP;
  }
  // 첫 사진에서 기다리지 않게, 놀이 시작 후 한가할 때 미리 받는다(데이터 절약 모드·느린 망이면 건너뜀)
  function preloadLandmarker() {
    const c = navigator.connection;
    if (c && (c.saveData || (c.effectiveType && c.effectiveType !== '4g'))) return;
    const go = () => getLandmarker().then((lm) => {
      if (detecting) return;
      if (demo || grabs.size || running) { setTimeout(go, 1500); return; } // 시범·당기기·출렁임을 끊지 않게 미룬다
      const w = document.createElement('canvas'); w.width = w.height = 32;
      w.getContext('2d').fillRect(0, 0, 32, 32);
      try { lm.detect(w); } catch { /* 워밍업 실패는 무시 */ }
    }).catch(() => { /* 인식 단계에서 처리 */ });
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 3000);
  }

  // 얼굴 메시 468점 중 볼 가운데를 둘러싼 점들. 평균을 볼 중심으로 쓴다. (사진 기준 왼쪽 / 오른쪽)
  const CHEEK_SETS = [[50, 187, 205], [280, 411, 425]];
  const FACE_EDGE = [234, 454];   // 얼굴 좌우 끝. 이 폭으로 볼 크기를 정한다.
  // 얼굴 윤곽(턱선~이마)을 도는 랜드마크. 앞사람 얼굴을 픽셀 단위로 보호할 때 쓴다.
  const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const OVAL_GROW = 1.04;         // 윤곽을 살짝 키워 경계 픽셀까지 덮는다
  const CHEEK_R_RATIO = 0.22;     // 볼 원 반지름 = 얼굴 폭 × 이 값 (사용자가 원하는 크기로 조정한 값)
  const MIN_FACE = 0.08;          // 사진 가로 대비 이보다 작은 얼굴은 놀기에 너무 작아 무시
  const TILE_IF_FACE_UNDER = 0.35; // 가장 큰 얼굴이 이보다 작으면 조각 재탐색(인식기가 근거리용이라 작은 얼굴을 놓침)
  const DETECT_PX = 1024;          // 인식 입력 긴 변(검출기 내부 입력이 작아 손실 없음, 업로드 4배 감소)

  const nextFrame = () => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(f, 0)); setTimeout(f, 60); });
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  function detectInput(source) {
    const s = Math.min(1, DETECT_PX / Math.max(source.width, source.height));
    if (s === 1) return source;
    const c = document.createElement('canvas');
    c.width = Math.round(source.width * s); c.height = Math.round(source.height * s);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  // 전체 사진 한 번. 좌표는 이미지 공간(가로 1, 세로 A0).
  async function detectFull(source, A0) {
    const lm = await getLandmarker();
    return facesFrom(lm.detect(detectInput(source)), 0, 0, 1, A0);
  }
  // 3×3 겹침 조각 재탐색. 이미 찾은 얼굴과 겹치는 결과는 버리고, 찾은 얼굴이 60% 이상 덮는 조각은 건너뛴다.
  // 토큰이 바뀌면(다른 사진) 중단. 조각마다 프레임을 양보해 화면이 얼어붙지 않게 한다.
  async function detectTiles(source, A0, known, token) {
    const lm = await getLandmarker();
    const input = detectInput(source);
    const px = input.width, tw = 0.5, th = 0.5 * A0;
    const c = document.createElement('canvas');
    c.width = Math.round(tw * px); c.height = Math.round(th * px);
    const g = c.getContext('2d');
    const found = [];
    const all = () => known.concat(found);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      if (token !== detectToken) return found;
      const x0 = i * 0.25, y0 = j * 0.25 * A0;
      const tile = { x0, y0, x1: x0 + tw, y1: y0 + th };
      let covered = 0;
      for (const f of all()) {
        const ix = Math.max(0, Math.min(tile.x1, f.box.x1) - Math.max(tile.x0, f.box.x0));
        const iy = Math.max(0, Math.min(tile.y1, f.box.y1) - Math.max(tile.y0, f.box.y0));
        covered += ix * iy;
      }
      if (covered >= 0.6 * tw * th) continue;
      await nextFrame();
      if (token !== detectToken) return found;
      g.drawImage(input, x0 * px, y0 * px, c.width, c.height, 0, 0, c.width, c.height);
      for (const f of facesFrom(lm.detect(c), x0, y0, tw, th)) {
        const cx = (f.box.x0 + f.box.x1) / 2, cy = (f.box.y0 + f.box.y1) / 2;
        const dup = all().some((e) =>
          Math.hypot((e.box.x0 + e.box.x1) / 2 - cx, (e.box.y0 + e.box.y1) / 2 - cy) < Math.max(e.W, f.W) * 0.5 ||
          (cx > e.box.x0 && cx < e.box.x1 && cy > e.box.y0 && cy < e.box.y1));
        if (!dup) found.push(f);
      }
    }
    return found;
  }
  // 디버그·샘플 좌표 계산용: 전체 + 조각
  async function detectFaces(source, A0 = A) {
    const faces = await detectFull(source, A0);
    if (!faces.length || faces[0].W < TILE_IF_FACE_UNDER) faces.push(...await detectTiles(source, A0, faces, detectToken));
    return faces.sort((p, q) => q.W - p.W).slice(0, MAX_FACES);
  }

  // 인식 결과(조각 기준 정규화 좌표)를 이미지 공간으로 옮긴다. 조각은 (x0, y0)에서 가로 tw, 세로 th.
  function facesFrom(res, x0, y0, tw, th) {
    const faces = [];
    for (const f of res.faceLandmarks || []) {
      const P = (i) => ({ x: x0 + f[i].x * tw, y: y0 + f[i].y * th });
      const a = P(FACE_EDGE[0]), b = P(FACE_EDGE[1]);
      const W = Math.hypot(a.x - b.x, a.y - b.y);
      if (W < MIN_FACE) continue;
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let i = 0; i < f.length; i++) {
        const p = P(i);
        box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x);
        box.y0 = Math.min(box.y0, p.y); box.y1 = Math.max(box.y1, p.y);
      }
      const r = Math.min(0.45, Math.max(0.02, W * CHEEK_R_RATIO));
      const cheeks = [];
      for (const set of CHEEK_SETS) {
        let x = 0, y = 0;
        for (const i of set) { const p = P(i); x += p.x; y += p.y; }
        x /= set.length; y /= set.length;
        cheeks.push({ cx: x, cy: y, r });
      }
      // 윤곽 폴리곤 (무게중심 기준으로 살짝 키움)
      const pts = FACE_OVAL.map(P);
      const gx = pts.reduce((s, q) => s + q.x, 0) / pts.length, gy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
      const poly = pts.map((q) => [gx + (q.x - gx) * OVAL_GROW, gy + (q.y - gy) * OVAL_GROW]);
      faces.push({ W, box, cheeks, poly });
    }
    return faces.sort((p, q) => q.W - p.W);
  }

  // 인식된 얼굴 목록 → 볼 영역(어느 얼굴 것인지 표시)과 얼굴 타원. 사진 밖으로 나간 볼은 안쪽으로 당기거나 버린다.
  function regionsAndOvals(faces, idFrom) {
    const regs = [], ovals = [];
    faces.forEach((f, k) => {
      const id = idFrom + k;
      for (const c of f.cheeks) {
        if (c.cx < -c.r / 2 || c.cx > 1 + c.r / 2 || c.cy < -c.r / 2 || c.cy > A + c.r / 2) continue; // 절반 넘게 잘린 볼
        regs.push({
          cx: Math.min(1 - c.r, Math.max(c.r, c.cx)), cy: Math.min(A - c.r, Math.max(c.r, c.cy)), r: c.r,
          face: id, W: f.W,
        });
      }
      ovals.push({
        id, W: f.W, poly: f.poly, box: f.box,
        cx: (f.box.x0 + f.box.x1) / 2, cy: (f.box.y0 + f.box.y1) / 2,
        rx: ((f.box.x1 - f.box.x0) / 2) * 1.05, ry: ((f.box.y1 - f.box.y0) / 2) * 1.05,
      });
    });
    return { regs, ovals };
  }
  function applyFaces(faces, replace) {
    const idFrom = replace ? 0 : (faceOvals.reduce((m, o) => Math.max(m, o.id), -1) + 1);
    const ro = regionsAndOvals(faces, idFrom);
    if (replace) { regions = ro.regs; faceOvals = ro.ovals; }
    else { regions = regions.concat(ro.regs); faceOvals = faceOvals.concat(ro.ovals); }
    settle(); updateFree(); buildRegionEls();
    if (editing) syncEditPanel();
  }

  // 인식 진행 상태. 사진 세대가 바뀌면(setImage) 토큰이 올라가 늦게 온 결과는 버린다.
  let detecting = false, detectToken = 0, busyTimers = [];
  function setDetecting(on) {
    detecting = on;
    for (const t of busyTimers) clearTimeout(t);
    busyTimers = [];
    $('#busy').hidden = !on;
    $('#busyManual').hidden = true;
    for (const id of ['#btnEdit', '#btnHelp', '#regionRefind']) $(id).disabled = on;
    $('#editPanel').inert = on; // 인식 중 옮긴 원이 결과로 조용히 덮이지 않게
    if (!on) { hintEl.textContent = editing ? '볼 위치를 맞추는 중' : '볼을 누른 채 끌었다가 놓아보세요'; return; }
    $('#busyText').textContent = '볼 찾는 중…';
    hintEl.textContent = '볼 찾는 중…';
    busyTimers.push(setTimeout(() => { if (detecting && !landmarkerReady) $('#busyText').textContent = '처음 한 번만 얼굴 인식 파일(약 7MB)을 받아요'; }, 2500));
    busyTimers.push(setTimeout(() => { if (detecting) $('#busyManual').hidden = false; }, 10000));
  }
  $('#busyManual').addEventListener('click', () => {
    ++detectToken; setDetecting(false);
    setEditing(true);
    toast('분홍 원을 볼 위로 옮겨주세요', 3000);
  });

  let pendingFaces = null; // 뒤에서 찾은 얼굴. 잡는 중·출렁이는 중·편집 중이면 멈춘 뒤에 붙인다
  function applyPendingFaces() {
    if (!pendingFaces || grabs.size || running || editing) return;
    const { token, faces } = pendingFaces; pendingFaces = null;
    if (token !== detectToken) return;
    const add = faces.slice(0, Math.max(0, MAX_FACES - faceOvals.length));
    if (!add.length) return;
    applyFaces(add, false);
    toast(`얼굴 ${add.length}개를 더 찾았어요`);
  }
  async function autoPlaceCheeks() {
    const token = ++detectToken; // 진행 중이던 조각 탐색(다시 찾기 포함)은 이 세대로 끊는다
    setDetecting(true);
    await nextFrame(); // 스피너와 새 사진이 먼저 그려지게(인식은 동기라 화면을 잠깐 붙잡는다)
    if (token !== detectToken) return;
    let faces = null, err = null;
    try { faces = await withTimeout(detectFull(srcCanvas, A), 40000); } catch (e) { err = e; console.error(e); }
    if (token !== detectToken) return;
    if (faces && faces.length) {
      applyFaces(faces, true);
      setDetecting(false);
      if (editing) setEditing(false);
      toast(faces.length > 1 ? `얼굴 ${faces.length}개를 찾았어요! 볼을 잡고 당겨보세요` : '볼을 찾았어요! 잡고 당겨보세요');
      if (coachStep === 1) startDemo();
      if (faces[0].W < TILE_IF_FACE_UNDER) {
        setTimeout(() => { if (token === detectToken) toast('두 손가락으로 벌리면 확대, 빈 곳을 끌면 이동돼요', 3200); }, 2200);
        // 작은 얼굴이 더 있을 수 있다: 놀이는 시작하고 뒤에서 조각 재탐색
        detectTiles(srcCanvas, A, faces, token).then((more) => {
          if (token !== detectToken || !more.length) return;
          pendingFaces = { token, faces: more };
          applyPendingFaces();
        }).catch(() => { /* 추가 탐색 실패는 조용히 */ });
      }
      return;
    }
    if (faces) { // 전체에서 0개 → 조각으로 한 번 더
      try { faces = await withTimeout(detectTiles(srcCanvas, A, [], token), 40000); } catch (e) { err = e; console.error(e); faces = null; }
      if (token !== detectToken) return;
      if (faces && faces.length) {
        applyFaces(faces.sort((p, q) => q.W - p.W).slice(0, MAX_FACES), true);
        setDetecting(false);
        if (editing) setEditing(false);
        toast(`얼굴 ${faces.length}개를 찾았어요! 볼을 잡고 당겨보세요`);
        if (coachStep === 1) startDemo();
        return;
      }
    }
    setDetecting(false);
    setEditing(true);
    if (faces) {
      showCoach('얼굴을 못 찾았어요. 분홍 원을 볼 위로 끌어 맞춘 뒤 [완료]를 눌러주세요. 강아지·고양이·아기 배도 돼요.', [
        { label: '직접 맞출게요', primary: true, onClick: hideCoach },
        { label: '다른 사진 고르기', onClick: () => { hideCoach(); openSheet('pick'); } },
      ], true);
    } else if (!SIMD_OK || landmarkerBroken) {
      showCoach('이 기기에서는 자동 인식이 안 돼요. 분홍 원을 볼 위로 직접 옮겨주세요.', [{ label: '알겠어요', onClick: hideCoach }], true);
    } else {
      showCoach(err && err.message === 'timeout'
        ? '얼굴 인식 파일을 받는 데 시간이 오래 걸려요. 원을 직접 맞추거나, 인터넷을 확인하고 다시 찾기를 눌러주세요.'
        : '얼굴 인식 파일을 받지 못했어요. 인터넷을 확인하고 다시 찾기를 눌러주세요.', [
        { label: '다시 찾기', primary: true, onClick: () => { hideCoach(); autoPlaceCheeks(); } },
        { label: '직접 맞출게요', onClick: hideCoach },
      ], true);
    }
  }

  // ---------- 좌표 변환 ----------
  function toImg(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - imgRect.x) / imgRect.w,
      y: (clientY - r.top - imgRect.y) / imgRect.w, // 세로도 "가로 = 1" 단위
    };
  }

  // ---------- 입력: 잡아당기기(여러 손가락) / 사진 이동·확대 ----------
  // 첫 손가락이 볼 위에 닿으면 "당기기" 모드(이후 손가락도 볼을 잡음),
  // 빈 곳에 닿으면 "보기" 모드(한 손가락 이동, 두 손가락 확대). 편집 중에는 항상 보기 모드(탭은 원 옮기기).
  const nav = new Map(); // pointerId -> { x, y, sx, sy } 스테이지 CSS 픽셀
  function stagePt(e) { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  let missCount = 0; // 사진마다 "빗나갔어요" 안내 횟수

  canvas.addEventListener('pointerdown', (e) => {
    const p = toImg(e.clientX, e.clientY);
    if (!editing && !detecting && nav.size === 0 && beginGrab(e.pointerId, p.x, p.y)) {
      stopDemo(); // 직접 잡았을 때만 시범을 멈춘다(빗나간 탭이면 계속 보여준다)
      buzz(12);
    } else if (userGrabCount() === 0) {
      const s = stagePt(e);
      nav.set(e.pointerId, { x: s.x, y: s.y, sx: s.x, sy: s.y });
    } else return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 */ }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (grabs.has(e.pointerId)) {
      const p = toImg(e.clientX, e.clientY);
      moveGrab(e.pointerId, p.x, p.y);
      return;
    }
    const cur0 = nav.get(e.pointerId);
    if (!cur0) return;
    const cur = { ...stagePt(e), sx: cur0.sx, sy: cur0.sy };
    if (nav.size === 1) {
      view.cx -= (cur.x - cur0.x) / imgRect.w;
      view.cy -= (cur.y - cur0.y) / imgRect.w;
    } else {
      for (const v of nav.values()) v.multi = true; // 두 손가락이 닿았으면 놓을 때 탭으로 보지 않는다
      cur.multi = true;
      const [idA, idB] = [...nav.keys()];
      const oa = nav.get(idA), ob = nav.get(idB);
      const na = e.pointerId === idA ? cur : oa, nb = e.pointerId === idB ? cur : ob;
      const od = Math.hypot(oa.x - ob.x, oa.y - ob.y), nd = Math.hypot(na.x - nb.x, na.y - nb.y);
      const om = { x: (oa.x + ob.x) / 2, y: (oa.y + ob.y) / 2 }, nm = { x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 };
      zoomAbout(om, nm, od > 1 ? nd / od : 1);
    }
    nav.set(e.pointerId, cur);
    layout();
  });
  // 스테이지 점 from 아래의 이미지 좌표가 배율을 바꾼 뒤 to 로 오게 한다
  function zoomAbout(from, to, factor) {
    const r = stage.getBoundingClientRect();
    const px = (from.x - imgRect.x) / imgRect.w, py = (from.y - imgRect.y) / imgRect.w;
    view.z = Math.min(ZOOM_MAX, Math.max(1, view.z * factor));
    const W = fitW * view.z;
    view.cx = px - (to.x - r.width / 2) / W;
    view.cy = py - (to.y - r.height / 2) / W;
  }
  canvas.addEventListener('wheel', (e) => { // 데스크톱: 휠로 확대
    e.preventDefault();
    const p = stagePt(e);
    zoomAbout(p, p, Math.exp(-e.deltaY * 0.002));
    layout();
  }, { passive: false });

  let releases = 0;
  const release = (e) => {
    const nv = nav.get(e.pointerId);
    if (nv) {
      nav.delete(e.pointerId);
      const moved = Math.hypot(nv.x - nv.sx, nv.y - nv.sy);
      if (moved < 8 && !nv.multi && e.type === 'pointerup') {
        const p = toImg(e.clientX, e.clientY);
        if (editing) { // 톡 누르면 선택한 원이 그 자리로
          const reg = regions[selected];
          if (reg) { reg.cx = Math.min(1, Math.max(0, p.x)); reg.cy = Math.min(A, Math.max(0, p.y)); placeRegions(); syncEditPanel(); }
        } else if (!detecting && view.z <= 1.01 && regions.length && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= A) {
          if (coachStep === 1 && !demo) startDemo(); // 시범이 끝난 뒤 빗나가면 다시 보여준다
          if (missCount < 2) { missCount++; toast('볼을 살짝 빗나갔어요. 볼 가운데를 눌러보세요', 2200); }
        }
      }
      return;
    }
    const g = grabs.get(e.pointerId);
    if (!g) return;
    if (Math.hypot(g.Dx, g.Dy) >= g.limit * 0.5) snapshotForCapture(); // 가장 늘어난 순간을 기억해 둔다(공유용)
    endGrab(e.pointerId);
    buzz(8);
    releases++;
    onUserRelease();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  $('#resetView').addEventListener('click', resetView);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 안드로이드: navigator.vibrate. iOS 사파리는 vibrate가 없으므로 switch 체크박스 토글로 시스템 햅틱을 빌린다(iOS 18+, 강도 조절 불가).
  const iosHaptic = $('#iosHaptic');
  function buzz(ms) {
    if (!settings.haptic) return;
    if (navigator.vibrate) {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // 첫 터치 전엔 크롬이 막고 경고를 남긴다
      try { navigator.vibrate(ms); } catch { /* 무시 */ }
      return;
    }
    if (iosHaptic) { try { iosHaptic.click(); } catch { /* 무시 */ } }
  }

  // ---------- 저장·공유 (사용자가 버튼을 눌러 공유 시트에서 고를 때만 사진이 나간다) ----------
  let cap = null, shareBlob = null, shareTimer = 0, lastCap = 0, capSnap = null;
  // 놓는 순간의 변위장을 복사해 두었다가 frame()이 멈출 때 captureFrame(snap)으로 찍는다
  function snapshotForCapture() {
    if (!srcCanvas || performance.now() - lastCap < 1500) return;
    capSnap = { dx: dx.slice(), dy: dy.slice(), mask: maskActive, src: srcCanvas, step: coachStep };
  }
  function ensureCapture() {
    const w = Math.min(1080, srcCanvas.width), h = Math.round(w * A);
    if (cap && cap.w === w && cap.h === h) return cap;
    if (cap) { gl.deleteFramebuffer(cap.fbo); gl.deleteTexture(cap.tex); }
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    texParams(gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cap = ok ? { fbo, tex: t, w, h, pixels: new Uint8Array(w * h * 4) } : null;
    return cap;
  }
  function captureFrame(snap) {
    if (!srcCanvas || snap.src !== srcCanvas || snap.step) return; // 사진이 바뀌었거나 첫 사용 안내 중이면 찍지 않는다
    lastCap = performance.now();
    let c;
    try { c = ensureCapture(); } catch { c = null; }
    if (!c) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.viewport(0, 0, c.w, c.h);
    gl.uniform2f(locO, -1, 1); gl.uniform2f(locS, 2, 2 / A);
    uploadDisp(snap.dx, snap.dy); drawQuad(snap.mask);
    gl.readPixels(0, 0, c.w, c.h, gl.RGBA, gl.UNSIGNED_BYTE, c.pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(locO, curO[0], curO[1]); gl.uniform2f(locS, curS[0], curS[1]);
    // 위아래가 뒤집혀 나오므로 줄 단위로 뒤집어 2D 캔버스에 옮긴다
    const out = document.createElement('canvas'); out.width = c.w; out.height = c.h;
    const img = out.getContext('2d').createImageData(c.w, c.h);
    const rowBytes = c.w * 4;
    for (let y = 0; y < c.h; y++) img.data.set(c.pixels.subarray((c.h - 1 - y) * rowBytes, (c.h - y) * rowBytes), y * rowBytes);
    out.getContext('2d').putImageData(img, 0, 0);
    const src = srcCanvas;
    out.toBlob((b) => {
      if (!b || src !== srcCanvas || coachStep) return;
      shareBlob = b;
      $('#shareChip').hidden = false;
      clearTimeout(shareTimer);
      shareTimer = setTimeout(() => { $('#shareChip').hidden = true; }, 4000);
    }, 'image/jpeg', 0.9);
  }
  async function shareCapture() {
    if (!shareBlob) return;
    const file = new File([shareBlob], '볼꼬집기.jpg', { type: 'image/jpeg' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '볼 꼬집기' });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(shareBlob);
    if (/KAKAOTALK|; wv\)/i.test(navigator.userAgent)) {
      // 카톡·앱 안 브라우저는 다운로드가 조용히 실패할 수 있다 → 사진을 띄워 길게 눌러 저장하게 한다
      const ov = document.createElement('div');
      ov.className = 'save-overlay';
      ov.innerHTML = `<img alt="저장할 장면"><p>사진을 길게 눌러 저장하세요</p><button class="btn small">닫기</button>`;
      ov.querySelector('img').src = url;
      ov.querySelector('button').addEventListener('click', () => { ov.remove(); URL.revokeObjectURL(url); });
      document.body.appendChild(ov);
      return;
    }
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('다운로드 폴더에 저장했어요');
  }
  $('#shareChip').addEventListener('click', () => {
    clearTimeout(shareTimer);
    $('#shareChip').hidden = true;
    if (flag('cheek.shareOk')) { shareCapture(); return; }
    showCoach('이 장면을 사진으로 저장하거나 공유해요. 공유는 내가 고른 앱으로만 가고, 사진 속 사람의 허락은 잊지 마세요.', [
      { label: '네, 계속', primary: true, onClick: () => { setFlag('cheek.shareOk'); hideCoach(); shareCapture(); } },
      { label: '괜찮아요', onClick: hideCoach },
    ], true);
  });

  // ---------- 시트(아래 카드) 열고 닫기 + 안드로이드 뒤로가기 ----------
  const SHEETS = ['pick', 'sheet', 'editPanel'];
  let openId = null;
  function showSheet(id) {
    for (const s of SHEETS) $('#' + s).hidden = s !== id;
    openId = id;
  }
  function openSheet(id) {
    if (openId === id) return;
    const had = !!openId; // setEditing이 openId를 비우기 전에 계산해야 history 항목이 새지 않는다
    if (openId === 'editPanel' && id !== 'editPanel') { setEditing(false, true); }
    showSheet(id);
    if (!had) { try { history.pushState({ sheet: 1 }, ''); } catch { /* 무시 */ } }
  }
  // closeSheet가 부른 history.back()의 popstate는 늦게 도착한다. 그 사이 다른 시트를 열었으면 그 popstate가 새 시트를
  // 닫아버리므로(실제로 겪음), 우리가 만든 back은 세어 두었다가 건너뛴다.
  let pendingBack = 0;
  function closeSheet() {
    if (!openId) return;
    showSheet(null);
    if (history.state && history.state.sheet) {
      pendingBack++;
      setTimeout(() => { pendingBack = Math.max(0, pendingBack - 1); }, 600);
      try { history.back(); } catch { pendingBack = 0; }
    }
  }
  window.addEventListener('popstate', () => {
    if (pendingBack > 0) { pendingBack--; return; }
    if (!openId) {
      // 열린 시트가 없는데 시트용 항목에 도착했다 = 어딘가에서 샌 항목. 한 번 더 뒤로 가서 건너뛴다
      if (history.state && history.state.sheet) { pendingBack++; setTimeout(() => { pendingBack = Math.max(0, pendingBack - 1); }, 600); try { history.back(); } catch { pendingBack = 0; } }
      return;
    }
    if (openId === 'editPanel') setEditing(false, true); else showSheet(null);
  });

  // ---------- 볼 영역 편집 ----------
  let editing = false;
  let selected = 0; // 편집 중인 볼 번호

  function regionLabel(i) {
    const reg = regions[i];
    const faces = new Set(regions.filter((r) => r.face >= 0).map((r) => r.face));
    const side = (() => {
      const same = regions.filter((r) => r.face === reg.face && reg.face >= 0);
      if (same.length === 2) return same[0] === reg ? '왼볼' : '오른볼';
      return '볼';
    })();
    if (reg.face < 0) return `볼 ${i + 1}`;
    const fi = [...faces].sort((a, b) => a - b).indexOf(reg.face) + 1;
    return faces.size > 1 ? `얼굴 ${fi} ${side}` : side === '볼' ? `볼 ${i + 1}` : side;
  }

  function buildRegionEls() {
    regionsEl.innerHTML = '';
    selected = Math.min(selected, Math.max(0, regions.length - 1));
    regions.forEach((reg, i) => {
      const el = document.createElement('div');
      el.className = 'region' + (i === selected ? ' selected' : '');
      el.innerHTML = `<span class="tag">${regionLabel(i)}</span><i class="handle"></i>`;
      regionsEl.appendChild(el);

      let mode = null, activeId = null, offX = 0, offY = 0;
      el.addEventListener('pointerdown', (e) => {
        if (!editing || detecting || activeId !== null) return;
        selectRegion(i);
        mode = e.target.classList.contains('handle') ? 'resize' : 'move';
        activeId = e.pointerId;
        const p = toImg(e.clientX, e.clientY);
        offX = p.x - reg.cx; offY = p.y - reg.cy;
        try { el.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 */ }
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointermove', (e) => {
        if (!mode || e.pointerId !== activeId) return;
        const p = toImg(e.clientX, e.clientY);
        if (mode === 'move') {
          reg.cx = Math.min(1, Math.max(0, p.x - offX));
          reg.cy = Math.min(A, Math.max(0, p.y - offY));
        } else {
          reg.r = Math.min(0.45, Math.max(0.03, Math.hypot(p.x - reg.cx, p.y - reg.cy)));
        }
        placeRegions(); syncEditPanel();
      });
      const up = (e) => { if (e.pointerId === activeId) { mode = null; activeId = null; } };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    placeRegions();
  }

  function placeRegions() {
    const els = regionsEl.children;
    regions.forEach((reg, i) => {
      const el = els[i]; if (!el) return;
      const rp = reg.r * imgRect.w;
      el.style.left = imgRect.x + reg.cx * imgRect.w - rp + 'px';
      el.style.top = imgRect.y + reg.cy * imgRect.w - rp + 'px';
      el.style.width = el.style.height = rp * 2 + 'px';
    });
  }

  // 편집으로 원을 다른 사람 얼굴 안으로 옮기면 그 얼굴 것으로 다시 정한다(중심이 들어 있는 가장 큰 얼굴).
  // 얼굴 밖(경계·머리카락 쪽)으로 살짝 옮긴 건 원래 얼굴 소속을 유지한다 — 소속을 지우면 앞사람 보호가 풀려 뒷볼을 당길 때 앞얼굴이 끌려간다.
  function reassignFaces() {
    if (!faceOvals.length) return;
    for (const reg of regions) {
      let best = null;
      for (const o of faceOvals) {
        const e = Math.hypot((reg.cx - o.cx) / o.rx, (reg.cy - o.cy) / o.ry);
        if (e < 1.0 && (!best || o.W > best.W)) best = o;
      }
      if (best && best.id !== reg.face) { reg.face = best.id; reg.W = best.W; }
    }
  }

  // ---------- 볼 위치 편집 패널 (탭 · 방향 버튼 · 크기 슬라이더 · 추가/삭제/다시 찾기) ----------
  const NUDGE = 0.01; // 한 번 누를 때 이동량 (사진 가로의 1%)
  function selectRegion(i) {
    selected = i;
    [...regionsEl.children].forEach((el, k) => el.classList.toggle('selected', k === i));
    syncEditPanel();
  }
  function syncEditPanel() {
    const tabs = $('#regionTabs');
    if (tabs.children.length !== regions.length) {
      tabs.innerHTML = '';
      regions.forEach((_, i) => {
        const b = document.createElement('button');
        b.className = 'chip'; b.textContent = regionLabel(i);
        b.addEventListener('click', () => selectRegion(i));
        tabs.appendChild(b);
      });
    }
    [...tabs.children].forEach((b, i) => { b.classList.toggle('on', i === selected); b.textContent = regionLabel(i); });
    [...regionsEl.children].forEach((el, i) => { const t = el.querySelector('.tag'); if (t) t.textContent = regionLabel(i); });
    $('#regionDel').disabled = regions.length <= 1;
    $('#regionAdd').disabled = regions.length >= 12;
    const reg = regions[selected];
    if (!reg) return;
    $('#sSize').value = reg.r;
    const px = reg.r * imgRect.w;
    $('#oSize').textContent = px < 30 ? '작게' : px < 60 ? '보통' : '크게';
  }
  function nudge(ddx, ddy) {
    const reg = regions[selected]; if (!reg) return;
    reg.cx = Math.min(1, Math.max(0, reg.cx + ddx * NUDGE));
    reg.cy = Math.min(A, Math.max(0, reg.cy + ddy * NUDGE));
    placeRegions();
  }
  function setSize(r) {
    const reg = regions[selected]; if (!reg) return;
    reg.r = Math.min(0.45, Math.max(0.03, r));
    placeRegions(); syncEditPanel();
  }
  // 방향 버튼: 누르면 한 칸, 길게 누르면 계속
  for (const b of document.querySelectorAll('.dbtn')) {
    const ddx = +b.dataset.dx, ddy = +b.dataset.dy;
    let hold = 0, rep = 0;
    const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = 0; };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      nudge(ddx, ddy);
      hold = setTimeout(() => { rep = setInterval(() => nudge(ddx, ddy), 60); }, 350);
    });
    for (const t of ['pointerup', 'pointercancel']) b.addEventListener(t, stop);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  $('#sSize').addEventListener('input', (e) => setSize(parseFloat(e.target.value)));
  $('#sizeDown').addEventListener('click', () => setSize(regions[selected].r * 0.92));
  $('#sizeUp').addEventListener('click', () => setSize(regions[selected].r * 1.08));
  $('#regionAdd').addEventListener('click', () => {
    if (regions.length >= 12) return;
    const base = regions[selected] || { cx: 0.5, cy: A / 2, r: 0.1 };
    regions.push({ cx: Math.min(1 - base.r, base.cx + base.r * 2.2), cy: base.cy, r: base.r, face: -1, W: Infinity });
    buildRegionEls(); selectRegion(regions.length - 1);
  });
  $('#regionDel').addEventListener('click', () => {
    if (regions.length <= 1) return;
    const [gone] = regions.splice(selected, 1);
    if (gone.face >= 0 && !regions.some((r) => r.face === gone.face)) faceOvals = faceOvals.filter((o) => o.id !== gone.face);
    buildRegionEls(); selectRegion(Math.min(selected, regions.length - 1));
  });
  $('#regionRefind').addEventListener('click', () => { hideCoach(); autoPlaceCheeks(); });

  function setEditing(on, viaHistory = false) {
    if (editing === on) return;
    editing = on;
    $('#btnEdit').setAttribute('aria-pressed', String(on));
    $('#btnEdit').textContent = on ? '완료' : '볼 위치 맞추기';
    if (on) {
      finishOnboarding(); clearGrabs(); settle(); render();
      openSheet('editPanel');
      selectRegion(Math.min(selected, Math.max(0, regions.length - 1)));
    } else {
      reassignFaces();
      updateFree();
      if (viaHistory) showSheet(null); else closeSheet();
    }
    regionsEl.classList.toggle('editing', on);
    regionsEl.classList.toggle('ghost', !on && settings.show);
    stage.classList.toggle('editing-mode', on); // 편집 중 안내 카드는 위쪽에(원을 가리지 않게)
    hintEl.textContent = on ? '볼 위치를 맞추는 중' : '볼을 누른 채 끌었다가 놓아보세요';
    layout(); // 패널이 열리고 닫히면 사진 크기가 바뀐다
    if (!on) applyPendingFaces();
  }

  // ---------- UI ----------
  let toastTimer = 0;
  function toast(msg, ms) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms || Math.max(1800, 900 + msg.length * 80));
  }

  // 사진 불러오기: 갤러리(사진 앱)와 카메라를 명확한 선택지로 보여준다.
  function pickPhoto() {
    getLandmarker().catch(() => { /* 사진 고르는 동안 모델을 미리 받는다. 실패는 인식 단계에서 처리 */ });
    openSheet('pick');
  }
  function openInput(id) {
    closeSheet();
    const inp = $(id);
    inp.value = '';
    try { inp.showPicker ? inp.showPicker() : inp.click(); } catch { inp.click(); }
  }
  $('#pickGallery').addEventListener('click', () => openInput('#file'));
  $('#pickCamera').addEventListener('click', () => openInput('#fileCam'));
  $('#pickClose').addEventListener('click', closeSheet);
  SAMPLES.forEach((smp, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<img src="${smp.src}" alt="샘플 아기 ${i + 1}" loading="lazy" draggable="false">`;
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      closeSheet();
      stopDemo(); hideCoach();
      if (editing) setEditing(false);
      loadSample(i).then(() => { toast('볼을 잡고 당겨보세요'); if (coachStep === 1) startDemo(); })
        .catch((e) => {
          console.error(e);
          showCoach('샘플 사진을 불러오지 못했어요. 인터넷을 확인하고 다시 눌러주세요.', [{ label: '알겠어요', onClick: hideCoach }], true);
        });
    });
    $('#sampleRow').appendChild(b);
  });
  $('#btnPhoto').addEventListener('click', () => { finishOnboarding(); hideCoach(); pickPhoto(); });
  $('#btnHelp').addEventListener('click', () => {
    if (editing) setEditing(false);
    closeSheet();
    startOnboarding();
  });
  $('#btnFeedback').addEventListener('click', () => { hideCoach(); openFeedback(); });
  if (!FEEDBACK_URL) $('#btnFeedback').hidden = true;

  function openFeedback() {
    if (!FEEDBACK_URL) return;
    let url = FEEDBACK_URL;
    try {
      const u = new URL(FEEDBACK_URL);
      const vals = {
        releases: String(releases),
        faces: String(faceOvals.length),
        ua: /KAKAOTALK/i.test(navigator.userAgent) ? 'kakao' : /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'other',
        preset: currentPreset() || 'custom',
      };
      let any = false;
      for (const [k, entry] of Object.entries(FEEDBACK_PREFILL)) if (vals[k] !== undefined) { u.searchParams.set(entry, vals[k]); any = true; }
      if (any) u.searchParams.set('usp', 'pp_url');
      url = u.toString();
    } catch { /* 주소가 이상하면 그대로 연다 */ }
    window.open(url, '_blank', 'noopener');
  }

  // ---------- 안내 카드 ----------
  const coachEl = $('#coach');
  function showCoach(text, buttons, small) {
    const p = $('#coachText');
    p.textContent = text;
    p.classList.toggle('small', !!small);
    const box = $('#coachBtns');
    box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      box.appendChild(el);
    }
    coachEl.hidden = false;
  }
  function hideCoach() { coachEl.hidden = true; }

  // ---------- 첫 사용 안내 ----------
  // 1단계: 시범 손가락이 볼을 당겼다 놓는 걸 반복해서 보여준다 → 사용자가 직접 한 번 당겼다 놓으면
  // 2단계: 양볼 동시 당기기와 내 사진 넣기를 알려준다.
  let coachStep = 0, nudgeShown = false;
  function startOnboarding() {
    coachStep = 1;
    showCoach('볼을 누른 채 끌었다가 놓아보세요', []);
    startDemo();
  }
  function finishOnboarding() {
    if (!coachStep) return;
    coachStep = 0;
    hideCoach(); stopDemo();
    setFlag('cheek.onboarded');
  }
  function onUserRelease() {
    if (coachStep === 1) {
      coachStep = 2;
      setFlag('cheek.onboarded'); // 여기서 앱을 닫아도 시범이 또 나오지 않게
      hideCoach(); stopDemo();
      setTimeout(() => {
        if (coachStep !== 2) return;
        showCoach('이번엔 두 손가락으로 양볼을 같이 당겨보세요', [
          { label: '내 사진 불러오기', primary: true, onClick: () => { finishOnboarding(); pickPhoto(); } },
          { label: '계속 만지기', onClick: finishOnboarding },
        ]);
      }, 900);
      return;
    }
    if (!coachStep && FEEDBACK_URL && releases >= NUDGE_AFTER && !nudgeShown && !flag('cheek.nudged')) {
      nudgeShown = true;
      showCoach('재밌게 만지셨나요? 1분이면 끝나는 의견을 남겨주시면 큰 도움이 돼요. 사진은 포함되지 않아요.', [
        { label: '의견 보내기', primary: true, onClick: () => { setFlag('cheek.nudged'); hideCoach(); openFeedback(); } },
        { label: '괜찮아요', onClick: () => { setFlag('cheek.nudged'); hideCoach(); } },
      ]);
    }
  }

  // 시범 손가락: 가짜 포인터(id -1)로 실제 물리를 그대로 돌린다. 8번 보여주면 멈춘다.
  const fingerEl = $('#finger');
  let demo = null;
  function showFinger(x, y, down) {
    fingerEl.hidden = false;
    fingerEl.style.left = imgRect.x + x * imgRect.w + 'px';
    fingerEl.style.top = imgRect.y + y * imgRect.w + 'px';
    fingerEl.classList.toggle('down', down);
    fingerEl.classList.toggle('up', !down);
    if (demo) demo.last = { x, y, down };
  }
  function startDemo() {
    stopDemo();
    if (!regions[0] || detecting) return;
    const d = { alive: true, timer: 0, count: 0, last: null };
    demo = d;
    const cycle = () => {
      if (!d.alive) return;
      const reg = regions[0]; // 매 사이클 새로 읽는다(인식 결과로 바뀔 수 있다)
      if (!reg || d.count >= 8) { stopDemo(); return; }
      if (document.hidden) { d.timer = setTimeout(cycle, 1500); return; }
      d.count++;
      const sx = reg.cx, sy = reg.cy;
      const tx = sx - reg.r * 0.9, ty = sy + reg.r * 0.35;
      showFinger(sx, sy, false);
      d.timer = setTimeout(() => {
        if (!d.alive || !beginGrab(DEMO_ID, sx, sy)) return;
        showFinger(sx, sy, true);
        const t0 = performance.now();
        const pull = (t) => {
          if (!d.alive) return;
          const u = Math.min(1, (t - t0) / 650);
          const ease = 1 - Math.pow(1 - u, 3);
          const x = sx + (tx - sx) * ease, y = sy + (ty - sy) * ease;
          moveGrab(DEMO_ID, x, y);
          showFinger(x, y, true);
          if (u < 1) { requestAnimationFrame(pull); return; }
          d.timer = setTimeout(() => {
            if (!d.alive) return;
            endGrab(DEMO_ID);
            showFinger(x, y, false);
            d.timer = setTimeout(cycle, 1700);
          }, 350);
        };
        requestAnimationFrame(pull);
      }, 350);
    };
    d.timer = setTimeout(cycle, 500);
  }
  function stopDemo() {
    if (!demo) return;
    demo.alive = false;
    clearTimeout(demo.timer);
    demo = null;
    endGrab(DEMO_ID);
    fingerEl.hidden = true;
  }
  for (const id of ['#file', '#fileCam']) {
    $(id).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) { stopDemo(); hideCoach(); loadFile(f); }
      e.target.value = '';
    });
  }
  $('#btnEdit').addEventListener('click', () => { if (!detecting) setEditing(!editing); });
  $('#editDone').addEventListener('click', () => setEditing(false));
  $('#btnFeel').addEventListener('click', () => { if (openId === 'sheet') closeSheet(); else openSheet('sheet'); });
  $('#sheetClose').addEventListener('click', closeSheet);

  // ---------- 느낌 조절 ----------
  const sliders = [
    ['#sFreq', '#oFreq', 'freq', (v) => v <= 3 ? '느긋' : v <= 5 ? '보통' : '통통'],
    ['#sWobble', '#oWobble', 'wobble', (v) => v <= 0.4 ? '살짝' : v <= 0.8 ? '보통' : '흐물'],
    ['#sStretch', '#oStretch', 'stretch', (v) => v <= 0.45 ? '조금' : v <= 0.75 ? '보통' : '쭉'],
    ['#sGrab', '#oGrab', 'grab', (v) => v <= 0.85 ? '좁게' : v <= 1.15 ? '보통' : '넓게'],
  ];
  const checks = [['#cMask', 'mask'], ['#cShow', 'show'], ['#cHaptic', 'haptic']];
  if (DEV) $('.dev-only').hidden = false;

  function currentPreset() {
    for (const [name, p] of Object.entries(PRESETS)) if (Math.abs(settings.freq - p.freq) < 0.05 && Math.abs(settings.wobble - p.wobble) < 0.02) return name;
    return null;
  }
  function syncUI() {
    for (const [s, o, key, fmt] of sliders) { $(s).value = settings[key]; $(o).textContent = fmt(settings[key]); }
    for (const [s, key] of checks) $(s).checked = settings[key];
    const cur = currentPreset();
    for (const b of document.querySelectorAll('.preset')) b.classList.toggle('on', b.dataset.preset === cur);
  }
  for (const [s, o, key, fmt] of sliders) {
    $(s).addEventListener('input', (e) => {
      settings[key] = parseFloat(e.target.value);
      $(o).textContent = fmt(settings[key]);
      saveSettings();
      const cur = currentPreset();
      for (const b of document.querySelectorAll('.preset')) b.classList.toggle('on', b.dataset.preset === cur);
    });
  }
  for (const [s, key] of checks) {
    $(s).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveSettings();
      if (key === 'mask') { settle(); updateFree(); render(); }
      if (key === 'show') regionsEl.classList.toggle('ghost', !editing && settings.show);
    });
  }
  for (const b of document.querySelectorAll('.preset')) {
    b.addEventListener('click', () => {
      Object.assign(settings, PRESETS[b.dataset.preset]);
      saveSettings(); syncUI();
      buzz(10);
    });
  }
  $('#btnReset').addEventListener('click', () => {
    for (const k of Object.keys(RANGES)) settings[k] = DEFAULTS[k]; // 진동·원 표시 설정은 그대로
    saveSettings();
    syncUI(); settle(); updateFree(); render();
    regionsEl.classList.toggle('ghost', !editing && settings.show);
  });

  // ---------- 시작 ----------
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); running = false;
    grabs.clear(); nav.clear();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      initGL();
      if (srcCanvas) { uploadTexture(); buildMesh(); clearGrabs(); layout(); }
    } catch (e) { console.error(e); fatal('화면을 다시 그리지 못했어요. 페이지를 새로고침해 주세요.'); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && n) render(); });
  window.addEventListener('pageshow', () => { if (n) render(); });

  try { history.replaceState(null, ''); } catch { /* 무시 */ }
  try { initGL(); } catch (e) {
    console.error(e);
    fatal('이 브라우저에서는 사진을 움직일 수 없어요. 크롬이나 사파리에서 열어주세요.');
    return;
  }
  syncUI();
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(stage);
  else window.addEventListener('resize', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => document.documentElement.classList.add('fonts-ready'));
  else document.documentElement.classList.add('fonts-ready');
  loadSample(0)
    .then(() => {
      if (!flag('cheek.onboarded')) startOnboarding();
      preloadLandmarker();
    })
    .catch((e) => {
      console.error(e);
      showCoach('샘플 사진을 불러오지 못했어요. 인터넷을 확인하거나 [사진 불러오기]로 내 사진을 넣어주세요.', [{ label: '알겠어요', onClick: hideCoach }], true);
    });

  // 디버그/자동 검증용
  window.__cheek = {
    settings, grabs, detectFaces, beginGrab, moveGrab, endGrab, step, render, toImg, captureFrame,
    get state() { return { n, cols, rows, A, dx, dy, vx, vy, free, owner, regions, faceOvals, imgRect, view, running, detecting, coachStep, editing, selected, maskActive, openId, shareBlob }; },
  };
})();
