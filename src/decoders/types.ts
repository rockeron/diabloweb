export interface Palette {
  readonly colors: readonly [r: number, g: number, b: number][]
}

export interface DecodedImage {
  readonly width: number
  readonly height: number
  readonly rgba: Buffer // RGBA pixel data
}
