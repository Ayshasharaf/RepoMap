"""Minimal smoke tests for hackathon submit confidence."""

from __future__ import annotations

import tempfile
import unittest

from diagram_ai import _EXCLUDED, _fill_flow_gaps
from scan import _unscored


class UnscoredTests(unittest.TestCase):
    def test_unscored_uses_incomplete_finding(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = _unscored(tmp, "abc123", "No Java files found")
        self.assertEqual(result["counts"]["risk"], "Unscored")
        self.assertEqual(result["counts"]["score"], 0)
        self.assertEqual(len(result["findings"]), 1)
        self.assertEqual(result["findings"][0]["kind"], "incomplete")
        self.assertIn("No Java", result["findings"][0]["detail"])


class FillFlowGapsTests(unittest.TestCase):
    def test_derives_data_flow_and_critical_paths(self):
        graph = {
            "nodes": [
                {"id": "a", "label": "API", "shape": "circle"},
                {"id": "b", "label": "Service", "shape": "box"},
                {"id": "c", "label": "Store", "shape": "database"},
            ],
            "edges": [
                {"from": "a", "to": "b", "label": "calls"},
                {"from": "b", "to": "c", "label": "writes"},
            ],
            "endpoints": [],
            "data_flow": [],
            "critical_paths": [],
        }
        filled = _fill_flow_gaps(graph)
        self.assertGreaterEqual(len(filled["data_flow"]), 1)
        self.assertEqual(filled["data_flow"][0]["from"], "a")
        self.assertEqual(filled["data_flow"][-1]["to"], "c")
        self.assertGreaterEqual(len(filled["critical_paths"]), 1)
        self.assertIn("API", filled["critical_paths"][0]["hops"])


class ExclusionTests(unittest.TestCase):
    def test_com_example_package_is_not_excluded(self):
        # Spring tutorials live under com/example/... — must stay in the AI index.
        self.assertIsNone(_EXCLUDED.search("src/main/java/com/example/demo/controllers/"))
        self.assertIsNotNone(_EXCLUDED.search("examples/demo/Thing.java"))
        self.assertIsNotNone(_EXCLUDED.search("src/test/java/Foo.java"))


if __name__ == "__main__":
    unittest.main()
