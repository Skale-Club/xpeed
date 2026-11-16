//! The one UDP door the readers of the games that send their telemetry to this computer share (EA SPORTS F1, Forza,
//! Wreckfest 2): a socket, one receive loop and one rule for who may talk to it.
//!
//! # Who may send
//!
//! By default the door is bound to `127.0.0.1` and a datagram is accepted only from a loopback sender, which is all a
//! game on this computer sends (every game's setup text says to point its output at `127.0.0.1`). So a program on the
//! network cannot feed the reader numbers, and the port is not open to the LAN.
//!
//! For a person whose game runs on another computer, setting the environment variable `XPEED_UDP_LISTEN_ALL` to `1`
//! (before starting Xpeed Companion) binds every address (`0.0.0.0`) and accepts any sender. It is off unless set. The
//! game's output IP is then the IP of this computer.
//!
//! # What is not an error
//!
//! Windows reports a refused earlier send on a UDP socket as `ConnectionReset`, and a datagram bigger than the
//! buffer as `WSAEMSGSIZE` (10040): neither is the door's fault, and neither ends the wait (the next datagram may be
//! a good one). A timeout ends the wait with nothing. Any other error means the socket is dead (`alive` turns
//! false and the reader is let go and opened again).

use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

/// Windows' "message too long": a datagram bigger than the buffer.
const WSAEMSGSIZE: i32 = 10040;

/// The environment variable that opens the door to every address and sender.
pub const LISTEN_ALL_VAR: &str = "XPEED_UDP_LISTEN_ALL";

/// Whether the person asked, by `XPEED_UDP_LISTEN_ALL`, for the door to be open to other computers.
pub fn listen_all_requested() -> bool {
    listen_all_value(std::env::var(LISTEN_ALL_VAR).ok().as_deref())
}

fn listen_all_value(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Whether a datagram from `sender` is taken.
pub fn accepts(sender: IpAddr, listen_all: bool) -> bool {
    listen_all || sender.is_loopback()
}

/// What one wait on the door came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// A datagram of this many bytes is in `Door::data`.
    Datagram(usize),
    /// The time ran out with nothing to take.
    Nothing,
    /// The socket is dead.
    Dead,
}

/// The open door: a UDP socket and the buffer a datagram is received into.
pub struct Door {
    socket: UdpSocket,
    buf: Vec<u8>,
    alive: bool,
    listen_all: bool,
}

impl Door {
    /// Binds `addr` and takes only loopback senders (the replay and the tests bind an ephemeral loopback port). `None`
    /// when that fails (the port is busy: another program, for example a dashboard, owns it; std gives no way to ask
    /// for address reuse before the bind).
    pub fn bind(addr: SocketAddr, buf_len: usize) -> Option<Door> {
        Door::bind_with(addr, buf_len, false)
    }

    /// The door of a real game on `port`: the loopback only, or every address when `XPEED_UDP_LISTEN_ALL` says so.
    pub fn listen(port: u16, buf_len: usize) -> Option<Door> {
        let all = listen_all_requested();
        let ip = if all { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST };
        Door::bind_with(SocketAddr::from((ip, port)), buf_len, all)
    }

    fn bind_with(addr: SocketAddr, buf_len: usize, listen_all: bool) -> Option<Door> {
        let socket = UdpSocket::bind(addr).ok()?;
        Some(Door {
            socket,
            buf: vec![0; buf_len],
            alive: true,
            listen_all,
        })
    }

    pub fn alive(&self) -> bool {
        self.alive
    }

    /// The datagram the last `Wait::Datagram(n)` said is there.
    pub fn data(&self, n: usize) -> &[u8] {
        &self.buf[..n.min(self.buf.len())]
    }

    #[cfg(test)]
    pub fn local_addr(&self) -> SocketAddr {
        self.socket.local_addr().expect("a bound socket has an address")
    }

