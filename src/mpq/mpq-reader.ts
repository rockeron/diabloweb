// packages/server/src/mpq/mpq-reader.ts
import { open, FileHandle } from 'node:fs/promises'
import { MpqHeader, MpqHashEntry, MpqBlockEntry, MpqFileInfo } from './types.js'
import { hashString, decryptBlock } from './crypto.js'
import {
  MPQ_MAGIC,
  MPQ_HEADER_SIZE_V1,
  MPQ_HASH_TABLE_OFFSET,
  MPQ_HASH_NAME_A,
  MPQ_HASH_NAME_B,
  MPQ_HASH_FILE_KEY,
  MPQ_HASH_ENTRY_EMPTY,
  MPQ_HASH_ENTRY_DELETED,
  MPQ_FILE_EXISTS,
  MPQ_FILE_ENCRYPTED,
  MPQ_FILE_FIX_KEY,
  MPQ_FILE_COMPRESS,
  MPQ_FILE_IMPLODE,
  MPQ_FILE_SINGLE_UNIT,
  MPQ_COMPRESSION_ZLIB,
  MPQ_COMPRESSION_PKWARE,
} from './constants.js'
import pako from 'pako'
import { explode } from 'node-pkware/simple'

export class MpqReader {
  private constructor(
    private readonly fileHandle: FileHandle,
    private readonly header: MpqHeader,
    private readonly hashTable: readonly MpqHashEntry[],
    private readonly blockTable: readonly MpqBlockEntry[],
    private readonly fileList: readonly string[],
    private readonly archiveOffset: number,
  ) {}

  static async open(filePath: string): Promise<MpqReader> {
    const fh = await open(filePath, 'r')
    try {
      const archiveOffset = 0 // DIABDAT.MPQ starts at offset 0
      const header = await MpqReader.readHeader(fh, archiveOffset)
      const hashTable = await MpqReader.readHashTable(fh, header, archiveOffset)
      const blockTable = await MpqReader.readBlockTable(fh, header, archiveOffset)
      const reader = new MpqReader(fh, header, hashTable, blockTable, [], archiveOffset)
      const fileList = await reader.readListFile()
      return new MpqReader(fh, header, hashTable, blockTable, fileList, archiveOffset)
    } catch (err) {
      await fh.close()
      throw err
    }
  }

  private static async readHeader(fh: FileHandle, offset: number): Promise<MpqHeader> {
    const buf = Buffer.alloc(MPQ_HEADER_SIZE_V1)
    await fh.read(buf, 0, MPQ_HEADER_SIZE_V1, offset)

    const magic = buf.readUInt32LE(0)
    if (magic !== MPQ_MAGIC) {
      throw new Error(`Invalid MPQ magic: 0x${magic.toString(16)}`)
    }

    return {
      magic,
      headerSize: buf.readUInt32LE(4),
      archiveSize: buf.readUInt32LE(8),
      formatVersion: buf.readUInt16LE(12),
      sectorSizeShift: buf.readUInt16LE(14),
      hashTableOffset: buf.readUInt32LE(16),
      blockTableOffset: buf.readUInt32LE(20),
      hashTableEntries: buf.readUInt32LE(24),
      blockTableEntries: buf.readUInt32LE(28),
    }
  }

  private static async readHashTable(
    fh: FileHandle, header: MpqHeader, archiveOffset: number
  ): Promise<readonly MpqHashEntry[]> {
    const size = header.hashTableEntries * 16
    const buf = Buffer.alloc(size)
    await fh.read(buf, 0, size, archiveOffset + header.hashTableOffset)

    const encrypted = new Uint32Array(buf.buffer, buf.byteOffset, size / 4)
    const decrypted = decryptBlock(encrypted, hashString('(hash table)', MPQ_HASH_FILE_KEY))

    const entries: MpqHashEntry[] = []
    for (let i = 0; i < header.hashTableEntries; i++) {
      const offset = i * 4
      entries.push({
        hashA: decrypted[offset],
        hashB: decrypted[offset + 1],
        locale: decrypted[offset + 2] & 0xFFFF,
        platform: (decrypted[offset + 2] >> 16) & 0xFFFF,
        blockIndex: decrypted[offset + 3],
      })
    }
    return entries
  }

  private static async readBlockTable(
    fh: FileHandle, header: MpqHeader, archiveOffset: number
  ): Promise<readonly MpqBlockEntry[]> {
    const size = header.blockTableEntries * 16
    const buf = Buffer.alloc(size)
    await fh.read(buf, 0, size, archiveOffset + header.blockTableOffset)

    const encrypted = new Uint32Array(buf.buffer, buf.byteOffset, size / 4)
    const decrypted = decryptBlock(encrypted, hashString('(block table)', MPQ_HASH_FILE_KEY))

    const entries: MpqBlockEntry[] = []
    for (let i = 0; i < header.blockTableEntries; i++) {
      const offset = i * 4
      entries.push({
        fileOffset: decrypted[offset],
        compressedSize: decrypted[offset + 1],
        uncompressedSize: decrypted[offset + 2],
        flags: decrypted[offset + 3],
      })
    }
    return entries
  }

