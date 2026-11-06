import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

script = Path(__file__).resolve().parents[1] / "scripts" / "collect.py"
spec = importlib.util.spec_from_file_location("collector", script)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorRegressionTests(unittest.TestCase):
    def test_failed_history_preserves_previous_data(self):
        previous = {"daily": [["2026-11-05", 100, 4]], "fiveMinute": [["2026-11-05 09:35", 100, 4]]}
        with patch.object(collector, "request", side_effect=ConnectionError):
            _, history = collector.history_for(collector.POOL[0], previous, None)
        self.assertEqual(history["daily"], previous["daily"])
        self.assertEqual(history["fiveMinute"], previous["fiveMinute"])

    def test_empty_history_uses_current_tencent_minutes(self):
        previous = {"daily": [["2026-11-05", 100, 4]], "fiveMinute": [["2026-11-05 09:35", 100, 4]]}
        current = [["2026-11-06 09:35", 200, 4.1]]
        with patch.object(collector, "request", return_value='{"data":{"klines":[]}}'):
            with patch.object(collector, "minute_bars", return_value=("2026-11-06", current)):
                _, history = collector.history_for(collector.POOL[0], previous, None)
        self.assertEqual(history["fiveMinute"], previous["fiveMinute"] + current)
        self.assertEqual(history["daily"], previous["daily"])

    def test_incomplete_snapshot_cannot_replace_valid_history(self):
        self.assertFalse(collector.usable_history({"history": {}}))


if __name__ == "__main__":
    unittest.main()
