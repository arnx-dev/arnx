package gopanic

import (
	"testing"
	"time"
)

func TestBefore(t *testing.T) {}

func TestGoroutinePanic(t *testing.T) {
	go func() { panic("kaboom in goroutine") }()
	time.Sleep(5 * time.Second)
}

func TestAfterNeverRuns(t *testing.T) {}
