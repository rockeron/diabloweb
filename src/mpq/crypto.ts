// packages/server/src/mpq/crypto.ts

let cryptTableCache: Uint32Array | null = null

export function buildCryptTable(): Uint32Array {
  if (cryptTableCache) {
    return cryptTableCache
  }

  const table = new Uint32Array(1280)
  let seed = 0x00100001

  for (let index1 = 0; index1 < 256; index1++) {
    let index2 = index1
    for (let i = 0; i < 5; i++) {
      seed = ((seed * 125 + 3) % 0x2AAAAB) >>> 0
      const temp1 = (seed & 0xFFFF) << 16
      seed = ((seed * 125 + 3) % 0x2AAAAB) >>> 0
      const temp2 = seed & 0xFFFF
      table[index2] = (temp1 | temp2) >>> 0
      index2 += 256
    }
  }

  cryptTableCache = table
  return table
}

export function hashString(str: string, hashType: number): number {
  const cryptTable = buildCryptTable()
  let seed1 = 0x7FED7FED
  let seed2 = 0xEEEEEEEE

  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i)
    // Normalize: uppercase only (MPQ uses toupper, no path conversion)
    if (ch >= 0x61 && ch <= 0x7A) ch -= 0x20 // a-z -> A-Z

    const tableIndex = hashType * 256 + ch
    seed1 = (cryptTable[tableIndex] ^ ((seed1 + seed2) >>> 0)) >>> 0
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0
  }

  return seed1 >>> 0
}

export function decryptBlock(data: Uint32Array, key: number): Uint32Array {
  const cryptTable = buildCryptTable()
  const result = new Uint32Array(data.length)
  let seed1 = key
  let seed2 = 0xEEEEEEEE

  for (let i = 0; i < data.length; i++) {
    seed2 = (seed2 + cryptTable[0x400 + (seed1 & 0xFF)]) >>> 0
    const value = (data[i] ^ ((seed1 + seed2) >>> 0)) >>> 0
    result[i] = value
    seed1 = ((((~seed1 << 21) >>> 0) + 0x11111111) | (seed1 >>> 11)) >>> 0
    seed2 = ((value + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF) >>> 0
  }

  return result
}
