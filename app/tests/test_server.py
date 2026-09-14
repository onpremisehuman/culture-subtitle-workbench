import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import (  # noqa: E402
    extract_video_id,
    normalize_language,
    normalize_language_hint,
    parse_byte_range,
    safe_local_filename,
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

    def test_unknown_language_is_rejected(self):
        with self.assertRaises(ValueError):
            normalize_language("xx")

    def test_media_language_hint_is_reduced_to_supported_code(self):
        self.assertEqual(normalize_language_hint("pt-BR"), "pt")
        self.assertEqual(normalize_language_hint("por"), "pt")
        self.assertEqual(normalize_language_hint("zh-Hans"), "zh")
        self.assertEqual(normalize_language_hint("unknown"), "")


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


if __name__ == "__main__":
    unittest.main()
