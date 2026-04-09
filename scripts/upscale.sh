#!/bin/bash
# Batch upscale extracted sprites using Real-ESRGAN
# Usage: ./scripts/upscale.sh [input_dir] [output_dir] [scale]

INPUT_DIR="${1:-./extracted}"
OUTPUT_DIR="${2:-./upscaled}"
SCALE="${3:-4}"
MODEL="realesrgan-x4plus-anime"

# Find realesrgan binary
REALESRGAN=""
if command -v realesrgan-ncnn-vulkan &> /dev/null; then
  REALESRGAN="realesrgan-ncnn-vulkan"
elif [ -f /tmp/realesrgan/realesrgan-ncnn-vulkan ]; then
  REALESRGAN="/tmp/realesrgan/realesrgan-ncnn-vulkan"
  MODEL_PATH="/tmp/realesrgan/models"
fi

if [ -z "$REALESRGAN" ]; then
  echo "Error: realesrgan-ncnn-vulkan not found"
  echo ""
  echo "Install options:"
  echo "  1. Download from https://github.com/xinntao/Real-ESRGAN/releases"
  echo "  2. curl -sL https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip -o /tmp/realesrgan.zip && unzip -o /tmp/realesrgan.zip -d /tmp/realesrgan && chmod +x /tmp/realesrgan/realesrgan-ncnn-vulkan"
  exit 1
fi

MODEL_ARG="-n $MODEL"
if [ -n "$MODEL_PATH" ]; then
  MODEL_ARG="$MODEL_ARG -m $MODEL_PATH"
fi

echo "Input:  $INPUT_DIR"
echo "Output: $OUTPUT_DIR"
echo "Scale:  ${SCALE}x"
echo "Model:  $MODEL"
echo "Binary: $REALESRGAN"
echo ""

# Process each subdirectory to preserve structure
TOTAL=0
DONE=0
SKIPPED=0

# Count total PNGs
TOTAL=$(find "$INPUT_DIR" -name "*.png" -type f | wc -l | tr -d ' ')
echo "Total files: $TOTAL"
echo ""

find "$INPUT_DIR" -name "*.png" -type f | sort | while read -r file; do
  rel_path="${file#$INPUT_DIR/}"
  out_file="$OUTPUT_DIR/$rel_path"
  out_dir=$(dirname "$out_file")

  DONE=$((DONE + 1))

  if [ -f "$out_file" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  mkdir -p "$out_dir"
  $REALESRGAN -i "$file" -o "$out_file" -s "$SCALE" $MODEL_ARG 2>/dev/null
  printf "\r[%d/%d] %s" "$DONE" "$TOTAL" "$rel_path"
done

echo ""
echo ""
echo "Done! Upscaled files in $OUTPUT_DIR"
echo "Skipped (already exist): $SKIPPED"
