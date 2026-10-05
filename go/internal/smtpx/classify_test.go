package smtpx

import (
	"errors"
	"testing"
)

func TestClassifyReply(t *testing.T) {
	tests := []struct {
		code int
		text string
		want Kind
	}{
		{250, "2.0.0 OK queued as 1234", Delivered},
		{421, "4.7.0 Too many connections", Temporary},
		{451, "4.7.1 Greylisted", Temporary},
		{452, "Insufficient storage", Temporary},
		{550, "5.1.1 User unknown", Permanent},
		{552, "Message size exceeds limit", Permanent},
		{554, "5.7.1 Rejected by policy", Permanent},
		{550, "4.2.1 Mailbox temporarily rate limited", Temporary},
		{451, "5.7.1 Message rejected", Permanent},
		{450, "mailbox 5.1.1x busy", Temporary},
	}
	for _, tt := range tests {
		got := ClassifyReply(tt.code, tt.text)
		if got.Kind != tt.want {
			t.Errorf("ClassifyReply(%d, %q) = %v, want %v", tt.code, tt.text, got.Kind, tt.want)
		}
		if got.Code != tt.code {
			t.Errorf("ClassifyReply(%d, %q).Code = %d", tt.code, tt.text, got.Code)
		}
	}
}

func TestTransportFailureIsRetried(t *testing.T) {
	got := TransportFailure(errors.New("dial tcp 127.0.0.1:1: connect: connection refused"))
	if got.Kind != Temporary || got.Code != 0 {
		t.Fatalf("got %+v, want a temporary outcome without a code", got)
	}
}
