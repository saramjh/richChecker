# Richchecker KR · Android 사진 읽기 오류 점검 (2026-11-13)

## 관측 (2026-11-12 KST, GA4 Data API)

| 지표 | 값 |
|---|---|
| 업로드 시작 | 14회/사용자 5명 |
| 업로드 오류 · file_read | **8회/사용자 3명** |
| 분석 시작/완료 | 각각 6회/사용자 3명 |
| Android Chrome | 시작 9, file_read 오류 8, 완료 1 |
| iOS Safari·Chrome | 시작 5, 읽기 오류 0, 완료 5 |
| 오류 유입 | DC Inside 5회/1명, Google organic 3회/2명 |
| 오류 국가/기기 | 대한민국·모바일 Android Chrome 8회 전체 |

직접 조회 차원: eventName, deviceCategory, operatingSystem, browser, country, sessionSourceMedium, customEvent:error_type.
customEvent:source 및 customEvent:file_size_kb는 현재 GA4 보고 API에서 조회되지 않았다.
하루 집계 이벤트는 독립 시행/세션의 확정 실패율이 아니므로 8/9를 엄격한 전환 실패율로 표현하지 않는다.

## 원인 분석

기존 업로드는 FileReader.readAsDataURL(file)로 원본 전체를 Base64 문자열로 복사한 후 이미지 로드와 얼굴 분석을 수행한다.
이 8건은 FileReader.onerror에서 기록된 것으로 확인했다. image_decode 발생은 0이었다.
원본 파일의 Base64 복사는 추가 메모리를 사용한다. 다만 실제 오류의 원인이 메모리 부족, Android 파일 접근 권한, 클라우드 사진 제공자 문제 중 무엇인지는 미확정이다.

## 최소 정비

FileReader 전체 복사 대신 URL.createObjectURL(file)의 브라우저 내부 Blob URL을 사용한다.
이전 사진은 교체/리셋 시 URL.revokeObjectURL()로 해제하며, 실패한 Blob URL 역시 해제한다.
공유용 크롭, 분석 캔버스, MediaPipe 모델 등 기존 코드는 재사용한다.
실패 경로는 object_url 생성 실패와 image_decode 실패로 나눠 기록한다.
옛 file_read 오류 이벤트가 사라지는 것은 코드 경로를 없앴기 때문이지 새 경로의 운영 성공률 개선이 증명됐다는 뜻이 아니다.

## 격리 브라우저 테스트

- 초기 TDD: 기존 구현에서 FileReader 생성자에 오류를 강제하면 정상 사진 선택 불가능 (RED).
- 수정 후 실제 Chrome 모바일 뷰포트: 정상 파일 Blob URL 표시 및 공유 크롭 성공, 같은 파일 재선택 시 이전 URL 해제, 리셋 시 URL 해제, 손상된 PNG 오류 안내·URL 해제·분석 차단 성공.
- 실제 MediaPipe 얼굴 감지, 결과 렌더링, Blob URL 사용자 이미지, analysis_complete 확인. 0건의 외부 POST·브라우저 스크립트 오류.
- 모든 기존 matching/runtime/design/ownership/growth 계약과 JS/JSON 검사 통과.
- 실제 Android Chrome 실기기 재현 및 배포 이후 독립 외부 사용자의 업로드 성공률 변화는 아직 검증하지 않았다.

## 사후 관측

Android Chrome의 동일 조건 upload_started, upload_error (object_url/image_decode),
analysis_started, analysis_complete를 향후 날짜별로 대조한다.
모바일 브라우저별 표본 크기와 서로 다른 이용자 수를 분리하고, 운영 성공률을 입증하지 않고 개선 효과를 주장하지 않는다.

## 추가 안정성 점검: 파일 형식·기기·단계 (2026-11-13)

사진 처리 경로: 브라우저 선택 → 로컬 Blob URL → 이미지 디코딩 → 픽셀 한도 검사 → 캔버스 → 기기 내 MediaPipe 분석 → 결과/공유. **사진 파일 자체는 서버에 업로드되지 않는다.**

### 브라우저 형식 매트릭스

실제 사진을 각 형식으로 변환하여 macOS 데스크톱 Chrome의 Android 모바일 화면/사용자 에이전트에서 테스트했다. 이는 Android 실기기나 iOS Safari의 코덱 지원 결과가 아니다.

| 형식·상황 | 결과 |
|---|---|
| JPEG, PNG, WebP, AVIF, GIF, BMP | 이미지 디코딩과 분석 입력 성공 |
| HEIC, TIFF | 현재 테스트 Chrome에서는 image_decode 오류; HEIC는 JPG 재저장 안내 |
| 손상된 JPEG | image_decode |
| 0바이트 이미지 | empty_file / preflight |
| SVG, PDF | unsupported_type / preflight |
| MIME 없는 JPEG, octet-stream JPEG | 실제 이미지이면 디코딩 허용 |
| 50MiB 초과 파일, 5천만 픽셀 초과 이미지 | file_too_large, too_many_pixels |
| Blob URL 생성·디코딩 시간 초과·캔버스 오류 | object_url, image_timeout, canvas_snapshot |
| 재선택과 초기화 | 이전 Blob URL 해제 |

