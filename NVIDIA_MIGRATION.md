# AI Engine Migration — Google Gemini/Vertex/Vision + Groq → NVIDIA

The cbt-exam-be AI layer was migrated from a mix of **Google Gemini**, **Vertex
AI**, **Google Cloud Vision**, and **Groq** to a single **NVIDIA** provider
(NVIDIA API Catalog, OpenAI-compatible endpoint) behind a clean provider
abstraction, with **Ollama** retained as the local/offline fallback.

Architecture, REST routes, DB schema, review UI, automation APIs, and the
deterministic extraction pipeline are unchanged — only the AI layer was replaced.

---

## 1. Migration summary

- New provider abstraction in [`src/ai/`](src/ai): a single `ai` facade
  (`chat` / `chatJSON` / `text` / `vision` / `visionText` / `health`) that every
  feature calls. No feature imports a vendor SDK directly.
- **NVIDIA** (`nvidia/llama-3.3-nemotron-super-49b-v1.5`) is the default cloud
  model; **Ollama** (`qwen3:8b`) is the offline provider and automatic fallback.
- **Vision/OCR** (image OCR + diagram analysis) now uses the configurable NVIDIA
  vision model (`NVIDIA_MODEL_VISION`). PDF text stays on deterministic
  `pdf-parse`; PDF-as-image diagram auto-extraction is disabled (the VLM is
  image-only) and handled manually in review.
- **Subjective grading + summarization** moved off Groq onto the NVIDIA facade
  (exported function names kept for back-compat: `gradeSubjectiveAnswerGroq`,
  `summarizeWithGroq`).
- **Resilience:** every call retries (`NVIDIA_MAX_RETRIES`) then falls back to
  Ollama; failures never abort an import. Each call is logged with
  provider/model/latency/tokens/retries/cost. `runBatch` adds bounded-concurrency
  batch processing with per-item retry.
- **nemotron specifics:** `detailed thinking off` system directive +
  `<think>…</think>` stripping + robust JSON repair (`src/ai/json.ts`).
- **Future-ready:** PPT, Notes, Flashcards, Lesson Plans, Hints, Adaptive
  generation can be added as new service modules on the same `ai` facade without
  touching provider code (not built in this migration).

---

## 2. Files changed

**New (`src/ai/`)**
- `config.ts` — env-driven config (no hardcoded models/endpoints)
- `types.ts` — `AIProvider` interface + DTOs
- `json.ts` — reasoning-trace stripping + robust JSON repair
- `logging.ts` — structured per-call telemetry + cost estimate
- `batch.ts` — `runBatch` concurrency-limited retrying runner
- `providers/nvidiaProvider.ts` — OpenAI SDK → NVIDIA (text + vision)
- `providers/ollamaProvider.ts` — local Ollama (text + optional vision)
- `factory.ts` — provider selection from `AI_PROVIDER`
- `withFallback.ts` — the `ai` facade (retry + fallback + logging + parse)
- `index.ts` — barrel
- `scripts/verify-nvidia.js` — connectivity check (+ Ollama probe)

**Migrated to the facade**
- `src/services/aiQuestionGenerationService.ts` — generation + NVIDIA vision OCR
- `src/services/aiService.ts` — generation/paper/refine/solutions + grading/summarize (Groq removed)
- `src/services/answerGenerationService.ts` — answer solving
- `src/services/documentAnalysisService.ts` — doc classification
- `src/services/mathService.ts` — LaTeX normalization
- `src/services/diagramService.ts` — image diagram analysis (PDF auto-extract disabled)
- `scripts/ai-enhancer.js` — `GeminiEnhancer` → `NvidiaEnhancer`; `createEnhancer('nvidia'|'ollama')`
- `src/controllers/automationController.ts` — trigger now passes NVIDIA env to the runner
- `src/services/ollamaService.ts` — model now from `OLLAMA_MODEL`
- `src/models/ImportedQuestion.ts` — `ocrProvider` enum adds `'nvidia-vision'` (default); legacy values kept
- `src/services/questionImportService.ts`, `aiQuestionGenerationService.ts` — vestigial `model` hints → generic string
- `.env.example`, `package.json` (deps + `verify:ai` script)

**Deleted**
- `src/lib/googleClients.ts` (Vertex + Vision clients)
- `scripts/verify-google-auth.js`
- `checkModels.mjs`

---

## 3. Dependencies removed
- `@google/generative-ai`
- `@google-cloud/vertexai`
- `@google-cloud/vision`
- `groq-sdk`

## 4. Dependencies added
- `openai` (used only as an OpenAI-compatible client against NVIDIA)

---

## 5. Required environment variables

```
AI_PROVIDER=nvidia                 # nvidia | ollama
NVIDIA_API_KEY=<your key>
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL_PRIMARY=nvidia/llama-3.3-nemotron-super-49b-v1.5
NVIDIA_MODEL_VISION=meta/llama-3.2-90b-vision-instruct
NVIDIA_TEMPERATURE=0.2
NVIDIA_TOP_P=0.95
NVIDIA_MAX_TOKENS=8192
NVIDIA_TIMEOUT_MS=60000
NVIDIA_MAX_RETRIES=3
NVIDIA_CONCURRENCY=3
NVIDIA_REASONING=off
NVIDIA_COST_INPUT_PER_M=0           # optional cost tracking
NVIDIA_COST_OUTPUT_PER_M=0          # optional cost tracking
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_VISION_MODEL=                # optional local VLM for vision fallback
```

**No longer used (safe to delete):** `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`,
`GROQ_API_KEY`, `GEMINI_MODEL`.

---

## 6. Manual configuration steps
1. Get an NVIDIA API Catalog key (build.nvidia.com) and set `NVIDIA_API_KEY`.
2. Copy the AI block from `.env.example` into your `.env`; set `AI_PROVIDER=nvidia`.
3. (Optional offline mode) install Ollama, `ollama pull qwen3:8b`, set
   `AI_PROVIDER=ollama`. For local vision fallback, pull a VLM and set
   `OLLAMA_VISION_MODEL`.
4. `npm install` (installs `openai`, drops the Google/Groq packages).
5. `npm run verify:ai` to confirm connectivity.
6. Remove the obsolete Google/Groq env vars and any `vision-key.json`.

---

## 7. Testing checklist
- [ ] `npm run build` — clean (esbuild)
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npm run verify:ai` — NVIDIA reachable; Ollama probe reported
- [ ] `POST /api/ai/ai-generate/text` — valid JSON questions, LaTeX intact, no `<think>` leakage
- [ ] `POST /api/ai/ai-generate/image` — NVIDIA vision OCR → questions
- [ ] `POST /api/import-paper` (PDF) — ImportBatch completes; questions extracted; math normalized; dedup works
- [ ] `POST /api/ai/generate/paper` + `/refine` — paper generation & refinement
- [ ] Question solve (`/questions/class/:class/:id/solve`) — answer + explanation
- [ ] Subjective grading path (attempt grading) — graded via NVIDIA (no Groq)
- [ ] Break `NVIDIA_API_KEY` temporarily → confirm automatic Ollama fallback in logs
- [ ] Existing ImportedQuestion records still load (back-compat enum)
- [ ] Automation runner: dashboard trigger with provider `nvidia` runs `NvidiaEnhancer`
