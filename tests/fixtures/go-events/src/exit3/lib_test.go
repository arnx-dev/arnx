package exit3

import (
	"os"
	"testing"
)

func TestBefore(t *testing.T)         {}
func TestCrash(t *testing.T)          { os.Exit(3) }
func TestAfterNeverRuns(t *testing.T) {}