    /// Waits for a datagram from an accepted sender until `deadline`. A datagram from anyone else, a refused earlier
    /// send and an oversized datagram are passed over, and the wait goes on.
    pub fn recv(&mut self, deadline: Instant) -> Wait {
        loop {
            // A zero timeout is an error for a socket: wait at least a millisecond.
            let wait = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            if self.socket.set_read_timeout(Some(wait)).is_err() {
                self.alive = false;
                return Wait::Dead;
            }
            match self.socket.recv_from(&mut self.buf) {
                Ok((n, from)) => {
                    if accepts(from.ip(), self.listen_all) {
                        return Wait::Datagram(n);
                    }
                }
                Err(e) if e.raw_os_error() == Some(WSAEMSGSIZE) => {}
                Err(e) => match e.kind() {
                    ErrorKind::WouldBlock | ErrorKind::TimedOut => return Wait::Nothing,
                    // Windows reports a refused earlier send on a UDP socket this way; nothing is wrong with the door.
                    ErrorKind::ConnectionReset | ErrorKind::Interrupted => {}
                    _ => {
                        self.alive = false;
                        return Wait::Dead;
                    }
                },
            }
            if Instant::now() >= deadline {
                return Wait::Nothing;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    const SOON: Duration = Duration::from_millis(300);

    fn pair(buf_len: usize) -> (Door, UdpSocket) {
        let door = Door::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), buf_len).expect("an ephemeral loopback port is free");
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        (door, sender)
    }

    #[test]
    fn only_a_loopback_sender_is_taken_unless_the_door_was_opened_to_all() {
        for loopback in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(127, 8, 9, 10)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ] {
            assert!(accepts(loopback, false), "{loopback}");
            assert!(accepts(loopback, true), "{loopback}");
        }
        for elsewhere in [
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            IpAddr::V6("fe80::1".parse().unwrap()),
        ] {
            assert!(!accepts(elsewhere, false), "{elsewhere} is dropped by default");
            assert!(accepts(elsewhere, true), "{elsewhere} is taken when the person opened the door");
        }
    }

    #[test]
    fn the_environment_variable_opens_the_door_only_when_it_says_yes() {
        for yes in ["1", "true", "YES", " on "] {
            assert!(listen_all_value(Some(yes)), "{yes:?}");
        }
        for no in [None, Some(""), Some("0"), Some("no"), Some("off"), Some("2")] {
            assert!(!listen_all_value(no), "{no:?}");
        }
    }

    #[test]
    fn a_loopback_datagram_comes_through_and_a_silent_door_waits_out_the_time() {
        let (mut door, sender) = pair(64);
        assert_eq!(door.recv(Instant::now() + Duration::from_millis(30)), Wait::Nothing);
        assert!(door.alive(), "a silent game does not close the door");
        sender.send_to(b"hello", door.local_addr()).unwrap();
        let wait = door.recv(Instant::now() + SOON);
        assert_eq!(wait, Wait::Datagram(5));
        assert_eq!(door.data(5), b"hello");
    }

    #[test]
    fn an_oversized_datagram_is_passed_over_and_the_door_stays_alive() {
        let (mut door, sender) = pair(16);
        sender.send_to(&[7u8; 64], door.local_addr()).unwrap();
        sender.send_to(b"ok", door.local_addr()).unwrap();
        assert_eq!(
            door.recv(Instant::now() + SOON),
            Wait::Datagram(2),
            "the next good datagram is still taken"
        );
        assert!(door.alive(), "an oversized datagram does not make a dead socket");
        // And with nothing after it, the wait just ends.
        sender.send_to(&[7u8; 64], door.local_addr()).unwrap();
        assert_eq!(door.recv(Instant::now() + Duration::from_millis(50)), Wait::Nothing);
        assert!(door.alive());
    }

    #[test]
    fn a_refused_earlier_send_does_not_end_the_wait() {
        // Send to a port nobody listens on: Windows answers the next receive of this socket with ConnectionReset.
        let (mut door, sender) = pair(64);
        let gone = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let gone_addr = gone.local_addr().unwrap();
        drop(gone);
        door.socket.send_to(b"x", gone_addr).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        sender.send_to(b"after", door.local_addr()).unwrap();
        assert_eq!(door.recv(Instant::now() + SOON), Wait::Datagram(5));
        assert!(door.alive());
    }
}
