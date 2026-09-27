import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import (  # noqa: E402
    extract_video_id,
    normalize_language,
    normalize_language_hint,
    normalize_srt_timings,
    parse_byte_range,
    resolve_tool_command,
    safe_local_filename,
    transcript_cues,
    transcript_quality_issues,
    validate_srt,
    validate_transcript_quality,
)
import server as server_module  # noqa: E402


class VideoIdTests(unittest.TestCase):
    def test_watch_url(self):
        self.assertEqual(extract_video_id("https://www.youtube.com/watch?v=7ifpw18OCwg"), "7ifpw18OCwg")

    def test_short_url(self):
        self.assertEqual(extract_video_id("https://youtu.be/7ifpw18OCwg?t=30"), "7ifpw18OCwg")

    def test_shorts_url(self):
        self.assertEqual(extract_video_id("https://youtube.com/shorts/7ifpw18OCwg"), "7ifpw18OCwg")

    def test_rejects_non_youtube(self):
        with self.assertRaises(ValueError):
            extract_video_id("https://example.com/watch?v=7ifpw18OCwg")


class SrtTests(unittest.TestCase):
    def test_valid(self):
        validate_srt("1\n00:00:00,000 --> 00:00:01,000\n안녕\n")

    def test_overlap(self):
        with self.assertRaises(ValueError):
            validate_srt(
                "1\n00:00:00,000 --> 00:00:02,000\n하나\n\n"
                "2\n00:00:01,000 --> 00:00:03,000\n둘\n"
            )

    def test_normalizer_sorts_blocks_and_removes_overlap(self):
        normalized = normalize_srt_timings(
            "1\n00:00:05,000 --> 00:00:07,000\n뒤 대사\n\n"
            "2\n00:00:03,000 --> 00:00:06,000\n앞 대사\n"
        )
        validate_srt(normalized)
        self.assertLess(normalized.index("앞 대사"), normalized.index("뒤 대사"))


class LocalVideoTests(unittest.TestCase):
    def test_filename_is_reduced_to_safe_basename(self):
        self.assertEqual(safe_local_filename("../../내 영상.mp4"), "내 영상.mp4")

    def test_non_video_extension_is_rejected(self):
        with self.assertRaises(ValueError):
            safe_local_filename("notes.txt")

    def test_media_range(self):
        self.assertEqual(parse_byte_range("bytes=10-19", 100), (10, 19))
        self.assertEqual(parse_byte_range("bytes=-10", 100), (90, 99))
        self.assertIsNone(parse_byte_range("", 100))

    def test_invalid_media_range(self):
        with self.assertRaises(ValueError):
            parse_byte_range("bytes=100-120", 100)


class LanguageTests(unittest.TestCase):
    def test_requested_multilingual_sources(self):
        self.assertEqual(normalize_language("TR"), "tr")
        self.assertEqual(normalize_language("fa"), "fa")
        self.assertEqual(normalize_language("pt"), "pt")
        self.assertEqual(normalize_language("pl"), "pl")

    def test_unknown_language_is_rejected(self):
        with self.assertRaises(ValueError):
            normalize_language("xx")

    def test_media_language_hint_is_reduced_to_supported_code(self):
        self.assertEqual(normalize_language_hint("pt-BR"), "pt")
        self.assertEqual(normalize_language_hint("por"), "pt")
        self.assertEqual(normalize_language_hint("pl-PL"), "pl")
        self.assertEqual(normalize_language_hint("pol"), "pl")
        self.assertEqual(normalize_language_hint("zh-Hans"), "zh")
        self.assertEqual(normalize_language_hint("unknown"), "")


class ToolResolutionTests(unittest.TestCase):
    @patch("server.shutil.which")
    def test_windows_prefers_cmd_shim_that_subprocess_can_launch(self, which):
        which.side_effect = lambda candidate: (
            r"C:\Users\me\.local\bin\codex.cmd" if candidate == "codex.cmd" else None
        )
        self.assertEqual(
            resolve_tool_command("codex", platform_name="nt"),
            [r"C:\Users\me\.local\bin\codex.cmd"],
        )

    @patch("server.shutil.which")
    def test_windows_wraps_powershell_only_tool(self, which):
        paths = {
            "codex": r"C:\Users\me\.local\bin\codex.ps1",
            "powershell.exe": r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        }
        which.side_effect = paths.get
        command = resolve_tool_command("codex", platform_name="nt")
        self.assertEqual(command[-2:], ["-File", paths["codex"]])


