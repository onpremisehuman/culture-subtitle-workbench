---
name: culture-subtitle-workbench
description: Build, install, run, and troubleshoot a local cultural-subtitle queue for YouTube or user-provided videos, using Whisper for timed transcription and a selected AI CLI for Korean translation and cultural notes. Use for 문화역주 자막 and workbench management, not as a general-purpose media downloader.
---

# Culture Subtitle Workbench

Run a local, asynchronous subtitle workflow that preserves speech timing and adds concise Korean cultural notes (`※ 역주`). The user's instructions about tone, target language, and note density take precedence.

## Safety and scope

- Process only media the user owns, is authorized to use, or may lawfully process. Do not help bypass access controls or DRM.
- Treat YouTube import as a transcription source, not as a general-purpose download service.
- Before creating a YouTube MP4 or MP4+SRT export, confirm that the user has the necessary rights. SRT export and in-player overlay do not require media export.
- Never commit or expose `app/data/`, access tokens, databases, logs, downloaded media, model caches, or user subtitles.
- Do not delete or hide completed jobs unless the user asks. Temporary transcription audio is deleted automatically after each job.

## First use

The implementation lives in `app/`; helper scripts live in `scripts/`.

1. On Windows, run `scripts/doctor.ps1` to inspect Python, ffmpeg, yt-dlp, Whisper, and Codex CLI.
2. If dependencies are missing, run `scripts/install.ps1`. Use `-InstallFfmpeg` only when winget may install ffmpeg, and `-RegisterAutostart` only when the user wants the server to start at login.
3. Run `scripts/start.ps1` to start the server without a persistent console and open `http://127.0.0.1:8876/app/`.
4. Load `app/extension` as an unpacked Chrome or Edge extension when the user wants subtitles over the original YouTube player.

Use **AI 선택** in the workbench to choose Codex, Claude Code or Antigravity (legacy Gemini is also selectable). Auto checks installation only, not login or remaining quota. If the selected CLI needs login, ask the user to sign in through that CLI; never request or store passwords. The workbench uses the selected CLI account, not an embedded API key. Transcript text is sent to that provider; audio transcription stays local. Backend choice is frozen for each translation job and errors never silently switch providers.

## Operating workflow

- For a YouTube URL, open the workbench or extension, choose source language (`auto` unless a reliable language is known), choose subtitle density, and queue the job.
- For a local video, use the workbench file picker. The original remains local under the workbench's protected data directory.
- Prefer an explicit language such as `pt`, `tr`, or `fa` when metadata is absent or auto-detection previously failed.
- Wait for the job to reach `감상 가능`. A failed transcript quality gate must be retried from transcription; do not translate a repetitive or obviously hallucinated transcript.
- Watch YouTube jobs through the original player overlay. Watch local jobs in the built-in player. Subtitle size and font preferences persist locally.
- Export SRT directly. Treat MP4 and MP4+SRT as optional, user-authorized media exports.

## Troubleshooting

- If the extension reports `Could not establish connection`, start the local server and reload the YouTube tab.
- If the manifest cannot be loaded, verify that the selected directory is exactly `app/extension` and contains `manifest.json`.
- If transcription fails, run `scripts/doctor.ps1`, verify ffmpeg/Whisper availability, and inspect `app/data/logs/autostart-server-error.log` without exposing its contents publicly.
- If translation fails, inspect the selected CLI's login and quota. For Codex use `codex login status`. Do not silently switch to another provider or API key. `AGENT_CLI_BACKEND` overrides the saved UI choice; `CULTURE_SUB_MODEL` applies to Codex only.
- Translation embeds the source cues in the prompt and runs in chunks (`CULTURE_TRANSLATION_CHUNK`, default 200). Per-chunk outputs live in `app/data/jobs/<id>/aligned_translation.partNN.json`; a chunk that returns empty or placeholder text is retried once, then the job fails naming the chunk range. Retrying a job that failed during translation reuses its `aligned_source.json` and skips download and Whisper.
- yt-dlp `HTTP Error 403` is usually transient and is retried automatically. If it persists, update yt-dlp and make sure Node or deno is installed as the JS runtime.
- In `--lan` mode, Tailscale nodes receive the pairing token automatically only when `CULTURE_TRUST_TAILSCALE=1`; otherwise only this PC does.
- Keep the server bound to `127.0.0.1` unless the user explicitly requests LAN access. LAN mode exposes a pairing token and should be limited to a trusted network.

## Validation after changes

Run:

```powershell
python -m unittest discover -s app/tests -v
python -m py_compile app/server.py app/make_ass.py app/culture-subtitle-autostart.pyw
```

Also validate `app/extension/manifest.json` as JSON and test one desktop and one narrow/mobile layout when UI code changes.
