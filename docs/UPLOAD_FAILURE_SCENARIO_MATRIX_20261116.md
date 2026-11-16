# Android photo upload failure and recovery matrix — 2026-11-16

Scope: Richchecker browser-based, on-device photo analysis. This is a **bounded, repeatable safety test matrix**, not a certification that every Android handset, gallery provider or malformed photo succeeds. Historical KR/US upload incidents cannot be attributed to a specific image format without the original photo and provider/permission context. Do not claim complete root-cause closure for those individual incidents.

## Verified and anticipated failure scenarios

| Scenario | Expected contract | Verified basis |
|---|---|---|
| JPEG, PNG, WebP, AVIF, GIF, BMP | Browser-local decode and enter analysis; no extra HEIC converter download on JPEG | Real format fixture / Chrome mobile viewport browser QA |
| HEIC/HEIF not natively decodable | Only on first decode failure, local HEIC conversion, then analysis | Real HEIC fixture plus unmocked MediaPipe face-analysis E2E |
| HEIC bytes mislabeled as JPEG by cloud provider | Verify first 16 bytes after failure and recover as HEIC | Real full HEIC bytes under fake JPEG name + MIME |
| TIFF uncompressed, LZW or Deflate | TIFF worker parses image dimensions before decompressing, converts to local JPEG, enters analysis | Real big-endian, LZW and Deflate fixtures plus unmocked MediaPipe E2E |
| TIFF bytes mislabeled as JPEG | Signature-based TIFF worker recovery | Real TIFF bytes under misleading JPEG name + MIME |
| Malformed HEIC/TIFF and corrupt JPEG | No fabricated completion, one terminal upload error, photo URL cleanup | Invalid/corrupt samples and signature-only stubs |
| Huge TIFF compressed dimension claim | Refuse before TIFF pixel allocation | Synthetic 100MP TIFF IFD metadata / bounded worker |
| TIFF IFD entry-count bomb | Reject before parsing arbitrary tag tables | 65,535-entry synthetic IFD |
| TIFF oversized tile dimensions | Reject before tile allocation | 65,535×65,535 tile metadata |
| TIFF Deflate expansion bomb | Cap streaming inflate output to the validated target strip/tile size | 32MiB+1 expansion fixture rejected by bounded pako inflater |
| TIFF worker stalls | Terminate stalled worker within configured time, no deadlock | Worker with nonresponding postMessage / 50ms test deadline |
| TIFF worker canceled by new selection or reset | AbortSignal terminates worker immediately; stale pixels never reach analysis | State tests assert signal abort on selection/reset; worker abort QA asserts termination |
| TIFF/HEIC above 12MiB, TIFF above 8MP, images above 50MiB or 50MP | Exclude from automatic conversion or fail with actionable bounded error | Source limits; 50MiB / 50MP / native bitmap rejection tests (not all formats physically tested) |
| Cloud/provider header read stalls or throws | Do not wait indefinitely for signature; fail with generic format guidance | Synthetic rejected/never-resolving file.slice reads |
| ImageElement decode error but native ImageBitmap works | One bounded native conversion, preserve preview/share pipeline | Forced initial image load failure with real JPEG bytes and MediaPipe E2E |
| ImageElement never fires load/error | Timeout/cleanup; no permanent progress overlay | Mock stalled img element; provider-timeout scenario |
| Native ImageBitmap itself hangs or returns late | Finish with error and close late bitmap, no photo URL leak | Synthetic delayed native bitmap and close assertion |
| SVG/PDF/nonimage masquerade, empty image, file >50MiB | Preflight rejection without decoding or transmitting photos | Local fixtures and synthetic >50MiB File |
| User chooses another photo during slow initial decode | Earlier photo never reaches analysis; latest selection owns preview | Deterministic gated provider-state test |
| User resets during slow initial decode or HEIC/TIFF recovery | Reset clears overlay immediately; late result cannot revive canceled photo | Deterministic gated provider + decoder-state tests |
| 12 fast consecutive photo selections | Only latest file reaches analysis; all stale object URLs revoked | Gated burst stress test |
| Photo access denied / object URL constructor throws | One terminal error and loader release, no raw exception/filename sent to analytics | Forced URL constructor failure |
| Canvas creation fails before model start | One analysis_error and immediate eventual loader release | Full app code with canvas snapshot fault injected |
| Recovery metadata | Only bounded format category, size bucket and recovery method; never original filename or photo bytes | Telemetry payload inspection, local browser interception |

## Correctness policy

- Every *supported* valid image must either reach an actual local analysis result or a bounded explicit error. The same upload must never produce both a fabricated success and an upload failure. A face-less image may legitimately yield `analysis_error(face_not_detected)` even when decoding is correct.
- Old asynchronous work cannot overwrite a newer choice or a reset. A revision token is checked at the queue entrance, after original image decode, after fallback work, and before presenting results. A new selection or reset cancels outstanding waiters; reset also dismisses the loader immediately. TIFF worker cancellation terminates the worker rather than merely ignoring its late result.
- Self-hosted TIFF worker uses MIT-licensed `utif@3.1.0` and pako inflate (MIT/Zlib); cap: source ≤12MiB, first page ≤8MP, conversion deadline 9s, encoding deadline 5s. Workers terminate after completion or timeout. Existing HEIC conversion remains failure-only with its own ≤12MiB/10s limits. No photo content leaves the browser for conversion.
- Upload state tests mock only the face-analysis output to isolate concurrency; format QA mocks `processImage` to check input integrity. **Unmocked MediaPipe E2E** is separate proof for representative JPEG/HEIC/TIFF photos, not automatically implied by the scenario count.
- Chrome on macOS with Android mobile user agent and viewport **is not an Android handset**. The available local Android AVD did not boot because its system image is incomplete. Google Photos, OEM gallery, WebView permissions, low-memory device kills and the originally affected user's source photo remain outside the verified environment.

## Latest verification

On both KR and US builds: 38/38 format/failure cases and 9/9 state-transition cases passed, including TIFF IFD-count, oversized-tile and Deflate-expansion bombs. Unmocked MediaPipe E2E passed for representative JPEG, HEIC and TIFF images; a no-face image produced `face_not_detected` with the loader released. These runs used macOS Chrome with Android 14 / Pixel 8 user-agent and mobile viewport emulation, not a physical Android handset.

## Reproduction

Run a temporary local HTTP static server from the project root and set `RICHCHECKER_QA_URL` to its origin; point `RICHCHECKER_QA_FIXTURES` at the local test image fixtures. Execute `node tools/upload_format_qa.mjs` and `node tools/upload_state_qa.mjs`, then full unmocked MediaPipe E2E using real JPEG, HEIC and TIFF fixtures. Optional `face-lzw.tiff` in the fixture folder adds the compression branch without making the general test suite dependent on ffmpeg.

The merge/deploy must be separately verified through CI, public HTTP asset readback and live-site browser E2E; an exit code alone is insufficient. Keep real affected-device Android P0 open until a source-specific photo/permission flow is observed to complete on that device; new provider failure examples must be added as repeatable tests before extending converters.
