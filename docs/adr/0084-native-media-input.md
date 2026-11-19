# 0084 — Native audio/video input

Date: 2026-11-19 · Status: accepted

## Context

Image input alone does not represent every model's modalities. Generic binary
mentions previously became base64 inside text, and the OpenAI chat adapter
rejects video file parts. A model's understanding and an endpoint's accepted
request format are separate facts.

## Decision

- Extend the existing mention, message and event-log pipeline with native
  `audio` and `video` parts. WAV/MP3 audio and MP4 video are supported initially;
  there is no local conversion, transcription or frame extraction.
- Snapshot permission-approved files as base64 on `user_message`, bounded by
  a combined 20 MiB per-send audio/video budget. Unsupported/oversized files
  produce visible mention warnings. Replay and fork use the persisted bytes.
  Extending ADR-0058's persistence redaction boundary: well-formed base64 in
  typed audio/video attachments is opaque binary and stays byte-identical;
  accidental credential-pattern matches must not corrupt it. Prompt text,
  filenames, metadata and malformed media content remain scanned. This does
  not decode or inspect secrets embedded inside media files.
- `capabilities.inputModels[exactModelId]` declares independent `image`, `audio`
  and `video` booleans. Missing modalities use catalog metadata, then unknown
  (unavailable). New declarations outrank legacy `imageModels`; the legacy
  endpoint `multimodal: false` remains an image veto. Legacy `multimodal` never
  grants audio/video. Wizard probes remain text-only and say so.
- Resolve audio/video support for every route target. Filter incompatible
  targets before credential resolution/network calls; retain media in history
  and fail visibly when no available target qualifies. No silent media removal.
- Chat audio uses `input_audio`; compatible chat video uses `video_url`. Google
  uses native inline media. Other transports reject unsupported modalities
  explicitly. A declared capability cannot override transport limitations.
- For calls containing video only, use the SDK's compatible chat adapter.
  Ordinary calls keep the existing OpenAI adapter. The reasoning wrapper
  supplies the same request/response translation to both adapters. Pin the
  compatible package to the V4 contract used by the installed SDK packages.

## Consequences

Model interpretation stays with the selected model. The core owns attachment
permission checks, immutable history and route eligibility; clients only collect
declarations and display media chips. SDK details remain internal (ADR-0002).
This extends the current attachment event shape; existing sessions/configs stay
readable by this build. Older builds do not support the new media kinds.

Base64 increases log/request size; provider limits can be lower than the local
cap. Large-file upload services, arbitrary media formats, remote media URLs,
realtime input and generated media are outside this change. Video input does
not imply that the model understands the video's audio track.

HTTP tests against a local server verify the actual payload, reasoning, replay
and incompatible fallback exclusion. They do not certify inference quality or
Infomaniak's hosted API; no activated Infomaniak account was available for a
live acceptance test.
