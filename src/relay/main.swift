import Foundation

var upstream = URL(string: "https://chatgpt.com")!
var resources = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
var arguments = Array(CommandLine.arguments.dropFirst())
while !arguments.isEmpty {
    let flag = arguments.removeFirst()
    if flag == "--resources", !arguments.isEmpty {
        resources = URL(fileURLWithPath: arguments.removeFirst(), isDirectory: true)
    } else {
        #if RELAY_TESTING
        if flag == "--test-origin", !arguments.isEmpty,
           let url = URL(string: arguments.removeFirst()), url.scheme == "http", url.host == "127.0.0.1", url.port != nil, url.user == nil, url.password == nil {
            upstream = url
            continue
        }
        #endif
        FileHandle.standardError.write(Data("Unknown or invalid relay argument\n".utf8))
        exit(1)
    }
}
do {
    let server = try RelayServer(mainOrigin: upstream, resources: resources)
    try server.start()
    withExtendedLifetime(server) { dispatchMain() }
} catch {
    FileHandle.standardError.write(Data("Unable to start local relay\n".utf8))
    exit(1)
}
