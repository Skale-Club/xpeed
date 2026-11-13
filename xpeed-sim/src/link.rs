//! The link the Xpeed app opens to connect this computer: `xpeedsim://pair?server=<address>&code=<code>`.
//!
//! The `link` command is kept for old links; the installer no longer registers the `xpeedsim:` scheme.
//! Anything on the web can send one, so a link only *proposes* a pairing: the program shows which server it
//! would connect to and waits for a yes before it does anything.

use crate::config::{normalize_code, normalize_server};

pub const SCHEME: &str = "xpeedsim";

#[derive(Debug, PartialEq)]
pub struct PairLink {
    /// Checked and in the form the program keeps (`https://host`, no trailing slash).
    pub server: String,
    /// `ABCD2345`.
    pub code: String,
}

/// `%41` -> `A`. Anything that is not valid percent-encoded UTF-8 is refused.
fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or("the link is cut short")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "the link has a bad % escape")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "the link is not valid text".to_owned())
}

pub fn parse(link: &str) -> Result<PairLink, String> {
    let link = link.trim().trim_matches('"');
    if link.len() > 2048 {
        return Err("the link is too long".into());
    }
    let (scheme, rest) = link.split_once(':').ok_or("this is not an Xpeed Companion link")?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return Err("this is not an Xpeed Companion link".into());
    }
    let rest = rest.strip_prefix("//").ok_or("this is not an Xpeed Companion link")?;
    let (action, query) = rest.split_once('?').ok_or("the link has nothing to pair with")?;
    if !action.trim_end_matches('/').eq_ignore_ascii_case("pair") {
        return Err("this link asks for something Xpeed Companion does not do".into());
    }
    let (mut server, mut code) = (None, None);
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let slot = match name {
            "server" => &mut server,
            "code" => &mut code,
            _ => continue,
        };
        if slot.replace(percent_decode(value)?).is_some() {
            return Err(format!("the link repeats {name}"));
        }
    }
    Ok(PairLink {
        server: normalize_server(&server.ok_or("the link has no server")?)?,
        code: normalize_code(&code.ok_or("the link has no code")?)?,
    })
}

/// The link for a server and code, the way the app writes it.
#[cfg(test)]
pub fn build(server: &str, code: &str) -> String {
    let encoded: String = server
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("{SCHEME}://pair?server={encoded}&code={code}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_link_the_app_writes() {
        let link = build("https://xpeed.skale.club", "ABCD2345");
        assert_eq!(link, "xpeedsim://pair?server=https%3A%2F%2Fxpeed.skale.club&code=ABCD2345");
        assert_eq!(
            parse(&link),
            Ok(PairLink {
                server: "https://xpeed.skale.club".into(),
                code: "ABCD2345".into()
            })
        );
    }

    #[test]
    fn is_forgiving_about_how_windows_hands_it_over() {
        let expected = Ok(PairLink {
            server: "https://xpeed.skale.club".into(),
            code: "ABCD2345".into(),
        });
        // Windows may wrap the link in quotes, and a person may type the code in lower case with a dash.
        assert_eq!(
            parse("\"XpeedSim://pair/?code=abcd-2345&server=https://xpeed.skale.club/\""),
            expected
        );
        assert_eq!(
            parse("  xpeedsim://pair?server=https%3a%2f%2fxpeed.skale.club&code=ABCD%2D2345&utm=1  "),
            expected
        );
    }

    #[test]
    fn a_link_only_proposes_what_the_program_would_accept_anyway() {
        for (link, why) in [
            ("https://xpeed.skale.club", "another scheme"),
            ("xpeedsim:pair?server=https%3A%2F%2Fa.example&code=ABCD2345", "missing //"),
            ("xpeedsim://delete?server=https%3A%2F%2Fa.example&code=ABCD2345", "another action"),
            ("xpeedsim://pair", "no query"),
            ("xpeedsim://pair?code=ABCD2345", "no server"),
            ("xpeedsim://pair?server=https%3A%2F%2Fa.example", "no code"),
            (
                "xpeedsim://pair?server=http%3A%2F%2Fa.example&code=ABCD2345",
                "plain http to somewhere else",
            ),
            (
                "xpeedsim://pair?server=https%3A%2F%2Fuser%3Apass%40a.example&code=ABCD2345",
                "credentials in the address",
            ),
            (
                "xpeedsim://pair?server=https%3A%2F%2Fa.example&code=AB",
                "a code that cannot be one",
            ),
            (
                "xpeedsim://pair?server=https%3A%2F%2Fa.example&server=https%3A%2F%2Fb.example&code=ABCD2345",
                "a repeated server",
            ),
            (
                "xpeedsim://pair?server=https%3A%2F%2Fa.example&code=ABCD2345&code=WXYZ9876",
                "a repeated code",
            ),
            ("xpeedsim://pair?server=%ZZ&code=ABCD2345", "a bad escape"),
            ("xpeedsim://pair?server=%C3&code=ABCD2345", "bytes that are not text"),
            ("xpeedsim://pair?server=https%3A%2F%2Fa.example&code=ABCD2345%", "cut short"),
        ] {
            assert!(parse(link).is_err(), "{why}: {link}");
        }
        assert!(
            parse(&format!(
                "xpeedsim://pair?server=https%3A%2F%2Fa.example&code=ABCD2345&x={}",
                "a".repeat(3000)
            ))
            .is_err(),
            "too long"
        );
    }

    #[test]
    fn this_computer_is_a_server_too_for_development() {
        assert_eq!(
            parse(&build("http://localhost:3000", "ABCD2345")).unwrap().server,
            "http://localhost:3000"
        );
    }
}
