// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OkProxyClient",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OkProxyClient", targets: ["OkProxyClient"]),
        .executable(name: "OkProxyProcessHelper", targets: ["OkProxyProcessHelper"])
    ],
    targets: [
        .executableTarget(name: "OkProxyClient"),
        .executableTarget(name: "OkProxyProcessHelper")
    ]
)
