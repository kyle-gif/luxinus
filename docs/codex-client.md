# Luxinus Codex 연결

2026-09-09: 공식 Codex App Server의 ChatGPT 로그인으로 대화, 이미지 참고, 보정·앱 동작 제안을 지원한다. 기존 로컬 LLM의 기본 보정 제안은 유지한다. 이미지가 첨부되지 않은 요청에는 사진 픽셀이 포함되지 않는다. 임시 대화의 cwd는 사용자 사진 폴더와 분리된 `/private/tmp/luxinus-codex-request-*`다.

## 연결과 로그인

`CodexClient` 생성자는 프로세스나 네트워크를 시작하지 않는다. 일반 `status()`는 설치된 CLI 파일의 존재와 앱 전용 `connection-state.json`만 읽는다. 캐시의 `ready`는 **저장된 로그인 요약**을 뜻하며 현재 인증이 검증되었다는 뜻이 아니다. 실제 계정 확인은 사용자가 보정 요청을 보낼 때 수행한다. 사용자가 시작한 로그인 진행 중에는 이미 실행 중인 서버에만 `account/read(refreshToken:false)`를 보낸다.

로그인 버튼은 공식 `account/login/start`의 `type:chatgpt` 흐름을 시작한다. 앱은 검증한 공식 HTTPS 로그인 주소를 기본 브라우저로 연다. Codex가 OAuth·갱신 토큰을 관리하며, Luxinus 코드가 토큰을 읽거나 옮기지 않는다. `CODEX_HOME`은 `userData/codex`, 인증 저장 방식은 `file`이다. 기존 개발용 Codex 계정과 설정을 변경하지 않는다. 자식 환경에는 사용자 API 키·인증 환경·프록시 또는 모델 엔드포인트 설정을 상속하지 않는다.

로그인 완료 후 한 번 계정 메타데이터를 확인하고 서버를 종료한다. 이메일·플랜만 포함한 작은 요약 파일은 원자적으로 저장한다. 로그아웃·실제 인증 만료 확인 시 요약을 지운다. 로그인 취소, 모델 목록 조회, 보정 완료 후에도 서버를 종료한다. 시작·로그인·추론 취소는 진행 중 프로세스와 요청을 정리하며 `shutdown()`은 캐시 저장과 자식 종료까지 기다릴 수 있다.

## 요청 범위

기존 단순 보정 API는 `ephemeral:true`와 `turn/start.outputSchema`를 유지한다. 대화 API는 자연어 답변과 App Server의 실험적 `dynamicTools`를 사용한다. `initialize.capabilities.experimentalApi=true`, `thread/start.dynamicTools`, `item/tool/call` 요청·응답은 설치된 CLI의 생성 스키마와 공식 문서에 맞췄다.

GPT-6-Astra의 공식 모델 카탈로그는 `tool_mode:code_mode_only`다. `features.code_mode_host=false`를 설정하면 Luxinus 동적 도구도 호출할 수 없었다. 이를 `true`로 고쳐 공식 hosted orchestration 경로를 유지한다. 일반 `features.code_mode=false` 및 아래 네이티브 도구 제한은 유지한다. App Server 스키마에서 `dynamicTools` 같은 실험적 필드를 확인하려면 `generate-json-schema --experimental`이 필요하다.

노출 도구는 `luxinus_read_state`, `luxinus_list_photos`, 제안 모드의 `luxinus_stage_edit`, `luxinus_stage_actions`다. 읽기는 전송 당시의 제한된 앱 상태만 반환한다. 보정은 수치·HSL·색상·곡선·자르기·마스크의 알려진 필드만 검증하여 임시 상태에 병합한다. 마스크나 곡선 문맥이 잘린 경우 해당 전체 값을 교체할 수 없다. 앱 동작도 검증된 목록으로 대기시키며 사진 선택·Undo/Redo·별점·플래그는 다른 변경과 섞을 수 없다. 사용자의 적용 버튼 전에는 파일 또는 화면을 바꾸지 않는다. `approveChat`은 원래 보정값과 저장 hash를 확인한 뒤 기존 `saveEdits` 경로로 저장하고 앱 동작을 렌더러에 반환한다. 렌더러는 별도로 현재 사진·편집 상태를 확인한다.

shell·웹·`view_image`·연결 앱·플러그인·브라우저·다중 에이전트 기능은 자식별 설정으로 비활성화한다. `view_image` 도구는 비활성화되어도 사용자가 첨부한 `type:image` 입력은 모델로 보낼 수 있다. 읽기 전용 작업 정책을 적용하며 별도의 네트워크 금지 정책은 추가하지 않는다. 기본 `apply_patch`를 포함한 모든 내부 도구가 완전히 제거된 상태까지는 증명하지 않았다. 허용 목록에 없는 도구 항목·요청은 중단하며 권한·외부 토큰 요청은 거부한다. 도구 알림은 실행 시작 후 도착할 수 있으므로 알림 감시 자체를 실행 전 차단이라고 주장하지 않는다.

모델 목록은 사용자가 불러오기 버튼을 눌러야 조회한다. 반환된 모델의 `supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`로 선택지를 만든다. 입력 모달리티가 없는 이전 카탈로그는 공식 문서의 호환 규칙에 따라 text/image로 처리한다. 추론 강도는 조회된 해당 모델의 지원 값만 받아 `turn/start.effort`로 전달한다.

## 첨부와 전송

