"""Regression: macOS ships Python 3.9 as `python3`. FastAPI/Pydantic evaluate
annotations at runtime, so `X | None` (PEP 604, Python 3.10+) crashed the bridge
on import there. Keep runtime modules free of `|` in annotations."""
import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _union_annotations(path: pathlib.Path):
    tree = ast.parse(path.read_text())
    bad = []
    for node in ast.walk(tree):
        anns = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            anns += [a.annotation for a in node.args.args + node.args.kwonlyargs if a.annotation]
            if node.returns:
                anns.append(node.returns)
        if isinstance(node, ast.AnnAssign):
            anns.append(node.annotation)
        for a in anns:
            if any(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr) for n in ast.walk(a)):
                bad.append(f"{path.name}:{a.lineno}")
    return bad


def test_no_pep604_unions_in_runtime_modules():
    bad = _union_annotations(ROOT / "bridge.py") + _union_annotations(ROOT / "stdb_adapter.py")
    assert bad == [], f"Use typing.Optional/Union for Python 3.9 (macOS): {bad}"
