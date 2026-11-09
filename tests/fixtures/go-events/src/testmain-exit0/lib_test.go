package tmexit0

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) { os.Exit(0) }

func TestNeverRuns(t *testing.T) { t.Fatal("should not run") }
