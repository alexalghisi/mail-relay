// Package worker drains the delivery queue over SMTP.
package worker

import (
	"context"
	"errors"
	"log/slog"
	"net/mail"
	"sync"
	"time"

	"github.com/alexalghisi/mail-relay/go/internal/message"
	"github.com/alexalghisi/mail-relay/go/internal/queue"
	"github.com/alexalghisi/mail-relay/go/internal/smtpx"
)

type Config struct {
	ID          string
	Concurrency int
	SMTPAddr    string
	Helo        string
	SMTPTimeout time.Duration
	IdleWait    time.Duration
}

type Worker struct {
	cfg   Config
	queue *queue.Queue
	log   *slog.Logger
}

func New(cfg Config, q *queue.Queue, log *slog.Logger) *Worker {
	return &Worker{cfg: cfg, queue: q, log: log}
}

// Run claims and sends until ctx is cancelled, then waits for in-flight sends
// to finish and records their outcomes before returning.
//
// One goroutine claims; Concurrency sender goroutines each own a long-lived
// SMTP connection. The claimer only asks for as many rows as there are idle
// senders, so every leased row is being sent and nothing is left leased
// after shutdown.
func (w *Worker) Run(ctx context.Context) {
	jobs := make(chan queue.Delivery)
	idle := make(chan struct{}, w.cfg.Concurrency)
	var wg sync.WaitGroup
	for range w.cfg.Concurrency {
		idle <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn := &smtpx.Conn{Addr: w.cfg.SMTPAddr, Helo: w.cfg.Helo, Timeout: w.cfg.SMTPTimeout}
			defer conn.Close()
			for d := range jobs {
				w.deliver(conn, d)
				idle <- struct{}{}
			}
		}()
	}

	w.claimLoop(ctx, jobs, idle)
	close(jobs)
	wg.Wait()
}

func (w *Worker) claimLoop(ctx context.Context, jobs chan<- queue.Delivery, idle chan struct{}) {
	for {
		// Wait for at least one idle sender, then take every idle one.
		select {
		case <-ctx.Done():
			return
		case <-idle:
		}
		free := 1
	drain:
		for {
			select {
			case <-idle:
				free++
			default:
				break drain
			}
		}

		claimed, err := w.queue.Claim(ctx, w.cfg.ID, free)
		if err != nil && ctx.Err() == nil {
			w.log.Error("claim failed", "err", err)
		}
		for _, d := range claimed {
			jobs <- d
		}
		for range free - len(claimed) {
			idle <- struct{}{}
		}
		if len(claimed) == 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(w.cfg.IdleWait):
			}
		}
	}
}

func (w *Worker) deliver(conn *smtpx.Conn, d queue.Delivery) {
	started := time.Now()
	outcome := w.send(conn, d)
	// Outcomes are recorded even during shutdown; the parent context is
	// already cancelled by then.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	status, err := w.queue.Settle(ctx, d, outcome)
	attrs := []any{"id", d.ID, "to", d.Recipient, "attempt", d.Attempt, "smtp", outcome.Response, "ms", time.Since(started).Milliseconds()}
	switch {
	case errors.Is(err, queue.ErrLeaseLost):
		w.log.Warn("lease lost, outcome discarded", attrs...)
	case err != nil:
		// Not recorded: the lease expires and the delivery is retried.
		w.log.Error("could not record outcome", append(attrs, "err", err)...)
	case status == "delivered":
		w.log.Info("delivered", attrs...)
	case status == "queued":
		w.log.Warn("deferred, will retry", attrs...)
	default:
		w.log.Warn(status, attrs...)
	}
}

func (w *Worker) send(conn *smtpx.Conn, d queue.Delivery) smtpx.Outcome {
	from, err := mail.ParseAddress(d.FromHeader)
	if err != nil {
		// The API validated the address, so this is a bug, not a bad message.
		return smtpx.Outcome{Kind: smtpx.Permanent, Code: 0, Response: "invalid sender: " + err.Error()}
	}
	raw, err := message.Render(message.Email{
		DeliveryID: d.ID, EmailID: d.EmailID, From: d.FromHeader, To: d.Recipient,
		Subject: d.Subject, HTML: d.HTML, Text: d.Text,
	}, time.Now())
	if err != nil {
		return smtpx.TransportFailure(err)
	}
	return conn.Send(from.Address, d.Recipient, raw)
}
