export interface MpqHeader {
  readonly magic: number
  readonly headerSize: number
  readonly archiveSize: number
  readonly formatVersion: number
  readonly sectorSizeShift: number
  readonly hashTableOffset: number
  readonly blockTableOffset: number
  readonly hashTableEntries: number
  readonly blockTableEntries: number
}

export interface MpqHashEntry {
  readonly hashA: number
  readonly hashB: number
  readonly locale: number
  readonly platform: number
  readonly blockIndex: number
}

export interface MpqBlockEntry {
  readonly fileOffset: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly flags: number
}

export interface MpqFileInfo {
  readonly path: string
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly flags: number
  readonly blockIndex: number
}

export interface FileTreeNode {
  readonly name: string
  readonly path: string
  readonly isDirectory: boolean
  readonly size?: number
  readonly compressedSize?: number
  readonly children?: readonly FileTreeNode[]
}
