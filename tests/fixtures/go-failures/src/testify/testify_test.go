package testify

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func value() string {
	if os.Getenv("FAIL_VARIANT") != "" {
		return "gamma"
	}
	return "beta"
}

func TestReadsOutput(t *testing.T) {
	_, err := os.ReadFile("testdata/missing.txt")
	require.NoError(t, err, "reading %s", "the output")
}

func TestEqualValue(t *testing.T) {
	t.Log("comparing the value")
	assert.Equal(t, "alpha", value())
}
