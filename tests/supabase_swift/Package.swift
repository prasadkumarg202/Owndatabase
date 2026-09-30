// swift-tools-version:5.9
// The official Supabase Swift client against an OwnDatabase project (run by tests/test_sdk_swift.py).
import PackageDescription

let package = Package(
  name: "OdbSwiftCompat",
  platforms: [.macOS(.v13)],
  dependencies: [.package(url: "https://github.com/supabase/supabase-swift.git", from: "2.5.0")],
  targets: [
    .executableTarget(name: "Compat", dependencies: [.product(name: "Supabase", package: "supabase-swift")]),
  ]
)
