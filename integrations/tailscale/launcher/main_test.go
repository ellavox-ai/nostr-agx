package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRequireLoopback(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:0", "127.0.0.1:1080", "[::1]:0", "localhost:0"} {
		if err := requireLoopback(addr); err != nil {
			t.Errorf("requireLoopback(%q) = %v", addr, err)
		}
	}
	for _, addr := range []string{"0.0.0.0:1080", "[::]:1080", "192.0.2.1:1080", "example.com:1080", "nope"} {
		if err := requireLoopback(addr); err == nil {
			t.Errorf("requireLoopback(%q) accepted a non-loopback address", addr)
		}
	}
}

func TestSplitTags(t *testing.T) {
	got := splitTags(" tag:agx, ,tag:relay ")
	want := []string{"tag:agx", "tag:relay"}
	if len(got) != len(want) {
		t.Fatalf("splitTags = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("splitTags = %v, want %v", got, want)
		}
	}
}

func TestSocksProxyURL(t *testing.T) {
	got := socksProxyURL("127.0.0.1:43210", "user-1", "p@ss/word")
	want := "socks5://user-1:p%40ss%2Fword@127.0.0.1:43210"
	if got != want {
		t.Fatalf("socksProxyURL = %q, want %q", got, want)
	}
}

func TestRandomCredential(t *testing.T) {
	first, err := randomCredential()
	if err != nil {
		t.Fatal(err)
	}
	second, err := randomCredential()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 24 || len(second) != 24 {
		t.Fatalf("credential lengths = %d, %d; want 24", len(first), len(second))
	}
	if first == second {
		t.Fatal("two generated credentials are equal")
	}
}

func TestStateDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	got, err := stateDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != dir {
		t.Fatalf("stateDirectory = %q, want %q", got, dir)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("state directory mode = %v", fi.Mode().Perm())
	}
}
