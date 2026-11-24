import SwiftUI
import WebKit

@main
struct SupportDeskApp: App {
    var body: some Scene {
        WindowGroup { DashboardScreen() }
    }
}

private let dashboard = URL(string: "https://starpilot-log-relay.nathan-g-hubbard.workers.dev/dashboard/ios")!

private struct DashboardScreen: View {
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        if failed {
            ContentUnavailableView {
                Label("Dashboard unavailable", systemImage: "wifi.exclamationmark")
            } actions: {
                Button("Try again") {
                    attempt += 1
                    failed = false
                }
            }
        } else {
            DashboardView(failed: $failed).id(attempt)
        }
    }
}

private struct DashboardView: UIViewRepresentable {
    @Binding var failed: Bool

    func makeCoordinator() -> Coordinator { Coordinator(failed: $failed) }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.load(URLRequest(url: dashboard))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var failed: Bool

        init(failed: Binding<Bool>) { _failed = failed }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.scheme == "https" else {
                decisionHandler(.cancel)
                return
            }
            if url.host == dashboard.host && url.port == nil {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                if action.navigationType == .linkActivated { UIApplication.shared.open(url) }
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) { handle(error) }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!,
                     withError error: Error) { handle(error) }

        private func handle(_ error: Error) {
            let failure = error as NSError
            if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
            failed = true
        }
    }
}
