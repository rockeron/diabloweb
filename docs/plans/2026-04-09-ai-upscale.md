# AI Upscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DiabloWeb의 640x480 게임 화면을 고해상도로 업스케일하여 HD 품질로 플레이할 수 있게 한다.

**Architecture:** WASM 엔진이 640x480 프레임을 렌더링하면, xBRZ 알고리즘 기반 WebGL 셰이더가 실시간으로 4x 업스케일(2560x1920)한다. 별도로 오프라인 파이프라인에서 Real-ESRGAN으로 스프라이트를 추출/업스케일하여 HD 에셋팩을 생성한다 (향후 WASM 재컴파일 시 사용).

**Tech Stack:** WebGL2 (xBRZ shader), Node.js (sprite extraction), Python + Real-ESRGAN (offline upscale)

---

## Phase 1: 실시간 프레임 업스케일 (xBRZ WebGL)

### Task 1: xBRZ WebGL 업스케일러 모듈 생성

**Files:**
- Create: `src/upscale/xbrz-shader.js`

xBRZ는 픽셀아트 전용 업스케일 알고리즘으로, hqx/xBR 계열 중 가장 품질이 좋다. WebGL fragment shader로 구현하여 GPU 가속으로 실시간 처리한다.

- [ ] **Step 1: xBRZ WebGL 셰이더 모듈 생성**

```js
// src/upscale/xbrz-shader.js

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

// Simplified xBRZ-style shader that enhances pixel art edges
// Full xBRZ is complex (5000+ lines); this uses a practical subset
// that provides good results with the edge-detection core
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform vec2 u_textureSize;

// Color distance function (YUV-weighted)
float colorDist(vec4 a, vec4 b) {
  vec3 d = a.rgb - b.rgb;
  float y = dot(d, vec3(0.299, 0.587, 0.114));
  float u = 0.493 * (d.b - y);
  float v = 0.877 * (d.r - y);
  return sqrt(y*y + u*u + v*v);
}

void main() {
  vec2 texel = 1.0 / u_textureSize;
  vec2 pos = v_texCoord;

  // Sample 3x3 neighborhood
  vec4 c = texture(u_texture, pos);
  vec4 u0 = texture(u_texture, pos + vec2(0.0, -texel.y));
  vec4 d0 = texture(u_texture, pos + vec2(0.0, texel.y));
  vec4 l0 = texture(u_texture, pos + vec2(-texel.x, 0.0));
  vec4 r0 = texture(u_texture, pos + vec2(texel.x, 0.0));
  vec4 ul = texture(u_texture, pos + vec2(-texel.x, -texel.y));
  vec4 ur = texture(u_texture, pos + vec2(texel.x, -texel.y));
  vec4 dl = texture(u_texture, pos + vec2(-texel.x, texel.y));
  vec4 dr = texture(u_texture, pos + vec2(texel.x, texel.y));

  // Sub-pixel position within the source texel
  vec2 fp = fract(pos * u_textureSize);

  // Edge detection using color distance
  float dlu = colorDist(l0, u0);
  float dru = colorDist(r0, u0);
  float dld = colorDist(l0, d0);
  float drd = colorDist(r0, d0);

  // Interpolation weights based on edge direction
  vec4 result = c;
  float threshold = 0.15;

  // Corner blending for smoother diagonal edges
  if (fp.x < 0.5 && fp.y < 0.5) {
    // Top-left quadrant
    if (colorDist(c, ul) < threshold && dlu > threshold * 2.0) {
      result = mix(c, ul, 0.25 * (1.0 - fp.x) * (1.0 - fp.y));
    }
  } else if (fp.x >= 0.5 && fp.y < 0.5) {
    // Top-right quadrant
    if (colorDist(c, ur) < threshold && dru > threshold * 2.0) {
      result = mix(c, ur, 0.25 * fp.x * (1.0 - fp.y));
    }
  } else if (fp.x < 0.5 && fp.y >= 0.5) {
    // Bottom-left quadrant
    if (colorDist(c, dl) < threshold && dld > threshold * 2.0) {
      result = mix(c, dl, 0.25 * (1.0 - fp.x) * fp.y);
    }
  } else {
    // Bottom-right quadrant
    if (colorDist(c, dr) < threshold && drd > threshold * 2.0) {
      result = mix(c, dr, 0.25 * fp.x * fp.y);
    }
  }

  fragColor = result;
}`;