class TranscriptQualityTests(unittest.TestCase):
    def test_repeated_hallucination_is_rejected(self):
        transcript = {
            "segments": [
                {"text": "Transcription by CastingWords"} for _ in range(18)
            ] + [{"text": f"real line {index}"} for index in range(4)]
        }
        issues = transcript_quality_issues(transcript)
        self.assertTrue(any("반복" in issue for issue in issues))
        with self.assertRaisesRegex(ValueError, "전사 품질 실패"):
            validate_transcript_quality(transcript)

    def test_varied_dialogue_is_accepted(self):
        transcript = {
            "segments": [{"text": f"different spoken sentence {index}"} for index in range(24)]
        }
        self.assertEqual(transcript_quality_issues(transcript), [])
        validate_transcript_quality(transcript)

    def test_word_boundaries_trim_silent_segment_padding(self):
        transcript = {
            "segments": [
                {
                    "start": 10.0,
                    "end": 20.0,
                    "text": " Olá mundo",
                    "words": [
                        {"word": " Olá", "start": 12.2, "end": 12.7},
                        {"word": " mundo", "start": 12.75, "end": 13.4},
                    ],
                }
            ]
        }
        self.assertEqual(
            transcript_cues(transcript),
            [{"id": 1, "start": 12.2, "end": 13.52, "text": "Olá mundo"}],
        )

    def test_word_tail_padding_does_not_overlap_next_cue(self):
        transcript = {
            "segments": [
                {"start": 0, "end": 2, "text": "one", "words": [{"word": "one", "start": 1, "end": 1.5}]},
                {"start": 1.55, "end": 3, "text": "two", "words": [{"word": "two", "start": 1.55, "end": 2}]},
            ]
        }
        cues = transcript_cues(transcript)
        self.assertEqual(cues[0]["end"], cues[1]["start"])
        self.assertLessEqual(cues[0]["end"], cues[1]["start"])

    def test_out_of_order_whisper_segments_are_sorted(self):
        transcript = {
            "segments": [
                {"start": 10, "end": 11, "text": "later", "words": []},
                {"start": 8, "end": 9, "text": "earlier", "words": []},
            ]
        }
        cues = transcript_cues(transcript)
        self.assertEqual([cue["text"] for cue in cues], ["earlier", "later"])
        self.assertEqual([cue["id"] for cue in cues], [1, 2])


class JobDeletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_paths = (server_module.DATA_DIR, server_module.JOBS_DIR, server_module.DB_PATH, server_module.TOKEN_PATH)
        root = Path(self.temp.name)
        server_module.DATA_DIR = root / "data"
        server_module.JOBS_DIR = server_module.DATA_DIR / "jobs"
        server_module.DB_PATH = server_module.DATA_DIR / "queue.sqlite3"
        server_module.TOKEN_PATH = server_module.DATA_DIR / "access_token.txt"
        server_module.init_storage()

    def tearDown(self):
        server_module.DATA_DIR, server_module.JOBS_DIR, server_module.DB_PATH, server_module.TOKEN_PATH = self.old_paths
        self.temp.cleanup()

    def add_job(self, job_id, status):
        now = server_module.utc_now()
        with server_module.db() as conn:
            conn.execute(
                """INSERT INTO jobs (id, video_id, url, level, status, created_at, updated_at)
                   VALUES (?, ?, ?, 'culture', ?, ?, ?)""",
                (job_id, "7ifpw18OCwg", "https://www.youtube.com/watch?v=7ifpw18OCwg", status, now, now),
            )
        job_dir = server_module.JOBS_DIR / job_id
        job_dir.mkdir(parents=True)
        (job_dir / "culture.srt").write_text("test", encoding="utf-8")
        return job_dir

    def test_completed_job_and_files_are_deleted(self):
        job_dir = self.add_job("delete-me", "completed")
        deleted = server_module.delete_job("delete-me")
        self.assertEqual(deleted["id"], "delete-me")
        self.assertIsNone(server_module.get_job("delete-me"))
        self.assertFalse(job_dir.exists())

    def test_active_job_is_not_deleted(self):
        job_dir = self.add_job("keep-me", "translating")
        with self.assertRaisesRegex(RuntimeError, "작업 중"):
            server_module.delete_job("keep-me")
        self.assertIsNotNone(server_module.get_job("keep-me"))
        self.assertTrue(job_dir.exists())

    def test_job_can_be_hidden_and_moved_without_deleting_files(self):
        job_dir = self.add_job("organize-me", "completed")
        updated = server_module.organize_job("organize-me", {"hidden": True, "playlist": "브라질 드라마"})
        self.assertTrue(updated["hidden"])
        self.assertEqual(updated["playlist"], "브라질 드라마")
        self.assertTrue(job_dir.exists())

        restored = server_module.organize_job("organize-me", {"hidden": False})
        self.assertFalse(restored["hidden"])

    def test_playlist_name_is_validated(self):
        self.add_job("organize-invalid", "completed")
        with self.assertRaisesRegex(ValueError, "이름"):
            server_module.organize_job("organize-invalid", {"playlist": "   "})

    def test_multiple_jobs_can_be_moved_to_one_playlist(self):
        self.add_job("bulk-one", "completed")
        self.add_job("bulk-two", "failed")
        updated = server_module.organize_jobs(
            ["bulk-one", "bulk-two", "bulk-one"], {"playlist": "  CONTROL   시즌 1  "}
        )
        self.assertEqual([job["id"] for job in updated], ["bulk-one", "bulk-two"])
        self.assertTrue(all(job["playlist"] == "CONTROL 시즌 1" for job in updated))

    def test_bulk_move_is_atomic_when_a_job_is_missing(self):
        self.add_job("bulk-existing", "completed")
        original = server_module.get_job("bulk-existing")["playlist"]
        with self.assertRaises(FileNotFoundError):
            server_module.organize_jobs(
                ["bulk-existing", "bulk-missing"], {"playlist": "옮겨지면 안 됨"}
            )
        self.assertEqual(server_module.get_job("bulk-existing")["playlist"], original)

    def test_empty_playlist_can_be_created_and_listed(self):
        created = server_module.create_playlist("  시연용   목록  ")
        self.assertEqual(created, "시연용 목록")
        self.assertIn("시연용 목록", server_module.list_playlists())

    def test_duplicate_playlist_name_is_rejected_case_insensitively(self):
        server_module.create_playlist("Drama")
        with self.assertRaisesRegex(ValueError, "이미"):
            server_module.create_playlist("drama")

    def test_moving_a_job_registers_the_playlist(self):
        self.add_job("register-playlist", "completed")
        server_module.organize_job("register-playlist", {"playlist": "새 분류"})
        self.assertIn("새 분류", server_module.list_playlists())


