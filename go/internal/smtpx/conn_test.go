package smtpx

import (
	"testing"
	"time"

	"github.com/alexalghisi/mail-relay/go/internal/testsmtp"
)

func TestConnClassifiesAndReusesTheConnection(t *testing.T) {
	srv := testsmtp.Start(t)
	c := &Conn{Addr: srv.Addr, Helo: "test", Timeout: 2 * time.Second}
	defer c.Close()
	msg := []byte("Subject: hi\r\nX-Delivery-Id: 1\r\n\r\nhello\r\n.leading dot\r\n")

	steps := []struct {
		to   string
		want Kind
		code int
	}{
		{"ok@x.test", Delivered, 250},
		{"bounce@x.test", Permanent, 550},
		{"flaky@x.test", Temporary, 451},
		{"flaky@x.test", Delivered, 250},
		{"tempfail@x.test", Temporary, 451},
		{"ok2@x.test", Delivered, 250},
	}
	var conn = c.conn
	for i, s := range steps {
		got := c.Send("hello@acme.test", s.to, msg)
		if got.Kind != s.want || got.Code != s.code {
			t.Fatalf("step %d (%s): got %+v, want %v/%d", i, s.to, got, s.want, s.code)
		}
		if i == 0 {
			conn = c.conn
		} else if c.conn != conn {
			t.Fatalf("step %d: connection was replaced after a protocol rejection", i)
		}
	}
	if got := srv.DeliveryIDs(); len(got) != 3 {
		t.Fatalf("server accepted %d messages, want 3", len(got))
	}
}

func TestConnReportsUnreachableRelayAsTemporary(t *testing.T) {
	c := &Conn{Addr: "127.0.0.1:1", Helo: "test", Timeout: time.Second}
	got := c.Send("a@acme.test", "b@x.test", []byte("x"))
	if got.Kind != Temporary || got.Code != 0 {
		t.Fatalf("got %+v", got)
	}
}
