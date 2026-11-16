package subtests

import "testing"

func TestTop(t *testing.T) {
	t.Run("a/b", func(t *testing.T) {})
	t.Run("with space", func(t *testing.T) {})
	t.Run("plain", func(t *testing.T) {
		t.Run("inner", func(t *testing.T) {})
	})
	t.Run("plain", func(t *testing.T) {})
	t.Run("bad one", func(t *testing.T) { t.Fatal("nope") })
	t.Run("q\"uote\t$^(x)", func(t *testing.T) {})
}
