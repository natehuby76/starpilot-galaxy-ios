import SwiftUI
import UIKit

enum StarPilotTheme {
    static let routePurple = UIColor(red: 0.66, green: 0.24, blue: 0.99, alpha: 1)
    // Shared by the native toolbar and the edge of the embedded Galaxy page.
    static func toolbarColor(dark: Bool) -> UIColor {
        dark ? UIColor(red: 0.026, green: 0.022, blue: 0.058, alpha: 1)
             : UIColor(red: 0.895, green: 0.855, blue: 0.945, alpha: 1)
    }
    static let uiAccent = UIColor(red: 139.0 / 255, green: 108.0 / 255, blue: 197.0 / 255, alpha: 1)
    static let uiGuidance = UIColor(red: 117.0 / 255, green: 88.0 / 255, blue: 176.0 / 255, alpha: 1)
    static let accent = Color(uiColor: uiAccent)
    static let guidance = Color(uiColor: uiGuidance)
    static let readable = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.82, green: 0.74, blue: 1, alpha: 1) : UIColor(red: 0.36, green: 0.20, blue: 0.62, alpha: 1) })
    static let readableSecondary = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.86, green: 0.86, blue: 0.90, alpha: 1) : UIColor(red: 0.24, green: 0.24, blue: 0.28, alpha: 1) })
    static let background = Color(red: 0.035, green: 0.035, blue: 0.078)
    static let panel = Color(red: 0.09, green: 0.065, blue: 0.145)
    static let muted = Color(red: 0.70, green: 0.65, blue: 0.77)
    static func title(_ size: CGFloat) -> Font { .custom("Sora-Regular", size: size, relativeTo: .title2) }
}