export class XbrzUpscaler {
  constructor(sourceWidth, sourceHeight, scale = 4) {
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.scale = scale;
    this.outWidth = sourceWidth * scale;
    this.outHeight = sourceHeight * scale;
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.canvas = null;
  }

  init() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.outWidth;
    this.canvas.height = this.outHeight;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    // Compile shaders
    const vs = this._compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error('Shader link failed: ' + gl.getProgramInfoLog(this.program));
    }

    // Set up quad geometry
    const positions = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    const texCoords = new Float32Array([0,1, 1,1, 0,0, 1,0]);

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const texBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    const texLoc = gl.getAttribLocation(this.program, 'a_texCoord');
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    // Create texture for source frame
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.useProgram(this.program);
    gl.uniform2f(
      gl.getUniformLocation(this.program, 'u_textureSize'),
      this.sourceWidth, this.sourceHeight
    );
    gl.viewport(0, 0, this.outWidth, this.outHeight);
  }

  /**
   * Upscale a source canvas/image and return the HD canvas
   * @param {HTMLCanvasElement|ImageBitmap} source - 640x480 source
   * @returns {HTMLCanvasElement} - upscaled canvas
   */
  upscale(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  destroy() {
    if (this.gl) {
      this.gl.deleteTexture(this.texture);
      this.gl.deleteProgram(this.program);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/upscale/xbrz-shader.js
git commit -m "feat: add xBRZ WebGL upscaler module"
```

---

### Task 2: 게임 렌더링 파이프라인에 업스케일러 통합

**Files:**
- Modify: `src/api/loader.js`
- Modify: `src/App.jsx`

게임 렌더링 흐름: WASM → draw_blit → canvas 640x480 → **xBRZ shader** → display canvas (2560x1920)

- [ ] **Step 1: loader.js에 업스케일 렌더링 통합**

`src/api/loader.js`를 수정하여, 게임 캔버스(640x480)를 렌더링한 후 xBRZ 업스케일러로 확대된 결과를 표시 캔버스에 그린다.

```js
// src/api/loader.js
import init_sound from './sound';
import load_spawn from './load_spawn';
import webrtc_open from './webrtc';
import { XbrzUpscaler } from '../upscale/xbrz-shader';

function onRender(api, ctx, upscaler, {bitmap, images, text, clip, belt}) {
  // Draw to the offscreen 640x480 source canvas
  const sourceCtx = api._sourceCtx;
  if (bitmap) {
    sourceCtx.transferFromImageBitmap(bitmap);
  } else {
    for (let {x, y, w, h, data} of images) {
      const image = sourceCtx.createImageData(w, h);
      image.data.set(data);
      sourceCtx.putImageData(image, x, y);
    }
    if (text.length) {
      sourceCtx.save();
      sourceCtx.font = 'bold 13px Times New Roman';
      if (clip) {
        const {x0, y0, x1, y1} = clip;
        sourceCtx.beginPath();
        sourceCtx.rect(x0, y0, x1 - x0, y1 - y0);
        sourceCtx.clip();
      }
      for (let {x, y, text: str, color} of text) {
        const r = ((color >> 16) & 0xFF);
        const g = ((color >> 8) & 0xFF);
        const b = (color & 0xFF);
        sourceCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        sourceCtx.fillText(str, x, y + 22);
      }
      sourceCtx.restore();
    }
  }

  // Upscale and draw to display canvas
  if (upscaler) {
    const hdCanvas = upscaler.upscale(api._sourceCanvas);
    ctx.drawImage(hdCanvas, 0, 0);
  }

  api.updateBelt(belt);
}

function testOffscreen() {
  return false;
}

async function do_load_game(api, audio, mpq, spawn) {
  const fs = await api.fs;
  if (spawn && !mpq) {
    await load_spawn(api, fs);
  }

  // Create offscreen source canvas (original 640x480)
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = 640;
  sourceCanvas.height = 480;
  api._sourceCanvas = sourceCanvas;
  api._sourceCtx = sourceCanvas.getContext('2d', { alpha: false });

  // Initialize upscaler if HD mode enabled
  let upscaler = null;
  const scale = api.hdScale || 1;
  if (scale > 1) {
    upscaler = new XbrzUpscaler(640, 480, scale);
    upscaler.init();
    api.canvas.width = 640 * scale;
    api.canvas.height = 480 * scale;
  }

  const context = api.canvas.getContext('2d', { alpha: false });

  return await new Promise((resolve, reject) => {
    try {
      const worker = new Worker(new URL('./game.worker.js', import.meta.url), { type: 'module' });

      let packetQueue = [];
      const webrtc = webrtc_open(data => {
        packetQueue.push(data);
      });

      worker.addEventListener("message", ({data}) => {
        switch (data.action) {
        case "loaded":
          resolve((func, ...params) => worker.postMessage({action: "event", func, params}));
          break;
        case "render":
          onRender(api, context, upscaler, data.batch);
          break;
        case "audio":
          audio[data.func](...data.params);
          break;
        case "audioBatch":
          for (let {func, params} of data.batch) {
            audio[func](...params);
          }
          break;
        case "fs":
          fs[data.func](...data.params);
          break;
        case "cursor":
          api.setCursorPos(data.x, data.y);
          break;
        case "keyboard":
          api.openKeyboard(data.rect);
          break;
        case "error":
          audio.stop_all();
          api.onError(data.error, data.stack);
          break;
        case "failed":
          reject({message: data.error, stack: data.stack});
          break;
        case "progress":
          api.onProgress({text: data.text, loaded: data.loaded, total: data.total});
          break;
        case "exit":
          api.onExit();
          break;
        case "current_save":
          api.setCurrentSave(data.name);
          break;
        case "packet":
          webrtc.send(data.buffer);
          break;
        case "packetBatch":
          for (let packet of data.batch) {
            webrtc.send(packet);
          }
          break;
        default:
        }
      });
      const transfer = [];
      for (let [, file] of fs.files) {
        transfer.push(file.buffer);
      }
      worker.postMessage({action: "init", files: fs.files, mpq, spawn, offscreen: false}, transfer);
      setInterval(() => {
        if (packetQueue.length) {
          worker.postMessage({action: "packetBatch", batch: packetQueue}, packetQueue);
          packetQueue.length = 0;
        }
      }, 20);
      delete fs.files;
    } catch (e) {
      reject(e);
    }
  });
}

export default function load_game(api, mpq, spawn) {
  const audio = init_sound();
  return do_load_game(api, audio, mpq, spawn);
}
```

- [ ] **Step 2: App.jsx에 HD 모드 토글 추가**

`src/App.jsx`에서 `start()` 메서드를 찾아 `this.hdScale` 속성을 게임 시작 전에 설정하고, UI에 HD 토글 버튼을 추가한다.

App.jsx의 state에 `hdMode: true` 추가, start 메서드에서 `this.hdScale = this.state.hdMode ? 4 : 1` 설정, 게임 시작 전 UI에 체크박스 추가.

구체적 변경:
1. state에 `hdMode: true` 추가
2. `start()` 메서드에서 canvas의 api 객체에 `api.hdScale = this.state.hdMode ? 4 : 1` 전달
3. 게임 시작 전 화면에 "HD Mode (4x)" 체크박스 렌더링

- [ ] **Step 3: 마우스 좌표 스케일링 처리**

HD 모드에서 캔버스가 4x로 커지므로, 마우스/터치 이벤트의 좌표를 원본 640x480 기준으로 변환해야 한다.

App.jsx의 이벤트 핸들러에서 좌표 계산 시 `hdScale`로 나누는 로직 추가:

```js
// 마우스 이벤트 핸들러에서:
const scale = this.hdScale || 1;
const x = Math.floor(eventX / scale);
const y = Math.floor(eventY / scale);
```

- [ ] **Step 4: 테스트 및 커밋**

```bash
npm run dev
# 브라우저에서 HD Mode 체크 후 게임 시작, 화면이 4x로 확대되는지 확인
git add src/upscale/ src/api/loader.js src/App.jsx
git commit -m "feat: add real-time xBRZ WebGL upscaling (4x HD mode)"
```

---

## Phase 2: 오프라인 스프라이트 추출 + Real-ESRGAN 업스케일

### Task 3: 스프라이트 추출 스크립트

**Files:**
- Create: `scripts/extract-sprites.ts`

기존 packages/server의 MPQ 파서와 CEL/CL2 디코더를 재활용하여 모든 스프라이트를 PNG로 추출한다.

- [ ] **Step 1: 추출 스크립트 생성**

```ts
// scripts/extract-sprites.ts
import { MpqReader } from '../../packages/server/src/mpq/mpq-reader.js'
import { decodeCel } from '../../packages/server/src/decoders/cel-decoder.js'
import { decodeCl2 } from '../../packages/server/src/decoders/cl2-decoder.js'
import { loadPalette } from '../../packages/server/src/decoders/palette-loader.js'
import { renderToPng } from '../../packages/server/src/decoders/image-renderer.js'
import { Palette } from '../../packages/server/src/decoders/types.js'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MPQ_PATH = process.argv[2] || '../../DIABDAT.MPQ'
const OUTPUT_DIR = process.argv[3] || './extracted'

// Known sprite widths for Diablo 1 CEL/CL2 files
const SPRITE_WIDTHS: Record<string, number> = {
  // Items are 56x56
  'items': 56,
  // Control panel elements
  'ctrlpan': 640,
  // Monster sprites
  'monsters': 96,
  // Towner sprites
  'towners': 96,
  // Player graphics
  'plrgfx': 96,
  // Objects
  'objects': 96,
  // Missiles
  'missiles': 96,
  // UI elements (variable)
  'data': 64,
  // Gendata (cutscenes)
  'gendata': 640,
}

function getWidth(path: string): number {
  const normalPath = path.replace(/\\/g, '/').toLowerCase()
  for (const [prefix, width] of Object.entries(SPRITE_WIDTHS)) {
    if (normalPath.startsWith(prefix)) return width
  }
  return 96 // default
}

async function main() {
  console.log(`Opening MPQ: ${MPQ_PATH}`)
  const reader = await MpqReader.open(MPQ_PATH)
  const fileList = reader.getFileList()

  // Load all palettes
  const palettes = new Map<string, Palette>()
  const palFiles = fileList.filter(f => f.toLowerCase().endsWith('.pal'))
  for (const palFile of palFiles) {
    try {
      const data = await reader.extractFile(palFile)
      if (data) palettes.set(palFile, loadPalette(data))
    } catch {}
  }
  console.log(`Loaded ${palettes.size} palettes`)

  // Find default palette
  const defaultPalette = palettes.get('levels\\towndata\\town.pal')
    || palettes.values().next().value
  if (!defaultPalette) {
    console.error('No palette found!')
    process.exit(1)
  }

  // Extract all CEL/CL2 files
  const spriteFiles = fileList.filter(f => {
    const ext = f.toLowerCase().split('.').pop()
    return ext === 'cel' || ext === 'cl2'
  })

  console.log(`Extracting ${spriteFiles.length} sprite files...`)
  let totalFrames = 0
  let errors = 0

  for (const filePath of spriteFiles) {
    try {
      const data = await reader.extractFile(filePath)
      if (!data) continue

      const ext = filePath.toLowerCase().split('.').pop()
      const width = getWidth(filePath)
      const palette = findPalette(filePath, palettes) || defaultPalette

      const frames = ext === 'cel'
        ? decodeCel(data, palette, width)
        : decodeCl2(data, palette, width)

      if (frames.length === 0) continue

      const outDir = join(OUTPUT_DIR, dirname(filePath.replace(/\\/g, '/')))
      mkdirSync(outDir, { recursive: true })

      const baseName = filePath.replace(/\\/g, '/').split('/').pop()!.replace(/\.\w+$/, '')

      for (let i = 0; i < frames.length; i++) {
        const png = await renderToPng(frames[i])
        const outPath = join(outDir, `${baseName}_frame${i.toString().padStart(3, '0')}.png`)
        writeFileSync(outPath, png)
        totalFrames++
      }

      process.stdout.write(`\r  Extracted: ${totalFrames} frames from ${filePath}`)
    } catch (err) {
      errors++
    }
  }

  console.log(`\n\nDone! ${totalFrames} frames extracted, ${errors} errors`)

  // Write metadata
  writeFileSync(join(OUTPUT_DIR, 'metadata.json'), JSON.stringify({
    totalFrames,
    errors,
    spriteFiles: spriteFiles.length,
    timestamp: new Date().toISOString(),
  }, null, 2))

  await reader.close()
}

function findPalette(filePath: string, palettes: Map<string, Palette>): Palette | null {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const keywords = ['town', 'l1', 'l2', 'l3', 'l4']
  for (const kw of keywords) {
    if (normalized.includes(kw)) {
      for (const [path, pal] of palettes) {
        if (path.toLowerCase().includes(kw)) return pal
      }
    }
  }
  return null
}

main().catch(console.error)
```

- [ ] **Step 2: 실행 및 확인**

```bash
cd /Users/kyoungmook/Documents/work/diablo1/diabloweb
npx tsx scripts/extract-sprites.ts ../../DIABDAT.MPQ ./extracted
ls extracted/ | head -20
cat extracted/metadata.json
```

- [ ] **Step 3: 커밋**

```bash
git add scripts/extract-sprites.ts
git commit -m "feat: add sprite extraction script (MPQ → PNG frames)"
```

---

### Task 4: Real-ESRGAN 설치 및 업스케일 스크립트

**Files:**
- Create: `scripts/upscale.sh`

- [ ] **Step 1: Real-ESRGAN 설치 확인 스크립트**

macOS에서는 Homebrew로 설치 가능:
```bash
brew install realesrgan-ncnn-vulkan
```

또는 GitHub Release에서 바이너리 다운로드:
```bash
# https://github.com/xinntao/Real-ESRGAN/releases
# realesrgan-ncnn-vulkan 바이너리를 PATH에 추가
```

- [ ] **Step 2: 배치 업스케일 스크립트 생성**

```bash
#!/bin/bash
# scripts/upscale.sh
# Usage: ./scripts/upscale.sh [input_dir] [output_dir] [scale]

INPUT_DIR="${1:-./extracted}"
OUTPUT_DIR="${2:-./upscaled}"
SCALE="${3:-4}"
MODEL="realesrgan-x4plus-anime"

if ! command -v realesrgan-ncnn-vulkan &> /dev/null; then
  echo "Error: realesrgan-ncnn-vulkan not found"
  echo "Install: brew install realesrgan-ncnn-vulkan"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Process each subdirectory
find "$INPUT_DIR" -name "*.png" -type f | while read -r file; do
  rel_path="${file#$INPUT_DIR/}"
  out_file="$OUTPUT_DIR/$rel_path"
  out_dir=$(dirname "$out_file")
  mkdir -p "$out_dir"

  if [ ! -f "$out_file" ]; then
    realesrgan-ncnn-vulkan -i "$file" -o "$out_file" -s "$SCALE" -n "$MODEL" 2>/dev/null
    echo "  Upscaled: $rel_path"
  fi
done

echo "Done! Upscaled files in $OUTPUT_DIR"
```

- [ ] **Step 3: 실행**

```bash
chmod +x scripts/upscale.sh
./scripts/upscale.sh ./extracted ./upscaled 4
```

- [ ] **Step 4: 커밋**

```bash
git add scripts/upscale.sh
git commit -m "feat: add Real-ESRGAN batch upscale script"
```

---

### Task 5: HD 에셋팩 패키저

**Files:**
- Create: `scripts/package-hdpack.ts`

업스케일된 PNG들을 하나의 ZIP 파일(.hdpack)로 패키징한다.

- [ ] **Step 1: 패키저 스크립트 생성**

```ts
// scripts/package-hdpack.ts
import { createWriteStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

const INPUT_DIR = process.argv[2] || './upscaled'
const OUTPUT_FILE = process.argv[3] || './diablo-hd.hdpack'

interface HdPackIndex {
  version: number
  scale: number
  files: Record<string, { offset: number; size: number }>
}

function collectFiles(dir: string, base: string = dir): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      result.push(...collectFiles(full, base))
    } else if (entry.endsWith('.png')) {
      result.push(relative(base, full))
    }
  }
  return result
}

async function main() {
  console.log(`Packaging HD pack from: ${INPUT_DIR}`)
  const files = collectFiles(INPUT_DIR)
  console.log(`Found ${files.length} upscaled files`)

  // Simple format: JSON index + concatenated PNGs in a tar-like structure
  const index: HdPackIndex = {
    version: 1,
    scale: 4,
    files: {},
  }

  const chunks: Buffer[] = []
  let offset = 0

  for (const relPath of files) {
    const data = readFileSync(join(INPUT_DIR, relPath))
    index.files[relPath] = { offset, size: data.length }
    chunks.push(data)
    offset += data.length
  }

  // Write: [4 bytes index length][JSON index][all PNG data]
  const indexBuf = Buffer.from(JSON.stringify(index))
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(indexBuf.length)

  const output = Buffer.concat([lenBuf, indexBuf, ...chunks])
  const { writeFileSync: wfs } = await import('node:fs')
  wfs(OUTPUT_FILE, output)

  const sizeMB = (output.length / 1024 / 1024).toFixed(1)
  console.log(`HD pack created: ${OUTPUT_FILE} (${sizeMB} MB, ${files.length} files)`)
}

main().catch(console.error)
```

- [ ] **Step 2: 실행**

```bash
npx tsx scripts/package-hdpack.ts ./upscaled ./diablo-hd.hdpack
```

- [ ] **Step 3: 커밋**

```bash
git add scripts/package-hdpack.ts
git commit -m "feat: add HD pack packager (upscaled PNGs → .hdpack)"
```
