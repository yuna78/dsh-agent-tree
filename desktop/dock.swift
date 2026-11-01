// desktop/dock.swift — Agent Tree Dock 桌面壳（macOS）
//
// 「跑出 DSH 窗口」的原生半边。网页永远画不出视口之外，所以和 dsh-maoxuan-pet 的桌宠壳
// 同一个思路：进程独立于 DSH，透明、无边框、置顶、跨所有 Space 的 NSWindow + WKWebView，
// 渲染页 dock.html 复用 client.js 的 MiniInner —— 桌面上的卡片和 DSH 页内那张长得一模一样。
//
//   - 状态：本进程轮询宿主 `GET /local/dsh-agent-tree/dock/state`（带 token）后注入页面，
//     页面全程零网络（WebKit 的 ATS 不放行 file:// 页面直连 http，索性一层都不走）；
//   - 点击：页面 → 这里 `POST /local/dsh-agent-tree/dock/action` → 宿主排队 →
//     浏览器那头的卡片在下次发布响应里取走并 openSession；
//   - 交互矩形：页面上报，白名单之外点击穿透到桌面（等价 dsh-tauri 的 set_pet_input_region）；
//   - 窗口尺寸：随卡片内容变化（收起成胶囊时窗口跟着变矮），顶边保持不动。
//
// 用法：dsh-agent-tree-dock [--origin=URL | --port=N] [--token=HEX] [--reset] [--verbose]
// 握手：不传参数时读 `$DSH_HOME`（默认 `~/.dsh`）里的 `agent-tree-dock-<port>.json`
//       ——宿主插件启动时写的（0600，只有 origin / port / token）。
// 退出：右键卡片 → 退出浮窗。

import AppKit
import WebKit

// MARK: - 配置

enum Shell {
    static var origin = ""
    static var token = ""
    static var verbose = false
    static let statePath = "/local/dsh-agent-tree/dock/state"
    static let actionPath = "/local/dsh-agent-tree/dock/action"
    static let tokenHeader = "x-agent-tree-dock-token"
    static let windowWidth: CGFloat = 548
    static let defaultHeight: CGFloat = 560
    static let minHeight: CGFloat = 220
    static let maxHeight: CGFloat = 980
    static let dshBundleID = "com.deepseek.dsh"
    static let defaults = UserDefaults(suiteName: "dsh-plugin-agent-tree.dock")!

    static func log(_ message: String) {
        guard verbose else { return }
        FileHandle.standardError.write(Data("[agent-tree-dock] \(message)\n".utf8))
    }
}

// MARK: - 无边框窗口要显式声明可成为 key（Esc 关菜单、按钮聚焦需要键盘事件）

final class DockWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - 点击穿透容器：白名单矩形之外，鼠标事件全部放行给桌面

final class ClickThroughView: NSView {
    weak var webView: WKWebView?
    /// 容器本地坐标（左下原点）；矩形之外 hitTest 返回 nil → 点击落到下层窗口。
    var passRects: [CGRect] = []

    override func hitTest(_ aPoint: NSPoint) -> NSView? {
        let local: NSPoint
        if let superview {
            local = convert(aPoint, from: superview)
        } else {
            local = aPoint
        }
        for rect in passRects where rect.contains(local) {
            return webView
        }
        return nil
    }
}

// MARK: - 握手描述文件（宿主插件启动时写在 DSH home 下）

struct Descriptor {
    let origin: String
    let token: String
    let port: Int
    let path: String
}

private func dshHome() -> String {
    if let explicit = ProcessInfo.processInfo.environment["DSH_HOME"], !explicit.isEmpty {
        return explicit
    }
    return NSHomeDirectory() + "/.dsh"
}

/// home 下所有 `agent-tree-dock-*.json`，按修改时间新→旧（多个 DSH 实例时最新的优先）。
private func readDescriptors() -> [Descriptor] {
    let fm = FileManager.default
    let dir = dshHome()
    guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
    var found: [(Date, Descriptor)] = []
    for name in entries where name.hasPrefix("agent-tree-dock-") && name.hasSuffix(".json") {
        let path = dir + "/" + name
        guard let data = fm.contents(atPath: path),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let origin = object["origin"] as? String,
              let token = object["token"] as? String else { continue }
        var mtime = Date.distantPast
        if let attributes = try? fm.attributesOfItem(atPath: path),
           let date = attributes[.modificationDate] as? Date {
            mtime = date
        }
        found.append((mtime, Descriptor(origin: origin, token: token, port: object["port"] as? Int ?? 0, path: path)))
    }
    return found.sorted { $0.0 > $1.0 }.map { $0.1 }
}

// MARK: - 主控制器

