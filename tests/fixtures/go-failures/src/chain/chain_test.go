package chain

import (
	"os"
	"testing"

	"example.com/failures/internal/check"
)

func listing() string {
	if os.Getenv("FAIL_VARIANT") != "" {
		return `["docs/","src/"]`
	}
	return `["docs/"]`
}

func TestListing(t *testing.T) {
	check.Equal(t, `["docs/","lib/"]`, listing())
}
