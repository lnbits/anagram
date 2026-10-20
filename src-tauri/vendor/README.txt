iOS compatibility patches

netwatch 0.19.3:
Source: crates.io release, upstream n0-computer/net-tools commit
0030e57fc70981895bb86212ff0f059cc41c8a4e (netwatch/).
Only Cargo.toml changes: on iOS, disable netdev's default features and retain
gateway support. This avoids its optional macOS-only SCDynamicStore and
SCNetworkConfiguration metadata enrichment on iOS. Other targets are unchanged.
Licenses are copied from that upstream commit.

n0-dns-resolver 0.1.0:
Source: crates.io release. Existing source and MIT/Apache licenses preserved.
Only iOS uses the new ios.c/ios.rs reader, built with cc. The reader uses the
public libresolv APIs to obtain IPv4/IPv6 resolver addresses, scope IDs, search
domains and ndots. Other Apple platforms retain the upstream implementation.
Failures retain the resolver's existing configured fallback behavior. As with
the upstream reader, this does not enumerate split-DNS per-domain resolvers.

Apple's iOS SDK marks SCDynamicStore and SCNetworkConfiguration APIs unavailable
on iOS. Do not solve the link failure by importing these private APIs.
Remove these patches when upstream supports iOS through public APIs.

netdev retains the repository's upstream pin
1327c36c32027d7252093cc1b58d9abd5a351496, including its libc compatibility fix.
