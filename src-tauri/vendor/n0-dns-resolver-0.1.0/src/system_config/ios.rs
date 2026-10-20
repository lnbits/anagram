//! Read iOS resolver settings without macOS-only SCDynamicStore APIs.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};

use super::{Config, DnsProtocol, Nameserver};

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct DnsServer {
    address: [u8; 16],
    scope_id: u32,
    port: u16,
    family: u8,
}

#[repr(C)]
struct DnsConfig {
    servers: [DnsServer; 3],
    count: u32,
    ndots: u32,
    search_domains: [[u8; 256]; 6],
}

const _: () = assert!(std::mem::size_of::<DnsServer>() == 24);
const _: () = assert!(std::mem::size_of::<DnsConfig>() == 1616);

unsafe extern "C" {
    fn anagram_ios_read_dns(config: *mut DnsConfig) -> std::ffi::c_int;
}

pub(super) fn read_system_dns() -> Result<Config, std::io::Error> {
    let mut raw = DnsConfig {
        servers: [DnsServer::default(); 3],
        count: 0,
        ndots: 0,
        search_domains: [[0; 256]; 6],
    };
    // SAFETY: repr(C) mirrors ios.c; it writes only within this initialized buffer.
    if unsafe { anagram_ios_read_dns(&mut raw) } != 0 {
        return Err(std::io::Error::other(
            "unable to read iOS resolver configuration",
        ));
    }
    let nameservers = raw
        .servers
        .iter()
        .take(raw.count.min(3) as usize)
        .filter_map(|server| {
            let port = if server.port == 0 { 53 } else { server.port };
            let addr = match server.family {
                4 => SocketAddr::from((
                    Ipv4Addr::new(
                        server.address[0],
                        server.address[1],
                        server.address[2],
                        server.address[3],
                    ),
                    port,
                )),
                6 => SocketAddr::V6(SocketAddrV6::new(
                    Ipv6Addr::from(server.address),
                    port,
                    0,
                    server.scope_id,
                )),
                _ => return None,
            };
            Some(Nameserver::new(addr, DnsProtocol::Udp))
        })
        .collect();
    let search_domains = raw
        .search_domains
        .iter()
        .filter_map(|domain| {
            let end = domain.iter().position(|byte| *byte == 0)?;
            if end == 0 {
                return None;
            }
            std::str::from_utf8(&domain[..end]).ok().map(str::to_owned)
        })
        .collect();
    Ok(Config {
        nameservers,
        search_domains,
        ndots: Some(raw.ndots as usize),
        ..Default::default()
    })
}
