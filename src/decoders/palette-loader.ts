// packages/server/src/decoders/palette-loader.ts
import { Palette } from './types.js'

/**
 * Parse a .pal file (256 colors x 3 bytes RGB = 768 bytes)
 */
export function loadPalette(data: Buffer): Palette {
  if (data.length < 768) {
    throw new Error(`Invalid palette size: ${data.length}, expected at least 768 bytes`)
  }

  const colors: [number, number, number][] = []
  for (let i = 0; i < 256; i++) {
    const offset = i * 3
    colors.push([data[offset], data[offset + 1], data[offset + 2]])
  }

  return { colors }
}
