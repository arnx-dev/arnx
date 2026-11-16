package panicpkg

import "testing"

func TestBefore(t *testing.T)         {}
func TestPanics(t *testing.T)         { panic("kaboom") }
func TestAfterNeverRuns(t *testing.T) {}
