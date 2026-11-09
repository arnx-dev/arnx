package timeout

import (
	"testing"
	"time"
)

func TestQuick(t *testing.T)          {}
func TestHang(t *testing.T)           { time.Sleep(30 * time.Second) }
func TestAfterNeverRuns(t *testing.T) {}
