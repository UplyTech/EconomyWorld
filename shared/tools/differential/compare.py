#!/usr/bin/env python3
"""Decide whether the two editions agree, and say where they do not.

    python compare.py --cases cases.json \
        --typescript results-typescript.json --python results-python.json

**This runs in Python for a reason.** Python parses a JSON integer exactly at
any size; ``JSON.parse`` in Node does not. A comparison that silently rounded
both sides before comparing them would report agreement about precisely the
thing this harness exists to disagree about.

The output names the exact field, prints Python's answer first -- its integers
are exact, so its answer is the definition of correct wherever the two differ by
rounding -- and prints the case in a form that can be pasted straight into
``shared/testcases/``.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


def walk(path: str, left: Any, right: Any, out: list[tuple[str, Any, Any]]) -> None:
    """Collect every leaf where the two answers differ, with its path."""
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(set(left) | set(right)):
            walk(f"{path}.{key}", left.get(key, "<missing>"), right.get(key, "<missing>"), out)
        return
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            out.append((f"{path}[len]", len(left), len(right)))
            return
        for index, (a, b) in enumerate(zip(left, right)):
            walk(f"{path}[{index}]", a, b, out)
        return
    if left != right:
        out.append((path, left, right))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    here = Path(__file__).parent
    parser.add_argument("--cases", default=str(here / "cases.json"))
    parser.add_argument("--typescript", default=str(here / "results-typescript.json"))
    parser.add_argument("--python", default=str(here / "results-python.json"))
    parser.add_argument(
        "--show", type=int, default=3, help="how many disagreements to print in full"
    )
    args = parser.parse_args()

    cases = {
        item["id"]: item
        for item in json.loads(Path(args.cases).read_text("utf-8"))["cases"]
    }
    typescript = json.loads(Path(args.typescript).read_text("utf-8"))
    python = json.loads(Path(args.python).read_text("utf-8"))

    if typescript["seed"] != python["seed"]:
        print("::error::the two runs used different seeds", file=sys.stderr)
        return 2

    ts_by_id = {item["id"]: item for item in typescript["results"]}
    py_by_id = {item["id"]: item for item in python["results"]}

    disagreements: list[tuple[str, str, list[tuple[str, Any, Any]]]] = []
    for case_id in sorted(ts_by_id.keys() | py_by_id.keys()):
        ts = ts_by_id.get(case_id, {})
        py = py_by_id.get(case_id, {})
        differences: list[tuple[str, Any, Any]] = []
        walk("", py.get("value", py.get("error", "<missing>")),
             ts.get("value", ts.get("error", "<missing>")), differences)
        if differences:
            disagreements.append((case_id, ts.get("kind", py.get("kind", "?")), differences))

    total = len(ts_by_id)
    if not disagreements:
        print(f"ok - both editions agree on all {total} cases (seed {typescript['seed']})")
        return 0

    print(
        f"::error::the editions disagree on {len(disagreements)} of {total} cases",
        file=sys.stderr,
    )
    print()

    for case_id, kind, differences in disagreements[: args.show]:
        print(f"--- {case_id}  ({kind}) " + "-" * 40)
        for path, py_value, ts_value in differences[:12]:
            print(f"  {path or '<root>'}")
            print(f"      python     {py_value!r}")
            print(f"      typescript {ts_value!r}")
        if len(differences) > 12:
            print(f"  ... and {len(differences) - 12} more fields")
        print()
        print("  the case, for shared/testcases/:")
        print("  " + json.dumps(cases[case_id], indent=2).replace("\n", "\n  "))
        print()

    print("by kind:")
    for kind, count in Counter(kind for _, kind, _ in disagreements).most_common():
        print(f"  {count:>6}  {kind}")
    print()
    print(f"reproduce with: node generate.mjs --seed {typescript['seed']} --cases {total}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
