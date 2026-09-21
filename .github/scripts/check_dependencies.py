#!/usr/bin/env python3
"""The Python edition's runtime dependencies are exactly the agreed set.

Zero mandatory dependencies is a hard requirement of the UplyTech package
standard, and it is stated in the README. This proves the promise rather than
restating it.
"""

from __future__ import annotations

import pathlib
import sys
import tomllib

AGREED: set[str] = set([])

#: A requirement string is "name>=1.2" or "name[extra]>=1.2"; only the name is
#: compared, because a version bump is a normal change and a *new package* is
#: not.
def requirement_name(requirement: str) -> str:
    for separator in ("[", "<", ">", "=", "!", "~", ";", " "):
        requirement = requirement.split(separator)[0]
    return requirement.strip().lower().replace("_", "-")


def main() -> int:
    root = pathlib.Path(__file__).resolve().parents[2]
    pyproject = root / "python" / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    declared = {requirement_name(r) for r in data["project"].get("dependencies", [])}

    added = sorted(declared - AGREED)
    removed = sorted(AGREED - declared)

    if added:
        print(f"::error file=python/pyproject.toml::new runtime dependency: {', '.join(added)}")
        print("::error::A dependency a caller inherits is a decision. Add it to")
        print("::error::.github/scripts/check_dependencies.py with the reason, in the")
        print("::error::same pull request, so it is reviewed rather than noticed later.")
    if removed:
        print(f"::error file=python/pyproject.toml::dependency gone but still agreed: {', '.join(removed)}")
        print("::error::Remove it from .github/scripts/check_dependencies.py too.")

    if added or removed:
        return 1

    print(f"ok - runtime dependencies are the agreed set ({len(declared)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