final class ShellController: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: DockWindow!
    private var webView: WKWebView!
    private var clickView: ClickThroughView!
    /// ephemeral：无磁盘缓存/cookie，壳不写任何本地数据
    private var http: URLSession = URLSession(configuration: .ephemeral)
    private var pollItem: DispatchWorkItem?
    private var pageReady = false
    private var failures = 0
    private var announcedOffline = false
    private var lastStateJSON: String?
    private var dragBaseOrigin: NSPoint?
    /// 页面上报的可交互矩形（CSS px，左上原点）；窗口高度变化时重算 passRects
    private var pendingHits: [[String: Any]] = []

    // MARK 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSRect(x: 0, y: 0, width: Shell.windowWidth, height: Shell.defaultHeight)
        let window = DockWindow(
            contentRect: restoredFrame() ?? defaultFrame(),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.isMovableByWindowBackground = false
        window.acceptsMouseMovedEvents = true
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = false

        let container = ClickThroughView(frame: content)
        container.wantsLayer = true

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "dock")

        let webView = WKWebView(frame: container.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // WKWebView 画透明底的两件套
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear

        container.webView = webView
        container.addSubview(webView)
        window.contentView = container

        self.window = window
        self.webView = webView
        self.clickView = container

        if let html = locateHTML() {
            webView.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        } else {
            FileHandle.standardError.write(Data("[agent-tree-dock] 找不到 dock.html（应与可执行文件同目录，重新 npm run dock:build）\n".utf8))
            NSApp.terminate(nil)
            return
        }

        window.orderFrontRegardless()
        Shell.log("Agent Tree Dock 已站上桌面 — \(Shell.origin.isEmpty ? "(等握手文件)" : Shell.origin)")
        schedulePoll(after: Shell.origin.isEmpty ? 1 : 0.2)
    }

    func applicationWillTerminate(_ notification: Notification) {
        persistFrame()
    }

    /// dock.html 与可执行文件同目录（build.sh 负责收集）。
    private func locateHTML() -> URL? {
        let argv0 = CommandLine.arguments.first ?? "dsh-agent-tree-dock"
        let executable = URL(fileURLWithPath: argv0).resolvingSymlinksInPath()
        let candidate = executable.deletingLastPathComponent().appendingPathComponent("dock.html")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    // MARK 窗口位置与尺寸

    private func defaultFrame() -> NSRect {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSRect(
            x: visible.maxX - Shell.windowWidth - 24,
            y: visible.minY + 24,
            width: Shell.windowWidth,
            height: Shell.defaultHeight
        )
    }

    private func restoredFrame() -> NSRect? {
        guard ProcessInfo.processInfo.arguments.contains("--reset") == false,
              let raw = Shell.defaults.string(forKey: "frame") else { return nil }
        let frame = NSRectFromString(raw)
        let widthOK = abs(frame.width - Shell.windowWidth) < 1
        let heightOK = frame.height >= Shell.minHeight && frame.height <= Shell.maxHeight
        let onScreen = NSScreen.screens.contains { $0.visibleFrame.intersects(frame) }
        guard widthOK, heightOK, onScreen else { return nil }
        return frame
    }

    private func persistFrame() {
        guard let window else { return }
        Shell.defaults.set(NSStringFromRect(window.frame), forKey: "frame")
        Shell.log("frame saved: \(NSStringFromRect(window.frame))")
    }

    private func resetFrame() {
        Shell.defaults.removeObject(forKey: "frame")
        let frame = defaultFrame()
        window.setFrame(frame, display: true)
        persistFrame()
    }

    /// 窗口高度随卡片内容变；顶边保持不动（卡片钉在窗口顶部留白处，视觉上位置不跳）。
    private func setContentHeight(_ height: CGFloat) {
        let clamped = min(max(height, Shell.minHeight), Shell.maxHeight)
        applyPassRects()
        guard let window, abs(window.frame.height - clamped) >= 1 else { return }
        var frame = window.frame
        let topY = frame.maxY
        frame.size.height = clamped
        frame.origin.y = topY - clamped
        window.setFrame(fitToScreen(frame), display: true)
        applyPassRects()
        persistFrame()
    }

    /// 拖拽落点收敛：窗口至少留 140pt 在可见区域内，防止拖丢。
    private func fitToScreen(_ frame: NSRect) -> NSRect {
        let screen = NSScreen.screens.first { $0.visibleFrame.intersects(frame) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var result = frame
        result.origin.x = min(max(result.origin.x, visible.minX - result.width + 140), visible.maxX - 140)
        result.origin.y = min(max(result.origin.y, visible.minY - result.height + 140), visible.maxY - 40)
        return result
    }

    /// 页面上报的 CSS 矩形（左上原点）→ 容器本地坐标（左下原点）。
    private func applyPassRects() {
        let contentHeight = webView.bounds.height
        clickView.passRects = pendingHits.compactMap { dict in
            guard let x = (dict["x"] as? NSNumber)?.doubleValue,
                  let y = (dict["y"] as? NSNumber)?.doubleValue,
                  let w = (dict["w"] as? NSNumber)?.doubleValue,
                  let h = (dict["h"] as? NSNumber)?.doubleValue,
                  w > 0, h > 0 else { return nil }
            return CGRect(x: x, y: contentHeight - (y + h), width: w, height: h)
        }
        Shell.log("pass rects: \(clickView.passRects.count) height: \(Int(contentHeight))")
    }

    // MARK 握手

    private func discover() {
        let candidates = readDescriptors()
        guard let newest = candidates.first else {
            Shell.log("no agent-tree-dock-*.json under \(dshHome()) — DSH 没起，或插件没装/没重启")
            return
        }
        // 多个实例时优先挑「正被浏览器发布」的那个（快照 30s 内新鲜），
        // 避免连到一个没人开页面的实例；全都停着就用最新的，等它的页面连上来。
        let live = candidates.first { isLive($0) }
        let adopted = live ?? newest
        Shell.origin = adopted.origin
        Shell.token = adopted.token
        Shell.log("descriptor: \(adopted.path) → \(adopted.origin)\(live == nil ? "（暂无活跃发布者，先用最新文件）" : "（活跃）")")
    }

    /// 同步探测一个候选实例：带它的 token 拉一次 state，看有没有浏览器在发布。
    /// 只在发现阶段调用（401 / 断连 / 重读握手文件），不在轮询热路径上。
    private func isLive(_ descriptor: Descriptor) -> Bool {
        guard let url = URL(string: descriptor.origin + Shell.statePath) else { return false }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        request.httpMethod = "GET"
        request.setValue(descriptor.token, forHTTPHeaderField: Shell.tokenHeader)
        let semaphore = DispatchSemaphore(value: 0)
        var fresh = false
        http.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data,
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let state = object["state"], !(state is NSNull) else { return }
            let now = (object["now"] as? NSNumber)?.doubleValue ?? 0
            let at = (object["at"] as? NSNumber)?.doubleValue ?? 0
            fresh = now - at < 30_000
        }.resume()
        _ = semaphore.wait(timeout: .now() + 3)
        return fresh
    }

    // MARK 轮询（原生层负责全部 HTTP，页面零网络）

    private func schedulePoll(after interval: TimeInterval) {
        pollItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.pollNow() }
        pollItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + interval, execute: item)
    }

    private func pollNow() {
        if Shell.origin.isEmpty || Shell.token.isEmpty { discover() }
        guard !Shell.origin.isEmpty, !Shell.token.isEmpty, let url = URL(string: Shell.origin + Shell.statePath) else {
            schedulePoll(after: 3)
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        request.httpMethod = "GET"
        request.setValue(Shell.token, forHTTPHeaderField: Shell.tokenHeader)
        http.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                self?.handlePoll(data: data, response: response, error: error)
            }
        }.resume()
    }

    private func handlePoll(data: Data?, response: URLResponse?, error: Error?) {
        if let error {
            Shell.log("state failed: \(error.localizedDescription)")
            return pollFailed()
        }
        guard let http = response as? HTTPURLResponse else { return pollFailed() }
        if http.statusCode == 401 {
            // token 轮换（DSH 重启过）：重新读描述文件
            Shell.log("state HTTP 401 — 重读握手文件")
            Shell.origin = ""
            Shell.token = ""
            discover()
            return schedulePoll(after: 2)
        }
        guard http.statusCode == 200, let data,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            Shell.log("state HTTP \(http.statusCode)")
            return pollFailed()
        }
        failures = 0

        // 浏览器页面还没发布过，或者快照太旧（页面关了）：显示离线态
        let now = (object["now"] as? NSNumber)?.doubleValue ?? 0
        let stateAt = (object["at"] as? NSNumber)?.doubleValue ?? 0
        let stale = object["state"] == nil || object["state"] is NSNull || (now - stateAt > 30_000)
        if stale {
            lastStateJSON = nil
            announceOffline()
            return schedulePoll(after: 2)
        }

        guard let stateObject = object["state"],
              let stateData = try? JSONSerialization.data(withJSONObject: stateObject),
              let stateText = String(data: stateData, encoding: .utf8) else {
            announceOffline()
            return schedulePoll(after: 2)
        }
        announcedOffline = false
        if stateText != lastStateJSON {
            lastStateJSON = stateText
            // base64 包一层：避免把 JSON 拼进 JS 字符串时的转义/换行问题
            let encoded = Data(stateText.utf8).base64EncodedString()
            evaluate("window.__dockStateB64 && window.__dockStateB64('\(encoded)');")
        }
        schedulePoll(after: 1)
    }

    private func pollFailed() {
        failures += 1
        if failures >= 4 { announceOffline() }
        // 连不上的原因也可能是「这个实例没了，新的在别的端口」：定期重读握手文件
        if failures % 4 == 0 { Shell.origin = ""; Shell.token = "" }
        schedulePoll(after: 3)
    }

    private func announceOffline() {
        guard !announcedOffline else { return }
        announcedOffline = true
        evaluate("window.__dockOffline && window.__dockOffline();")
    }

    private func evaluate(_ source: String) {
        guard pageReady else { return }
        webView.evaluateJavaScript(source, completionHandler: { _, error in
            if let error { Shell.log("evaluate failed: \(error.localizedDescription)") }
        })
    }

    // MARK 回传动作（点行 → 浏览器 openSession）

    private func postOpen(id: String) {
        guard let url = URL(string: Shell.origin + Shell.actionPath) else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        request.httpMethod = "POST"
        request.setValue(Shell.token, forHTTPHeaderField: Shell.tokenHeader)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": "open", "id": id])
        Shell.log("open session: \(id)")
        http.dataTask(with: request) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let bodyText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            Shell.log("open → \(status) \(String(bodyText.prefix(120)))\(error.map { " \($0.localizedDescription)" } ?? "")")
        }.resume()
        // 让 DSH 应用到前台来接这次跳转（web 版跑在浏览器里时只发指令，不抢焦点）
        activateDSH()
    }

    private func activateDSH() {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: Shell.dshBundleID).first {
            app.activate()
            return
        }
        if let url = URL(string: Shell.origin), !Shell.origin.isEmpty {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        Shell.log("page ready")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Shell.log("page load failed: \(error.localizedDescription)")
    }

    /// <a href> 点到外链（检查更新面板里的 GitHub Releases 等）→ 交给系统默认浏览器。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// window.open（点别的 dsh 实例的会话行）→ 同样交给系统默认浏览器。
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK WKScriptMessageHandler（页面 → 原生）

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dock",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            pageReady = true
            Shell.log("page ready (script)")
            injectLastState()
            pollNow()

        case "layout":
            // 可交互矩形 + 期望的窗口尺寸（内容外沿 + 留白）
            if let hits = body["hit"] as? [[String: Any]] {
                pendingHits = hits
                applyPassRects()
            }
            if let height = (body["size"] as? [String: Any])?["h"] as? NSNumber {
                setContentHeight(CGFloat(height.doubleValue))
            }

        case "dragstart":
            dragBaseOrigin = window.frame.origin

        case "dragto":
            guard let base = dragBaseOrigin,
                  let dx = (body["dx"] as? NSNumber)?.doubleValue,
                  let dy = (body["dy"] as? NSNumber)?.doubleValue else { return }
            var frame = window.frame
            frame.origin = fitToScreen(NSRect(
                x: base.x + CGFloat(dx),
                y: base.y - CGFloat(dy), // 页面 dy 向下；AppKit 的 y 向上
                width: frame.width,
                height: frame.height
            )).origin
            window.setFrame(frame, display: true)

        case "dragend":
            dragBaseOrigin = nil
            persistFrame()

        case "open":
            if let id = body["id"] as? String, !id.isEmpty {
                postOpen(id: id)
            }

        case "config":
            handleConfig(body["action"] as? String)

        default:
            break
        }
    }

    private func injectLastState() {
        guard let text = lastStateJSON else { return }
        let encoded = Data(text.utf8).base64EncodedString()
        evaluate("window.__dockStateB64 && window.__dockStateB64('\(encoded)');")
    }

    private func handleConfig(_ action: String?) {
        switch action {
        case "focus":
            activateDSH()
        case "reset":
            resetFrame()
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}

// MARK: - 入口

let arguments = ProcessInfo.processInfo.arguments
var index = 1
while index < arguments.count {
    let argument = arguments[index]
    if argument.hasPrefix("--origin=") {
        var value = String(argument.dropFirst("--origin=".count))
        while value.hasSuffix("/") { value.removeLast() }
        Shell.origin = value
    } else if argument.hasPrefix("--port=") {
        Shell.origin = "http://127.0.0.1:\(argument.dropFirst("--port=".count))"
    } else if argument.hasPrefix("--token=") {
        Shell.token = String(argument.dropFirst("--token=".count))
    } else if argument == "--verbose" {
        Shell.verbose = true
    }
    index += 1
}

// --origin 指定了但没给 --token：按 origin 从描述文件里配对（找不到就等轮询里重试）
if !Shell.origin.isEmpty, Shell.token.isEmpty {
    if let match = readDescriptors().first(where: { $0.origin == Shell.origin }) {
        Shell.token = match.token
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 不占 Dock、不进 Cmd-Tab
let controller = ShellController()
app.delegate = controller
app.run()
