import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import translation_context as context


def guide():
    return {'story': '두 사람이 카페에서 만나 화해한다.', 'characters': [],
            'terms': [{'source': 'Blue Room', 'korean': '블루 룸', 'usage': '상호명'}],
            'cultural_context': [], 'uncertainties': ['화자 정보 없음'],
            'review_rules': ['블루 룸 표기 통일, 확인되지 않은 관계의 반말은 추측 금지']}


def cues():
    return [{'id': 11, 'start': 1.123, 'end': 2.456, 'text': 'Meet me at Blue Room.'},
            {'id': 12, 'start': 4.789, 'end': 5.91, 'text': 'See you there.'}]


class ContextTests(unittest.TestCase):
    def test_split_covers_every_row_including_last_without_truncation(self):
        rows = [{'id': i, 'text': '대사' * 40} for i in range(30)]
        batches = context.split_rows(rows, 500)
        self.assertEqual([r for batch in batches for r in batch], rows)
        self.assertTrue(all(len(context.packed(batch)) <= 500 for batch in batches))

    def test_oversized_single_cue_fails_instead_of_truncating(self):
        with self.assertRaises(ValueError):
            context.split_rows([{'id': 1, 'text': 'x' * 500}], 100)

    def test_context_scans_all_then_merges(self):
        rows = [{'id': i, 'text': 'x' * 200} for i in range(30)]
        stages, prompts = [], []
        def call(stage, prompt, schema, validator):
            stages.append(stage)
            prompts.append(prompt)
            return validator(guide())
        with patch.object(context, 'INPUT_BUDGET', 1600):
            result = context.global_guide(rows, '제목', 'pl', call, lambda *a: None)
        self.assertTrue(any('.merge' in stage for stage in stages))
        self.assertIn('"id":29', '\n'.join(prompts))
        self.assertEqual(result['terms'][0]['korean'], '블루 룸')

    def test_unknown_character_evidence_is_rejected(self):
        value = guide()
        value['characters'] = [{'name': 'A', 'relationships': '동료', 'speech_style': '존댓말', 'evidence_ids': [999]}]
        with self.assertRaises(ValueError):
            context.validate_guide(value, {11, 12})

    def test_conflicting_glossary_is_rejected(self):
        value = guide()
        value['terms'].append({'source': 'Blue Room', 'korean': '파란 방', 'usage': '상호명'})
        with self.assertRaises(ValueError):
            context.validate_guide(value, {11, 12})

    def test_translation_prompt_has_global_guide_and_both_boundaries(self):
        prompt = server.build_translation_prompt('title', 'culture', 'pt', cues(),
            [{'id': 10, 'text': '앞 문맥'}], 1, 2, 10, guide(), [{'id': 13, 'text': '뒤 문맥'}])
        for text in ('앞 문맥', '뒤 문맥', '블루 룸', '화자가 확인되지', '스포일러'):
            # Prompt explicitly forbids leaking a later reveal even without the literal word.
            self.assertIn(text if text != '스포일러' else '후반의 반전', prompt)

    def test_review_preserves_untouched_cues_and_deduplicates_notes(self):
        original = cues()
        before = copy.deepcopy(original)
        stages = []
        def call(stage, prompt, schema, validator):
            stages.append(stage)
            if stage.startswith('review.apply'):
                return validator({'changes': [{'id': 11, 'text': '블루 룸에서 만나요.', 'reason': '상호 통일'}],
                                  'notes': [{'cue_id': 11, 'text': '문화 설명'}, {'cue_id': 12, 'text': '문화 설명'}]})
            self.assertIn('파란 방', prompt)
            return validator(guide())
        texts, notes, _ = context.review_all(original, {11: '파란 방에서 만나요.', 12: '거기서 봐요.'}, [],
            guide(), 'title', 'en', 'culture', 10, call, lambda *a: None, server.TRANSLATION_REFUSAL_RE)
        self.assertEqual(original, before)
        self.assertEqual(texts, {11: '블루 룸에서 만나요.', 12: '거기서 봐요.'})
        self.assertEqual(len(notes), 1)
        self.assertTrue(stages[0].startswith('review.scan'))
        self.assertTrue(stages[-1].startswith('review.apply'))

    def test_review_rejects_unknown_duplicate_blank_and_timing_changes(self):
        good = {'id': 11, 'text': '번역', 'reason': '통일'}
        bad_changes = [[{**good, 'id': 999}], [good, good], [{**good, 'text': ''}],
                       [{**good, 'start': 0}], [{**good, 'text': '00:00 --> 00:01'}]]
        for changes in bad_changes:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                context.parse_review({'changes': changes, 'notes': []}, {11, 12}, server.TRANSLATION_REFUSAL_RE)

    def test_long_review_uses_one_global_plan_and_covers_every_cue(self):
        source = [{'id': i, 'start': i, 'end': i + .5, 'text': 'source ' * 25} for i in range(1, 25)]
        applied = []
        scans = []
        def call(stage, prompt, schema, validator):
            if stage.startswith('review.apply'):
                batch = json.loads(prompt.split('검수 대상:\n')[-1])
                applied.extend(row['id'] for row in batch)
                self.assertIn('전체 번역 검수 지침', prompt)
                return validator({'changes': [], 'notes': []})
            if stage.startswith('review.scan'):
                batch = json.loads(prompt.split('자료:\n')[-1])
                scans.extend(row['id'] for row in batch)
            return validator(guide())
        with patch.object(context, 'INPUT_BUDGET', 1800):
            texts, _, _ = context.review_all(source, {cue['id']: '번역' * 40 for cue in source}, [],
                guide(), 't', 'fa', 'curator', 16, call, lambda *a: None, server.TRANSLATION_REFUSAL_RE)
        self.assertEqual(scans, list(range(1, 25)))
        self.assertEqual(applied, list(range(1, 25)))
        self.assertEqual(set(texts), set(range(1, 25)))


