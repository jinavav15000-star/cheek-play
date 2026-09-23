# MediaPipe (자체 호스팅)

얼굴 인식을 기기 안에서만 돌리기 위해 CDN 대신 파일을 직접 둔다.

- `vision_bundle.mjs`, `vision_wasm_internal.js/.wasm`: npm `@mediapipe/tasks-vision@1.0.1` (Apache-2.0). SIMD 빌드만 포함(최신 폰은 모두 지원).
- `face_landmarker.task`: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task (Apache-2.0)

갱신할 때는 버전을 올리고 세 파일을 같은 버전으로 함께 교체한다.