def make_cues(count, start_id=1):
    return [
        {"id": start_id + index, "start": index, "end": index + 0.9, "text": f"line {index}"}
        for index in range(count)
    ]


class ChunkedTranslationTests(unittest.TestCase):
    def test_short_video_is_one_chunk(self):
        self.assertEqual(len(server_module.chunk_cues(make_cues(50), 200)), 1)

    def test_long_video_is_split_evenly_without_losing_cues(self):
        cues = make_cues(455)
        chunks = server_module.chunk_cues(cues, 200)
        self.assertEqual(len(chunks), 3)
        self.assertEqual([cue["id"] for chunk in chunks for cue in chunk], [cue["id"] for cue in cues])
        self.assertLessEqual(max(map(len, chunks)) - min(map(len, chunks)), 1)

    def test_prompt_embeds_source_so_codex_needs_no_file_access(self):
        cues = [{"id": 1, "start": 0, "end": 1, "text": "本物や"}]
        prompt = server_module.build_translation_prompt("t", "culture", "ja", cues, [], 1, 1, 1)
        self.assertIn("本物や", prompt)
        self.assertIn("파일을 읽거나", prompt)

    def test_exact_ids_are_accepted(self):
        chunk = make_cues(3, start_id=11)
        result = {
            "translations": [{"id": cue["id"], "text": f"번역{cue['id']}"} for cue in chunk],
            "notes": [{"cue_id": 12, "text": "역주"}, {"cue_id": 99, "text": "범위 밖"}],
        }
        texts, notes = server_module.parse_chunk_translation(result, chunk)
        self.assertEqual(texts[11], "번역11")
        self.assertEqual(notes, [{"cue_id": 12, "text": "역주"}])

    def test_zero_based_ids_are_remapped_by_position(self):
        chunk = make_cues(4)
        result = {
            "translations": [{"id": index, "text": f"번역{index}"} for index in range(4)],
            "notes": [{"cue_id": 0, "text": "첫 역주"}],
        }
        texts, notes = server_module.parse_chunk_translation(result, chunk)
        self.assertEqual(texts[1], "번역0")
        self.assertEqual(notes, [{"cue_id": 1, "text": "첫 역주"}])

    def test_blank_skeleton_is_rejected(self):
        # Real failure from 2026-09-26: Codex could not read the file and filled the schema
        # with empty text instead of translating.
        chunk = make_cues(20)
        result = {"translations": [{"id": cue["id"], "text": ""} for cue in chunk], "notes": []}
        with self.assertRaisesRegex(ValueError, "비었거나"):
            server_module.parse_chunk_translation(result, chunk)

    def test_refusal_message_is_rejected(self):
        chunk = make_cues(20)
        result = {
            "translations": [
                {"id": cue["id"], "text": "원문 파일에 접근할 수 없어 번역을 생성할 수 없습니다."}
                for cue in chunk
            ],
            "notes": [],
        }
        with self.assertRaises(ValueError):
            server_module.parse_chunk_translation(result, chunk)

    def test_scrambled_ids_are_rejected(self):
        chunk = make_cues(3)
        result = {"translations": [{"id": i, "text": "x"} for i in (3, 1, 2)], "notes": []}
        with self.assertRaisesRegex(ValueError, "구간 번호"):
            server_module.parse_chunk_translation(result, chunk)

    def test_translation_merges_chunks_into_one_srt(self):
        cues = make_cues(5)

        def fake_chunk(job_dir, level, prompt, chunk, part, backend):
            self.assertEqual(backend, "claude")
            return {cue["id"]: f"번역{cue['id']}" for cue in chunk}, [{"cue_id": chunk[0]["id"], "text": "주"}]

        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(server_module, "TRANSLATION_CHUNK_SIZE", 2), \
                patch.object(server_module, "chunk_cues", lambda c: [c[0:2], c[2:4], c[4:]]), \
                patch.object(server_module, "translate_chunk_with_codex", side_effect=fake_chunk), \
                patch.object(server_module.agent_cli, "resolve_backend", return_value="claude"), \
                patch.object(server_module, "update_job"):
            job_dir = Path(tmp)
            server_module.translate_aligned_with_codex("j", job_dir, "t", "culture", cues, "en")
            srt = (job_dir / "culture.srt").read_text(encoding="utf-8")
        validate_srt(srt)
        self.assertEqual(srt.count("-->"), 5)
        self.assertEqual(srt.count("※ 역주: 주"), 3)
        self.assertIn("번역5", srt)


