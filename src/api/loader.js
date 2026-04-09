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
  } else {
    ctx.drawImage(api._sourceCanvas, 0, 0);
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
