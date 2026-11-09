package dup

import "testing"

func helper() int { return 1 }
func TestA(t *testing.T) { _ = helper() }
