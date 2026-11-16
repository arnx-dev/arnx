package table

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestTable(t *testing.T) {
	t.Log("running the table")
	t.Run("ok", func(t *testing.T) {
		t.Parallel()
		t.Log("fine")
	})
	t.Run("one", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, 1, 2)
	})
	t.Run("two", func(t *testing.T) {
		t.Parallel()
		t.Log("about to fail")
		t.Errorf("wrong count: %d", 3)
	})
}
