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
