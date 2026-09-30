// The official Supabase Swift client against an OwnDatabase project.
// tests/test_sdk_swift.py prepares the project and sets ODB_URL, ODB_ANON_KEY, ODB_SERVICE_KEY.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Supabase

let env = ProcessInfo.processInfo.environment
let url = URL(string: env["ODB_URL"]!)!          // http://<host>/p/<projectId>
let anon = env["ODB_ANON_KEY"]!
let service = env["ODB_SERVICE_KEY"]!

struct Fail: Error, CustomStringConvertible { let description: String }
func expect(_ cond: Bool, _ what: @autoclosure () -> String) throws { if !cond { throw Fail(description: what()) } }

var failures = 0
func check(_ name: String, _ body: () async throws -> Void) async {
  do { try await body(); print("ok   \(name)") } catch { failures += 1; print("FAIL \(name): \(error)") }
}

// in-memory session storage and the implicit flow (no keychain on Linux)
final class MemoryStorage: AuthLocalStorage, @unchecked Sendable {
  private var items: [String: Data] = [:]
  func store(key: String, value: Data) throws { items[key] = value }
  func retrieve(key: String) throws -> Data? { items[key] }
  func remove(key: String) throws { items[key] = nil }
}
func client(_ key: String) -> SupabaseClient {
  SupabaseClient(supabaseURL: url, supabaseKey: key,
                 options: SupabaseClientOptions(auth: .init(storage: MemoryStorage(), flowType: .implicit)))
}

struct Item: Codable { let id: Int; let name: String }
struct Note: Codable { let body: String }
struct Echo: Codable { let got: Int }

let db = client(anon)
let admin = client(service)

await check("postgrest: select, filters, count, single, insert/delete, rpc") {
  let rows: [Item] = try await db.from("swift_items").select("id,name").gte("price", value: 20).order("price", ascending: false).execute().value
  try expect(rows.map(\.name) == ["gamma", "beta"], "filter/order \(rows)")
  let counted = try await db.from("swift_items").select("id", head: true, count: .exact).execute()
  try expect(counted.count == 3, "count \(String(describing: counted.count))")
  let one: Item = try await db.from("swift_items").select("id,name").eq("id", value: 1).single().execute().value
  try expect(one.name == "alpha", "single \(one)")
  try await admin.from("swift_items").insert(["id": AnyJSON.integer(9), "name": .string("nine"), "price": .integer(9)]).execute()
  try await admin.from("swift_items").delete().eq("id", value: 9).execute()
  let sum: Int = try await db.rpc("swift_add", params: ["a": 2, "b": 5]).execute().value
  try expect(sum == 7, "rpc \(sum)")
}

await check("auth: sign up, sign in, user, RLS, sign out") {
  let email = "swift-\(Int(Date().timeIntervalSince1970 * 1000))@example.com"
  let up = try await db.auth.signUp(email: email, password: "password-123", data: ["plan": .string("free")])
  try expect(up.user.email == email, "signUp")
  let session = try await db.auth.signIn(email: email, password: "password-123")
  try expect(!session.accessToken.isEmpty, "no session")
  let me = try await db.auth.user()
  try expect(me.userMetadata["plan"] == .string("free"), "metadata \(me.userMetadata)")
  try await db.from("swift_notes").insert(["body": "mine"]).execute()
  let mine: [Note] = try await db.from("swift_notes").select("body").execute().value
  try expect(mine.map(\.body) == ["mine"], "rls \(mine)")
  try await db.auth.signOut()
  let none: [Note] = try await db.from("swift_notes").select("body").execute().value
  try expect(none.isEmpty, "after sign out \(none)")
}

await check("storage: upload, download, list, signed URL, remove") {
  let b = admin.storage.from("swift")
  _ = try await b.upload("dir/hello.txt", data: Data("hello swift".utf8), options: FileOptions(contentType: "text/plain", upsert: true))
  let data = try await b.download(path: "dir/hello.txt")
  try expect(String(decoding: data, as: UTF8.self) == "hello swift", "download")
  let files = try await b.list(path: "dir")
  try expect(files.contains { $0.name == "hello.txt" }, "list")
  let signed = try await b.createSignedURL(path: "dir/hello.txt", expiresIn: 60)
  let (body, _) = try await URLSession.shared.data(from: signed)
  try expect(String(decoding: body, as: UTF8.self) == "hello swift", "signed url \(signed)")
  _ = try await b.remove(paths: ["dir/hello.txt"])
}

await check("functions.invoke") {
  let r: Echo = try await db.functions.invoke("swift-echo", options: FunctionInvokeOptions(body: ["n": 3]))
  try expect(r.got == 3, "invoke \(r)")
}

print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
