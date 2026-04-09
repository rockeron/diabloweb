// packages/server/src/decoders/image-renderer.ts
import sharp from 'sharp'
import { DecodedImage, Palette } from './types.js'

/**
 * Convert RGBA pixel buffer to PNG
 */
export async function renderToPng(image: DecodedImage): Promise<Buffer> {
  return sharp(image.rgba, {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer()
}

/**
 * Render a palette as a 16x16 grid PNG (each cell 8x8 pixels)
 */
export async function renderPaletteToPng(palette: Palette): Promise<Buffer> {
  const cellSize = 8
  const gridSize = 16
  const width = gridSize * cellSize
  const height = gridSize * cellSize
  const rgba = Buffer.alloc(width * height * 4)

  for (let i = 0; i < 256; i++) {
    const gridX = i % gridSize
    const gridY = Math.floor(i / gridSize)
    const [r, g, b] = palette.colors[i]

    for (let cy = 0; cy < cellSize; cy++) {
      for (let cx = 0; cx < cellSize; cx++) {
        const px = gridX * cellSize + cx
        const py = gridY * cellSize + cy
        const offset = (py * width + px) * 4
        rgba[offset] = r
        rgba[offset + 1] = g
        rgba[offset + 2] = b
        rgba[offset + 3] = 255
      }
    }
  }

  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
}