class YtDlpTests(unittest.TestCase):
    @patch("server.shutil.which", side_effect=lambda name: "C:/node.exe" if name == "node" else None)
    def test_node_runtime_is_used_when_deno_is_missing(self, which):
        self.assertIn("--js-runtimes", server_module.yt_dlp_base_args())

    @patch("server.time.sleep")
    def test_transient_403_is_retried(self, sleep):
        calls = []

        def flaky(args, cwd, stdin=None, timeout=0):
            calls.append(args)
            if len(calls) == 1:
                raise RuntimeError("ERROR: unable to download video data: HTTP Error 403: Forbidden")
            return "ok"

        with tempfile.TemporaryDirectory() as tmp, patch.object(server_module, "run_process", side_effect=flaky):
            self.assertEqual(server_module.run_yt_dlp(["url"], Path(tmp), timeout=10), "ok")
        self.assertEqual(len(calls), 2)

    def test_permanent_error_is_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            server_module, "run_process", side_effect=RuntimeError("ERROR: Video unavailable")
        ) as run:
            with self.assertRaises(RuntimeError):
                server_module.run_yt_dlp(["url"], Path(tmp), timeout=10)
        self.assertEqual(run.call_count, 1)


class PairingTrustTests(unittest.TestCase):
    def test_loopback_is_always_trusted(self):
        self.assertTrue(server_module.is_trusted_pairing_client("127.0.0.1", trust_tailscale=False))
        self.assertTrue(server_module.is_trusted_pairing_client("::1", trust_tailscale=False))

    def test_tailscale_requires_opt_in(self):
        self.assertFalse(server_module.is_trusted_pairing_client("100.101.102.103", trust_tailscale=False))
        self.assertTrue(server_module.is_trusted_pairing_client("100.101.102.103", trust_tailscale=True))

    def test_env_var_enables_tailscale(self):
        with patch.dict(server_module.os.environ, {"CULTURE_TRUST_TAILSCALE": "1"}):
            self.assertTrue(server_module.is_trusted_pairing_client("100.101.102.103"))
        with patch.dict(server_module.os.environ, {"CULTURE_TRUST_TAILSCALE": ""}):
            self.assertFalse(server_module.is_trusted_pairing_client("100.101.102.103"))

    def test_ordinary_lan_is_never_auto_paired(self):
        self.assertFalse(server_module.is_trusted_pairing_client("192.168.0.10", trust_tailscale=True))


class ReusableTranscriptTests(unittest.TestCase):
    def test_retry_reuses_transcript_when_translation_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp)
            (job_dir / "aligned_source.json").write_text(
                '[{"id": 1, "start": 0, "end": 1, "text": "hi"}]', encoding="utf-8"
            )
            job = {"status": "queued", "detected_language": "ja", "requested_language": "auto"}
            cues, language = server_module.load_reusable_transcript(job, job_dir)
        self.assertEqual(len(cues), 1)
        self.assertEqual(language, "ja")

    def test_completed_output_forces_full_rerun(self):
        with tempfile.TemporaryDirectory() as tmp:
            job_dir = Path(tmp)
            (job_dir / "aligned_source.json").write_text(
                '[{"id": 1, "start": 0, "end": 1, "text": "hi"}]', encoding="utf-8"
            )
            (job_dir / "culture.srt").write_text("x", encoding="utf-8")
            self.assertIsNone(server_module.load_reusable_transcript({"status": "queued"}, job_dir))


if __name__ == "__main__":
    unittest.main()
