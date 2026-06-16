// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OkProxyClient",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OkProxyClient", targets: ["OkProxyClient"])
    ],
    targets: [
        .executableTarget(name: "OkProxyClient")
    ]
)
