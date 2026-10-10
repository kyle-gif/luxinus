# 2026-09-09 로컬 개발 기록

> 이 문서는 최초 로컬 통합 작업의 이력입니다. 사용자의 후속 요청으로 네트워크 강제 차단을 제거하고 Codex 로그인·보정 제공자, 전역 실행 취소, 자르기 도구 통합과 쉬운 명칭을 추가했습니다. 아래의 차단 정책·Codex 미구현·42개 테스트 등은 당시 기록이며, 최신 상태와 검증은 [후속 변경 기록](codex-and-ux.md)을 따릅니다.


## 범위와 현재 환경

- 사용자 첨부의 macOS 로컬 개발 통합 지시서(P0→P4)를 현재 체크아웃에 적용했습니다.
- 경로: `/Users/fallenegg/Documents/luxinus`, 시작 브랜치 `main`, 시작 HEAD `e3aa413`, 시작 작업 트리는 깨끗했습니다.
- `029a415` Git 객체는 로컬에 존재합니다. 원격 커밋을 가져오거나 브랜치를 변경하지 않았습니다.
- macOS 26.6.2, arm64, Apple M4 Pro, 물리 RAM **48GiB**(`node:os.totalmem()`), 디스크 가용 약 **285GiB**. free memory 약1.2GiB는 한 시점의 유휴 메모리이며 macOS 회수 가능 메모리나 전체 가용 예산으로 간주하지 않습니다.
- Node25.2.1, npm11.6.2. package-lock의 기존 의존성을 재사용했고 추가 패키지나 일괄 업그레이드는 없습니다.
- 설치된 Codex0.153.4의 help·App Server schema를 확인했습니다. 사용자 인증·전역 설정·모델은 변경하지 않았습니다.
- 시작 시 Ollama/LM Studio/llama.cpp/MLX 실행기는 PATH에서 발견되지 않았습니다. 이후 사용자의 계속 진행 승인으로 공식 llama.cpp 실행기와 Qwen GGUF를 별도로 설치·검증했습니다. 전역 PATH나 계정 설정은 변경하지 않습니다.

## 실제 변경

- `App.tsx`, `components/layout/*`, `useWorkspaceStore.ts`, `index.css`, `tailwind.config.js`: 라이브러리/현상 분리, 중립 암실 토큰, 사진 배경, 가상화, 선택·필터·정렬·스크롤 유지, 보정 탭과 도구 맥락, 사진만 보기. 기본 13px, 보조 12px. 원격 글꼴이나 장식 WebGL 없음.
- `Slider`, `PresetsPanel`, `ExportDialog`, `useDialogFocus`: 직접 수치 입력, 연속 드래그 Undo, 임시 프리셋 미리보기, 모달 포커스, 한국어 라벨, 실제 출력 옵션과 취소·부분 실패.
- `useStore.ts`, `saveQueue.ts`: per-photo 직렬 저장, 미저장 값 보존, 실패/재시도, 종료 시 flush, 오래된 응답 거부, 승인된 에이전트 편집을 기존 Undo에 반영. 저장 충돌은 강제 덮어쓰기 대신 명시적 디스크 다시 읽기로 복구합니다.
- `file-policy`, `safe-file`, `sidecar-store`, `edit-validation`: native picker와 스캔으로 부여한 파일 범위, inode/realpath/symlink, trusted renderer의 정확한 URL, schema·값 범위, 원자적 저장·해시 충돌, 알 수 없는 JSON 필드 보존. 에이전트 조회/내보내기는 편집기의 저장 기준 해시를 바꾸지 않습니다.
- `local-model`, `local-agent`, 신규 dialogs: 현재 한 장에 대한 텍스트 수치 제안. 정확한 모델/실행기 체크, 실행 중단, 문맥/출력/시간 제한, 네트워크 차단 자식 프로세스, 승인 범위와 before/after 로컬 journal. 일반 shell/개발 파일 쓰기는 비활성입니다.
- `xmp-patch`, `xmp-handlers`, `XmpDialog`: 사용자 선택 XMP의 기존 지원 숫자 속성만 수정. DTD/entity 거부, namespace URI 확인, 원문/필드 diff, 충돌 검사, byte 보존, journal, 현재 실행 중 Undo. `.lux.json`과 XMP를 서로 다른 저장 경로로 유지합니다.
- `onnx`, `onnx.worker`, `worker-readiness`, `export`, `exportRender`, `decode-window`: 모델 체크섬·입출력 검사, 실패를 원본 반환 성공으로 숨기지 않음, 실제 취소, 단일 복원/내보내기, startup timeout 정리, export 복원·자원 해제. 출력 파일은 메타데이터 처리까지 마친 뒤 exclusive link로 게시하여 기존 파일을 덮어쓰지 않습니다.
- `offline-policy`: 앱 사진 프로세스의 Node sockets/TLS/UDP/fetch 차단. Electron UI/decoder 세션은 로컬 자원만 허용. 언어 모델 프로세스는 별도 macOS sandbox 규칙 사용.
- 실행 검증 후 모델 관리자의 오래된 ready 표시와 모달 재열기 응답 경합, 보정 저장을 기다리는 중 누른 추론 취소가 무시되는 문제를 수정했습니다.

