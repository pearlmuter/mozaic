// Mozaic.app: a native window around the Mozaic UI.
// It sets up a private Python environment on first launch, starts the Mozaic server (which installs
// and runs its own ComfyUI), shows the UI in a WKWebView, and shuts everything down on quit.
// If a Mozaic server is already running it just connects to it.

import Cocoa
import WebKit

let port = 47811
let baseURL = URL(string: "http://127.0.0.1:\(port)/")!

let appSupport = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Mozaic")
let runtimeDir = appSupport.appendingPathComponent("runtime")
let logDir = appSupport.appendingPathComponent("logs")

/// Runs the Mozaic server from a private Python environment that the app creates on first launch
/// (and again after an update) from the backend source bundled in Resources/backend.
final class Backend {
    private(set) var process: Process?

    private var resources: URL { Bundle.main.resourceURL! }
    private var bundledUV: URL { resources.appendingPathComponent("bin/uv") }
    private var venvPython: URL { runtimeDir.appendingPathComponent("venv/bin/python") }
    private var stampURL: URL { runtimeDir.appendingPathComponent("build-id.txt") }
    private var buildID: String {
        (try? String(contentsOf: resources.appendingPathComponent("build-id.txt"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "dev"
    }

    var needsSetup: Bool {
        let stamp = (try? String(contentsOf: stampURL, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        return stamp != buildID || !FileManager.default.isExecutableFile(atPath: venvPython.path)
    }

    func isRunning(completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/status"))
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            completion((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    private func logHandle(_ name: String) throws -> FileHandle {
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let url = logDir.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        handle.seekToEndOfFile()
        return handle
    }

    private func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["UV_PYTHON_INSTALL_DIR"] = appSupport.appendingPathComponent("python").path
        env["UV_CACHE_DIR"] = appSupport.appendingPathComponent("cache/uv").path
        env["UV_PYTHON_PREFERENCE"] = "only-managed"
        env["UV_PROJECT_ENVIRONMENT"] = runtimeDir.appendingPathComponent("venv").path
        env["MOZAIC_UV"] = runtimeDir.appendingPathComponent("uv").path
        return env
    }

    /// Creates or updates the private Python environment. Blocking; call off the main thread.
    func setup() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: runtimeDir, withIntermediateDirectories: true)
        let uv = runtimeDir.appendingPathComponent("uv")
        try? fm.removeItem(at: uv)
        try fm.copyItem(at: bundledUV, to: uv)

        let p = Process()
        p.executableURL = uv
        p.arguments = ["sync", "--frozen", "--no-editable", "--no-dev", "--project", resources.appendingPathComponent("backend").path]
        p.currentDirectoryURL = runtimeDir
        p.environment = environment()
        let log = try logHandle("setup.log")
        p.standardOutput = log
        p.standardError = log
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw NSError(domain: "Mozaic", code: 3, userInfo: [NSLocalizedDescriptionKey:
                "Setting up Mozaic failed. Check your internet connection and reopen the app. Details: ~/Library/Application Support/Mozaic/logs/setup.log"])
        }
        try buildID.write(to: stampURL, atomically: true, encoding: .utf8)
    }

    func start() throws {
        let p = Process()
        p.executableURL = venvPython
        p.arguments = ["-m", "mozaic", "serve", "--port", "\(port)"]
        p.currentDirectoryURL = appSupport
        let log = try logHandle("server.log")
        p.standardOutput = log
        p.standardError = log
        p.environment = environment()
        try p.run()
        process = p
    }

    /// Asks the server to shut down cleanly (it stops ComfyUI too), then waits a little.
    func stop() {
        guard let p = process, p.isRunning else { return }
        p.interrupt()
        let deadline = Date().addingTimeInterval(12)
        while p.isRunning && Date() < deadline { usleep(100_000) }
        if p.isRunning { p.terminate() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let backend = Backend()
    var attempts = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        // Set the Dock icon from the bundle so a rebuilt icon shows even when macOS has the old one cached.
        if let url = Bundle.main.url(forResource: "Mozaic", withExtension: "icns"), let icon = NSImage(contentsOf: url) {
            NSApp.applicationIconImage = icon
        }

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "mozaic")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadHTMLString(Self.splash("Starting Mozaic…"), baseURL: nil)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Mozaic"
        window.backgroundColor = NSColor(red: 0.055, green: 0.059, blue: 0.067, alpha: 1)
        window.minSize = NSSize(width: 1080, height: 680)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("MozaicMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        backend.isRunning { running in
            if running {
                DispatchQueue.main.async { self.waitForServer() }
                return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    if self.backend.needsSetup {
                        DispatchQueue.main.async {
                            self.webView.loadHTMLString(Self.splash("Preparing Mozaic…<br><span style='opacity:.6'>One-time setup, about a minute.</span>"), baseURL: nil)
                        }
                        try self.backend.setup()
                    }
                    try self.backend.start()
                    DispatchQueue.main.async { self.waitForServer() }
                } catch {
                    DispatchQueue.main.async {
                        self.webView.loadHTMLString(Self.splash(error.localizedDescription, error: true), baseURL: nil)
                    }
                }
            }
        }
    }

    func waitForServer() {
        backend.isRunning { running in
            DispatchQueue.main.async {
                if running {
                    self.webView.load(URLRequest(url: baseURL))
                } else if self.attempts < 120 {
                    self.attempts += 1
                    if let p = self.backend.process, !p.isRunning {
                        self.webView.loadHTMLString(Self.splash("The Mozaic server stopped. Details: ~/Library/Application Support/Mozaic/logs/server.log", error: true), baseURL: nil)
                        return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForServer() }
                } else {
                    self.webView.loadHTMLString(Self.splash("The Mozaic server did not start.", error: true), baseURL: nil)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        backend.stop()
    }

    // MARK: JS bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "saveAs":
            guard let path = body["path"] as? String else { return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (body["name"] as? String) ?? URL(fileURLWithPath: path).lastPathComponent
            panel.allowedContentTypes = [.png]
            panel.beginSheetModal(for: window) { resp in
                guard resp == .OK, let dest = panel.url else { return }
                try? FileManager.default.removeItem(at: dest)
                do { try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: dest) } catch {
                    NSAlert(error: error).beginSheetModal(for: self.window)
                }
            }
        case "copyImage":
            guard let path = body["path"] as? String, let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return }
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setData(data, forType: .png)
            if let img = NSImage(data: data), let tiff = img.tiffRepresentation { pb.setData(tiff, forType: .tiff) }
        case "openUrl":
            if let s = body["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
        default:
            break
        }
    }

    // MARK: WKUIDelegate: file inputs, alert/confirm

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.beginSheetModal(for: window) { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { resp in completionHandler(resp == .alertFirstButtonReturn) }
    }

    // Links to anything other than the local server open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated, url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Menu

    @objc func reload() { webView.load(URLRequest(url: baseURL)) }

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem()
            let menu = NSMenu(title: title)
            items.forEach { menu.addItem($0) }
            item.submenu = menu
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        sub("Mozaic", [
            item("About Mozaic", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Hide Mozaic", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            item("Quit Mozaic", #selector(NSApplication.terminate(_:)), "q"),
        ])
        sub("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "Z"),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        sub("View", [
            item("Reload", #selector(reload), "r"),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        sub("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
        ])
        NSApp.mainMenu = main
    }

    // The app logo, inlined because the splash page has no server to load it from.
    static let markURI: String = {
        guard let url = Bundle.main.url(forResource: "mark", withExtension: "png"), let data = try? Data(contentsOf: url) else { return "" }
        return "data:image/png;base64," + data.base64EncodedString()
    }()

    static func splash(_ text: String, error: Bool = false) -> String {
        let color = error ? "#ff8a8a" : "#a6a9b3"
        return """
        <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0e0f11;color:\(color);font:13px -apple-system">
        <img src="\(markURI)" width="56" height="56" alt=""><div style="max-width:520px;text-align:center">\(text)</div></body></html>
        """
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
