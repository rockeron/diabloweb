# AI 업스케일링 (Real-ESRGAN) 설계

## 목표

DIABDAT.MPQ의 CEL/CL2 스프라이트를 Real-ESRGAN으로 4x 업스케일하여 HD 에셋팩을 생성하고, DiabloWeb에서 원본 MPQ + HD팩을 함께 로드하여 고해상도로 게임 플레이.

## 아키텍처

```
[1회성 빌드 파이프라인]
DIABDAT.MPQ
  → Node.js 추출기 (기존 MPQ 파서 재활용)
  → 모든 CEL/CL2 스프라이트를 프레임별 PNG로 추출
  → Real-ESRGAN 4x 업스케일 (Python CLI)
  → HD 에셋팩 파일로 패키징 (.hdpack)

[게임 실행]
유저: DIABDAT.MPQ 업로드 + HD팩 업로드 (optional)
  → HD팩이 있으면 스프라이트 렌더링 시 HD 텍스처 사용
  → HD팩이 없으면 원본 그대로 동작 (하위 호환)
```

## 구성 요소

### 1. 스프라이트 추출기 (scripts/extract-sprites.ts)

기존 packages/server의 MPQ 파서 + CEL/CL2 디코더를 재활용하여:
- DIABDAT.MPQ에서 모든 CEL/CL2 파일 추출
- 각 파일의 모든 프레임을 개별 PNG로 저장
- 디렉토리 구조: `extracted/{원본경로}/{파일명}_frame{N}.png`
- 메타데이터 JSON 생성 (파일 목록, 프레임 수, 원본 크기)

### 2. 업스케일러 (scripts/upscale.py)

- Real-ESRGAN CLI (realesrgan-ncnn-vulkan) 사용
- 입력: extracted/ 디렉토리의 PNG 파일들
- 출력: upscaled/ 디렉토리에 4x PNG
- 모델: realesrgan-x4plus (범용) 또는 realesrgan-x4plus-anime (픽셀아트에 더 나을 수 있음)
- 배치 처리, 진행률 표시

### 3. 패키저 (scripts/package-hdpack.ts)

- upscaled/ 디렉토리의 PNG들을 하나의 .hdpack 파일로 패키징
- 포맷: ZIP 또는 tar (브라우저에서 읽기 쉬운 형태)
- 내부 구조: 원본 CEL/CL2 경로를 키로 하는 인덱스 + PNG 데이터
- 결과물: `diablo-hd.hdpack` (예상 크기: 수백 MB)

### 4. DiabloWeb 로더 패치

#### App.jsx 수정
- "HD Pack (optional)" 파일 업로드 버튼 추가
- HD팩 파일을 읽어서 게임 Worker에 전달

#### game.worker.js 수정
- HD팩이 있으면 스프라이트 렌더링 시 원본 대신 HD 텍스처 사용
- WASM의 렌더링 콜백에서 텍스처 교체 로직 삽입
- 캔버스 크기를 4x로 확대 (또는 CSS 스케일링)

## 1차 범위

- CEL/CL2 스프라이트만 (타일맵 제외)
- 4x 업스케일 고정
- 오프라인 빌드 파이프라인
- 듀얼 업로드 (MPQ + HD팩)

## 제외 사항

- 실시간 업스케일링
- 타일맵/레벨 데이터 업스케일 (2차)
- 서버 호스팅/CDN (추후)
- 모델 학습/파인튜닝

## 기술 스택

- Node.js + TypeScript: 추출기, 패키저
- Python: Real-ESRGAN CLI 래퍼
- Real-ESRGAN (realesrgan-ncnn-vulkan): GPU 가속 업스케일
