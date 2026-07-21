import SwiftUI
import SafariServices

@main
struct SpaceScanApp: App {
    var body: some Scene {
        WindowGroup { ModeHome() }
    }
}

/// Home screen offering all three measuring modes. LiDAR runs natively;
/// Quick and Precision are the web app (same engine as the browser version),
/// opened in an in-app Safari sheet.
struct ModeHome: View {
    private static let webBase = "https://salehyahyaa.github.io/SoKat/"
    @State private var webURL: WebDestination?

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                Spacer()
                VStack(spacing: 6) {
                    Text("SpaceScan").font(.largeTitle.bold())
                    Text("Measure any space with your iPhone")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()

                NavigationLink {
                    ContentView()
                        .navigationBarTitleDisplayMode(.inline)
                } label: {
                    modeRow("ruler", "LiDAR Scan", "aim & tap, no setup · about ±0.5″")
                }

                Button {
                    webURL = WebDestination(url: URL(string: Self.webBase)!)
                } label: {
                    modeRow("camera.viewfinder", "Quick Scan", "one photo, nothing to tape · ±5–8%")
                }

                Button {
                    webURL = WebDestination(url: URL(string: Self.webBase + "?mode=precision")!)
                } label: {
                    modeRow("checkerboard.rectangle", "Precision", "printed target · verified to 1/16″")
                }

                Spacer()
            }
            .padding()
            .preferredColorScheme(.dark)
            .sheet(item: $webURL) { dest in
                SafariView(url: dest.url).ignoresSafeArea()
            }
        }
    }

    private func modeRow(_ icon: String, _ title: String, _ sub: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.title2).frame(width: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(sub).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.secondary)
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .foregroundStyle(.primary)
    }
}

private struct WebDestination: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

struct ContentView: View {
    @StateObject private var session = MeasureSession()

    var body: some View {
        ZStack {
            ARMeasureView(session: session)
                .ignoresSafeArea()

            if session.phase != .done {
                Crosshair(valid: session.reticleValid)
            }

            VStack(spacing: 12) {
                Text(session.instruction)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))

                if !session.hasLiDAR {
                    Text("No LiDAR on this device — accuracy reduced")
                        .font(.caption)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(.yellow.opacity(0.85), in: Capsule())
                        .foregroundStyle(.black)
                }

                if let live = session.liveInches {
                    Text(Format.inches(live))
                        .font(.title2.monospacedDigit().bold())
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: Capsule())
                }

                Spacer()

                if session.phase == .done {
                    ResultCard(session: session)
                } else {
                    controls
                }
            }
            .padding()
        }
        .preferredColorScheme(.dark)
    }

    private var controls: some View {
        HStack(spacing: 24) {
            Button(action: session.undo) {
                Image(systemName: "arrow.uturn.backward")
                    .font(.title2)
                    .frame(width: 56, height: 56)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .opacity(session.canUndo ? 1 : 0.3)
            .disabled(!session.canUndo)

            Button(action: session.mark) {
                Image(systemName: "plus")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.black)
                    .frame(width: 84, height: 84)
                    .background(session.reticleValid ? .white : .gray, in: Circle())
            }
            .disabled(!session.reticleValid)

            // spacer balancing the undo button so Mark stays centered
            Color.clear.frame(width: 56, height: 56)
        }
        .padding(.bottom, 8)
    }
}

struct Crosshair: View {
    let valid: Bool
    var body: some View {
        ZStack {
            Circle().stroke(valid ? .white : .red, lineWidth: 2)
                .frame(width: 28, height: 28)
            Circle().fill(valid ? .white : .red)
                .frame(width: 4, height: 4)
        }
        .shadow(radius: 2)
        .allowsHitTesting(false)
    }
}

struct ResultCard: View {
    @ObservedObject var session: MeasureSession

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 28) {
                dimension("Height", session.heightInches)
                dimension("Width", session.widthInches)
            }
            Text(session.hasLiDAR ? "LiDAR · about ±0.5 in" : "Camera only · about ±2 in")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Measure again", action: session.reset)
                .buttonStyle(.borderedProminent)
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    private func dimension(_ label: String, _ inches: Double?) -> some View {
        VStack(spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(Format.inches(inches ?? 0))
                .font(.title.monospacedDigit().bold())
            Text(Format.centimeters(inches ?? 0))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

enum Format {
    static func inches(_ inches: Double) -> String {
        String(format: "%.1f\u{2033}", inches)
    }
    static func centimeters(_ inches: Double) -> String {
        String(format: "%.1f cm", inches * 2.54)
    }
}
