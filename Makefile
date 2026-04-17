.PHONY: web build run docker

web:
	cd web && npm install
	cd web && npm run build
	rm -rf internal/webui/assets/*
	cp -a web/dist/. internal/webui/assets/

build: web
	go build -trimpath -ldflags="-s -w" -o bin/mdns-topoviz ./cmd/mdns-topoviz

run: build
	./bin/mdns-topoviz

docker:
	docker build -t mdns-topoviz:local .
