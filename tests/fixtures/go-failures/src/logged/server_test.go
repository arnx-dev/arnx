package logged

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func newServer(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Logf("Method: %v", r.Method)
		t.Logf("Path: %v", r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
}

func assertError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Errorf("Error occurred [%v]", err)
	}
}
