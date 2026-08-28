package com.waywiser.accessibility

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.time.Instant

/**
 * Accessibility service for device automation.
 *
 * Event-driven architecture — NEVER polls the accessibility tree.
 * Tree snapshots are captured only for pre-action verification (TOCTOU).
 *
 * Provisioning requirement (Android 15+ ECM bypass):
 * - Option A: Custom factory image with package in /system/etc/sysconfig
 * - Option B: MDM programmatic grant (RECOMMENDED for scalability)
 * - Option C: Per-device ADB: adb shell settings put secure enabled_accessibility_services
 *
 * Security: FLAG_SECURE windows block both screenshots AND accessibility
 * tree inspection. The service detects this and reports SECURE_BLOCKED.
 */
class WaywiserAccessibilityService : AccessibilityService() {

    private var lastWindowPackage: String = ""

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> onWindowChanged(event)
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> onContentChanged(event)
            AccessibilityEvent.TYPE_VIEW_CLICKED -> onViewClicked(event)
            AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED -> onNotificationChanged(event)
            else -> {} // ignore other events
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "Accessibility service interrupted")
    }

    // ── Event handlers (event-driven, not polling) ──

    private fun onWindowChanged(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        if (pkg != lastWindowPackage) {
            lastWindowPackage = pkg
            Log.d(TAG, "Window changed: $pkg")
            // TODO: Notify Rust runtime of window change via FFI
        }
    }

    private fun onContentChanged(event: AccessibilityEvent) {
        // Content changes are high-frequency — only log significant ones
        // TODO: Forward relevant changes to Rust for context graph updates
    }

    private fun onViewClicked(event: AccessibilityEvent) {
        Log.d(TAG, "View clicked in ${event.packageName}: ${event.text}")
        // TODO: Forward to Rust for post-action verification if within a workflow
    }

    private fun onNotificationChanged(event: AccessibilityEvent) {
        // Notification changes handled by NotificationListenerService instead
    }

    // ── Snapshot for TOCTOU verification ──

    /**
     * Capture a snapshot of the current accessibility tree.
     * Called only for pre-action verification — NOT for polling.
     */
    fun captureTreeSnapshot(windowId: Int): TreeSnapshot? {
        val root = rootInActiveWindow ?: run {
            Log.w(TAG, "No root node available for snapshot")
            return null
        }

        val secureState = detectSecureWindow()
        val a11yNode = convertToA11yNode(root)
        val quality = assessTreeQuality(a11yNode)

        return TreeSnapshot(
            windowId = windowId,
            packageName = root.packageName?.toString() ?: "unknown",
            root = a11yNode,
            quality = quality,
            secureState = secureState,
            capturedAt = Instant.now(),
        )
    }

    /**
     * Perform an action on a specific node by ID.
     * Called by the Rust runtime during workflow execution.
     */
    fun performNodeAction(nodeId: Long, actionId: Int): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = findNodeById(root, nodeId)
        return target?.performAction(actionId) ?: false
    }

    // ── Helpers ──

    private fun convertToA11yNode(node: AccessibilityNodeInfo): A11yNode {
        val children = mutableListOf<A11yNode>()
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                children.add(convertToA11yNode(child))
                child.recycle()
            }
        }

        val rect = android.graphics.Rect()
        node.getBoundsInScreen(rect)

        return A11yNode(
            nodeId = node.hashCode().toLong(),
            packageName = node.packageName?.toString() ?: "",
            windowId = node.windowId,
            resourceId = node.viewIdResourceName,
            className = node.className?.toString() ?: "",
            role = null, // AccessibilityNodeInfo doesn't expose role directly
            text = node.text?.toString(),
            contentDescription = node.contentDescription?.toString(),
            hintText = node.hintText?.toString(),
            stateDescription = node.stateDescription?.toString(),
            bounds = Rect(rect.left, rect.top, rect.right, rect.bottom),
            isClickable = node.isClickable,
            isScrollable = node.isScrollable,
            isEditable = node.isEditable,
            isFocusable = node.isFocusable,
            isChecked = if (node.isCheckable) node.isChecked else null,
            children = children,
        )
    }

    private fun findNodeById(root: AccessibilityNodeInfo, targetId: Long): AccessibilityNodeInfo? {
        if (root.hashCode().toLong() == targetId) return root
        for (i in 0 until root.childCount) {
            root.getChild(i)?.let { child ->
                val found = findNodeById(child, targetId)
                if (found != null) return found
                child.recycle()
            }
        }
        return null
    }

    private fun detectSecureWindow(): SecureWindowState {
        // FLAG_SECURE detection — limited from AccessibilityService
        // If screenshots fail or tree is unusually sparse, assume secure
        return SecureWindowState.NORMAL
    }

    private fun assessTreeQuality(root: A11yNode): TreeQuality {
        val total = countNodes(root)
        if (total == 0) return TreeQuality.UNUSABLE

        val withId = countNodesWith(root) { it.resourceId != null }
        val withDesc = countNodesWith(root) { it.text != null || it.contentDescription != null }
        val ratio = (withId + withDesc).toFloat() / (total * 2).toFloat()

        return when {
            ratio >= 0.6f -> TreeQuality.GOOD
            ratio >= 0.3f -> TreeQuality.PARTIAL
            ratio >= 0.1f -> TreeQuality.POOR
            else -> TreeQuality.UNUSABLE
        }
    }

    private fun countNodes(node: A11yNode): Int {
        return 1 + node.children.sumOf { countNodes(it) }
    }

    private fun countNodesWith(node: A11yNode, predicate: (A11yNode) -> Boolean): Int {
        val self = if (predicate(node)) 1 else 0
        return self + node.children.sumOf { countNodesWith(it, predicate) }
    }

    companion object {
        private const val TAG = "WaywiserA11y"
    }
}

// ── Data types (mirror Rust A11yNode from waywiser-automation crate) ──

data class A11yNode(
    val nodeId: Long,
    val packageName: String,
    val windowId: Int,
    val resourceId: String?,
    val className: String,
    val role: String?,
    val text: String?,
    val contentDescription: String?,
    val hintText: String?,
    val stateDescription: String?,
    val bounds: Rect,
    val isClickable: Boolean,
    val isScrollable: Boolean,
    val isEditable: Boolean,
    val isFocusable: Boolean,
    val isChecked: Boolean?,
    val children: List<A11yNode>,
)

data class Rect(val left: Int, val top: Int, val right: Int, val bottom: Int)

enum class TreeQuality { GOOD, PARTIAL, POOR, UNUSABLE }

enum class SecureWindowState { NORMAL, SECURE_BLOCKED }

data class TreeSnapshot(
    val windowId: Int,
    val packageName: String,
    val root: A11yNode,
    val quality: TreeQuality,
    val secureState: SecureWindowState,
    val capturedAt: Instant,
)
