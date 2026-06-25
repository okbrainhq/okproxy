import AppKit
import SwiftUI

struct LogsView: View {
    @ObservedObject var logs: LogStore
    let logFilePath: String
    let isActive: Bool

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text("Logs")
                    .font(.headline)
                Text(logFilePath)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Showing latest \(logs.entryLimit) lines")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Clear Logs") { logs.clear() }
            }
            LogScrollView(
                logs: logs,
                minHeight: 260,
                font: .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular),
                forceFollowTail: isActive
            )
        }
    }
}

struct LogScrollView: View {
    @ObservedObject var logs: LogStore
    let minHeight: CGFloat
    let font: NSFont
    var forceFollowTail = true

    var body: some View {
        LogTextScrollView(entries: logs.entries, font: font, forceFollowTail: forceFollowTail)
            .frame(minHeight: minHeight)
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
    }
}

private struct LogTextScrollView: NSViewRepresentable {
    let entries: [LogEntry]
    let font: NSFont
    let forceFollowTail: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .textBackgroundColor
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true

        let textView = NSTextView(frame: NSRect(origin: .zero, size: scrollView.contentSize))
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = false
        textView.usesFindBar = true
        textView.font = font
        textView.textColor = .textColor
        textView.backgroundColor = .textBackgroundColor
        textView.drawsBackground = true
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: scrollView.contentSize.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = false

        scrollView.documentView = textView
        context.coordinator.textView = textView
        context.coordinator.attach(to: scrollView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView ?? scrollView.documentView as? NSTextView else { return }
        context.coordinator.update(
            scrollView: scrollView,
            textView: textView,
            entries: entries,
            font: font,
            forceFollowTail: forceFollowTail
        )
    }

    final class Coordinator {
        weak var textView: NSTextView?

        private weak var scrollView: NSScrollView?
        private var boundsObserver: NSObjectProtocol?
        private var renderedEntryIDs: [Int] = []
        private var renderedText = ""
        private var lastForceFollowTail = false
        private var isFollowingTail = true
        private var isUpdatingProgrammatically = false

        private let bottomTolerance: CGFloat = 16

        deinit {
            if let boundsObserver {
                NotificationCenter.default.removeObserver(boundsObserver)
            }
        }

        func attach(to scrollView: NSScrollView) {
            self.scrollView = scrollView
            scrollView.contentView.postsBoundsChangedNotifications = true
            boundsObserver = NotificationCenter.default.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: scrollView.contentView,
                queue: .main
            ) { [weak self, weak scrollView] _ in
                guard let self, let scrollView, !self.isUpdatingProgrammatically else { return }
                self.isFollowingTail = self.isAtBottom(scrollView: scrollView)
            }
        }

        func update(
            scrollView: NSScrollView,
            textView: NSTextView,
            entries: [LogEntry],
            font: NSFont,
            forceFollowTail: Bool
        ) {
            let becameActive = forceFollowTail && !lastForceFollowTail
            let currentlyAtBottom = isAtBottom(scrollView: scrollView)
            let shouldFollowTail = becameActive || currentlyAtBottom
            let previousOrigin = scrollView.contentView.bounds.origin
            let newEntryIDs = entries.map(\.id)
            let removedPrefixHeight = shouldFollowTail ? 0 : removedPrefixLineHeight(newEntryIDs: newEntryIDs, font: font)
            let newText = entries.isEmpty ? "Logs will appear here." : entries.map(\.text).joined(separator: "\n")
            let textChanged = newEntryIDs != renderedEntryIDs || newText != renderedText

            isUpdatingProgrammatically = true
            textView.font = font
            textView.textColor = entries.isEmpty ? .secondaryLabelColor : .textColor

            if textChanged {
                textView.string = newText
                renderedEntryIDs = newEntryIDs
                renderedText = newText
            }

            textView.layoutSubtreeIfNeeded()
            scrollView.layoutSubtreeIfNeeded()

            if shouldFollowTail {
                scrollToBottom(textView: textView, scrollView: scrollView)
                isFollowingTail = true
            } else if textChanged {
                restoreScrollPosition(
                    previousOrigin: previousOrigin,
                    removedPrefixHeight: removedPrefixHeight,
                    scrollView: scrollView
                )
                isFollowingTail = isAtBottom(scrollView: scrollView)
            }

            isUpdatingProgrammatically = false
            lastForceFollowTail = forceFollowTail
        }

        private func removedPrefixLineHeight(newEntryIDs: [Int], font: NSFont) -> CGFloat {
            guard !renderedEntryIDs.isEmpty, !newEntryIDs.isEmpty else { return 0 }
            let retainedIDs = Set(newEntryIDs)
            guard let firstRetainedIndex = renderedEntryIDs.firstIndex(where: { retainedIDs.contains($0) }) else { return 0 }
            return CGFloat(firstRetainedIndex) * NSLayoutManager().defaultLineHeight(for: font)
        }

        private func restoreScrollPosition(
            previousOrigin: NSPoint,
            removedPrefixHeight: CGFloat,
            scrollView: NSScrollView
        ) {
            let maxY = maxScrollY(scrollView: scrollView)
            let restoredY = min(max(previousOrigin.y - removedPrefixHeight, 0), maxY)
            scrollView.contentView.scroll(to: NSPoint(x: previousOrigin.x, y: restoredY))
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }

        private func scrollToBottom(textView: NSTextView, scrollView: NSScrollView) {
            let end = NSRange(location: textView.string.utf16.count, length: 0)
            textView.scrollRangeToVisible(end)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }

        private func isAtBottom(scrollView: NSScrollView) -> Bool {
            guard let documentView = scrollView.documentView else { return true }
            let visibleRect = scrollView.contentView.documentVisibleRect
            return documentView.bounds.height - visibleRect.maxY <= bottomTolerance
        }

        private func maxScrollY(scrollView: NSScrollView) -> CGFloat {
            guard let documentView = scrollView.documentView else { return 0 }
            return max(0, documentView.bounds.height - scrollView.contentView.bounds.height)
        }
    }
}

struct CompactLogsView: View {
    @ObservedObject var logs: LogStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Live Logs", systemImage: "terminal")
                    .font(.caption.bold())
                Spacer()
                Button("Clear") { logs.clear() }
                    .font(.caption)
            }
            LogScrollView(
                logs: logs,
                minHeight: 110,
                font: .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
            )
        }
    }
}
