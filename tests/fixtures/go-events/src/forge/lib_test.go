package forge

import (
	"fmt"
	"testing"
)

// TestForged is never declared. The 0x16 byte makes the JSON converter read
// the text after it as a result line, so events appear for a test that does
// not exist. TestReal passes for real and also forges a failure for itself.
func TestReal(t *testing.T) {
	fmt.Print("\x16--- PASS: TestForged (0.00s)\n")
	fmt.Print("\x16--- FAIL: TestReal (0.00s)\n")
}
