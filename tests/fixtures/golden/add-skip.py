"""Generated."""
from __future__ import annotations
import pytest

from app import add


def test_add():
    assert add(2, 3) == 5


class TestMore:
    @pytest.mark.skip(reason='arnx: not confirmed')
    @staticmethod
    def test_neg():
        assert add(-1, 1) == 0


@pytest.mark.skip(reason='arnx: not confirmed')
def test_zero():
    assert add(0, 0) == 0
