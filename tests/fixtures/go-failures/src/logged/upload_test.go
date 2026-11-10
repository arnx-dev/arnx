package logged

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestUpload(t *testing.T) {
	srv := newServer(t)
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/upload", "text/plain", strings.NewReader("hello"))
	if err == nil {
		resp.Body.Close()
	}
	_, err = os.Open("testdata/picture.png")
	assertError(t, err)
}
