package queue

import (
	"context"
	"errors"
	"testing"

	"github.com/alexalghisi/mail-relay/go/internal/pgtest"
	"github.com/alexalghisi/mail-relay/go/internal/smtpx"
)

var opts = Options{LeaseSeconds: 30, DefaultDomainConcurrency: 8, RetryBaseMs: 20, RetryCapMs: 50}

func TestStaleLeaseCannotSettle(t *testing.T) {
	pool := pgtest.Open(t)
	team, key := pgtest.Seed(t, pool)
	pgtest.InsertEmail(t, pool, team, key, "a@x.test")
	q := New(pool, opts)
	ctx := context.Background()
	delivered := smtpx.Outcome{Kind: smtpx.Delivered, Code: 250, Response: "250 OK"}

	stale, _ := q.Claim(ctx, "slow", 1)
	if _, err := pool.Exec(ctx, `UPDATE deliveries SET available_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	fresh, _ := q.Claim(ctx, "fast", 1)
	if len(stale) != 1 || len(fresh) != 1 || fresh[0].Attempt != 2 {
		t.Fatalf("stale=%v fresh=%v", stale, fresh)
	}

	if _, err := q.Settle(ctx, stale[0], delivered); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale settle err = %v, want ErrLeaseLost", err)
	}
	if status, err := q.Settle(ctx, fresh[0], delivered); err != nil || status != "delivered" {
		t.Fatalf("fresh settle = %q, %v", status, err)
	}
}

func TestSettleMapsOutcomesToStatuses(t *testing.T) {
	pool := pgtest.Open(t)
	team, key := pgtest.Seed(t, pool)
	pgtest.InsertEmail(t, pool, team, key, "a@x.test", "b@x.test", "c@x.test")
	q := New(pool, opts)
	ctx := context.Background()

	claimed, err := q.Claim(ctx, "w", 3)
	if err != nil || len(claimed) != 3 {
		t.Fatalf("claimed %d, err %v", len(claimed), err)
	}
	outcomes := []smtpx.Outcome{
		{Kind: smtpx.Delivered, Code: 250, Response: "250 OK"},
		{Kind: smtpx.Temporary, Response: "dial tcp: connection refused"},
		{Kind: smtpx.Permanent, Code: 550, Response: "550 5.1.1 unknown"},
	}
	want := []string{"delivered", "queued", "bounced"}
	for i, d := range claimed {
		got, err := q.Settle(ctx, d, outcomes[i])
		if err != nil || got != want[i] {
			t.Errorf("delivery %d: got %q, %v; want %q", i, got, err, want[i])
		}
	}
}