총 20개 브라우저 회귀 시나리오 통과, JS 예외 0개. 별도로 실제 MediaPipe 얼굴 분석의 전체 흐름도 통과했다. 일부 인위적 오류는 브라우저 후킹으로 재현했으며 실제 Android 하드웨어 실패율 개선은 아직 확인되지 않았다.

### 진단 이벤트와 개인정보

- upload_started: stage=selected, upload_format, upload_size_band
- upload_error: error_type + stage (preflight / object_url / decode) + 동일한 형식·크기 구간
- analysis_started, analysis_error, analysis_complete: 분석 처리 단계와 진단용 형식·크기 구간 전달
- format 값은 jpeg/png/webp/avif/heic/gif/bmp/tiff/svg/other_image/unknown/non_image처럼 제한된 카테고리. size 값은 empty/under_1mib/1_5mib/5_15mib/15_50mib/over_50mib.
- 파일명, 원본 바이트, 사진 이미지, Blob URL, 네이티브 오류 메시지는 분석 이벤트로 전송하지 않는다. MIME/확장자 기반 카테고리는 실제 파일 바이트 형식에 대한 확정 판정이 아니며, 최종 판정은 브라우저의 실제 디코딩이다.

### GA4 현재 등록 상태와 운영 제한

속성 457170548에서 error_type, stage, entry_context의 이벤트 범위 맞춤 측정기준 등록을 실제 확인했다. 새 upload_format, upload_size_band 등록을 시도했으나 OAuth 토큰의 Analytics Admin 쓰기 범위가 부족해 HTTP 403 / ACCESS_TOKEN_SCOPE_INSUFFICIENT가 반환됐다. **새 카테고리는 코드에서 전송하더라도 GA4 일반 보고서에서 아직 조회할 수 없다.**

관리자/편집자가 GA4 관리 → 데이터 표시 → 맞춤 정의 → 맞춤 측정기준 만들기에서 이벤트 범위 upload_format 및 upload_size_band를 각각 등록하거나, 연결을 Admin 쓰기 스코프로 다시 승인해야 한다. 새 정의는 소급 적용되지 않고 통상 24~48시간 처리 지연이 있다.

그 전에는 기존 error_type, stage 및 GA4 기본 deviceCategory, operatingSystem, browser, sessionSourceMedium을 이용해 오류·완료 사용자 수와 이벤트 수를 나란히 살필 수 있다. 이벤트 8회/시작 9회를 사용자 단위의 검증된 실패율로 주장하지 않는다.

### QA 재실행

로컬 정적 서버를 시작하고 RICHCHECKER_QA_URL과 실제 형식별 fixture 디렉터리 RICHCHECKER_QA_FIXTURES를 설정한 뒤 node tools/upload_format_qa.mjs를 실행한다. 기존 Puppeteer/Chrome 개발 환경을 재사용하며 새로운 프로덕션 의존성이나 외부 업로드 서버는 없다. 실기기 Android Chrome·iOS Safari에서 제조사 파일 제공자별 정상/실패 확인은 별도 후속 항목이다.

## 2026-11-14 — 디코딩 실패 후 실제 파일 헤더 기반 안내 보완

- Android 클라우드 사진 제공자가 파일명·MIME을 JPEG로 표시해도 실제 바이트는 HEIC/TIFF일 수 있다. 이는 **가능한 실패 사례**이며 11월 13일 외부 사용자 오류의 원인으로 확정된 것은 아니다.
- 디코딩 성공 경로는 변경하지 않는다. `image_decode` 실패 시에만 `File.slice(0, 16).arrayBuffer()`로 브라우저 로컬의 16바이트 서명을 제한적으로 검사해 HEIC/TIFF인 경우 JPG/PNG로 다시 저장하도록 맞춤 안내한다.
- 파일 제공자가 헤더를 읽지 못하거나 읽기가 지연되면 250ms 후 기존 일반 안내로 진행한다. 파일 전체 읽기/복사, 두 번째 디코더, 이미지 서버 업로드, 새로운 분석 이벤트 차원은 추가하지 않는다. 이벤트 `error_type=image_decode, stage=decode`는 기존 분류 그대로 유지한다.
- 테스트에는 실제 포맷 샘플과 JPEG로 잘못 표기된 HEIC/TIFF 서명, 헤더 읽기 예외·영구 대기, 기존 Blob URL 정리, 모델 분석 실패 안내를 포함한다.
- **주의:** 이 변경은 재시도 안내의 정확성과 안정성을 보강하며 Android 실기기 코덱 지원이나 외부 사용자의 업로드 성공률을 보증하지 않는다. 정확한 원인을 확정하려면 해당 기기/사진 제공자에서 개인정보를 수집하지 않는 재현과 완료 영수증이 여전히 필요하다.
