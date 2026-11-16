package dup

import "testing"

func helper() int { return 2 }
func TestB(t *testing.T) { _ = helper() }
