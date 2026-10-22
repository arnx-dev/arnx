"""Generated."""
from __future__ import annotations

from app import add


def test_add():
    assert add(2, 3) == 5


class TestMore:
    @staticmethod
    def test_neg():
        assert add(-1, 1) == 0


def test_zero():
    assert add(0, 0) == 0
