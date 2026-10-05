// Package pgtest gives each test a private Postgres schema with the
// project's migrations applied, so Go tests can run next to the TypeScript
// suite on the same database without touching its tables.
package pgtest

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

const defaultURL = "postgres://synckit:synckit@localhost:5432/mailrelay_test"

var noTransaction = regexp.MustCompile(`^--\s*migrate:\s*no-transaction`)

// Open returns a pool whose search_path points at a fresh, migrated schema.
// The test is skipped when Postgres is unreachable.
func Open(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	url := os.Getenv("MAILRELAY_TEST_DATABASE_URL")
	if url == "" {
		url = defaultURL
	}
	admin, err := pgxpool.New(ctx, url)
	if err == nil {
		err = admin.Ping(ctx)
	}
	if err != nil {
		t.Skipf("postgres not available: %v", err)
	}
	schema := fmt.Sprintf("gotest_%d", rand.Uint32())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	migrate(t, pool)
	return pool
}

func migrate(t testing.TB, pool *pgxpool.Pool) {
	t.Helper()
	dir := migrationsDir(t)
	files, _ := filepath.Glob(filepath.Join(dir, "*.sql"))
	sort.Strings(files)
	for _, f := range files {
		sql, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		statements := []string{string(sql)}
		if noTransaction.Match(sql) {
			statements = strings.Split(string(sql), ";\n")
		}
		for _, s := range statements {
			if strings.TrimSpace(stripComments(s)) == "" {
				continue
			}
			if _, err := pool.Exec(context.Background(), s); err != nil {
				t.Fatalf("%s: %v", filepath.Base(f), err)
			}
		}
	}
}

func stripComments(s string) string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "--") {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func migrationsDir(t testing.TB) string {
	dir, _ := os.Getwd()
	for {
		candidate := filepath.Join(dir, "migrations")
		if st, err := os.Stat(candidate); err == nil && st.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("migrations directory not found")
		}
		dir = parent
	}
}

// Seed creates a team with an API key and returns their ids.
func Seed(t testing.TB, pool *pgxpool.Pool) (teamID, apiKeyID string) {
	t.Helper()
	ctx := context.Background()
	err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('acme') RETURNING id::text`).Scan(&teamID)
	if err == nil {
		err = pool.QueryRow(ctx, `
			INSERT INTO api_keys (team_id, name, token_hash, token_prefix)
			VALUES ($1, 'test', gen_random_uuid()::text::bytea, 'mr_test') RETURNING id::text`, teamID).Scan(&apiKeyID)
	}
	if err != nil {
		t.Fatal(err)
	}
	return teamID, apiKeyID
}

// InsertEmail queues an email with one delivery per recipient.
func InsertEmail(t testing.TB, pool *pgxpool.Pool, teamID, apiKeyID string, recipients ...string) string {
	t.Helper()
	ctx := context.Background()
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO emails (team_id, api_key_id, from_header, from_email, recipients, subject, text_body)
		VALUES ($1, $2, 'Acme <hello@acme.test>', 'hello@acme.test', $3, 'Hello', 'hi') RETURNING id::text`,
		teamID, apiKeyID, recipients).Scan(&id)
	if err == nil {
		_, err = pool.Exec(ctx, `
			INSERT INTO deliveries (email_id, recipient, recipient_domain)
			SELECT $1, r, split_part(r, '@', 2) FROM unnest($2::text[]) r`, id, recipients)
	}
	if err != nil {
		t.Fatal(err)
	}
	return id
}
