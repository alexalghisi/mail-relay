// Command relay-worker is the Go delivery worker. It drains the same
// Postgres queue as the TypeScript worker and can run next to it.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexalghisi/mail-relay/go/internal/queue"
	"github.com/alexalghisi/mail-relay/go/internal/worker"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil)).With("component", "go-worker")
	if err := run(log); err != nil {
		log.Error("exiting", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	concurrency := envInt("WORKER_CONCURRENCY", 32)
	leaseSeconds := envInt("LEASE_SECONDS", 60)

	cfg, err := pgxpool.ParseConfig(env("DATABASE_URL", "postgres://synckit:synckit@localhost:5432/mailrelay_dev"))
	if err != nil {
		return err
	}
	cfg.MaxConns = int32(min(concurrency/4+2, 16))
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	hostname, _ := os.Hostname()
	q := queue.New(pool, queue.Options{
		LeaseSeconds:             leaseSeconds,
		DefaultDomainConcurrency: envInt("DOMAIN_CONCURRENCY", 8),
		RetryBaseMs:              envInt("RETRY_BASE_MS", 30_000),
		RetryCapMs:               envInt("RETRY_CAP_MS", 3_600_000),
	})
	w := worker.New(worker.Config{
		ID:          fmt.Sprintf("go-%s-%d", hostname, os.Getpid()),
		Concurrency: concurrency,
		SMTPAddr:    env("SMTP_HOST", "127.0.0.1") + ":" + env("SMTP_PORT", "2525"),
		Helo:        env("SMTP_HELO", "mail-relay.local"),
		// Half the lease, so a send can't outlive the lease it runs under.
		SMTPTimeout: min(30*time.Second, time.Duration(leaseSeconds)*time.Second/2),
		IdleWait:    250 * time.Millisecond,
	}, q, log)

	log.Info("started", "concurrency", concurrency)
	w.Run(ctx)
	log.Info("stopped after draining in-flight sends")
	return nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	n, err := strconv.Atoi(env(key, strconv.Itoa(fallback)))
	if err != nil {
		return fallback
	}
	return n
}