참고 이미지는 네이티브 선택기로 고른다. 현재 사진은 보이는 **현재 사진 포함** 체크(기본 켜짐)에 따라 보내기 시점에 최신 보정·자르기·복원을 공유 셰이더로 렌더링한다. 체크를 끄면 현재 사진을 보내지 않는다. JPEG·PNG·WebP·TIFF·HEIC·AVIF 정지 이미지, 원본 16MiB·4천만 픽셀 제한이다. Sharp가 방향을 적용하고 긴 변 1536px 이내 JPEG로 재인코딩하며 EXIF·ICC·XMP를 제거한다. 파일 경로와 원본 바이트를 저장하지 않는다. 불투명 첨부 ID는 창별 메모리에서 10분간 유지되고 한 요청에 최대 4개를 해석한다. 대기 캐시는 12개·압축 이미지 합계 32MiB로 제한한다.

준비 과정에는 Codex 통신이 없다. 보내기 시에만 선택된 JPEG를 `turn/start.input`의 `type:image,url:data:image/jpeg;base64,...`로 전달한다. 모델에는 첨부 순서와 현재 사진의 보정 반영 축소본/참고 이미지라는 구분만 알려주며 원래 파일명을 보내지 않는다. 현재 앱 상태는 불투명 사진 ID·순서·별점·플래그·화면 설정으로 제한하고 파일명 검색어를 지운다. 사용자가 직접 입력한 요청과 제한된 최근 대화 기록은 보낼 내용에 포함된다.

JSON-RPC는 newline 단위 UTF-8로 처리하고 요청 ID·대화 ID·턴 ID를 대조한다. 초기 응답 순서가 바뀌어도 다른 턴 결과를 사용하지 않는다. 서버의 원문 오류·진단·인증 URL·토큰·프롬프트는 로그에 남기지 않는다. 수신 프로토콜 메시지: 텍스트 기본 1MiB, 이미지 요청은 실제 첨부 data URL 합계 + 1MiB(최대 17MiB), 초기 대기 이벤트 합계 1MiB·128건, 최종 텍스트 64KiB, 앱 도구 호출 16회, 준비 응답 15초, 일반 RPC 20초, 도구 응답 15초, 추론 전체 180초, 로그인 대기 10분으로 제한한다.

## 검증 수준

설치된 CLI `/Applications/ChatGPT.app/Contents/Resources/codex`의 버전 `0.153.4`, `app-server --help`의 `--stdio`, 실제 `features list`, CLI가 생성한 v2 JSON schema를 확인했다. 최종 파일 전용 상태 조회는 실제 설치 경로를 찾고 `signed-out`, 자식 실행 0회, 생성 파일 0개를 반환했다.

`tests/codex.test.ts`의 검사는 모의 stdio 서버를 사용한다. 한국어 UTF-8 분할, 응답 순서 역전, 다른 턴 무시, 요청 제한과 타임아웃, 서버 도구 요청 거부, 시작 중 취소와 재연결, 공식 로그인 URL 검사, 로그인 캐시·로그아웃·인증 만료와 캐시 정리, 뜻밖의 도구 중단을 확인한다. 모의 응답을 실제 로그인 또는 GPT 추론 결과로 제시하지 않는다.

이미지·추론 강도·초기 동적 도구 호출도 모의 서버로 확인한다. `agent-attachments.test.ts`는 실제 Sharp로 축소와 메타데이터 제거, 만료·창 범위·입력 제한을 검사한다. `agent-chat-session.test.ts`는 실제 제안 상태 병합과 읽기 모드의 변경 거부, 앱 동작 혼합 거부를 검사한다. 이 모의 테스트를 실제 서비스 동작 증거로 취급하지 않는다.

이전 초기 App Server 연결 검사 시도는 당시 네트워크 금지 지시와 충돌하여 자동 승인 검토에서 거절됐다. 이를 우회하지 않고 일반 상태 조회를 프로세스 없는 로컬 파일 읽기로 변경했다. 이후 사용자가 실제 GPT 도구 오류 수정을 요청하여, 승인을 받은 서비스 진단을 별도로 수행했다.

실제 GPT-6-Astra A/B 진단: 동일한 합성 32×32 JPEG와 가짜 보정 상태에서 기존 host 비활성 설정은 10.648초 후 도구 비활성 응답·호출 0회였다. host만 활성화한 설정은 8.059초에 실제 `item/tool/call` → `luxinus_stage_edit` → exposure 20 임시 제안으로 완료됐다. 최종 제품 설정의 추가 진단도 8.282초에 같은 제안이 등록됐고, 문장에 색상 정보를 넣지 않은 합성 이미지를 “벽돌빛 빨강”으로 식별했다. 모든 진단은 원본 사진·경로·EXIF를 사용하지 않았으며 저장하거나 적용하지 않았다. 실제 브라우저 OAuth 버튼·리디렉션 전체 절차는 이 진단의 검증 범위가 아니다.

재현 스크립트는 `scripts/diagnose-codex-tools.cjs`다. 명시적으로 실행할 때 공식 서비스와 계정 사용량을 사용한다. 결과는 `.omc/artifacts/codex-tools-real-diagnostic.json`(실패 기준), `codex-tools-real-host-only.json`, `codex-tools-real-production.json`에 남겼다. 모의 프로토콜 검증과 실제 합성 요청 검증을 분리해서 기록한다.

공식 근거: [App Server 프로토콜 및 관리형 ChatGPT 로그인](https://learn.chatgpt.com/docs/app-server), [Codex 설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference). 앱은 외부 토큰 주입 경로를 사용하지 않는다.
