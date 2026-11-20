// Command agx-tailscale joins a Tailscale tailnet with tsnet and serves a
// loopback-only SOCKS5 proxy. The @nostr-agx/tailscale package
// bundles this launcher, starts it as a child process, and reads the proxy URL
// from stdout.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/socks5"
	"tailscale.com/tsnet"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "agx-tailscale:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		listen      = flag.String("listen", "127.0.0.1:0", "SOCKS5 listen address (loopback only)")
		stateDir    = flag.String("state-dir", "", "tsnet state directory (default ~/.nostr-agx/tailscale)")
		hostname    = flag.String("hostname", "agx-tailscale", "Tailscale hostname")
		authKey     = flag.String("auth-key", "", "Tailscale auth key (or TS_AUTHKEY)")
		controlURL  = flag.String("control-url", "", "coordination server URL (or TS_CONTROL_URL)")
		tags        = flag.String("tags", "", "comma-separated ACL tags, such as tag:agx")
		ephemeral   = flag.Bool("ephemeral", false, "register an ephemeral node")
		connectWait = flag.Duration("connect-timeout", 2*time.Minute, "how long to wait for the tailnet")
		exitOnEOF   = flag.Bool("exit-on-stdin-eof", false, "exit when stdin closes")
		showVersion = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return nil
	}

	dir, err := stateDirectory(*stateDir)
	if err != nil {
		return err
	}
	key := firstNonEmpty(*authKey, os.Getenv("TS_AUTHKEY"), os.Getenv("AGX_TAILSCALE_AUTH_KEY"))
	if key == "" && !fileExists(filepath.Join(dir, "tailscaled.state")) {
		return errors.New("no auth key and no existing state; pass --auth-key or set TS_AUTHKEY")
	}
	if err := requireLoopback(*listen); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *exitOnEOF {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	srv := &tsnet.Server{
		Dir:           dir,
		Hostname:      *hostname,
		AuthKey:       key,
		Ephemeral:     *ephemeral,
		AdvertiseTags: splitTags(*tags),
		ControlURL:    *controlURL,
	}
	defer srv.Close()

	upCtx, cancel := context.WithTimeout(ctx, *connectWait)
	defer cancel()
	status, err := srv.Up(upCtx)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return fmt.Errorf("join tailnet: %w", err)
	}
	visibleNames := make(map[string]bool)
	if status != nil {
		if status.Self != nil {
			log.Printf("joined tailnet as %s (%v)", status.Self.DNSName, status.TailscaleIPs)
		}
		names := tailnetNames(status)
		for _, name := range names {
			visibleNames[canonicalName(name)] = true
		}
		if len(names) > 50 {
			log.Printf("visible tailnet names (%d, first 50): %v", len(names), names[:50])
		} else {
			log.Printf("visible tailnet names: %v", names)
		}
	}
	srv.AuthKey = ""

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", *listen, err)
	}
	defer ln.Close()
	// The proxy accepts connections only from loopback, but any local process
	// could otherwise use this node's tailnet identity. Require per-run random
	// credentials, delivered only on stdout to the parent that started us.
	username, err := randomCredential()
	if err != nil {
		return err
	}
	password, err := randomCredential()
	if err != nil {
		return err
	}
	fmt.Println(socksProxyURL(ln.Addr().String(), username, password))

	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err == nil && net.ParseIP(host) == nil && strings.HasSuffix(canonicalName(host), ".ts.net") &&
			!visibleNames[canonicalName(host)] {
			log.Printf("socks5: %s is not visible to this node; check tailnet ACLs/grants", host)
		}
		return srv.Dial(ctx, network, address)
	}

	proxy := &socks5.Server{
		Dialer:   dial,
		Username: username,
		Password: password,
		Logf: func(format string, args ...any) {
			log.Printf("socks5: "+format, args...)
		},
	}
	done := make(chan error, 1)
	go func() { done <- proxy.Serve(ln) }()

	select {
	case <-ctx.Done():
		return nil
	case err := <-done:
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		return fmt.Errorf("socks5 server: %w", err)
	}
}

func stateDirectory(flagValue string) (string, error) {
	dir := flagValue
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("find home directory: %w", err)
		}
		dir = filepath.Join(home, ".nostr-agx", "tailscale")
	} else if dir == "~" || strings.HasPrefix(dir, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("find home directory: %w", err)
		}
		dir = filepath.Join(home, strings.TrimPrefix(dir, "~/"))
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create state directory: %w", err)
	}
	return dir, nil
}

func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("--listen: %w", err)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("--listen must use a loopback host, got %q", host)
	}
	return nil
}

func canonicalName(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, "."))
}

func tailnetNames(status *ipnstate.Status) []string {
	names := make([]string, 0, len(status.Peer)+len(status.ExtraRecords)+1)
	if status.Self != nil && status.Self.DNSName != "" {
		names = append(names, status.Self.DNSName)
	}
	for _, peer := range status.Peer {
		if peer != nil && peer.DNSName != "" {
			names = append(names, peer.DNSName)
		}
	}
	for _, record := range status.ExtraRecords {
		if record.Name != "" {
			names = append(names, record.Name)
		}
	}
	sort.Strings(names)
	return names
}

func splitTags(value string) []string {
	var tags []string
	for _, tag := range strings.Split(value, ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			tags = append(tags, tag)
		}
	}
	return tags
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// randomCredential returns a URL-safe 24-character value (18 random bytes),
// comfortably below the SOCKS5 username/password field's 255-byte limit.
func randomCredential() (string, error) {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate SOCKS5 credential: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func socksProxyURL(addr, username, password string) string {
	return (&url.URL{
		Scheme: "socks5",
		User:   url.UserPassword(username, password),
		Host:   addr,
	}).String()
}
