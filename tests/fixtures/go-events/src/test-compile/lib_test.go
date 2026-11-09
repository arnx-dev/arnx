package testcompile

import "testing"

func TestWouldPass(t *testing.T) {}
func TestBroken(t *testing.T)    { undefinedThing() }
