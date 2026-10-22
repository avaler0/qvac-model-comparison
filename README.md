# QVAC Model Compare

Phase 1 macOS desktop app for a single shared prompt and two sequential local LLM runs. Both panels remain visible; model A's inference process exits before model B starts. Results, prompts, metrics, and imported local paths live only in the current window.

## Run and package

Requires macOS on Apple Silicon, Node.js 22 or later, and npm.

```sh
npm ci
npm run dev
npm test
npm run package
open 'dist/mac-arm64/QVAC Model Compare.app'
```

`npm run package` produces an unsigned, unpacked `.app` bundle. It may need macOS local app approval when opened. The bundle contains the QVAC SDK and its native runtime; the current app bundle is about 2.5 GB because the SDK ships multiple native backends. For a normal development launch after building, use `npm start`.

Pinned direct versions are QVAC SDK `0.22.0`, Electron `38.8.6` (resolved in `package-lock.json`), React `19.2.0`, and Vite `7`. The lockfile pins transitive dependencies. The UI uses the QVAC site’s dark palette and bundled Geist font; the source badge and sketch were unavailable, and the user elected to proceed without them.

## Models and downloads

The app reads supported single-file LLM GGUF entries from the installed SDK catalog. It checks their artifact records in `~/.qvac/models`, the same cache used by inference. Existing complete catalog artifacts work offline. Registry selection with missing bytes opens a native approval dialog showing the source, remaining download size, destination, required assets, and available space. Cancel transfers no model bytes. Approved downloads use QVAC `downloadAsset`, can be paused, and retain partial bytes for a later approved resume. Downloading does not run inference. A cache miss or checksum failure at Compare stops before `loadModel`; the inference worker receives a verified local path and never receives a registry source that could trigger an implicit fetch.

“Choose local model file…” references one unsharded GGUF in place. It does not copy or alter the file. The app checks the GGUF header before selection and again before a run. The pinned macOS backend is `llamacpp-completion`; other backends and companion-file local bundles are outside this release. Local imports are forgotten on exit.

## Run and metrics

Compare requires a nonempty prompt and two ready models. A fixed shared configuration requests temperature `0.7`, top-p `0.9`, `predict` `2048`, seed `42`, and `reasoning_budget` `0`, with a `4096` context size. QVAC documents `reasoning_budget: 0` as disabling a supported model's reasoning channel. The app also requests separate thinking events and renders only answer content events. The SDK applies each model's chat template. The exact prompt and requested generation settings are passed to both workers. A response that reaches the token limit is labeled as potentially incomplete. Each worker loads, streams, unloads, closes QVAC, then exits. The second worker starts only after the first exit. Stop cancels the active SDK request, prevents the queued worker from starting, and escalates to process termination if cleanup stalls.

Preflight verifies the local artifact and calls QVAC's weightless `assessModelFit` in sequential mode. Its verdict is advisory: on this validation machine it reported `likely-too-large` for the cached 4B model that completed in the packaged app. The UI discloses the warning and allows the run. A real out-of-memory load error is reported in its panel.

“First output” is the interval from inference submission to the first visible text chunk, measured by a monotonic clock in the inference worker. It is not token TTFT; QVAC 0.22.0 emits text chunks rather than one event per generated token. “SDK tokens/s” and input/output token counts come from QVAC completion statistics, not chunk or word counts. Output token counts can include generated tokens that do not appear in the visible answer. “Inference” excludes loading, unloading, download, and queue time. “Load time” measures `loadModel`. “Total model run” starts when the worker is forked and ends on exit. Peak worker tree RSS sums resident memory reported by macOS `ps` for the worker and descendants every 250 ms; sampling can miss short peaks and shared resident pages can be counted more than once. It is not model-only memory or dedicated VRAM. Missing stats show Unavailable. Cancelled runs retain partial metrics without showing final throughput.

## Privacy and storage

The renderer uses volatile React state only. The app has no history, comparison files, prompt/output logs, analytics, accounts, cloud inference, or export. Clear removes the current prompt, outputs, and metrics. A new launch restores none of them or imported file paths. The app persists only QVAC model assets and the SDK config needed to reuse the cache, with SDK console logging disabled. This does not erase OS swap or crash data.

## Validation

On a MacBook Pro Mac17,2 with Apple M5, 32 GB unified memory, macOS 27.0.1, QVAC SDK 0.22.0, and `llamacpp-completion` on GPU, the packaged `.app` loaded the already-cached Qwen3 4B Q4_K_M GGUF (`QWEN3_4B_Q4_K_M`), streamed and completed panel A, unloaded and exited its worker, then did the same for panel B. The artifact SHA-256 matched the SDK's catalog checksum. No model bytes were downloaded or copied for this validation. The packaged UI showed both results, SDK metrics, and a 3.21 GB sampled peak process-tree RSS in one run. A Stop during preflight cancelled both panels before B started. Cancelling the missing-model approval dialog retained the previous selection and created no model file. The native picker selected the existing GGUF in place; after closing and reopening, the prompt, outputs, metrics, selections, and local import were absent. Controller checks cover sequential exit ordering, A failure followed by B, and Stop suppressing queued B.

Remaining validation gaps: an approved download/resume was not exercised because no new download was authorized; the badge/sketch visual comparison cannot be completed without those original files; and the current local-file path supports single GGUF files only. The unsigned package is not notarized. Future VLM, image, and music adapters should retain the same serial worker ownership and approved provisioning boundary; their controls are intentionally absent from Phase 1.
