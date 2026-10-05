package message

import (
	"bytes"
	"io"
	"mime"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func TestRenderText(t *testing.T) {
	raw, err := Render(Email{DeliveryID: 7, EmailID: "e1", From: "Acme <hello@acme.test>", To: "ana@x.test", Subject: "Olá", Text: "Thanks."}, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	checks := map[string]string{
		"From":          "Acme <hello@acme.test>",
		"Message-Id":    "<e1.7@mail-relay>",
		"X-Delivery-Id": "7",
		"Content-Type":  "text/plain; charset=utf-8",
	}
	for k, want := range checks {
		if got := msg.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	subject, _ := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if subject != "Olá" {
		t.Errorf("Subject decodes to %q", subject)
	}
	body, _ := io.ReadAll(msg.Body)
	if strings.TrimSpace(string(body)) != "Thanks." {
		t.Errorf("body = %q", body)
	}
}

func TestRenderAlternative(t *testing.T) {
	raw, err := Render(Email{DeliveryID: 1, EmailID: "e", From: "a@acme.test", To: "b@x.test", Subject: "s", Text: "plain", HTML: "<p>html</p>"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if ct := msg.Header.Get("Content-Type"); !strings.HasPrefix(ct, "multipart/alternative; boundary=") {
		t.Fatalf("Content-Type = %q", ct)
	}
	body, _ := io.ReadAll(msg.Body)
	for _, want := range []string{"text/plain", "plain", "text/html", "<p>html</p>"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("body is missing %q", want)
		}
	}
}
