import ARKit
import SceneKit
import SwiftUI

struct ARMeasureView: UIViewRepresentable {
    let session: MeasureSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.automaticallyUpdatesLighting = true
        view.delegate = context.coordinator
        session.arView = view

        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            config.sceneReconstruction = .mesh
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            config.frameSemantics.insert(.sceneDepth)
        }
        view.session.run(config)
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}

    static func dismantleUIView(_ uiView: ARSCNView, coordinator: Coordinator) {
        uiView.session.pause()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session)
    }

    final class Coordinator: NSObject, ARSCNViewDelegate {
        let session: MeasureSession

        init(session: MeasureSession) {
            self.session = session
        }

        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
            DispatchQueue.main.async { [weak session] in
                session?.updateReticle()
            }
        }
    }
}
