import ARKit
import SceneKit

/// State machine for the two-measurement flow: height (2 marks), width
/// (2 marks), done. Each mark is placed at the world point under the
/// screen-center reticle, raycast against the LiDAR mesh when available.
final class MeasureSession: NSObject, ObservableObject {
    enum Phase { case height, width, done }

    @Published var phase: Phase = .height
    @Published var reticleValid = false
    @Published var liveInches: Double?
    @Published var heightInches: Double?
    @Published var widthInches: Double?

    let hasLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)

    weak var arView: ARSCNView?

    private var reticleWorld: simd_float3?
    private var pendingPoint: simd_float3?
    private var pendingSphere: SCNNode?
    private var previewLine: SCNNode?
    private var heightNodes: [SCNNode] = []
    private var widthNodes: [SCNNode] = []

    var instruction: String {
        switch phase {
        case .height:
            return pendingPoint == nil
                ? "Aim at the floor of the space, then tap +"
                : "Now aim at the top — floor to ceiling"
        case .width:
            return pendingPoint == nil
                ? "Aim at the left edge, then tap +"
                : "Now aim at the right edge"
        case .done:
            return "Done"
        }
    }

    var canUndo: Bool {
        pendingPoint != nil || heightInches != nil
    }

    // MARK: - Per-frame reticle update (called from the render loop)

    func updateReticle() {
        guard let view = arView, view.bounds.width > 0 else { return }
        let center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        guard let query = view.raycastQuery(from: center, allowing: .estimatedPlane, alignment: .any),
              let hit = view.session.raycast(query).first else {
            if reticleValid { reticleValid = false; liveInches = nil }
            previewLine?.isHidden = true
            return
        }
        let world = hit.worldTransform.translation
        reticleWorld = world
        if !reticleValid { reticleValid = true }

        if let from = pendingPoint {
            let inches = Double(simd_distance(from, world)) * 39.3701
            if liveInches.map({ abs($0 - inches) > 0.05 }) ?? true { liveInches = inches }
            updatePreviewLine(from: from, to: world)
        }
    }

    // MARK: - Actions

    func mark() {
        guard reticleValid, let point = reticleWorld else { return }
        if let from = pendingPoint {
            complete(from: from, to: point)
        } else {
            pendingPoint = point
            let sphere = Nodes.sphere(at: point, color: .white)
            arView?.scene.rootNode.addChildNode(sphere)
            pendingSphere = sphere
        }
    }

    func undo() {
        if pendingPoint != nil {
            clearPending()
        } else if phase == .done {
            widthInches = nil
            removeAll(&widthNodes)
            phase = .width
        } else if phase == .width, heightInches != nil {
            heightInches = nil
            removeAll(&heightNodes)
            phase = .height
        }
    }

    func reset() {
        clearPending()
        removeAll(&heightNodes)
        removeAll(&widthNodes)
        heightInches = nil
        widthInches = nil
        phase = .height
    }

    // MARK: - Private

    private func complete(from: simd_float3, to: simd_float3) {
        let inches = Double(simd_distance(from, to)) * 39.3701
        let color: UIColor = phase == .height ? .systemGreen : .systemOrange
        var nodes: [SCNNode] = [
            Nodes.sphere(at: from, color: color),
            Nodes.sphere(at: to, color: color),
            Nodes.line(from: from, to: to, color: color),
        ]
        nodes.forEach { arView?.scene.rootNode.addChildNode($0) }
        clearPending()

        switch phase {
        case .height:
            heightInches = inches
            heightNodes = nodes
            phase = .width
        case .width:
            widthInches = inches
            widthNodes = nodes
            phase = .done
        case .done:
            nodes.forEach { $0.removeFromParentNode() }
            nodes.removeAll()
        }
    }

    private func updatePreviewLine(from: simd_float3, to: simd_float3) {
        previewLine?.removeFromParentNode()
        let line = Nodes.line(from: from, to: to, color: .white.withAlphaComponent(0.7))
        arView?.scene.rootNode.addChildNode(line)
        previewLine = line
    }

    private func clearPending() {
        pendingPoint = nil
        liveInches = nil
        pendingSphere?.removeFromParentNode()
        pendingSphere = nil
        previewLine?.removeFromParentNode()
        previewLine = nil
    }

    private func removeAll(_ nodes: inout [SCNNode]) {
        nodes.forEach { $0.removeFromParentNode() }
        nodes.removeAll()
    }
}

enum Nodes {
    static func sphere(at position: simd_float3, color: UIColor) -> SCNNode {
        let geometry = SCNSphere(radius: 0.008)
        geometry.firstMaterial?.diffuse.contents = color
        geometry.firstMaterial?.lightingModel = .constant
        let node = SCNNode(geometry: geometry)
        node.simdPosition = position
        return node
    }

    static func line(from a: simd_float3, to b: simd_float3, color: UIColor) -> SCNNode {
        let length = simd_distance(a, b)
        let geometry = SCNCylinder(radius: 0.002, height: CGFloat(length))
        geometry.firstMaterial?.diffuse.contents = color
        geometry.firstMaterial?.lightingModel = .constant
        let node = SCNNode(geometry: geometry)
        node.simdPosition = (a + b) / 2
        if length > 1e-4 {
            // Cylinder axis is local Y; rotate it onto the segment direction.
            node.simdOrientation = simd_quatf(from: simd_float3(0, 1, 0),
                                              to: simd_normalize(b - a))
        }
        return node
    }
}

extension simd_float4x4 {
    var translation: simd_float3 {
        simd_float3(columns.3.x, columns.3.y, columns.3.z)
    }
}
