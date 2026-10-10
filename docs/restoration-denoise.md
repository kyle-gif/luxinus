# NAFNet SIDD 노이즈 제거

Luxinus의 노이즈 제거는 **NAFNet SIDD width-32**를 사용한다. 기존 `models/nafnet.onnx`는 GoPro 흐림 복원용 모델이므로 그대로 보존하고 새 노이즈 제거의 자동 대체 모델로 사용하지 않는다. 원본 파일에 쓰지 않고 디코딩된 RGB에 적용한다. RAW 센서 모자이크에서 처리하는 모델은 아니다.

## 모델 출처와 설치

- 공식 배포: [darktable-ai release-5.6.0](https://github.com/darktable-org/darktable-ai/releases/tag/release-5.6.0)의 `denoise-nafnet.dtmodel`
- 모델 설명과 입출력: [NAFNet SIDD Width-32 모델 카드](https://github.com/darktable-org/darktable-ai/tree/master/models/denoise-nafnet)
- 원본 연구·체크포인트: [Megvii NAFNet](https://github.com/megvii-research/NAFNet). 모델 라이선스 MIT. 배포 도구 저장소의 라이선스와 모델 라이선스는 구별한다. 원본 라이선스는 `docs/licenses/NAFNet.txt`에 보존했고 설치 시 모델 옆에도 복사한다.

| 항목 | 고정값 |
| --- | --- |
| archive 크기 | 108,413,592 bytes (103.4 MiB) |
| archive SHA256 | `4b5c0b9c2650956eaab9a3fc6ffe3e11d4dc4f55b246b7f3a0d2d72161b6980c` |
| ONNX 크기 | 117,341,957 bytes (111.9 MiB) |
| ONNX SHA256 | `8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230` |
| 설치 파일 | `models/nafnet-sidd-width32.onnx` |
| 입력 / 출력 | `input` / `output`, float32 `[1,3,768,768]`, RGB `[0,1]` |
| ONNX opset / 가중치 | 20 / 외부 tensor 파일 없음 |

명시적으로 실행하는 개발용 설치 명령만 다운로드한다. 앱 시작, 사진 보기, 로컬 추론에서는 다운로드하지 않는다. Node 18 이상과 프로젝트 의존성이 필요하다.

```sh
node scripts/install-denoise-model.cjs
# 이미 내려받은 공식 archive를 사용하면 네트워크 없이 설치한다.
node scripts/install-denoise-model.cjs --archive .omc/model-improvement/denoise-nafnet.dtmodel
# 별도 앱의 models 디렉터리가 필요할 때만 지정한다.
node scripts/install-denoise-model.cjs --archive /path/denoise-nafnet.dtmodel --destination /path/to/models
```

설치기는 archive와 ONNX 양쪽의 SHA256을 검사하고, 고정된 이름의 모델·라이선스·manifest만 게시한다. 기존 파일이 다르거나 링크이면 덮지 않는다. 현재 개발 프로젝트에는 설치되어 있으며 중복 userData 사본을 만들지 않았다. 앱은 userData/models, 프로젝트 models, resources/models 순서로 새 파일명을 찾는다. 모델이 없거나 체크섬이 다르면 실행 실패를 표시한다.

## 실행과 저장

공식 그래프의 정적 크기인 768픽셀 타일, reflect padding, 32픽셀 cosine overlap을 사용한다. 작은 타일로 바꾸면 그래프 규격을 어기므로 메모리 부족 때 512/384로 재시도하거나 원본을 성공 결과처럼 반환하지 않는다. macOS에서 측정한 CPU를 기본값으로 쓰며 다른 플랫폼은 해당 실행 제공자를 시도하고 세션 생성 실패 때 CPU로 대체한다. Windows 실제 장비 속도는 측정하지 않았다.

이 Mac의 Electron에서는 ORT 기본 CPU arena가 첫 추론을, arena만 끈 경우 memory pattern이 두 번째 추론을 exitCode 5로 종료시켰다. 공식 [SessionOptions](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.SessionOptions.html)의 `enableCpuMemArena:false`, `enableMemPattern:false`를 함께 적용해 동일 utility 프로세스의 연속 두 추론을 확인했다. `graphOptimizationLevel:'all'`, 모델 bytes, 입력 shape는 유지했다. 앱·smoke·품질 벤치가 `RESTORATION_SESSION_OPTIONS`를 공유한다. [공식 저장소의 유사 Electron/ORT 할당 이슈](https://github.com/microsoft/onnxruntime/issues/29763)도 참고했지만, 해당 이슈의 이전 버전 원인이 이 빌드와 완전히 같다고 단정하지 않는다. Chromium sandbox나 일반 네트워크 설정은 변경하지 않았다.

main은 파일 identity가 달라지면 다시 해시를 검사한다. worker는 정확히 검증한 메모리 bytes로 ONNX 세션을 만든다. 세션과 결과 캐시의 모델 fingerprint는 다음과 같다.

```text
nafnet-sidd-width32:8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230:rgb-reflect-cosine32-v1
```

프리뷰 캐시는 강도 100%의 모델 결과를 저장하고 UI 기본 강도는 60%로 원본과 혼합한다. 알파값은 그대로 유지한다. 내보내기는 동일 모델·타일러의 결과와 동일 shader 강도 혼합을 사용하지만, 프리뷰와 원본 해상도가 다르면 입력 샘플링·타일 문맥이 달라지므로 두 화면의 모든 픽셀이 같다는 보장은 없다. 사진 변경·취소 시 이전 결과를 채택하지 않고 worker 종료로 추론을 중단한다.

## 합성 품질 측정: 2026-09-09

`node scripts/benchmark-denoise.cjs`는 사용자 사진 없이 색 그라데이션, 도형, 가는 선, 낮은 대비의 사인 무늬를 만든다. 고정 seed로 RGB Gaussian 또는 신호 의존 Gaussian 노이즈를 더하고 알려진 깨끗한 RGB와 비교한다. PSNR은 높을수록 좋다. 런타임은 이 Mac의 arm64 CPU, Node 25.2.1, ONNX Runtime 1.27.0이었다.

최종 앱과 동일한 두 메모리 옵션을 적용해 다시 측정한 320×256 한 이미지의 결과이며 각 수치는 한 번의 실행이다. 강도 60%는 앱 기본값, 100%는 완전 혼합이다.

| 노이즈 | 처리 전 PSNR | 기존 GoPro 60% | SIDD 60% | SIDD 100% | SIDD 추론 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gaussian σ15 | 24.59 dB | 10.00 dB | **30.43 dB** | 34.01 dB | 0.93초 |
| Gaussian σ25 | 20.21 dB | 10.01 dB | **26.75 dB** | 30.83 dB | 0.84초 |
| 신호 의존 노이즈 | 24.22 dB | 10.03 dB | **29.93 dB** | 33.48 dB | 1.01초 |

기존 모델은 이 노이즈 입력을 증폭해 포화 픽셀을 만들었다. [OpenCV 공식 전처리](https://github.com/opencv/opencv_zoo/blob/main/models/deblurring_nafnet/nafnet.py)는 RGB, 배율 `0.00392`, 출력 `×255` 후 clipping이다. 현재 코드의 `1/255`와 공식 근사 배율을 같은 σ25 입력으로 각각 시험해 기본 강도 PSNR 10.01285 / 10.01309 dB를 확인했다. 색 순서나 정규화 오류를 고쳐 얻은 개선이라고 주장하지 않는다. GoPro 흐림 복원의 일반적인 성능 점수로도 해석하면 안 된다.

세부 무늬 영역의 RGB RMSE는 σ25에서 처리 전 24.93 → SIDD 60% 11.81 → 100% 6.36으로 감소했다. 그러나 강한 경계의 gradient RMSE는 처리 전 34.24 → 60% 33.02 → 100% 47.71이었다. 즉 100%가 PSNR은 높아도 가는 선을 더 부드럽게 만들 수 있다. 깨끗한 입력에서 SIDD 60% PSNR은 41.97 dB였고 낮은 대비 무늬의 RMSE는 0.77이었다. 기본 강도 60%를 유지하고 필요할 때 사진에 맞춰 조절한다.

`node scripts/benchmark-denoise.cjs --large`의 896×800, 4개 SIDD 타일 시험에서는 처리 전 20.20 → 60% **26.83 dB**, 100% 32.08 dB, 추론 3.18초였다. 깨끗한 입력 60%는 45.16 dB였다. 단일 작은 이미지에서 기존512 타일은 약1.17–1.39초, SIDD768은 약0.84–1.01초였으나 반복 통계·다양한 사진·Windows GPU 비교가 없으므로 보편적인 속도 향상을 주장하지 않는다. 별도 SIDD CPU smoke의 프로세스 최고 RSS는 약2.4GiB였다. 별도 Electron utility 연속 두 추론의 최고 RSS는 약1.77GiB였다. 큰 사진과 실행 제공자에 따라 더 많은 메모리·시간이 필요할 수 있다.

이 합성 노이즈는 SIDD의 실제 카메라 노이즈와 같지 않다. 실제 사진 전체에서의 품질 점수나 원본 세부 복원을 보장하는 수치가 아니다. 시각 비교에서도 포화된 기존 결과와 새 모델의 노이즈 감소를 확인했다.

## 재현과 검증 자료

```sh
npm run test:onnx
node scripts/benchmark-denoise.cjs
node scripts/benchmark-denoise.cjs --large
npm run typecheck
npm test
npm run build
# 아래는 격리된 임시 userData와 합성 사진만 사용하는 실제 Electron 검사다.
npm run test:electron:restoration
```

비교 벤치는 보존된 기존 `models/nafnet.onnx`와 새 모델의 해시를 모두 검사한다. 후보 파일 경로를 첫 인자로 명시할 수도 있으나 같은 공식 모델 해시가 필요하다.

- `.omc/artifacts/denoise-benchmark/report.json`, `denoise-benchmark-large/report.json`: 원시 PSNR, edge/texture RMSE, 시간, 모델 해시, RGB 출력 PNG.
- `.omc/artifacts/denoise-benchmark/comparison.png`: 왼쪽부터 clean, σ25 noisy, 기존60, SIDD60, SIDD100.
- `.omc/artifacts/denoise-benchmark/gopro-normalization-check.json`: 기존 모델 공식 배율 확인.
- `.omc/artifacts/onnx-electron-memory-options.json`: 실제 Electron utility의 arena/pattern 옵션 분리와 연속 추론 결과.
- `.omc/artifacts/onnx-smoke.json`: 실제 새 ONNX, 정적 입출력·알파 보존·무변화 원본 반환 아님·Node API 네트워크 요청0. Electron 실행 증거는 별도 native 보고서를 참고한다.
- `.omc/artifacts/denoise-installer-symlink.json`: installer의 LICENSE/manifest 링크 대상 원본 불변 회귀.
- `tests/model-integrity.test.ts`, `tests/tiled-inference.test.ts`: 교체 모델 검증, 반사 경계·겹친 타일 연속성, 강도·알파, 잘못된 크기 거부.

최종 캐시·내보내기·재실행 native 결과는 `.omc/artifacts/electron-restoration-smoke.json` 및 캐시 전용 보고서에 기록한다. 네트워크 관찰은 API 호출 관찰이며 OS 패킷 캡처를 의미하지 않는다.

## 실제 앱 저장·재시작·내보내기 확인

최종 통합 타입 검사·빌드와 전체 테스트 105개를 통과했다. 실제 Electron UI에서 복원 버튼 → 결과 자동 저장 → 정상 종료 시 강도 60 저장 → 새 프로세스에서 동일 proxy/결과 해시의 캐시 hit를 확인했다. 재시작 후 추가 추론은 0회였다. 원본 640×400 GPU PNG 내보내기, 저장 강도 100 반영, 배경색 독립, 파일명 충돌 시 새 파일 생성, 실행 취소와 worker 재시작도 통과했다. 모든 검증은 합성 사진과 임시 userData를 사용했고 원본 해시는 유지됐다. 상세 기록은 `.omc/artifacts/restoration-chat-verification.json`에 모았다.
