// 볼 꼬집기 시제품
// 사진을 WebGL 격자 메시에 입히고, 정점마다 스프링-댐퍼 물리를 돌린다.
// 좌표계: 이미지 공간. 가로 = 1, 세로 = A(세로/가로 비율). 원본 사진은 절대 수정하지 않는다.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const canvas = $('#gl');
  const regionsEl = $('#regions');
  const hintEl = $('#hint');
  const toastEl = $('#toast');

  // ---------- 설정 ----------
  // 의견 보내기 버튼이 여는 주소(구글 폼 등). 비어 있으면 "준비 중" 안내만 뜬다.
  const FEEDBACK_URL = '';
  const NUDGE_AFTER = 30; // 이만큼 당기고 놓으면 한 번 의견을 부탁한다

  const DEFAULTS = { freq: 4, wobble: 0.75, stretch: 0.6, grab: 1.0, mask: true, show: false, haptic: true };
  const settings = { ...DEFAULTS, ...loadJSON('cheek.settings') };

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
  }
  function saveJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ }
  }
  function flag(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
  function setFlag(key) { try { localStorage.setItem(key, '1'); } catch { /* 무시 */ } }

  // ---------- WebGL ----------
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
  if (!gl) {
    hintEl.textContent = '이 브라우저는 WebGL을 지원하지 않습니다';
    return;
  }

  const VS = `
    attribute vec2 aPos; attribute vec2 aUV;
    uniform vec2 uO; uniform vec2 uS;
    varying vec2 vUV;
    void main() {
      vUV = aUV;
      gl_Position = vec4(uO.x + aPos.x * uS.x, uO.y - aPos.y * uS.y, 0.0, 1.0);
    }`;
  // 2패스: 1) 변형된 메시에 사진을 그린다 2) 보호할 얼굴(앞사람)만 원본 위치에 다시 덮어 그린다.
  // 2패스의 알파는 마스크 텍스처(얼굴 윤곽을 픽셀 단위로 칠한 것)에서 온다 → 격자와 무관하게 정확한 누끼.
  const FS = `
    precision mediump float;
    varying vec2 vUV; uniform sampler2D uTex; uniform sampler2D uMask; uniform float uUseMask;
    void main() {
      vec4 c = texture2D(uTex, vUV);
      float a = uUseMask > 0.5 ? texture2D(uMask, vUV).a : 1.0;
      gl_FragColor = vec4(c.rgb, a);
    }`;

  let prog, locPos, locUV, locO, locS, locUseMask, posBuf, restBuf, uvBuf, idxBuf, tex, maskTex, uintIndex;

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
    gl.useProgram(prog);
    locPos = gl.getAttribLocation(prog, 'aPos');
    locUV = gl.getAttribLocation(prog, 'aUV');
    locO = gl.getUniformLocation(prog, 'uO');
    locS = gl.getUniformLocation(prog, 'uS');
    locUseMask = gl.getUniformLocation(prog, 'uUseMask');
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uMask'), 1);
    posBuf = gl.createBuffer(); restBuf = gl.createBuffer(); uvBuf = gl.createBuffer(); idxBuf = gl.createBuffer();
    tex = gl.createTexture(); maskTex = gl.createTexture();
    uintIndex = !!gl.getExtension('OES_element_index_uint'); // 격자가 촘촘하면 인덱스가 65535를 넘는다
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0x17 / 255, 0x12 / 255, 0x0f / 255, 1);
  }

  // ---------- 메시 + 물리 상태 ----------
  const GRID_FINE = 224, GRID_COARSE = 96; // 긴 변 기준 격자 칸 수. 촘촘할수록 늘어난 실루엣의 다각형 티가 안 난다.
  let A = 1;            // 이미지 세로/가로 비율
  let cols, rows, n, stride, indexCount;
  let restX, restY, dx, dy, vx, vy, tgtX, tgtY, held, free, owner, pos;
  let srcCanvas = null; // 텍스처 원본(컨텍스트 복구용)

  function buildMesh() {
    const G = uintIndex ? GRID_FINE : GRID_COARSE;
    if (A >= 1) { rows = G; cols = Math.max(8, Math.round(G / A)); }
    else { cols = G; rows = Math.max(8, Math.round(G * A)); }
    stride = cols + 1;
    n = stride * (rows + 1);
    restX = new Float32Array(n); restY = new Float32Array(n);
    dx = new Float32Array(n); dy = new Float32Array(n);
    vx = new Float32Array(n); vy = new Float32Array(n);
    tgtX = new Float32Array(n); tgtY = new Float32Array(n); held = new Float32Array(n);
    free = new Uint8Array(n); owner = new Int16Array(n);
    pos = new Float32Array(n * 2);
    const uv = new Float32Array(n * 2);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = j * stride + i;
      restX[k] = i / cols; restY[k] = (j / rows) * A;
      uv[k * 2] = i / cols; uv[k * 2 + 1] = j / rows;
    }
    const idx = new (uintIndex ? Uint32Array : Uint16Array)(cols * rows * 6);
    let p = 0;
    // 대각선 방향을 체크무늬로 번갈아 둔다. 한 방향으로만 자르면 늘어난 경계에 한쪽으로 쏠린 지그재그가 생긴다.
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      if ((i + j) & 1) {
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      } else {
        idx[p++] = a; idx[p++] = c; idx[p++] = d;
        idx[p++] = a; idx[p++] = d; idx[p++] = b;
      }
    }
    indexCount = idx.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
    const rest = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { rest[k * 2] = restX[k]; rest[k * 2 + 1] = restY[k]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, restBuf);
    gl.bufferData(gl.ARRAY_BUFFER, rest, gl.STATIC_DRAW);
    updateFree();
  }

  // ---------- 볼 영역 ----------
  // cx, cy, r 모두 이미지 가로 = 1 기준
  let regions = [];
  function defaultRegions() {
    return [
      { cx: 0.33, cy: 0.55 * A, r: 0.12 },
      { cx: 0.67, cy: 0.55 * A, r: 0.12 },
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

  // 얼굴 윤곽(타원). 자동 인식 때만 채워진다. { id, cx, cy, rx, ry, W }
  // 얼굴이 겹치면 더 큰(=앞에 있는) 얼굴의 안쪽은 뒷사람 볼을 당겨도 움직이지 않게 보호한다.
  let faceOvals = [];
  function protection(reg, x, y) {
    let f = 1;
    for (const o of faceOvals) {
      if (o.id === reg.face || o.W <= (reg.W || 0) * 1.02) continue; // 같은 얼굴이거나 뒤에 있는 얼굴이면 무시
      const e = Math.hypot((x - o.cx) / o.rx, (y - o.cy) / o.ry);
      f *= smoothstep(0.7, 1.2, e); // 타원 안 0 → 경계 밖 1. 띠를 넓게 잡아 정점 변위가 급하게 꺾이지 않게 한다(정확한 경계는 픽셀 마스크가 맡음)
      if (f === 0) break;
    }
    return f;
  }
  function effMask(reg, x, y) {
    const m = regionMask(reg, x, y);
    return m > 0 && faceOvals.length ? m * protection(reg, x, y) : m;
  }

  // 정점마다 움직일 수 있는지(free)와 주인 볼(owner)을 정한다.
  // 테두리는 항상 고정. 마스크 모드에서는 어느 볼 영역에도 안 들면 고정.
  // 주인이 다른 이웃끼리는 물리 결합을 끊어서, 한 사람 볼을 당겨도 옆 사람 볼이 따라오지 않는다.
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
  // pointerId -> { sx, sy, Dx, Dy, limit, w }. w는 그 손가락이 각 정점을 끌고 가는 비율(0~1).
  const grabs = new Map();
  const MAX_GRABS = 4;

  function beginGrab(id, x, y) {
    if (grabs.size >= MAX_GRABS || grabs.has(id)) return false;
    let reg = null, regIdx = -1, Rg;
    if (settings.mask) {
      let best = Infinity;
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const d = Math.hypot(x - r.cx, y - r.cy);
        if (d < Math.max(r.r * GRAB_HIT, MIN_HIT_PX / imgRect.w) && d < best) { best = d; reg = r; regIdx = i; }
      }
      if (!reg) return false;
      Rg = reg.r * GRAB_BASE * settings.grab;
    } else {
      const avg = regions.reduce((s, r) => s + r.r, 0) / (regions.length || 1) || 0.12;
      Rg = avg * GRAB_BASE * settings.grab;
    }
    const w = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      // 주인 볼과 상관없이 이 볼의 영향권(effMask) 안이면 전부 부드럽게 따라온다.
      // 주인으로 걸러내면 두 사람 볼 영역이 겹치는 경계에서 한 칸씩 어긋난 톱니가 생긴다(실제로 겪음).
      if (!free[k]) continue;
      const q = Math.hypot(restX[k] - x, restY[k] - y) / Rg;
      let g = q < 1 ? (1 - q * q) * (1 - q * q) : 0;
      if (reg) g *= effMask(reg, restX[k], restY[k]);
      w[k] = g;
    }
    grabs.set(id, { sx: x, sy: y, Dx: 0, Dy: 0, limit: Rg * settings.stretch, w, face: reg ? reg.face : -1 });
    updateTargets();
    updateProtectMask();
    wake();
    return true;
  }

  function moveGrab(id, x, y) {
    const g = grabs.get(id);
    if (!g) return;
    // 당긴 거리에 부드러운 한계를 둔다(tanh). 한계를 넘기면 메시가 접혀 사진이 찢어져 보인다.
    const mx = x - g.sx, my = y - g.sy;
    const len = Math.hypot(mx, my);
    if (len < 1e-6) { g.Dx = g.Dy = 0; }
    else {
      const s = (g.limit * Math.tanh(len / g.limit)) / len;
      g.Dx = mx * s; g.Dy = my * s;
    }
    updateTargets();
    wake();
  }

  function endGrab(id) {
    if (!grabs.delete(id)) return false;
    updateTargets();
    wake();
    return true;
  }

  function clearGrabs() {
    grabs.clear();
    updateTargets();
  }

  // 모든 손가락의 당김을 합쳐 정점별 목표 변위(tgtX, tgtY)와 "잡혀 있는 정도"(held)를 만든다.
  function updateTargets() {
    tgtX.fill(0); tgtY.fill(0); held.fill(0);
    for (const g of grabs.values()) {
      const w = g.w;
      for (let k = 0; k < n; k++) {
        const wk = w[k];
        if (wk === 0) continue;
        tgtX[k] += wk * g.Dx; tgtY[k] += wk * g.Dy; held[k] += wk;
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
    dx.fill(0); dy.fill(0); vx.fill(0); vy.fill(0);
    maskActive = false; maskKey = '';
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
    if (grabs.size === 0 && energy < 2e-5) { settle(); running = false; }
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
    gl.uniform2f(locO, -1 + (2 * imgRect.x) / r.width, 1 - (2 * imgRect.y) / r.height);
    gl.uniform2f(locS, (2 * imgRect.w) / r.width, (2 * imgRect.h) / r.height / A);
    placeRegions();
    render();
  }

  function render() {
    if (!n) return;
    for (let k = 0; k < n; k++) { pos[k * 2] = restX[k] + dx[k]; pos[k * 2 + 1] = restY[k] + dy[k]; }
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(locUV);
    gl.vertexAttribPointer(locUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    const type = uintIndex ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    // 1패스: 변형된 사진
    gl.disable(gl.BLEND);
    gl.uniform1f(locUseMask, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawElements(gl.TRIANGLES, indexCount, type, 0);
    // 2패스: 보호할 얼굴을 원본 자리에 픽셀 단위로 덮는다
    if (maskActive) {
      gl.enable(gl.BLEND);
      gl.uniform1f(locUseMask, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, restBuf);
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawElements(gl.TRIANGLES, indexCount, type, 0);
      gl.disable(gl.BLEND);
    }
  }

  // ---------- 픽셀 단위 얼굴 보호 마스크 ----------
  // 잡힌 볼의 얼굴보다 앞에 있는(더 큰) 얼굴들의 윤곽 폴리곤을 캔버스에 칠해 텍스처로 올린다.
  // 이 마스크가 있는 동안 2패스가 그 얼굴 픽셀을 원본 그대로 덮어 그린다.
  let maskActive = false, maskKey = '';
  const MASK_PX = 768;
  function updateProtectMask() {
    const grabbedFaces = new Set();
    for (const g of grabs.values()) if (g.face !== undefined && g.face >= 0) grabbedFaces.add(g.face);
    let minW = Infinity;
    for (const o of faceOvals) if (grabbedFaces.has(o.id)) minW = Math.min(minW, o.W);
    const front = grabbedFaces.size ? faceOvals.filter((o) => !grabbedFaces.has(o.id) && o.W > minW * 1.02 && o.poly) : [];
    const key = front.map((o) => o.id).join(',');
    if (!front.length) { if (!grabs.size) return; maskActive = false; maskKey = ''; return; } // 놓은 뒤엔 멈출 때까지 유지
    if (key === maskKey && maskActive) return;
    maskKey = key;
    const c = document.createElement('canvas');
    c.width = MASK_PX; c.height = Math.round(MASK_PX * A);
    const g = c.getContext('2d');
    const sx = MASK_PX, sy = MASK_PX / A; // 이미지 공간(가로 1, 세로 A) → 캔버스 픽셀
    g.fillStyle = '#fff';
    try { g.filter = 'blur(1.5px)'; } catch { /* 지원 안 하면 딱딱한 경계 */ }
    for (const o of front) {
      g.beginPath();
      o.poly.forEach(([x, y], i) => { if (i) g.lineTo(x * sx, y * sy); else g.moveTo(x * sx, y * sy); });
      g.closePath(); g.fill();
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    maskActive = true;
  }

  function uploadTexture() {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    // 2의 거듭제곱이 아닌 크기의 텍스처는 WebGL1에서 CLAMP + 밉맵 없음이어야 한다
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  // drawable: HTMLImageElement | ImageBitmap | HTMLCanvasElement
  function setImage(drawable, sw, sh, newRegions) {
    const maxSide = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
    c.getContext('2d').drawImage(drawable, 0, 0, c.width, c.height);
    srcCanvas = c;
    A = c.height / c.width;
    regions = newRegions || defaultRegions();
    faceOvals = []; // 자동 인식이 끝나면 다시 채운다
    grabs.clear();
    view.z = 1; view.cx = 0.5; view.cy = A / 2;
    uploadTexture();
    buildMesh();
    buildRegionEls();
    layout();
  }

  // ---------- 사진 불러오기 (기기 안에서만 처리) ----------
  // Blob/File → 그릴 수 있는 객체와 원본 크기. EXIF 회전을 반영한다.
  async function decodeImage(blob) {
    if ('createImageBitmap' in window) {
      try {
        const bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        return { drawable: bm, sw: bm.width, sh: bm.height };
      } catch { /* 아래 대체 경로 */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const im = await new Promise((res, rej) => {
        const el = new Image();
        el.onload = () => res(el); el.onerror = rej; el.src = url;
      });
      return { drawable: im, sw: im.naturalWidth, sh: im.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  }

  async function loadFile(file) {
    try {
      const { drawable, sw, sh } = await decodeImage(file);
      setImage(drawable, sw, sh, null);
      if (drawable.close) drawable.close();
    } catch (e) {
      console.error(e);
      const kind = (file.type || file.name.split('.').pop() || '알 수 없음').replace('image/', '').toUpperCase();
      toast(`이 사진(${kind}, ${Math.round(file.size / 1024)}KB)은 열 수 없어요. JPG로 다시 시도해 보세요`);
      return;
    }
    await autoPlaceCheeks();
  }

  // ---------- 샘플 사진 (AI로 만든 가상의 아기. 실존 인물 아님) ----------
  // 볼 위치는 detectFaces로 미리 계산해 두었다. 덕분에 첫 화면에서 인식 모델(15MB)을 내려받지 않는다.
  // 사진을 바꾸면 이 좌표도 다시 계산할 것 (브라우저 콘솔에서 __cheek.detectFaces).
  const SAMPLES = [
    { src: 'samples/baby1.jpg', regions: [{ cx: 0.3516, cy: 0.7302, r: 0.1 }, { cx: 0.6851, cy: 0.6989, r: 0.1 }] },
    { src: 'samples/baby2.jpg', regions: [{ cx: 0.3380, cy: 0.7270, r: 0.1 }, { cx: 0.6640, cy: 0.7574, r: 0.1 }] },
    { src: 'samples/baby3.jpg', regions: [{ cx: 0.3451, cy: 0.6601, r: 0.1 }, { cx: 0.6823, cy: 0.6098, r: 0.1 }] },
  ];
  async function loadSample(i) {
    const smp = SAMPLES[i];
    const blob = await (await fetch(smp.src)).blob();
    const { drawable, sw, sh } = await decodeImage(blob);
    setImage(drawable, sw, sh, smp.regions.map((r) => ({ ...r })));
    if (drawable.close) drawable.close();
  }

  // ---------- 자동 볼 인식 (MediaPipe Face Landmarker, 기기 안에서만 실행) ----------
  // 모델과 wasm은 vendor/mediapipe에 자체 호스팅한다. 외부 CDN이나 서버로 사진이 나가지 않는다.
  const MP = './vendor/mediapipe/';
  let landmarkerP = null;
  function getLandmarker() {
    if (!landmarkerP) {
      landmarkerP = (async () => {
        const { FaceLandmarker } = await import(MP + 'vision_bundle.mjs');
        return FaceLandmarker.createFromOptions(
          { wasmLoaderPath: MP + 'vision_wasm_internal.js', wasmBinaryPath: MP + 'vision_wasm_internal.wasm' },
          {
            baseOptions: { modelAssetPath: MP + 'face_landmarker.task', delegate: 'CPU' },
            runningMode: 'IMAGE',
            numFaces: 4,
          },
        );
      })();
      landmarkerP.catch(() => { landmarkerP = null; }); // 실패하면 다음에 다시 시도
    }
    return landmarkerP;
  }

  // 얼굴 메시 468점 중 볼 가운데를 둘러싼 점들. 평균을 볼 중심으로 쓴다. (사진 기준 왼쪽 / 오른쪽)
  const CHEEK_SETS = [[50, 187, 205], [280, 411, 425]];
  const FACE_EDGE = [234, 454];   // 얼굴 좌우 끝. 이 폭으로 볼 크기를 정한다.
  // 얼굴 윤곽(턱선~이마)을 도는 랜드마크. 앞사람 얼굴을 픽셀 단위로 보호할 때 쓴다.
  const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const OVAL_GROW = 1.04;         // 윤곽을 살짝 키워 경계 픽셀까지 덮는다
  const CHEEK_R_RATIO = 0.19;     // 볼 원 반지름 = 얼굴 폭 × 이 값
  const MIN_FACE = 0.05;          // 사진 가로 대비 이보다 작은 얼굴(배경 속 행인 등)은 무시

  // 얼굴마다 { W: 얼굴 폭, box: 얼굴 경계 상자, cheeks: [볼 두 개] }. 큰 얼굴부터.
  // 인식기는 가까이서 찍은 큰 얼굴용이라 단체 사진의 작은 얼굴을 놓친다.
  // 그래서 전체에서 찾은 얼굴이 작거나 없으면, 사진을 겹치는 3×3 조각으로 나눠 한 번 더 찾는다.
  const TILE_IF_FACE_UNDER = 0.35;
  async function detectFaces(source) {
    const lm = await getLandmarker();
    let faces = facesFrom(lm.detect(source), 0, 0, 1, A);
    if (!faces.length || faces[0].W < TILE_IF_FACE_UNDER) {
      const px = source.width, tw = 0.5, th = 0.5 * A;
      const c = document.createElement('canvas');
      c.width = Math.round(tw * px); c.height = Math.round(th * px);
      const g = c.getContext('2d');
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const x0 = i * 0.25, y0 = j * 0.25 * A;
        g.drawImage(source, x0 * px, y0 * px, c.width, c.height, 0, 0, c.width, c.height);
        for (const f of facesFrom(lm.detect(c), x0, y0, tw, th)) {
          // 이미 찾은 얼굴과 겹치면 버린다
          const cx = (f.box.x0 + f.box.x1) / 2, cy = (f.box.y0 + f.box.y1) / 2;
          const dup = faces.some((e) => Math.hypot((e.box.x0 + e.box.x1) / 2 - cx, (e.box.y0 + e.box.y1) / 2 - cy) < Math.max(e.W, f.W) * 0.5);
          if (!dup) faces.push(f);
        }
      }
      faces.sort((p, q) => q.W - p.W);
    }
    return faces.slice(0, 6);
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
      const cheeks = CHEEK_SETS.map((set) => {
        let x = 0, y = 0;
        for (const i of set) { const p = P(i); x += p.x; y += p.y; }
        return { cx: x / set.length, cy: y / set.length, r };
      });
      // 윤곽 폴리곤 (무게중심 기준으로 살짝 키움)
      const pts = FACE_OVAL.map(P);
      const gx = pts.reduce((a, q) => a + q.x, 0) / pts.length, gy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
      const poly = pts.map((q) => [gx + (q.x - gx) * OVAL_GROW, gy + (q.y - gy) * OVAL_GROW]);
      faces.push({ W, box, cheeks, poly });
    }
    return faces.sort((p, q) => q.W - p.W);
  }

  // 인식된 얼굴 목록 → 볼 영역(어느 얼굴 것인지 표시)과 얼굴 타원
  function regionsAndOvals(faces) {
    const regs = [], ovals = [];
    faces.forEach((f, id) => {
      for (const c of f.cheeks) regs.push({ ...c, face: id, W: f.W });
      ovals.push({
        id, W: f.W, poly: f.poly,
        cx: (f.box.x0 + f.box.x1) / 2, cy: (f.box.y0 + f.box.y1) / 2,
        rx: ((f.box.x1 - f.box.x0) / 2) * 1.05, ry: ((f.box.y1 - f.box.y0) / 2) * 1.05,
      });
    });
    return { regs, ovals };
  }

  let detecting = false, detectToken = 0;
  async function autoPlaceCheeks() {
    const token = ++detectToken;
    detecting = true;
    $('#busy').hidden = false;
    hintEl.textContent = '볼 찾는 중…';
    let faces = null;
    try { faces = await detectFaces(srcCanvas); } catch (e) { console.error(e); }
    if (token !== detectToken) return; // 그 사이 다른 사진을 불러왔다
    detecting = false;
    $('#busy').hidden = true;
    if (faces && faces.length) {
      const ro = regionsAndOvals(faces);
      regions = ro.regs; faceOvals = ro.ovals;
      settle(); updateFree(); buildRegionEls();
      setEditing(false);
      const small = faces[0].W < 0.35; // 얼굴이 작으면 확대 방법을 알려준다 (자동으로 확대하지 않는다)
      toast(faces.length > 1 ? `얼굴 ${faces.length}개를 찾았어요! 볼을 잡고 당겨보세요` : '볼을 찾았어요! 잡고 당겨보세요');
      if (small) setTimeout(() => toast('두 손가락으로 벌리면 확대, 빈 곳을 끌면 이동돼요'), 2000);
    } else {
      setEditing(true);
      toast(faces ? '얼굴을 못 찾았어요. 원을 볼 위로 옮겨주세요' : '자동 인식을 못 했어요. 원을 볼 위로 옮겨주세요');
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
  // 빈 곳에 닿으면 "보기" 모드(한 손가락 이동, 두 손가락 확대). 편집 중에는 항상 보기 모드.
  const nav = new Map(); // pointerId -> 스테이지 CSS 픽셀 좌표
  function stagePt(e) { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  canvas.addEventListener('pointerdown', (e) => {
    if (detecting) return;
    stopDemo();
    const p = toImg(e.clientX, e.clientY);
    if (!editing && nav.size === 0 && beginGrab(e.pointerId, p.x, p.y)) {
      buzz(12);
    } else if (grabs.size === 0) {
      nav.set(e.pointerId, stagePt(e));
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
    if (!nav.has(e.pointerId)) return;
    const cur = stagePt(e);
    if (nav.size === 1) {
      const prev = nav.get(e.pointerId);
      view.cx -= (cur.x - prev.x) / imgRect.w;
      view.cy -= (cur.y - prev.y) / imgRect.w;
    } else {
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
    nav.delete(e.pointerId);
    if (!endGrab(e.pointerId)) return;
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
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* 무시 */ } return; }
    if (iosHaptic) { try { iosHaptic.click(); } catch { /* 무시 */ } }
  }

  // ---------- 볼 영역 편집 ----------
  let editing = false;

  let selected = 0; // 편집 중인 볼 번호
  function buildRegionEls() {
    regionsEl.innerHTML = '';
    selected = Math.min(selected, Math.max(0, regions.length - 1));
    regions.forEach((reg, i) => {
      const el = document.createElement('div');
      el.className = 'region' + (i === selected ? ' selected' : '');
      el.innerHTML = `<span class="tag">볼 ${i + 1}</span><i class="handle"></i>`;
      regionsEl.appendChild(el);

      let mode = null, offX = 0, offY = 0;
      el.addEventListener('pointerdown', (e) => {
        if (!editing) return;
        selectRegion(i);
        mode = e.target.classList.contains('handle') ? 'resize' : 'move';
        const p = toImg(e.clientX, e.clientY);
        offX = p.x - reg.cx; offY = p.y - reg.cy;
        el.setPointerCapture(e.pointerId);
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointermove', (e) => {
        if (!mode) return;
        const p = toImg(e.clientX, e.clientY);
        if (mode === 'move') {
          reg.cx = Math.min(1, Math.max(0, p.x - offX));
          reg.cy = Math.min(A, Math.max(0, p.y - offY));
        } else {
          reg.r = Math.min(0.45, Math.max(0.03, Math.hypot(p.x - reg.cx, p.y - reg.cy)));
        }
        placeRegions(); syncEditPanel();
      });
      const up = () => { mode = null; };
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

  // ---------- 볼 위치 편집 패널 (탭 · 방향 버튼 · 크기 슬라이더) ----------
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
        b.className = 'chip'; b.textContent = `볼 ${i + 1}`;
        b.addEventListener('click', () => selectRegion(i));
        tabs.appendChild(b);
      });
    }
    [...tabs.children].forEach((b, i) => b.classList.toggle('on', i === selected));
    const reg = regions[selected];
    if (!reg) return;
    $('#sSize').value = reg.r;
    $('#oSize').textContent = Math.round(reg.r * imgRect.w) + 'px';
  }
  function nudge(dx, dy) {
    const reg = regions[selected]; if (!reg) return;
    reg.cx = Math.min(1, Math.max(0, reg.cx + dx * NUDGE));
    reg.cy = Math.min(A, Math.max(0, reg.cy + dy * NUDGE));
    placeRegions();
  }
  function setSize(r) {
    const reg = regions[selected]; if (!reg) return;
    reg.r = Math.min(0.45, Math.max(0.03, r));
    placeRegions(); syncEditPanel();
  }
  // 방향 버튼: 누르면 한 칸, 길게 누르면 계속
  for (const b of document.querySelectorAll('.dbtn')) {
    const dx = +b.dataset.dx, dy = +b.dataset.dy;
    let hold = 0, rep = 0;
    const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = 0; };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      nudge(dx, dy);
      hold = setTimeout(() => { rep = setInterval(() => nudge(dx, dy), 60); }, 350);
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(t, stop);
  }
  $('#sSize').addEventListener('input', (e) => setSize(parseFloat(e.target.value)));
  $('#sizeDown').addEventListener('click', () => setSize(regions[selected].r * 0.92));
  $('#sizeUp').addEventListener('click', () => setSize(regions[selected].r * 1.08));

  function setEditing(on) {
    editing = on;
    if (on) { finishOnboarding(); clearGrabs(); settle(); render(); $('#sheet').hidden = true; $('#pick').hidden = true; }
    else { updateFree(); }
    $('#editPanel').hidden = !on;
    if (on) { selectRegion(Math.min(selected, regions.length - 1)); }
    regionsEl.classList.toggle('editing', on);
    regionsEl.classList.toggle('ghost', !on && settings.show);
    hintEl.textContent = on ? '볼 위치를 맞추는 중' : '볼을 누른 채로 당겼다가 놓아보세요';
    layout(); // 패널이 열리고 닫히면 사진 크기가 바뀐다
  }

  // ---------- UI ----------
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
  }

  // 사진 가져오기: 갤러리(사진 앱)와 카메라를 명확한 선택지로 보여준다.
  // 갤럭시는 갤러리·내 파일·카메라 중 고르는 창이, 아이폰은 사진 보관함·촬영·파일 선택 창이 뜬다.
  function pickPhoto() {
    getLandmarker().catch(() => { /* 사진 고르는 동안 모델을 미리 받는다. 실패는 인식 단계에서 처리 */ });
    $('#sheet').hidden = true;
    $('#pick').hidden = false;
  }
  function openInput(id) {
    $('#pick').hidden = true;
    const inp = $(id);
    inp.value = '';
    try { inp.showPicker ? inp.showPicker() : inp.click(); } catch { inp.click(); }
  }
  $('#pickGallery').addEventListener('click', () => openInput('#file'));
  $('#pickCamera').addEventListener('click', () => openInput('#fileCam'));
  $('#pickClose').addEventListener('click', () => { $('#pick').hidden = true; });
  SAMPLES.forEach((smp, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<img src="${smp.src}" alt="샘플 아기 ${i + 1}" loading="lazy">`;
    b.addEventListener('click', () => {
      $('#pick').hidden = true;
      stopDemo();
      loadSample(i).then(() => { setEditing(false); toast('볼을 잡고 당겨보세요'); })
        .catch((e) => { console.error(e); toast('샘플 사진을 불러오지 못했어요'); });
    });
    $('#sampleRow').appendChild(b);
  });
  $('#btnPhoto').addEventListener('click', () => { finishOnboarding(); pickPhoto(); });
  $('#btnHelp').addEventListener('click', () => {
    if (editing) setEditing(false);
    $('#sheet').hidden = true;
    startOnboarding();
  });
  $('#btnFeedback').addEventListener('click', () => { hideCoach(); openFeedback(); });

  function openFeedback() {
    if (!FEEDBACK_URL) { toast('의견 링크가 아직 준비되지 않았어요'); return; }
    window.open(FEEDBACK_URL, '_blank', 'noopener');
  }

  // ---------- 안내 카드 ----------
  const coachEl = $('#coach');
  function showCoach(text, buttons) {
    $('#coachText').textContent = text;
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
  let coachStep = 0;
  function startOnboarding() {
    coachStep = 1;
    showCoach('볼을 꾹 잡고 당겼다가 놓아보세요', []);
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
      hideCoach();
      setTimeout(() => {
        if (coachStep !== 2) return;
        showCoach('좋아요! 양볼을 두 손가락으로 동시에 당길 수도 있어요. 빈 곳을 끌면 사진이 움직이고, 두 손가락으로 벌리면 확대돼요', [
          { label: '내 사진으로 해보기', primary: true, onClick: () => { finishOnboarding(); pickPhoto(); } },
          { label: '계속 만지기', onClick: finishOnboarding },
        ]);
      }, 900);
      return;
    }
    if (!coachStep && FEEDBACK_URL && releases >= NUDGE_AFTER && !flag('cheek.nudged')) {
      setFlag('cheek.nudged');
      showCoach('재밌게 만지셨나요? 1분이면 끝나는 의견을 남겨주시면 큰 도움이 돼요', [
        { label: '의견 보내기', primary: true, onClick: () => { hideCoach(); openFeedback(); } },
        { label: '나중에', onClick: hideCoach },
      ]);
    }
  }

  // 시범 손가락: 가짜 포인터(id -1)로 실제 물리를 그대로 돌린다
  const fingerEl = $('#finger');
  const DEMO_ID = -1;
  let demo = null;
  function showFinger(x, y, down) {
    fingerEl.hidden = false;
    fingerEl.style.left = imgRect.x + x * imgRect.w + 'px';
    fingerEl.style.top = imgRect.y + y * imgRect.w + 'px';
    fingerEl.classList.toggle('down', down);
    fingerEl.classList.toggle('up', !down);
  }
  function startDemo() {
    stopDemo();
    const reg = regions[0];
    if (!reg) return;
    const d = { alive: true, timer: 0 };
    demo = d;
    const cycle = () => {
      if (!d.alive) return;
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
      if (f) { stopDemo(); loadFile(f); }
      e.target.value = '';
    });
  }
  $('#btnEdit').addEventListener('click', () => setEditing(!editing));
  $('#editDone').addEventListener('click', () => setEditing(false));
  $('#btnFeel').addEventListener('click', () => { $('#pick').hidden = true; if (editing) setEditing(false); $('#sheet').hidden = !$('#sheet').hidden; });
  $('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });

  const sliders = [
    ['#sFreq', '#oFreq', 'freq', (v) => v.toFixed(1) + ' Hz'],
    ['#sWobble', '#oWobble', 'wobble', (v) => Math.round(v * 100) + '%'],
    ['#sStretch', '#oStretch', 'stretch', (v) => Math.round(v * 100) + '%' + (v > 0.7 ? ' (접힐 수 있음)' : '')],
    ['#sGrab', '#oGrab', 'grab', (v) => Math.round(v * 100) + '%'],
  ];
  const checks = [['#cMask', 'mask'], ['#cShow', 'show'], ['#cHaptic', 'haptic']];

  function syncUI() {
    for (const [s, o, key, fmt] of sliders) { $(s).value = settings[key]; $(o).textContent = fmt(settings[key]); }
    for (const [s, key] of checks) $(s).checked = settings[key];
  }
  for (const [s, o, key, fmt] of sliders) {
    $(s).addEventListener('input', (e) => {
      settings[key] = parseFloat(e.target.value);
      $(o).textContent = fmt(settings[key]);
      saveJSON('cheek.settings', settings);
    });
  }
  for (const [s, key] of checks) {
    $(s).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveJSON('cheek.settings', settings);
      if (key === 'mask') { settle(); updateFree(); render(); }
      if (key === 'show') regionsEl.classList.toggle('ghost', !editing && settings.show);
    });
  }
  $('#btnReset').addEventListener('click', () => {
    Object.assign(settings, DEFAULTS);
    saveJSON('cheek.settings', settings);
    syncUI(); settle(); updateFree(); render();
    regionsEl.classList.toggle('ghost', !editing && settings.show);
  });

  // ---------- 시작 ----------
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; });
  canvas.addEventListener('webglcontextrestored', () => {
    initGL(); uploadTexture(); buildMesh(); layout();
  });

  initGL();
  syncUI();
  new ResizeObserver(layout).observe(stage);
  loadSample(0)
    .then(() => { setEditing(false); if (!flag('cheek.onboarded')) startOnboarding(); })
    .catch((e) => { console.error(e); toast('샘플 사진을 불러오지 못했어요. 사진 불러오기를 눌러주세요'); });

  // 디버그/자동 검증용
  window.__cheek = {
    settings, grabs, detectFaces, beginGrab, moveGrab, endGrab, step, render, toImg,
    get state() { return { n, cols, rows, A, dx, dy, vx, vy, free, owner, regions, faceOvals, imgRect, view, running, detecting, coachStep, editing, selected, maskActive, uintIndex }; },
  };
})();
