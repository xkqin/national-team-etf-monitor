import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("activity_collector", scripts / "collect_activity.py")
activity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activity)
sys.path.pop(0)


class ActivityCollectorTests(unittest.TestCase):
    def test_tencent_failure_uses_genuine_eastmoney_minutes(self):
        with patch.object(activity, "request", side_effect=[ConnectionError(), '{"data":{"trends":["2026-11-17 09:31,4,4,1,100"]}}']) as request:
            symbol, result = activity.fetch_fund(activity.POOL[0])
        self.assertEqual(symbol, activity.POOL[0]["symbol"])
        self.assertEqual(result["format"], "eastmoney")
        self.assertIn("ndays=5", request.call_args.args[0])

    def test_total_failure_stays_unknown(self):
        with patch.object(activity, "request", side_effect=ConnectionError):
            _, result = activity.fetch_fund(activity.POOL[0])
        self.assertIn("error", result)
        self.assertNotIn("payload", result)


if __name__ == "__main__":
    unittest.main()
