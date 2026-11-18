"""The release scripts must refuse paths outside the workspace."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / ".github" / "scripts"


def _load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), SCRIPTS / f"{name}.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(params=["release-manifest", "release-publish"])
def script(request: pytest.FixtureRequest) -> ModuleType:
    return _load(request.param)


def test_path_inside_workspace_is_resolved(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
    (tmp_path / "release").mkdir()
    resolved = script.resolve_within_workspace(str(tmp_path / "release"))
    assert resolved == (tmp_path / "release").resolve()


def test_path_outside_workspace_is_refused(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (tmp_path / "elsewhere").mkdir()
    monkeypatch.setenv("GITHUB_WORKSPACE", str(workspace))
    with pytest.raises(SystemExit):
        script.resolve_within_workspace(str(workspace / ".." / "elsewhere"))


def test_relative_traversal_is_refused(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GITHUB_WORKSPACE", "")
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit):
        script.resolve_within_workspace("..")


def test_manifest_writes_checksums(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = _load("release-manifest")
    release = tmp_path / "release"
    release.mkdir()
    (release / "a.whl").write_bytes(b"abc")
    monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
    env = {
        "GITHUB_REPOSITORY": "o/r",
        "GITHUB_RUN_ID": "1",
        "GITHUB_REF": "refs/tags/v1",
        "GITHUB_SHA": "0" * 40,
        "GITHUB_RUN_ATTEMPT": "1",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr("sys.argv", ["release-manifest.py", str(release)])
    assert manifest.main() == 0
    sums = (release / "SHA256SUMS").read_text(encoding="utf-8")
    assert sums.startswith(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.whl"
    )