  private async readListFile(): Promise<readonly string[]> {
    // Try internal (listfile) first
    try {
      const data = await this.extractFile('(listfile)')
      if (data && data.length > 0) {
        const text = data.toString('utf-8')
        const files = text
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0)
        if (files.length > 0) return files
      }
    } catch {
      // No internal listfile
    }

    // Fallback: load external listfile (e.g. DIABDAT.MPQ has no internal listfile)
    try {
      const { readFileSync } = await import('node:fs')
      const { fileURLToPath } = await import('node:url')
      const { dirname, join } = await import('node:path')
      const dir = dirname(fileURLToPath(import.meta.url))
      const listPath = join(dir, '..', 'data', 'diabdat.lst')
      const text = readFileSync(listPath, 'utf-8')
      const files = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
      if (files.length > 0) return files
    } catch {
      // No external listfile
    }

    return []
  }

  getHeader(): MpqHeader {
    return this.header
  }

  getFileList(): readonly string[] {
    return this.fileList
  }

  getFileInfo(filePath: string): MpqFileInfo | null {
    const blockIndex = this.findBlockIndex(filePath)
    if (blockIndex < 0) return null

    const block = this.blockTable[blockIndex]
    return {
      path: filePath,
      compressedSize: block.compressedSize,
      uncompressedSize: block.uncompressedSize,
      flags: block.flags,
      blockIndex,
    }
  }

  private findBlockIndex(filePath: string): number {
    const hashTableSize = this.header.hashTableEntries
    const startIndex = hashString(filePath, MPQ_HASH_TABLE_OFFSET) % hashTableSize
    const hashA = hashString(filePath, MPQ_HASH_NAME_A)
    const hashB = hashString(filePath, MPQ_HASH_NAME_B)

    let index = startIndex
    for (let i = 0; i < hashTableSize; i++) {
      const entry = this.hashTable[index]
      if (entry.blockIndex === MPQ_HASH_ENTRY_EMPTY) return -1
      if (entry.blockIndex !== MPQ_HASH_ENTRY_DELETED &&
          entry.hashA === hashA && entry.hashB === hashB) {
        return entry.blockIndex
      }
      index = (index + 1) % hashTableSize
    }
    return -1
  }

  private getFileKey(filePath: string, block: MpqBlockEntry, flags: number): number {
    // Extract filename from path for key calculation
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath
    let key = hashString(fileName, MPQ_HASH_FILE_KEY)
    if (flags & MPQ_FILE_FIX_KEY) {
      key = ((key + block.fileOffset) ^ block.uncompressedSize) >>> 0
    }
    return key
  }

  async extractFile(filePath: string): Promise<Buffer | null> {
    const blockIndex = this.findBlockIndex(filePath)
    if (blockIndex < 0) return null

    const block = this.blockTable[blockIndex]
    if (!(block.flags & MPQ_FILE_EXISTS)) return null

    const sectorSize = 512 << this.header.sectorSizeShift
    const isImploded = !!(block.flags & MPQ_FILE_IMPLODE)
    const isCompressed = !!(block.flags & MPQ_FILE_COMPRESS)
    const hasCompression = isImploded || isCompressed
    const isEncrypted = !!(block.flags & MPQ_FILE_ENCRYPTED)
    const isSingleUnit = !!(block.flags & MPQ_FILE_SINGLE_UNIT)

    if (isSingleUnit) {
      return this.extractSingleUnit(block, filePath, hasCompression, isEncrypted, isImploded)
    }

    if (!hasCompression) {
      return this.extractUncompressed(block, filePath, sectorSize, isEncrypted)
    }

    return this.extractSectored(block, filePath, sectorSize, isEncrypted, isImploded)
  }

  private async extractSingleUnit(
    block: MpqBlockEntry, filePath: string,
    isCompressed: boolean, isEncrypted: boolean, isImploded: boolean = false
  ): Promise<Buffer> {
    const buf = Buffer.alloc(block.compressedSize)
    await this.fileHandle.read(buf, 0, block.compressedSize, this.archiveOffset + block.fileOffset)

    let data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

    if (isEncrypted) {
      const key = this.getFileKey(filePath, block, block.flags)
      const u32 = new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4))
      const decrypted = decryptBlock(u32, key)
      data = new Uint8Array(decrypted.buffer)
    }

    if (isCompressed && block.compressedSize < block.uncompressedSize) {
      return Buffer.from(this.decompressSector(data, isImploded))
    }
    return Buffer.from(data)
  }

  private async extractUncompressed(
    block: MpqBlockEntry, filePath: string,
    sectorSize: number, isEncrypted: boolean
  ): Promise<Buffer> {
    const fileSize = block.uncompressedSize
    const buf = Buffer.alloc(fileSize)
    await this.fileHandle.read(buf, 0, fileSize, this.archiveOffset + block.fileOffset)

    if (isEncrypted) {
      const fileKey = this.getFileKey(filePath, block, block.flags)
      const numSectors = Math.ceil(fileSize / sectorSize)
      for (let i = 0; i < numSectors; i++) {
        const start = i * sectorSize
        const end = Math.min(start + sectorSize, fileSize)
        const len = end - start
        // Decrypt in 4-byte aligned chunks
        const alignedLen = Math.floor(len / 4) * 4
        if (alignedLen > 0) {
          const u32 = new Uint32Array(buf.buffer, buf.byteOffset + start, alignedLen / 4)
          const decrypted = decryptBlock(u32, (fileKey + i) >>> 0)
          Buffer.from(decrypted.buffer).copy(buf, start, 0, alignedLen)
        }
      }
    }

    return buf
  }

  private async extractSectored(
    block: MpqBlockEntry, filePath: string,
    sectorSize: number, isEncrypted: boolean, isImploded: boolean
  ): Promise<Buffer> {
    const numSectors = Math.ceil(block.uncompressedSize / sectorSize)
    // Read sector offset table (numSectors + 1 entries, each 4 bytes)
    const offsetTableSize = (numSectors + 1) * 4
    const offsetBuf = Buffer.alloc(offsetTableSize)
    await this.fileHandle.read(offsetBuf, 0, offsetTableSize, this.archiveOffset + block.fileOffset)

    let offsetData = new Uint32Array(offsetBuf.buffer, offsetBuf.byteOffset, numSectors + 1)
    const fileKey = isEncrypted ? this.getFileKey(filePath, block, block.flags) : 0

    if (isEncrypted) {
      offsetData = decryptBlock(offsetData, (fileKey - 1) >>> 0)
    }

    const sectorOffsets = Array.from(offsetData)
    const result = Buffer.alloc(block.uncompressedSize)
    let outputOffset = 0

    for (let i = 0; i < numSectors; i++) {
      const sectorStart = sectorOffsets[i]
      const sectorEnd = sectorOffsets[i + 1]
      const sectorLen = sectorEnd - sectorStart
      const expectedLen = Math.min(sectorSize, block.uncompressedSize - outputOffset)

      const sectorBuf = Buffer.alloc(sectorLen)
      await this.fileHandle.read(
        sectorBuf, 0, sectorLen,
        this.archiveOffset + block.fileOffset + sectorStart
      )

      let sectorData = new Uint8Array(sectorBuf.buffer, sectorBuf.byteOffset, sectorBuf.byteLength)

      if (isEncrypted) {
        const alignedLen = Math.floor(sectorData.byteLength / 4)
        const trailingBytes = sectorData.byteLength - alignedLen * 4
        const u32 = new Uint32Array(
          sectorData.buffer, sectorData.byteOffset, alignedLen
        )
        const decrypted = decryptBlock(u32, (fileKey + i) >>> 0)
        // Preserve trailing unencrypted bytes
        const combined = new Uint8Array(alignedLen * 4 + trailingBytes)
        combined.set(new Uint8Array(decrypted.buffer), 0)
        if (trailingBytes > 0) {
          combined.set(sectorData.subarray(alignedLen * 4), alignedLen * 4)
        }
        sectorData = combined
      }

      if (sectorLen < expectedLen) {
        const decompressed = this.decompressSector(sectorData, isImploded)
        Buffer.from(decompressed).copy(result, outputOffset)
        outputOffset += decompressed.length
      } else {
        Buffer.from(sectorData).copy(result, outputOffset, 0, expectedLen)
        outputOffset += expectedLen
      }
    }

    return result
  }

  private decompressSector(data: Uint8Array, isImploded: boolean): Uint8Array {
    if (data.length === 0) return data

    if (isImploded) {
      // For IMPLODE files: try PKWare DCL directly first (no type byte)
      try {
        const result = new Uint8Array(explode(Buffer.from(data)))
        if (result.length > 0) return result
      } catch {
        // Fall through to type-byte approach
      }
      // Some MPQ builders still use a compression type byte even with IMPLODE flag
      const compressionType = data[0]
      const compressedData = data.slice(1)
      if (compressionType & MPQ_COMPRESSION_PKWARE) {
        return new Uint8Array(explode(Buffer.from(compressedData)))
      }
      if (compressionType & MPQ_COMPRESSION_ZLIB) {
        return pako.inflate(compressedData)
      }
      // If nothing works, return raw data
      return data
    }

    // COMPRESS: first byte indicates compression method
    const compressionType = data[0]
    const compressedData = data.slice(1)

    if (compressionType & MPQ_COMPRESSION_ZLIB) {
      return pako.inflate(compressedData)
    }
    if (compressionType & MPQ_COMPRESSION_PKWARE) {
      return new Uint8Array(explode(Buffer.from(compressedData)))
    }
    if (compressionType === 0) {
      return compressedData
    }

    throw new Error(`Unsupported compression type: 0x${compressionType.toString(16)}`)
  }

  async close(): Promise<void> {
    await this.fileHandle.close()
  }
}
