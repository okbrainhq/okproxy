import Darwin
import Foundation

/// A `host:port` endpoint with IPv6-literal support.
///
/// The old validation was a bare `contains(":")`, which accepted nonsense such
/// as `::1` or `host:notaport` and could not round-trip an IPv6 literal. Rules:
///
/// - IPv4/hostnames: exactly one `:`, a non-empty host and a numeric port.
/// - IPv6 literals must be bracketed (`[::1]:9443`); a bare value with more than
///   one `:` is rejected instead of being guessed at, because `::1:9443` is
///   ambiguous.
/// - Ports are validated as 1...65535.
/// - `serialized` always emits the canonical bracketed form for IPv6, which is
///   what gets passed to the Node client.
struct Endpoint: Equatable, CustomStringConvertible {
    let host: String
    let port: Int

    var isIPv6Literal: Bool { host.contains(":") }

    var serialized: String {
        isIPv6Literal ? "[\(host)]:\(port)" : "\(host):\(port)"
    }

    var description: String { serialized }

    static func parse(_ raw: String) -> Endpoint? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.hasPrefix("[") {
            guard let closing = trimmed.firstIndex(of: "]") else { return nil }
            let host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<closing])
            let remainder = trimmed[trimmed.index(after: closing)...]
            guard remainder.hasPrefix(":"),
                  let port = validatedPort(String(remainder.dropFirst())),
                  isValidIPv6Literal(host)
            else { return nil }
            return Endpoint(host: host, port: port)
        }

        let colonCount = trimmed.reduce(into: 0) { count, character in
            if character == ":" { count += 1 }
        }
        guard colonCount == 1 else { return nil }

        let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let host = String(parts[0])
        guard !host.isEmpty,
              !host.contains(where: { $0.isWhitespace }),
              let port = validatedPort(String(parts[1]))
        else { return nil }
        return Endpoint(host: host, port: port)
    }

    private static func validatedPort(_ raw: String) -> Int? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.allSatisfy(\.isNumber), let port = Int(trimmed) else { return nil }
        guard (1...65535).contains(port) else { return nil }
        return port
    }

    private static func isValidIPv6Literal(_ host: String) -> Bool {
        guard host.contains(":") else { return false }
        var address = in6_addr()
        return host.withCString { inet_pton(AF_INET6, $0, &address) } == 1
    }
}
