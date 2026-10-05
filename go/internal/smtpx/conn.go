package smtpx

import (
	"errors"
	"net"
	"net/smtp"
	"net/textproto"
	"time"
)

// Conn is one long-lived SMTP connection to a relay. Connection setup costs a
// greeting delay plus EHLO, so each sender goroutine keeps its own Conn and
// reuses it across messages. Not safe for concurrent use.
type Conn struct {
	Addr    string
	Helo    string
	Timeout time.Duration

	conn   net.Conn
	client *smtp.Client
}

// Send delivers one message to one recipient and classifies the result. A
// protocol rejection keeps the connection (after RSET); anything else drops
// it so the next Send redials.
func (c *Conn) Send(from, to string, msg []byte) Outcome {
	if c.client == nil {
		if err := c.dial(); err != nil {
			return TransportFailure(err)
		}
	}
	_ = c.conn.SetDeadline(time.Now().Add(c.Timeout))
	outcome, err := c.transact(from, to, msg)
	if err != nil {
		c.Close()
		return TransportFailure(err)
	}
	return outcome
}

// Close quits politely if it can and forgets the connection.
func (c *Conn) Close() {
	if c.client != nil {
		_ = c.conn.SetDeadline(time.Now().Add(time.Second))
		_ = c.client.Quit()
		_ = c.client.Close()
	}
	c.client, c.conn = nil, nil
}

func (c *Conn) dial() error {
	conn, err := net.DialTimeout("tcp", c.Addr, c.Timeout)
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(c.Timeout))
	host, _, _ := net.SplitHostPort(c.Addr)
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return err
	}
	if err := client.Hello(c.Helo); err != nil {
		client.Close()
		return err
	}
	c.conn, c.client = conn, client
	return nil
}

func (c *Conn) transact(from, to string, msg []byte) (Outcome, error) {
	if err := c.client.Mail(from); err != nil {
		return c.rejected(err)
	}
	if err := c.client.Rcpt(to); err != nil {
		return c.rejected(err)
	}
	// DATA is driven by hand because smtp.Client discards the final reply
	// text, and the reply ("250 2.0.0 Ok: queued as ...") is worth keeping.
	text := c.client.Text
	id, err := text.Cmd("DATA")
	if err != nil {
		return Outcome{}, err
	}
	text.StartResponse(id)
	_, _, err = text.ReadResponse(354)
	text.EndResponse(id)
	if err != nil {
		return c.rejected(err)
	}
	dw := text.DotWriter()
	if _, err := dw.Write(msg); err != nil {
		return Outcome{}, err
	}
	if err := dw.Close(); err != nil {
		return Outcome{}, err
	}
	code, reply, err := text.ReadResponse(250)
	if err != nil {
		return c.rejected(err)
	}
	return ClassifyReply(code, reply), nil
}

// rejected turns a protocol error into an outcome and resets the session so
// the connection can carry the next message.
func (c *Conn) rejected(err error) (Outcome, error) {
	var reply *textproto.Error
	if !errors.As(err, &reply) {
		return Outcome{}, err
	}
	if resetErr := c.client.Reset(); resetErr != nil {
		c.Close()
	}
	return ClassifyReply(reply.Code, reply.Msg), nil
}
