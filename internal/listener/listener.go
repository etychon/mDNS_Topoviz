package listener

import (
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"time"
)

// Start joins mDNS multicast groups on eligible interfaces and forwards payloads.
func Start(filter []string, onPacket func(iface string, src net.Addr, payload []byte)) (func(), error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	filterSet := map[string]struct{}{}
	for _, n := range filter {
		filterSet[n] = struct{}{}
	}

	var conns []io.Closer
	var wg sync.WaitGroup
	stop := make(chan struct{})

	startRead := func(c *net.UDPConn, name string) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 65536)
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = c.SetReadDeadline(time.Now().Add(750 * time.Millisecond))
				n, addr, err := c.ReadFrom(buf)
				if err != nil {
					if ne, ok := err.(net.Error); ok && ne.Timeout() {
						continue
					}
					select {
					case <-stop:
						return
					default:
						log.Printf("read %s: %v", name, err)
						return
					}
				}
				pkt := make([]byte, n)
				copy(pkt, buf[:n])
				onPacket(name, addr, pkt)
			}
		}()
	}

	for _, ifi := range ifs {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagMulticast == 0 {
			continue
		}
		if len(filterSet) > 0 {
			if _, ok := filterSet[ifi.Name]; !ok {
				continue
			}
		}

		v4 := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
		if c4, err := net.ListenMulticastUDP("udp4", &ifi, v4); err == nil {
			conns = append(conns, c4)
			startRead(c4, ifi.Name+"@ipv4")
		} else {
			log.Printf("multicast ipv4 %s: %v", ifi.Name, err)
		}

		v6, err := net.ResolveUDPAddr("udp6", "[ff02::fb]:5353")
		if err == nil {
			if c6, err := net.ListenMulticastUDP("udp6", &ifi, v6); err == nil {
				conns = append(conns, c6)
				startRead(c6, ifi.Name+"@ipv6")
			} else {
				log.Printf("multicast ipv6 %s: %v", ifi.Name, err)
			}
		}
	}

	if len(conns) == 0 {
		return nil, errors.New("no multicast listeners could be started (permissions, interfaces, or addresses)")
	}

	return func() {
		close(stop)
		for _, c := range conns {
			_ = c.Close()
		}
		wg.Wait()
	}, nil
}
