package plain

import "testing"

func TestIsLocal(t *testing.T) {
	if got := false; !got {
		t.Errorf("expected true, received false")
	}
}

func TestDecode(t *testing.T) {
	t.Log("decoding the document")
	t.Fatal("bad json")
}
