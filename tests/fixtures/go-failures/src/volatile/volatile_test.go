package volatile

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSlowHandler(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	dir := t.TempDir()
	h := &struct{ n [64]byte }{}
	start := time.Now()
	time.Sleep(time.Millisecond)
	t.Errorf("request to %s for %s failed: handler %p after %v", srv.URL, dir, h, time.Since(start))
}
