// Package queue calls the delivery queue contract defined in
// migrations/0002_queue_contract.sql. The TypeScript worker calls the same
// functions, so both workers can drain one queue side by side.
package queue

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alexalghisi/mail-relay/go/internal/smtpx"
)

type Delivery struct {
	ID         int64
	EmailID    string
	Recipient  string
	Attempt    int
	LeaseToken string
	FromHeader string
	Subject    string
	HTML       string
	Text       string
}

type Options struct {
	LeaseSeconds             int
	DefaultDomainConcurrency int
	RetryBaseMs              int
	RetryCapMs               int
}

type Queue struct {
	db   *pgxpool.Pool
	opts Options
}

func New(db *pgxpool.Pool, opts Options) *Queue {
	return &Queue{db: db, opts: opts}
}

// Claim leases up to limit due deliveries to worker.
func (q *Queue) Claim(ctx context.Context, worker string, limit int) ([]Delivery, error) {
	rows, err := q.db.Query(ctx, `
		SELECT delivery_id, email_id::text, recipient, attempt, lease_token::text,
		       from_header, subject, coalesce(html, ''), coalesce(text_body, '')
		FROM claim_deliveries($1, $2, $3, $4)`,
		worker, limit, q.opts.LeaseSeconds, q.opts.DefaultDomainConcurrency)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Delivery, error) {
		var d Delivery
		err := row.Scan(&d.ID, &d.EmailID, &d.Recipient, &d.Attempt, &d.LeaseToken, &d.FromHeader, &d.Subject, &d.HTML, &d.Text)
		return d, err
	})
}

// ErrLeaseLost means another worker took the delivery over after this
// worker's lease expired; the outcome was not recorded.
var ErrLeaseLost = errors.New("lease lost")

// Settle records the outcome of an attempt and returns the delivery's new
// status: delivered, queued (retry scheduled), bounced or dead.
func (q *Queue) Settle(ctx context.Context, d Delivery, o smtpx.Outcome) (string, error) {
	code := &o.Code
	if o.Code == 0 {
		code = nil
	}
	if o.Kind == smtpx.Delivered {
		var ok bool
		err := q.db.QueryRow(ctx, `SELECT complete_delivery($1, $2::uuid, $3, $4)`, d.ID, d.LeaseToken, code, o.Response).Scan(&ok)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", ErrLeaseLost
		}
		return "delivered", nil
	}
	var status *string
	err := q.db.QueryRow(ctx, `SELECT fail_delivery($1, $2::uuid, $3, $4, $5, $6, $7)`,
		d.ID, d.LeaseToken, code, o.Response, o.Kind == smtpx.Permanent, q.opts.RetryBaseMs, q.opts.RetryCapMs).Scan(&status)
	if err != nil {
		return "", err
	}
	if status == nil {
		return "", ErrLeaseLost
	}
	return *status, nil
}
