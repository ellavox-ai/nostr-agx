VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
PLATFORMS := darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64

.PHONY: build build-all stage test fmt vet clean

build:
	go build -trimpath -buildvcs=false -ldflags "$(LDFLAGS)" -o bin/agx-tailscale .

build-all:
	@for platform in $(PLATFORMS); do \
		os=$${platform%-*}; arch=$${platform#*-}; \
		case $$arch in x64) arch=amd64;; esac; \
		case $$os in win32) os=windows;; esac; \
		ext=; [ $$os = windows ] && ext=.exe; \
		echo "building dist/$$platform/agx-tailscale$$ext"; \
		mkdir -p dist/$$platform; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -buildvcs=false \
			-ldflags "$(LDFLAGS)" -o dist/$$platform/agx-tailscale$$ext . || exit 1; \
	done

stage: build-all
	node ../scripts/stage-binaries.mjs

test:
	go test ./...

fmt:
	gofmt -w main.go main_test.go

vet:
	go vet ./...

clean:
	rm -rf bin dist