## 확인한 기존 문제

1. 저장 Promise의 실패를 무시해 저장 성공 여부가 보이지 않았음.
2. 늦게 도착한 sidecar/사진/복원 응답이 현재 선택에 끼어들 수 있었음.
3. NAFNet deblurring 모델을 denoise로 표시했고 export에서는 복원이 빠졌음.
4. XMP 입력 검증과 renderer가 전달한 임의 파일 경로에 대한 범위 검증이 부족했음.
5. ONNX/decoder 시작 실패·종료와 취소 경로에 무한 대기·재시작 경쟁이 있었음.

## 모델 및 실측

기존 `models/nafnet.onnx`는 공식 [OpenCV deblurring_nafnet_2025may.onnx](https://huggingface.co/opencv/opencv_zoo/blob/main/models/deblurring_nafnet/deblurring_nafnet_2025may.onnx)와 SHA256가 같습니다.

- SHA256: `07263f416febecce10193dd648e950b22e397cf521eedab1a114ef77b2bc9587`
- 파일 약91.7MB, [해당 모델 디렉터리 라이선스 MIT](https://huggingface.co/opencv/opencv_zoo/blob/main/models/deblurring_nafnet/README.md).
- 실제 runtime: 기존 `onnxruntime-node`, **CPU** provider. CoreML/Metal 사용으로 표시하지 않습니다.
- 입력 `lq` / 출력 `output`, float32 NCHW RGB, [0,1], reflect padding / overlap32 / tiled output blend. 알파는 원본 유지.
- 이번 합성96×80 이미지, 384×384 타일1개: 로드767ms, 추론560ms, 프로세스 peak RSS 약1087MiB. 실제 출력 변화·유한값·알파 보존을 확인했습니다. 품질/전체 사진 성능의 벤치마크가 아닙니다.
- 이 실행은 **Node 실제 ONNX 추론**입니다. Electron utility process·UI·내보내기 전체 경로의 성공 증거로 사용하지 않습니다.
- 후속 실제 Electron 33.4.11 통합 검사도 통과했습니다. renderer→preload→main→ONNX utility의 96×80 CPU 추론은 약1.64초였고 출력 변화·알파 보존을 확인했습니다. 작업 중단 후 새 worker로 재시작하는 경로도 통과했습니다.
- 저장한 RGB 복원 강도100이 원본 해상도640×400 WebGL export에 반영됐습니다. 강도0과 픽셀 차이가 있으며 화면 배경색 변경 전후의 출력 픽셀은 동일합니다. export의 WebGL은 ANGLE Metal Renderer / Apple M4 Pro, ONNX 추론 provider는 CPU입니다. 40MP 사진의 품질/속도를 검증한 결과는 아닙니다.
- export 복원은 최대40MP RGBA 입력과 GPU 최대 텍스처 한도 내에서 처리합니다. 부족하면 실패로 보고하며 복원을 조용히 생략하지 않습니다.

언어 모델·정확한 파일·SHA256·라이선스·실행 방법과 실제 추론 결과는 [local-agent.md](local-agent.md)를 참조하세요. 공식 Qwen GGUF와 llama.cpp b10809 ARM64 아카이브를 다운로드했고 두 파일의 공식 SHA256가 일치했습니다.

## 검증 기록

- 변경 전 `npm run typecheck`: 통과. `npm run build`: 통과.
- 변경 후 전체 타입 검사, 테스트, 프로덕션 빌드의 최종 결과는 이 문서 마지막의 최종 검사 항목에 기록합니다.
- 데이터 테스트: 실제 임시 파일로 sidecar 저장/읽기/Undo, 알 수 없는 필드, 동시 변경 충돌, 잘못된 schema, XMP 주석/BOM/CRLF/RDF/namespace 보존, DTD 거부, 경로 탈출/symlink/파일 교체 거부, 원본 해시 불변.
- 상태 테스트: 드래그 Undo, 미리보기 파일·기록 불변, 저장 실패·재시도, A→B→A 오래된 응답, 선택 순서, 추론 입력 준비 중 취소, worker startup 경쟁, 허용 도구/schema, 모델 없음.
- `npm run test:onnx`: 위 실제 CPU 추론 통과. Node 네트워크 차단 정책을 활성화한 채 실행.
- Electron baseline 실행은 Codex 실행 제한에서 **SIGABRT** 종료. 로컬 Vite 서버는 `127.0.0.1:5199` bind **EPERM**. 이는 renderer 화면을 확인한 결과가 아닙니다.
- 사용자 지시의 별도 승인 조건에 따라 Electron 실행과 약1.12GB 모델/실행기 설치를 요청했고, 사용자의 ‘계속 해줘’ 응답 후 진행했습니다.
- `npm run test:electron`: 합성 가로/세로/EXIF 회전 사진과 임시 userData로 실제 preload/IPC/SQLite/sharp 스캔, 슬라이더 exposure=1 저장, 빈 폴더, 사진만 보기/Escape, PNG 320×200 내보내기를 통과했습니다. 원본 SHA256 불변, renderer 오류0. 1440×900/1024×768 화면을 캡처해 직접 확인했고 작은 창 가로 넘침이 없었습니다. `.omc/artifacts/electron-smoke.json`과 `electron-*.png`에 기록했습니다.
- 실제 내보내기 모달에서 Tab 순환, PNG 선택, 저장 위치 선택, 버튼으로640×400 내보내기도 통과했습니다. 긴 저장 경로에서도 TIFF·범위 옵션이 모달 안에 남습니다.
- `npm run test:electron:restoration`: 위 ONNX utility/원본 해상도 export/중단·재시작 통과. main 및 두 utility의 TCP/TLS/UDP/fetch 차단, renderer/hidden decoder의 외부 fetch 거부를 실제 실행 중 확인했습니다. 기존 출력 파일 충돌은 새 접미 이름으로 처리했고 기존 파일·원본 해시가 유지됐습니다. `.omc/artifacts/electron-restoration-smoke.json`에 기록했습니다. 이는 실제 JS API·Chromium 정책의 검사이며 전체 OS 패킷 캡처나 모든 임의 native 코드의 sandbox 증거는 아닙니다.
- 실제 실행에서 창에 직접 전달된 키보드 이벤트의 `event.target.closest` 예외를 수정했습니다. 내보내기 긴 경로가 fieldset의 기본 최소 너비를 밀어 옵션을 자르는 문제는 명시적 `min-width: 0`으로 수정했습니다.
- 모델 loader 진단 중 읽기/쓰기 제한을 넓힌 임시 실행은 자동 승인 검토에서 거절되어 실행하지 않았습니다. 이후 기존 제한을 유지하고 macOS의 거부 로그에서 확인한 정확한 시스템 경로만 추가하는 방식으로 조사했습니다.
- `npm run test:electron:agent -- --runtime '…/llama-completion' --model '…/qwen2.5-1.5b-instruct-q4_k_m.gguf'`: 실제 모델 관리자 검사, 한국어 수치 제안, 1024px 모달 포커스·Escape 복귀, 실제 WebGL 픽셀 미리보기/해제 복원, sidecar 불변/승인 저장/Undo/Redo, XMP 승인/byte 단위 Undo, debounce 저장 중 즉시 닫기 flush를 통과했습니다. `--resume SCRATCH`로 완전히 새 Electron 프로세스를 실행해 그림자20·노출1과 모델 설정 복원을 확인했습니다. 모델은 재실행 시 실제 검사 전까지 untested입니다. `.omc/artifacts/electron-agent-smoke.json`, `electron-agent-restart.json` 및 캡처에 기록했습니다.
- 최종 실행의 한국어 검사 시간은3.935초였으며 예시에 없는 “대비를 17로 설정해줘”도 `{contrast:17}`로 정확히 제안했습니다. 실제 IPC에서 EV·상대 수치 요청 거부를 확인했습니다. 합성 fixture의 실제 저장 handler를1.8초 지연한 뒤 UI에서 중단했고 모델 요청 호출 수가 늘지 않았습니다. 모델 응답을 가짜로 대체한 테스트가 아닙니다. 복구 대기 후 Undo와 정상 저장도 확인했습니다.
- 정상 `npm run dev`도 실제 실행했습니다. localhost:5173의 Luxinus 창을 macOS 접근성 도구로 확인했고, 정상 사용자 데이터의 설치 경로를 읽어 모델 관리자에서 실제 추론 검사를 통과했습니다. 테스트 harness의 임시 프로필에만 설치된 상태가 아닙니다.

## 현재 미검증·미구현 및 재개

**미검증:** RAW 제조사/카메라·HEIF·손상파일 샘플, 대형 RAW/광색역의 색 정확도·마스크/export 품질, 메모리 부족, renderer 충돌·15초 무응답 복구 대화상자, 전체 프로세스 OS 패킷 캡처. 실제 UI·RGB/언어 모델·저장/내보내기·프로세스 재시작 검사는 위 합성 fixture 범위에서 통과했습니다. 모든 현상 도구의 카메라별 수동 회귀까지 완료한 것은 아닙니다.

**모델 품질 제한:** 1.5B 모델의 예시 밖 EV 변환과 상대 수치 계산에서 잘못된 출력이 발견됐습니다. 지원을 과장하지 않도록 수치 요청은 명시적인 절대 앱 값으로 제한하며 EV·배수·상대 증감 요청은 실행 전 안내합니다. 질적인 밝기/색상 제안도 사용자가 미리보기와 변경값을 검토해야 합니다. 사진 픽셀을 분석하는 모델이 아닙니다.

최종 직접 모델 진단에서도 두 항목을 묶은 요청의 채도 키를 대비로 잘못 고르는 사례가 남았습니다. 실제 앱은 요청·출력 불일치로 승인 가능한 제안을 만들지 않았습니다. 단일 그림자20/새 대비17 지시와 안전 정책은 통과했지만, 직접 진단은 다중 항목 품질 실패를 종료 코드2와 `allSupportedCasesMatched:false`로 보고합니다. 이를 타입/단위/실제 Electron 통합 검사의 통과와 혼동하지 않습니다. [모델 문서](local-agent.md)에 원문 출력과 메모리 실측을 남겼습니다.

**미구현:** 앱 내 모델 다운로드/업데이트 관리자, 사진 비전 모델·한국어 의미 검색·Smart Cull·AI 분할 마스크·전용 denoise·업스케일, Codex 실제 연결/별도 개발 에이전트, 원본 ID 재연결, 프리셋 강도/변형, 고급 EXIF 필터/프로필, XMP 재시작 복구 UI, batch sync 취소/Undo·선택적 항목 UI. [ROADMAP](../ROADMAP.md)에 다음 단계가 있습니다. 없는 기능의 작동 버튼이나 가짜 분석 결과를 추가하지 않았습니다.

**보장의 한계:** 앱 내부 쓰기는 직렬화하고 승인 시 SHA256와 위치를 재검사합니다. 다른 프로세스가 마지막 검사와 rename 사이에 바꾸는 극단적 경쟁 조건에 대해 OS filesystem compare-and-swap과 같은 보장은 없습니다. Node API 차단은 우리 코드의 방어이며 임의 native 실행파일의 보안 sandbox가 아닙니다. 별도 모델 sandbox는 production과 동일한 규칙의 합성 native fixture로 외부 읽기/쓰기·네트워크·다른 실행 파일 호출 거부를 확인했습니다. scratch 쓰기는 허용됐고 loopback 연결은0이었습니다.

재개 순서: 승인된 RAW 샘플로 카메라/좌표/색/대형 export 회귀 → 오류 복구 실물 시나리오 → 모델 변경 시 같은 한국어 holdout·메모리·sandbox 검증 → [ROADMAP](../ROADMAP.md)의 사진 특화 기능. 재검사 스크립트는 README와 모델 문서에 있습니다.

사용자 원본은 사용하거나 수정하지 않았습니다. 테스트 입력은 합성/임시 파일입니다. Git 브랜치 생성·전환, pull, merge, reset, stash, 커밋, push, PR/원격 변경은 수행하지 않았습니다.

## 최종 검사

- `npm run typecheck`: Node/Web 모두 통과.
- `npm test`: **42/42 통과**, 실패0·skip0·todo0. 실제 모델 실패에서 도출한 수치 요청 범위/출력 일치 검사와 프롬프트 역할 구분자 검사를 포함합니다.
- `npm run build`: main/preload/renderer 모두 통과. renderer JS 약497KB(비압축).
- `git diff --check`: 통과.
- 별도 검증자가 데이터 경계·취소·동시 실행·에이전트 승인 경로를 검토했습니다. 최종 종료 처리에는 응답 제한시간/화면 실패 시 native 복구 안내와 진행 중인 export/agent/XMP/batch sync 종료 방지를 추가했습니다.
- `scripts/electron-smoke.cjs`: 실제 Electron 실행·1440/1024 캡처와 기본 편집/저장/내보내기 통과.
- `scripts/electron-agent-smoke.cjs`의 최종 코드로 실제 제안·미리보기·절대값 일치·저장 대기 중 취소·승인/Undo/Redo·종료 저장·새 프로세스 복원을 통과했습니다. renderer 오류0. 실제 설치 파일을 사용했으며 합성 원본 해시는 동일합니다.
- 추가 좌표 회귀 테스트7개로 색상 샘플링의 자르기/회전/반전 순서를 확인했습니다. 기존 마스크 좌표는 현재 표시/crop UV에 묶이는 기존 포맷을 유지합니다. 마스크 작성 후 다시 crop/rotate하면 원본 피사체의 동일 위치를 추적하는 source-anchored 마스크는 아니므로 이 추가 좌표계 개선은 남아 있습니다.
