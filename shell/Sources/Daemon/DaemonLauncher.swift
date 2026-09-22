import Foundation

/// Opening Gumbo.app brings up the whole stack — daemon (which starts the dashboard dev
/// server itself) and the dashboard window — and quitting shuts it all down again.
/// Ownership rule: only what the app STARTED gets stopped. A daemon already running
/// (a terminal `npm run dev:daemon`) is detected by its port and left untouched, so the
/// development workflow keeps working and ⌘Q never kills a terminal-owned process.
final class DaemonLauncher {
    private var owned: Process?
    private let daemonPort = 8737
    private let dashboardPort = 5173

    /// The repo checkout this app manages. Single machine, one standard location;
    /// overridable via `defaults write ai.scalinity.Gumbo RepoPath <path>`.
    private var repoRoot: URL {
        if let override = UserDefaults.standard.string(forKey: "RepoPath"), !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/Apps/Gumbo")
    }

    /// Ensure the daemon is up (spawning it when nothing answers), then call `ready` once
    /// the dashboard dev server responds — the moment the dashboard window can load.
    /// `ready` fires on the main queue; on a cold start that is a few seconds out.
    func ensureStack(ready: @escaping () -> Void) {
        probe(port: daemonPort) { [weak self] daemonUp in
            guard let self else { return }
            if !daemonUp { self.spawnDaemon() }
            // The daemon starts Vite itself; poll until the dashboard answers (or give up
            // quietly after ~40 s — a cold npm+Vite start takes a while; the window can
            // still be opened by hand later).
            self.waitFor(port: self.dashboardPort, attempts: 80, interval: 0.5) { up in
                if up { DispatchQueue.main.async(execute: ready) }
            }
        }
    }

    /// Quit tears down only an app-owned stack: SIGTERM to tsx (which kills its node
    /// child), plus the detached Vite server found by its port (the daemon deliberately
    /// spawns it detached so tsx reloads don't kill it — that means quit must).
    func shutdownIfOwned() {
        guard let daemon = owned else { return }
        daemon.terminate()
        let kill = Process()
        kill.executableURL = URL(fileURLWithPath: "/bin/zsh")
        kill.arguments = ["-c", "lsof -ti tcp:\(dashboardPort) | xargs kill 2>/dev/null"]
        try? kill.run()
        kill.waitUntilExit()
        daemon.waitUntilExit()
        owned = nil
    }

    // MARK: internals

    private func spawnDaemon() {
        let daemonDir = repoRoot.appendingPathComponent("daemon")
        guard FileManager.default.fileExists(atPath: daemonDir.appendingPathComponent("package.json").path) else {
            NSLog("DaemonLauncher: no daemon workspace at %@ — nothing to launch", daemonDir.path)
            return
        }
        let process = Process()
        // A login zsh supplies the PATH (node lives in homebrew's prefix); exec replaces
        // the shell with tsx, so terminate() lands SIGTERM on tsx directly and tsx takes
        // its node child down with it.
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "exec ../node_modules/.bin/tsx watch src/index.ts"]
        process.currentDirectoryURL = daemonDir
        // The daemon's console output is its debugging surface — append it to the shared
        // log home rather than discarding it.
        let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Gumbo/logs")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logPath = logDir.appendingPathComponent("daemon.log").path
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        if let log = FileHandle(forWritingAtPath: logPath) {
            log.seekToEndOfFile()
            process.standardOutput = log
            process.standardError = log
        } else {
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
        }
        do {
            try process.run()
            owned = process
            NSLog("DaemonLauncher: started daemon (pid %d)", process.processIdentifier)
        } catch {
            NSLog("DaemonLauncher: daemon spawn failed: %@", String(describing: error))
        }
    }

    private func probe(port: Int, done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
        request.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: request) { _, response, _ in
            done(response != nil)
        }.resume()
    }

    private func waitFor(port: Int, attempts: Int, interval: TimeInterval, done: @escaping (Bool) -> Void) {
        probe(port: port) { [weak self] up in
            if up { done(true); return }
            guard attempts > 1, let self else { done(false); return }
            DispatchQueue.global().asyncAfter(deadline: .now() + interval) {
                self.waitFor(port: port, attempts: attempts - 1, interval: interval, done: done)
            }
        }
    }
}