class PipelineTests(unittest.TestCase):
    def fake_ai(self, prompt, schema, **kwargs):
        self.assertEqual(kwargs['backend'], 'codex')
        self.calls.append(prompt)
        if 'changes' in schema['properties']:
            return {'changes': [{'id': 11, 'text': '블루 룸에서 만나요.', 'reason': '상호 통일'}], 'notes': []}
        if 'translations' in schema['properties']:
            self.assertIn('블루 룸', prompt)
            return {'translations': [{'id': 11, 'text': '파란 방에서 만나요.'}, {'id': 12, 'text': '거기서 봐요.'}], 'notes': []}
        return guide()

    def test_end_to_end_stages_fixed_timestamps_and_artifacts(self):
        self.calls = []
        source = cues()
        before = copy.deepcopy(source)
        with tempfile.TemporaryDirectory() as temp, patch.object(server.agent_cli, 'resolve_backend', return_value='codex'), \
                patch.object(server.agent_cli, 'run_json', side_effect=self.fake_ai), patch.object(server, 'update_job') as progress:
            root = Path(temp)
            server.translate_aligned_with_codex('test', root, 'Synthetic cafe', 'culture', source, 'en')
            srt = (root / 'culture.srt').read_text(encoding='utf-8')
            self.assertIn('블루 룸에서 만나요.', srt)
            self.assertIn('00:00:01,123 --> 00:00:02,456', srt)
            self.assertIn('00:00:04,789 --> 00:00:05,910', srt)
            self.assertEqual(srt.count('-->'), 2)
            for filename in ('context-guide.json', 'translation-draft.json', 'review-guide.json', 'review.apply001.json'):
                self.assertTrue((root / filename).is_file())
            report = json.loads((root / 'pipeline-report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['pipeline'], 'context-translate-review-v1')
            self.assertTrue(report['timing_preserved'])
            self.assertEqual(report['reviewed_cues'], len(source))
            self.assertEqual(report['changed_translations'], 1)
            self.assertEqual(report['final_note_count'], 0)
            values = [item.kwargs['progress'] for item in progress.call_args_list]
            self.assertEqual(values, sorted(values))
        self.assertEqual(source, before)
        self.assertEqual(len(self.calls), 4)
        self.assertIn('번역 전 전체 맥락 분석', self.calls[0])
        self.assertIn('번역 후 전체 일관성 검수', self.calls[2])

    def test_invalid_source_timing_fails_before_ai(self):
        source = cues()
        source[1]['start'] = 1.5
        with tempfile.TemporaryDirectory() as temp, patch.object(server.agent_cli, 'run_json') as ai:
            with self.assertRaises(ValueError):
                server.translate_aligned_with_codex('test', Path(temp), 't', 'culture', source, 'en')
            ai.assert_not_called()

    def test_review_failure_never_replaces_existing_srt(self):
        self.calls = []
        original_ai = self.fake_ai
        def invalid_review(prompt, schema, **kwargs):
            if 'changes' in schema['properties']:
                return {'changes': [{'id': 999, 'text': 'bad', 'reason': 'bad'}], 'notes': []}
            return original_ai(prompt, schema, **kwargs)
        with tempfile.TemporaryDirectory() as temp, patch.object(server.agent_cli, 'resolve_backend', return_value='codex'), \
                patch.object(server.agent_cli, 'run_json', side_effect=invalid_review), patch.object(server, 'update_job'), \
                patch.object(server.time, 'sleep'):
            root = Path(temp)
            (root / 'culture.srt').write_text('existing subtitle', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'review.apply'):
                server.translate_aligned_with_codex('test', root, 't', 'culture', cues(), 'en')
            self.assertEqual((root / 'culture.srt').read_text(encoding='utf-8'), 'existing subtitle')


if __name__ == '__main__':
    unittest.main()
