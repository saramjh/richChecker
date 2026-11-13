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
