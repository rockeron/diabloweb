// MPQ format constants
export const MPQ_MAGIC = 0x1A51504D // "MPQ\x1a" little-endian
export const MPQ_HEADER_SIZE_V1 = 32

// Block table flags
export const MPQ_FILE_IMPLODE = 0x00000100
export const MPQ_FILE_COMPRESS = 0x00000200
export const MPQ_FILE_ENCRYPTED = 0x00010000
export const MPQ_FILE_FIX_KEY = 0x00020000
export const MPQ_FILE_SINGLE_UNIT = 0x01000000
export const MPQ_FILE_EXISTS = 0x80000000

// Compression types (first byte of compressed sector)
export const MPQ_COMPRESSION_ZLIB = 0x02
export const MPQ_COMPRESSION_PKWARE = 0x08

// Hash table constants
export const MPQ_HASH_TABLE_OFFSET = 0
export const MPQ_HASH_NAME_A = 1
export const MPQ_HASH_NAME_B = 2
export const MPQ_HASH_FILE_KEY = 3
export const MPQ_HASH_ENTRY_EMPTY = 0xFFFFFFFF
export const MPQ_HASH_ENTRY_DELETED = 0xFFFFFFFE
