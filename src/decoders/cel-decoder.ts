// packages/server/src/decoders/cel-decoder.ts
import { Palette, DecodedImage } from './types.js'

/**
 * Decode a Diablo 1 CEL file into frames.
 * CEL files contain one or more frames of indexed pixel data.
 */
export function decodeCel(data: Buffer, palette: Palette, width: number): DecodedImage[] {
  if (data.length < 4) return []

  const frameCount = data.readUInt32LE(0)
  if (frameCount === 0 || frameCount > 10000) return []

  // Verify we have enough data for the frame offset table
  const offsetTableEnd = 4 + (frameCount + 1) * 4
  if (offsetTableEnd > data.length) return []

  const frameOffsets: number[] = []
  for (let i = 0; i <= frameCount; i++) {
    frameOffsets.push(data.readUInt32LE(4 + i * 4))
  }

  const frames: DecodedImage[] = []
  for (let i = 0; i < frameCount; i++) {
    const frameStart = frameOffsets[i]
    const frameEnd = frameOffsets[i + 1]
    const frameData = data.subarray(frameStart, frameEnd)

    try {
      const frame = decodeRegularFrame(frameData, palette, width)
      frames.push(frame)
    } catch {
      // Skip malformed frames
    }
  }

  return frames
}

function decodeRegularFrame(
  frameData: Buffer, palette: Palette, width: number
): DecodedImage {
  const pixels: number[] = []
  let x = 0

  let i = 0
  while (i < frameData.length) {
    const byte = frameData[i]
    i++

    if (byte >= 0x80) {
      // Transparent run: (256 - byte) transparent pixels
      const count = 256 - byte
      for (let j = 0; j < count; j++) {
        pixels.push(0, 0, 0, 0) // transparent RGBA
      }
      x += count
    } else if (byte > 0) {
      // Pixel run: byte pixels of palette-indexed data
      for (let j = 0; j < byte; j++) {
        if (i < frameData.length) {
          const colorIndex = frameData[i]
          i++
          const [r, g, b] = palette.colors[colorIndex]
          pixels.push(r, g, b, 255)
          x++
        }
      }
    }
  }

  const height = Math.max(1, Math.ceil(pixels.length / 4 / width))
  const rgbaSize = width * height * 4
  const rgba = Buffer.alloc(rgbaSize)

  // CEL frames are stored bottom-to-top, flip vertically
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
