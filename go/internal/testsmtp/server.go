// Package testsmtp is a minimal SMTP server for tests. Like the fake MTA in
// the TypeScript code, the recipient's local part picks the behaviour:
// bounce* gets 550, tempfail* gets 451, flaky* gets 451 once and is then
// accepted.
package testsmtp

import (
	"bufio"
	"net"
	"net/mail"
	"strings"
	"sync"
	"testing"
	"time"
)

type Server struct {
	Addr string
	// DataDelay is spent before answering the end of DATA.
	DataDelay time.Duration

	mu       sync.Mutex
	received []*mail.Message
	seen     map[string]bool
	ln       net.Listener
	wg       sync.WaitGroup
}

// Start listens on a random local port until the test ends.
func Start(t testing.TB) *Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Addr: ln.Addr().String(), ln: ln, seen: map[string]bool{}}
	s.wg.Add(1)
	go s.accept()
	t.Cleanup(func() {
		ln.Close()
		s.wg.Wait()
	})
	return s
}

// DeliveryIDs returns the X-Delivery-Id of every accepted message.
func (s *Server) DeliveryIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, len(s.received))
	for i, m := range s.received {
		ids[i] = m.Header.Get("X-Delivery-Id")
	}
	return ids
}

func (s *Server) accept() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.serve(conn)
		}()
	}
}

func (s *Server) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	reply := func(line string) { conn.Write([]byte(line + "\r\n")) }
	reply("220 testsmtp ready")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			reply("250 testsmtp")
		case strings.HasPrefix(cmd, "MAIL FROM:"), cmd == "RSET", cmd == "NOOP":
			reply("250 2.0.0 OK")
		case strings.HasPrefix(cmd, "RCPT TO:"):
			reply(s.rcpt(strings.Trim(strings.TrimSpace(line)[len("RCPT TO:"):], "<> ")))
		case cmd == "DATA":
			reply("354 End data with <CR><LF>.<CR><LF>")
			var body strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				body.WriteString(strings.TrimPrefix(l, "."))
			}
			time.Sleep(s.DataDelay)
			if msg, err := mail.ReadMessage(strings.NewReader(body.String())); err == nil {
				s.mu.Lock()
				s.received = append(s.received, msg)
				s.mu.Unlock()
			}
			reply("250 2.0.0 Ok: queued")
		case cmd == "QUIT":
			reply("221 2.0.0 Bye")
			return
		default:
			reply("502 5.5.2 Command not recognized")
		}
	}
}

func (s *Server) rcpt(addr string) string {
	local := strings.ToLower(strings.SplitN(addr, "@", 2)[0])
	s.mu.Lock()
	first := !s.seen[addr]
	s.seen[addr] = true
	s.mu.Unlock()
	switch {
	case strings.HasPrefix(local, "bounce"):
		return "550 5.1.1 User unknown"
	case strings.HasPrefix(local, "tempfail"), strings.HasPrefix(local, "flaky") && first:
		return "451 4.7.1 Try again later"
	default:
		return "250 2.1.5 OK"
	}
}
