// Package smtpx classifies SMTP replies and delivers messages over
// long-lived SMTP connections.
package smtpx

import (
	"regexp"
	"strconv"
)

// Kind is what the queue should do with a delivery after an attempt.
type Kind int

const (
	Delivered Kind = iota
	Temporary
	Permanent
)

func (k Kind) String() string {
	switch k {
	case Delivered:
		return "delivered"
	case Temporary:
		return "temporary"
	default:
		return "permanent"
	}
}

// Outcome is the classified result of one delivery attempt. Code is 0 when
// the attempt never got an SMTP reply (connection refused, timeout).
type Outcome struct {
	Kind     Kind
	Code     int
	Response string
}

var enhancedStatus = regexp.MustCompile(`^([245])\.\d{1,3}\.\d{1,3}\b`)

// ClassifyReply maps an SMTP reply to an outcome: 2xx delivered, 4xx
// temporary, 5xx permanent. An enhanced status code (RFC 3463) at the start
// of the text wins over the basic code, because servers do send things like
// "550 4.2.1 rate limited". Same rules as src/smtp/classify.ts.
func ClassifyReply(code int, text string) Outcome {
	class := code / 100
	if m := enhancedStatus.FindStringSubmatch(text); m != nil {
		class, _ = strconv.Atoi(m[1])
	}
	response := strconv.Itoa(code) + " " + text
	switch class {
	case 2:
		return Outcome{Kind: Delivered, Code: code, Response: response}
	case 5:
		return Outcome{Kind: Permanent, Code: code, Response: response}
	default:
		return Outcome{Kind: Temporary, Code: code, Response: response}
	}
}

// TransportFailure is an attempt that never reached a verdict. It is retried.
func TransportFailure(err error) Outcome {
	return Outcome{Kind: Temporary, Response: err.Error()}
}
