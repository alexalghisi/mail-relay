// Package message renders a queued email as an RFC 5322 message.
package message

import (
	"bytes"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/textproto"
	"time"
)

// Email holds what the worker needs to render one delivery.
type Email struct {
	DeliveryID int64
	EmailID    string
	From       string
	To         string
	Subject    string
	HTML       string
	Text       string
}

// MessageID is stable across retries so a receiver that accepted an earlier
// attempt (whose reply we never saw) can drop the duplicate. It matches the
// TypeScript worker's format.
func (e Email) MessageID() string {
	return fmt.Sprintf("<%s.%d@mail-relay>", e.EmailID, e.DeliveryID)
}

// Render builds the message. With both HTML and text it is
// multipart/alternative; otherwise a single quoted-printable part.
func Render(e Email, now time.Time) ([]byte, error) {
	var buf bytes.Buffer
	header := func(k, v string) { fmt.Fprintf(&buf, "%s: %s\r\n", k, v) }
	header("From", e.From)
	header("To", e.To)
	header("Subject", mime.QEncoding.Encode("utf-8", e.Subject))
	header("Date", now.UTC().Format(time.RFC1123Z))
	header("Message-ID", e.MessageID())
	header("X-Delivery-Id", fmt.Sprint(e.DeliveryID))
	header("X-Email-Id", e.EmailID)
	header("MIME-Version", "1.0")

	if e.HTML != "" && e.Text != "" {
		mw := multipart.NewWriter(&buf)
		header("Content-Type", fmt.Sprintf("multipart/alternative; boundary=%q", mw.Boundary()))
		buf.WriteString("\r\n")
		for _, part := range []struct{ typ, body string }{{"text/plain", e.Text}, {"text/html", e.HTML}} {
			w, err := mw.CreatePart(textproto.MIMEHeader{
				"Content-Type":              {part.typ + "; charset=utf-8"},
				"Content-Transfer-Encoding": {"quoted-printable"},
			})
			if err != nil {
				return nil, err
			}
			if err := writeQP(w, part.body); err != nil {
				return nil, err
			}
		}
		if err := mw.Close(); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}

	typ, body := "text/plain", e.Text
	if e.HTML != "" {
		typ, body = "text/html", e.HTML
	}
	header("Content-Type", typ+"; charset=utf-8")
	header("Content-Transfer-Encoding", "quoted-printable")
	buf.WriteString("\r\n")
	if err := writeQP(&buf, body); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeQP(w interface{ Write([]byte) (int, error) }, body string) error {
	qp := quotedprintable.NewWriter(w)
	if _, err := qp.Write([]byte(body)); err != nil {
		return err
	}
	return qp.Close()
}
