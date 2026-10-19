// brain-auth "<reason>": asks the person at this Mac to confirm with Touch ID
// (or their Mac login password when Touch ID is unavailable). Exit 0 when they
// confirm, 1 when they cancel or fail, 2 when the Mac cannot ask at all.
// Drydock compiles this once into the workspace and runs it before it reads
// a secret from Bitwarden/Vaultwarden, whose CLI has no biometric unlock.
import Foundation
import LocalAuthentication

let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Drydock wants to use a secret"
let context = LAContext()
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
  FileHandle.standardError.write("cannot ask: \(error?.localizedDescription ?? "unknown")\n".data(using: .utf8)!)
  exit(2)
}
let done = DispatchSemaphore(value: 0)
var ok = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, err in
  ok = success
  if !success { FileHandle.standardError.write("\(err?.localizedDescription ?? "cancelled")\n".data(using: .utf8)!) }
  done.signal()
}
done.wait()
exit(ok ? 0 : 1)
