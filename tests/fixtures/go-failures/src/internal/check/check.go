// Package check compares values the way some projects' own helpers do: it reports the caller's caller by hand, so
// the failure's location is this file's and the message starts with the test's location.
package check

import (
	"fmt"
	"path/filepath"
	"runtime"
	"testing"
)

func Equal(t *testing.T, expected, actual string) {
	compare(t, expected, actual)
}

func compare(t *testing.T, expected, actual string) {
	if expected != actual {
		_, file, line, _ := runtime.Caller(2)
		t.Errorf("%v:%v:\n%v", filepath.Base(file), line, diff(expected, actual))
	}
}

func diff(expected, actual string) string {
	return fmt.Sprintf("--- expected\n+++ actual\n@@ -1 +1 @@\n\033[0;31m-%s\033[0m\n\033[0;32m+%s\033[0m", expected, actual)
}
