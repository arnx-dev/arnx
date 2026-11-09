package pfs

import "testing"

func TestPass(t *testing.T) {
	t.Log("a log line")
	if One() != 1 {
		t.Fatal("no")
	}
}
func TestFail(t *testing.T) { t.Errorf("boom %d", 1) }
func TestSkip(t *testing.T) { t.Skip("not today") }
