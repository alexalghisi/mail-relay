package worker

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexalghisi/mail-relay/go/internal/pgtest"
	"github.com/alexalghisi/mail-relay/go/internal/queue"
	"github.com/alexalghisi/mail-relay/go/internal/testsmtp"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func newWorker(id string, pool *pgxpool.Pool, smtpAddr string, concurrency int) *Worker {
	q := queue.New(pool, queue.Options{LeaseSeconds: 30, DefaultDomainConcurrency: 8, RetryBaseMs: 20, RetryCapMs: 50})
	return New(Config{ID: id, Concurrency: concurrency, SMTPAddr: smtpAddr, Helo: "test", SMTPTimeout: 2 * time.Second, IdleWait: 10 * time.Millisecond}, q, quiet)
}

func runInBackground(t *testing.T, w *Worker) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
	t.Cleanup(stop)
	return stop
}

func statuses(t *testing.T, pool *pgxpool.Pool) map[string]string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT recipient, status FROM deliveries`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var r, s string
		if err := rows.Scan(&r, &s); err != nil {
			t.Fatal(err)
		}
		out[r] = s
	}
	return out
}

func waitSettled(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var open int
		pool.QueryRow(context.Background(), `SELECT count(*) FROM deliveries WHERE status IN ('queued', 'sending')`).Scan(&open)
		if open == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("deliveries did not settle: %v", statuses(t, pool))
}

func TestDeliversRetriesAndBounces(t *testing.T) {
	pool := pgtest.Open(t)
	srv := testsmtp.Start(t)
	team, key := pgtest.Seed(t, pool)
	emailID := pgtest.InsertEmail(t, pool, team, key, "ok@x.test", "flaky@x.test", "bounce@x.test")

	runInBackground(t, newWorker("go-1", pool, srv.Addr, 4))
	waitSettled(t, pool)

	want := map[string]string{"ok@x.test": "delivered", "flaky@x.test": "delivered", "bounce@x.test": "bounced"}
	if got := statuses(t, pool); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
	var events []string
	rows, _ := pool.Query(context.Background(), `SELECT type || ' ' || (payload->>'to') FROM events WHERE email_id = $1 ORDER BY created_at`, emailID)
	for rows.Next() {
		var e string
		rows.Scan(&e)
		events = append(events, e)
	}
	if len(events) != 4 {
		t.Fatalf("events = %v", events)
	}
}

func TestManyWorkersDeliverEachMessageOnce(t *testing.T) {
	pool := pgtest.Open(t)
	srv := testsmtp.Start(t)
	team, key := pgtest.Seed(t, pool)
	for i := range 10 {
		recipients := make([]string, 20)
		for j := range recipients {
			recipients[j] = fmt.Sprintf("u%d-%d@d%d.test", i, j, j%5)
		}
		pgtest.InsertEmail(t, pool, team, key, recipients...)
	}

	for i := range 4 {
		runInBackground(t, newWorker(fmt.Sprintf("go-%d", i), pool, srv.Addr, 6))
	}
	waitSettled(t, pool)

	ids := srv.DeliveryIDs()
	seen := map[string]int{}
	for _, id := range ids {
		seen[id]++
	}
	if len(ids) != 200 || len(seen) != 200 {
		t.Fatalf("server received %d messages for %d distinct deliveries, want 200/200", len(ids), len(seen))
	}
}

func TestShutdownFinishesInFlightSends(t *testing.T) {
	pool := pgtest.Open(t)
	srv := testsmtp.Start(t)
	srv.DataDelay = 300 * time.Millisecond
	team, key := pgtest.Seed(t, pool)
	pgtest.InsertEmail(t, pool, team, key, "a@x.test", "b@x.test", "c@x.test")

	stop := runInBackground(t, newWorker("go-1", pool, srv.Addr, 3))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var sending int
		pool.QueryRow(context.Background(), `SELECT count(*) FROM deliveries WHERE status = 'sending'`).Scan(&sending)
		if sending == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()

	for r, s := range statuses(t, pool) {
		if s != "delivered" {
			t.Errorf("%s is %s after shutdown, want delivered", r, s)
		}
	}
}
