# Luxinus Local Agent

2026-09-09 구현: 현재 사진 한 장의 한국어 지시를 제한된 수치 제안으로 변환 → 항목별 diff → 임시 미리보기 → 명시적 승인 → 기존 `.lux.json` 저장 → 일반 Undo 경로로 연결한다. 실제 추론은 별도 모델·실행기를 설치하고 검사에 통과한 경우에만 활성화된다. 테스트용 응답이나 클라우드 대체 경로는 없다.

## 모델과 실행기

| 항목 | 설정 |
|---|---|
| 역할 | 한국어 텍스트 지시를 보정 수치로 변환 |
| 공식 모델 | Qwen/Qwen2.5-1.5B-Instruct-GGUF |
| 정확한 파일 | `qwen2.5-1.5b-instruct-q4_k_m.gguf` |
| 라이선스 | Apache-2.0 |
| 모델 파일 용량 | 1,117,320,736 bytes (약 1.12 GB) |
| SHA256 | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` |
| 실제 검증 실행기 | llama.cpp b10809 `llama-completion`, commit `5266f24da`, macOS arm64 |
| 자원 한도 | 문맥 4,096 토큰, 출력 512 토큰, CPU 최대 4개 스레드, GPU offload 0, 작업 180초 |
| 입력 / 전처리 | 현재 허용된 scalar 값 + 1,500자 이하 요청, Qwen ChatML |
| 출력 / 후처리 | JSON schema 강제 + 별도 엄격 검증, CLI의 마지막 `[end of text]` 표식만 제거 |

모델 출처와 체크섬은 [공식 파일 페이지](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/main/qwen2.5-1.5b-instruct-q4_k_m.gguf)에서 확인했다. [공식 모델 카드](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF)는 한국어와 구조화 출력 지원을 설명하지만, 이것은 Luxinus의 실제 품질 검증 결과가 아니다.

2026-09-09 사용자가 설치와 실제 실행을 승인한 후 [공식 b10809 배포물](https://github.com/ggml-org/llama.cpp/releases/tag/b10809)의 `llama-b10809-bin-macos-arm64.tar.gz` (11,123,196 bytes)를 다운로드했다. 공개 SHA256 `7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2`와 모델 SHA256이 각각 일치했다. 최종 설치는 앱 전용 디렉터리다.

```text
~/Library/Application Support/luxinus/models/runtime/llama-b10809/llama-completion
~/Library/Application Support/luxinus/models/qwen2.5-1.5b-instruct-q4_k_m.gguf
~/Library/Application Support/luxinus/models/local-model.json
```

설치하려면 사용자가 별도로 승인한 다운로드로 공식 GGUF와 [llama.cpp 공식 배포물](https://github.com/ggml-org/llama.cpp/releases)을 준비한 뒤 앱의 AI 설정의 로컬 모델에서 실행기와 GGUF를 선택한다. 앱은 실행기의 `--help` 옵션, `--version`, GGUF 헤더 및 공식 SHA256을 확인한다. 모델 선택 뒤 ‘모델 실행 확인’는 한국어 지시로 그림자만 정확히 20으로 바꾸고 한국어 이유를 반환하는지 검사한다. 단순 파일 존재나 타이머로 준비됨을 표시하지 않는다. 모델 파일 삭제는 앱이 대신 실행하지 않는다.

직접 추론용 실행기를 고른 이유: 현재 [llama-cli 소스](https://github.com/ggml-org/llama.cpp/blob/master/tools/cli/cli-context.cpp)는 로컬 서버 프로세스와 통신한다. [llama-completion](https://github.com/ggml-org/llama.cpp/tree/master/tools/completion)은 파일을 읽어 직접 추론하며, 앱은 `--no-conversation`, `--json-schema`, `--simple-io` 등의 실제 지원을 먼저 확인한다. 서버 주소는 입력받지 않는다. `-ngl 0`만으로는 시작 시 Metal 장치를 조회하므로 [검증한 b10809 구현](https://github.com/ggml-org/llama.cpp/blob/b10809/ggml/src/ggml-metal/ggml-metal.cpp)의 `GGML_METAL_DEVICES=0`도 자식 환경에 고정했다. 이번 경로는 CPU 실행이다.

## 경계와 승인

- main이 생성한 임의 scope ID만 모델에 전송한다. 사진 경로·파일명·EXIF·픽셀을 모델 프로세스에 전달하지 않는다.
- 허용 도구는 `proposeEditPatch`, `unsupported`뿐이다. 허용 scalar 외 키, 잘못된 JSON, 다른 사진 ID, 무한대, 범위 초과, 빈 제안, 미지원 도구는 거부한다. 마스크·crop·denoise·내보내기·파일·shell 도구는 제공하지 않는다.
- 실제 모델이 EV 계산을 틀려 main은 EV·Kelvin 환산, 상대 증감·배수 요청을 **추론 전에 거부**한다. 수치 요청은 “노출을 25로, 채도를 -12로”처럼 항목별 변경 후 앱 절대값만 허용한다. 무해한 “사진 1장” 표기는 허용한다. 모델 출력의 모든 key와 값은 명시한 값과 다시 대조하며, 하나라도 다르거나 항목이 추가·누락되면 제안을 저장하지 않는다. 정성적 요청은 제안 수치와 미리보기 검토가 필요하다.
- 현재 사진의 저장을 먼저 완료한다. main은 사진 목록에서 선택한 경로인지 확인하고, 저장된 편집값·현재 편집값·sidecar SHA256을 제안에 묶는다. 제안은 최대 20개, 10분간 유지된다.
- 미리보기는 renderer의 일시 상태다. 승인할 때 현재 사진과 편집값을 다시 검사하며, main의 원자적 sidecar 저장은 제안 당시 SHA256이 일치할 때만 진행한다. 성공한 제안 ID는 소모되어 재적용할 수 없다. 저장에 실패하면 UI는 성공으로 표시하지 않는다.
- 모델 자식 프로세스는 `shell:false`, 고정 인자 배열과 최소 환경으로 실행한다. macOS `sandbox-exec`는 임시 디렉터리 밖 쓰기를 거부한다. 사용자의 후속 요청에 따라 네트워크 금지 규칙은 제거했다. 로컬 추론 실행기는 네트워크를 사용하지 않는다. 시스템 라이브러리·선택한 모델·실행기와 필요한 인접 dylib만 읽는다. macOS dyld의 실제 커널 거절 로그에 근거하여 루트 `/`와 실행기 상위 디렉터리 자체의 열람만 허용하며, 하위 사용자 파일 권한은 부여하지 않는다. scratch 경로는 `/var` 별칭을 실제 `/private/var` 경로로 정규화한다. 읽기 권한은 사용자 홈 전체로 확장하지 않는다. 모델 프로세스가 다른 프로그램을 실행하는 것도 거부한다.
- sandbox 실행을 거부하는 환경에서는 추론도 실패한다. 파일 보호 제한을 풀고 재실행하거나 원격 서버로 자동 대체하지 않는다. 취소 시 SIGTERM, 1초 후 필요 시 SIGKILL로 프로세스 그룹을 종료한다. 준비 중 체크섬 읽기도 취소를 확인한다.
- `userData/agent-journal/YYYY-MM-DD.jsonl`에 승인 범위와 보정 전후를 로컬 기록한다. 프롬프트·EXIF·인증값·모델 자유문·사진 경로는 기록하지 않는다. 사진 식별은 경로의 SHA256이다. 기존 일반 Undo와 sidecar 재로딩으로 복구한다.

## Codex 제공자 추가

사용자의 후속 요청으로 공식 ChatGPT 로그인과 Codex App Server 보정 경로를 추가했다. 로컬 모델을 교체하지 않고 AI 창의 제공자 선택으로 구분한다. Codex는 로컬 모델의 산술 제한을 적용하지 않으며, 별도 엄격한 응답 스키마를 거쳐 동일한 보정값 검증·제안 승인·저장·Undo를 사용한다.

설치된 `codex-cli 0.153.4`의 help·feature registry·생성 JSON 스키마와 [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)를 확인했다. 구현과 검증의 정확한 범위는 [Codex와 UX 변경 기록](codex-and-ux.md)에 있다. 실제 사용자의 브라우저 로그인 완료와 인증된 모델 응답은 사용자가 계정 연결을 마친 뒤 확인할 수 있다.

## 실제 검증과 품질 한계

`npm test`에는 strict JSON, tool/사진 범위, 값 범위, 미지원 응답, prototype 키, 편집 fingerprint, CLI 표식, 모델 없음, 잘못된 체크섬, 부분 설정 복원, sandbox 정책 구성 검사가 포함된다. 정책 문자열 검사는 실제 OS 차단이나 실제 모델 추론을 대체하지 않는다.

개발 도구의 중첩 sandbox 안에서는 `sandbox_apply: Operation not permitted`로 실패하므로, 사용자 승인 범위에서 native 프로세스로 앱과 동일한 파일 보호 프로필을 검사했다. 최신 정책은 loopback 통신을 허용하며 실제 연결 1건이 도달했다. 허용되지 않은 합성 파일 읽기·쓰기와 `/bin/sh` 실행은 계속 거부하고 scratch 쓰기만 허용한다. 호스트의 일반 모델 실행 경로에서는 네트워크 요청이 관찰되지 않았다. 실제 취소와 PID 종료도 확인했다. 이 결과는 해당 macOS의 검사이며 다른 OS나 향후 sandbox 지원을 보장하지 않는다.

후속 검사에서 설치 실행기의 dylib 링크 18개가 정리된 임시 압축 해제 폴더를 가리키는 문제가 발견되었다. 설치 폴더 안의 동일한 versioned 파일을 가리키는 상대 링크로 복구했고 모든 일반 파일의 SHA256 전후 일치를 확인했다. 복구 후 실제 한국어 추론을 재검사했다.

설치한 모델과 실제 production prompt/schema를 사용한 검사 결과:

| 지시 | 현재값 → 모델 출력 | 결과 |
|---|---|---|
| 그림자를 정확히 20으로, 다른 항목 유지 | 0 → `shadows:20`, 한국어 이유 | 경로 검사 통과, 프롬프트 예시와 유사 |
| 색감 유지하고 어두운 부분만 조금 살리기 | 0 → `shadows:15`만 변경 | 통과, 프롬프트 예시 |
| 사진 내용 설명 | `unsupported`, 빈 patch, 한국어 설명 | 통과, 프롬프트 예시와 유사 |
| 노출 +0.5EV와 채도 12 감소 | 0 → `exposure:0.5, saturation:-12` | **실패**, Luxinus 기대 노출은 25 |
| 그림자를 지금보다 10 밝게 | 20 → `shadows:10` | **실패**, 기대 절대값은 30 |

예시 외 두 실패 문장을 프롬프트에 추가하여 결과를 맞추지 않았다. 일반 규칙으로 “EV 수치에 50을 곱한다”와 “현재값에 증감량을 계산한 절대값을 출력한다”만 보강하고, 기존 실패 사례와 새 holdout을 다시 검사했다. 상대값은 그림자 20+10→30, 대비 8+4→12로 통과했지만 EV는 0.5→50, 새 1.2→6.4로 여전히 실패했다(기대값 25, 60). 이 결과에 따라 상대 계산도 보수적으로 미지원 범위에 포함했다. 이들 잘못된 수치 요청은 최종 앱에서 추론 전에 거부되므로 적용 가능한 제안을 만들지 못한다.

이 1.5B 모델은 한국어 JSON 생성 경로는 작동하지만 단위 환산과 일반 산술을 신뢰할 수 없다. 모델 관리자의 검사 통과는 파일·실제 실행·구조화 출력 경로 확인이며 일반 보정 품질 인증이 아니다. 정량 요청은 별도 입력·출력 대조로 보호하며, 정성적 요청은 반드시 diff와 미리보기를 보고 승인해야 한다.

최종 제한 경로의 새 절대값 검사에서 “대비를 17로”는 `contrast:17`로 통과했다. 여러 항목 요청 “사진 1장 노출을 25로, 채도를 -12로”는 모델이 `exposure:25, contrast:-12`를 반환했다. 채도를 대비로 잘못 매핑했으므로 별도 요청·출력 대조가 제안을 거부했다. 따라서 여러 항목을 묶은 요청도 항상 성공한다고 볼 수 없다. 단일 항목으로 다시 요청하거나 기존 수동 슬라이더를 사용할 수 있다. 최신 진단 보고서는 `policyPassed:true`, `allSupportedCasesMatched:false`를 구분하고 품질 실패를 종료 코드 2로 알린다.

M4 Pro / 물리 메모리 48 GiB에서 CPU 추론은 초기 3개 검사 3.07~3.15초, 일반 규칙 보강 후 100ms RSS 샘플을 병행한 5개 검사 4.13~4.51초였다. 시간은 모델 파일 무결성 사전 해시 시간을 제외한 프로세스 로딩부터 완료까지다. 해당 모델 자식의 샘플 최고 RSS는 2,036.1 MiB였으며 샘플 사이의 절대 peak나 Electron 전체 메모리를 뜻하지 않는다. Metal 성능과 메모리 부족 강제 상황은 검증하지 않았다.

최종 제한 프롬프트의 3개 추론은 3.80~3.97초, 같은 100ms 샘플 최고 RSS 2,036.7 MiB였다. 단일 요청에서도 warm/cold 캐시와 동시 앱 부하에 따라 시간·메모리가 달라질 수 있다. 임시 다운로드 사본 `/private/tmp/luxinus-model-install`은 최종 앱 모델을 검증한 뒤 정리하여 중복 약 1.1 GB를 해제했다. 공식 release 원문은 `.omc/local-agent-smoke/llama-b10809-release.json`에 보존했다.

모델 자체의 산술 실패를 확인한 이전 직접 추론 보고서는 `.omc/local-agent-smoke/model-quality-probe.json`에 보존했다. 최종 시스템 프롬프트도 단위 환산·상대 계산을 미지원으로 명시한다.

아래 재현 명령은 이미 설치된 두 파일을 받으며 다운로드하지 않는다. 최종 입력 경계 함수로 미지원 요청을 차단하는지 검사하고, 허용된 절대값 요청은 **실제 로컬 모델**로 실행하여 요청값과 출력값을 대조한다. 실제 취소와 동일 OS 프로필 검사를 끝내고 `.omc/local-agent-smoke/model-smoke.json`에 기록한다. 직접 모델 출력은 사진 보정 제안으로 저장하거나 적용하지 않는다. 실제 IPC·승인 저장 경로는 별도 Electron 통합 검사에서 다룬다.

```sh
node scripts/smoke-local-model.cjs \
  "$HOME/Library/Application Support/luxinus/models/runtime/llama-b10809/llama-completion" \
  "$HOME/Library/Application Support/luxinus/models/qwen2.5-1.5b-instruct-q4_k_m.gguf"
```

Electron의 diff·preview 취소 불변성, 적용·Undo·재시작은 별도 `scripts/electron-agent-smoke.cjs` 통합 검사로 확인한다. 비전, 한국어 이미지 검색, 학습 분할, Smart Cull과 개발 에이전트는 이 텍스트 수치 제안 구현의 범위에 포함되지 않는다.
