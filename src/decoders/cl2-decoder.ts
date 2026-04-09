// packages/server/src/decoders/cl2-decoder.ts
import { Palette, DecodedImage } from './types.js'

/**
 * Decode a Diablo 1 CL2 file into frames.
 * CL2 files can contain multiple groups of frames (directions).
 */
export function decodeCl2(data: Buffer, palette: Palette, width: number): DecodedImage[] {
  if (data.length < 4) return []

  // Check if this is a multi-group CL2 (first 4 bytes point past the group header)
  const firstValue = data.readUInt32LE(0)
  const frames: DecodedImage[] = []

  if (firstValue === 0 || firstValue > data.length) {
    // Single-group CL2
    return decodeCl2Group(data, palette, width)
  }

  // Might be multi-group: check if the first few values look like group offsets
  const possibleGroupCount = firstValue / 4
  if (possibleGroupCount > 0 && possibleGroupCount <= 8 && firstValue % 4 === 0) {
    // Multi-group CL2
    const groupOffsets: number[] = []
    for (let i = 0; i < possibleGroupCount; i++) {
      groupOffsets.push(data.readUInt32LE(i * 4))
    }

    for (let i = 0; i < groupOffsets.length; i++) {
      const groupStart = groupOffsets[i]
      const groupEnd = i + 1 < groupOffsets.length ? groupOffsets[i + 1] : data.length
      const groupData = data.subarray(groupStart, groupEnd)
      frames.push(...decodeCl2Group(groupData, palette, width))
    }
  } else {
    // Single-group CL2
    return decodeCl2Group(data, palette, width)
  }

  return frames
}

function decodeCl2Group(data: Buffer, palette: Palette, width: number): DecodedImage[] {
  if (data.length < 4) return []

  const frameCount = data.readUInt32LE(0)
  if (frameCount === 0 || frameCount > 10000) return []

  const frameOffsets: number[] = []
  for (let i = 0; i <= frameCount; i++) {
    if (4 + i * 4 + 4 > data.length) return []
    frameOffsets.push(data.readUInt32LE(4 + i * 4))
  }

  const frames: DecodedImage[] = []
  for (let i = 0; i < frameCount; i++) {
    const frameStart = frameOffsets[i]
    const frameEnd = frameOffsets[i + 1]
    if (frameEnd > data.length) continue
    const frameData = data.subarray(frameStart, frameEnd)

    try {
      const frame = decodeCl2Frame(frameData, palette, width)
      frames.push(frame)
    } catch {
      // Skip malformed frames
    }
  }
  return frames
}

function decodeCl2Frame(
  frameData: Buffer, palette: Palette, width: number
): DecodedImage {
  // CL2 frames have a 10-byte header: 5 x uint16 row offsets
  const pixels: number[] = []
  let i = 10 // Skip CL2 frame header

  while (i < frameData.length) {
    const cmd = frameData[i]
    i++

    if (cmd > 0x00 && cmd < 0x80) {
      // cmd palette-indexed pixels
      for (let j = 0; j < cmd; j++) {
        if (i < frameData.length) {
          const colorIndex = frameData[i]
          i++
          const [r, g, b] = palette.colors[colorIndex]
          pixels.push(r, g, b, 255)
        }
      }
    } else if (cmd >= 0x80 && cmd < 0xBF) {
      // Transparent run
      const count = 256 - cmd
      for (let j = 0; j < count; j++) {
        pixels.push(0, 0, 0, 0)
      }
    } else if (cmd >= 0xBF) {
      // Fill run: (256 - cmd) pixels of next byte
      const count = 256 - cmd
      if (i < frameData.length) {
        const colorIndex = frameData[i]
        i++
        const [r, g, b] = palette.colors[colorIndex]
        for (let j = 0; j < count; j++) {
          pixels.push(r, g, b, 255)
        }
      }
    }
  }

  const height = Math.max(1, Math.ceil(pixels.length / 4 / width))
  const rgbaSize = width * height * 4
  const rgba = Buffer.alloc(rgbaSize)

  const totalPixels = Math.min(pixels.length / 4, width * height)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const srcIdx = (py * width + px) * 4
      const dstY = height - 1 - py
      const dstIdx = (dstY * width + px) * 4
      if (srcIdx + 3 < pixels.length) {
        rgba[dstIdx] = pixels[srcIdx]
        rgba[dstIdx + 1] = pixels[srcIdx + 1]
        rgba[dstIdx + 2] = pixels[srcIdx + 2]
        rgba[dstIdx + 3] = pixels[srcIdx + 3]
      }
    }
  }

  return { width, height, rgba }
}
