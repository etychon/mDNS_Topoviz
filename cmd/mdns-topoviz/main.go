package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mdns-topoviz/internal/api"
	"mdns-topoviz/internal/config"
	"mdns-topoviz/internal/discovery"
	"mdns-topoviz/internal/listener"
	"mdns-topoviz/internal/model"
)

func main() {
	cfg := config.Parse()
	reg := model.NewRegistry()
	ring := model.NewRing(cfg.EventCap)
	hub := api.NewHub()
	eng := discovery.NewEngine(reg, ring, hub.Publish, cfg.StaleRatio, cfg.NewPulseWindow)

	stop := make(chan struct{})
	defer close(stop)

	shutdown, err := listener.Start(cfg.Interfaces, func(iface string, src net.Addr, payload []byte) {
		eng.HandleDNS(iface, src.String(), payload)
	})
	if err != nil {
		log.Fatalf("listener: %v", err)
	}
	defer shutdown()

	go discovery.NewQuerier(eng, cfg.QueryInterval).Run(stop)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.NewServer(cfg, reg, ring, eng, hub).Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("http listening on %s (read-only observer + DNS-SD queries)", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
