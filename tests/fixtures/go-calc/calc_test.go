package calc

import "testing"

func TestAddsZero(t *testing.T) {
	if Add(2, 0) != 2 {
		t.Fatal("Add(2, 0)")
	}
}
