/// Transcript folding for the remote session UI.
///
/// Mirrors the desktop ChatWindow's process grouping: each completed user turn
/// folds its intermediate messages (thinking, tool calls, interim text) into a
/// collapsed "process details" row, while the trailing answer stays visible.
/// The turn still streaming stays flat so live output is never hidden.
library;

import 'session_models.dart';

/// One row of the transcript: either a standalone line or a folded group.
class TranscriptEntry {
  final ChatLine? line;
  final ProcessGroupEntry? group;

  const TranscriptEntry.line(ChatLine this.line) : group = null;
  const TranscriptEntry.group(ProcessGroupEntry this.group) : line = null;

  bool get isGroup => group != null;
}

/// A completed turn's process, collapsed behind one expandable header.
class ProcessGroupEntry {
  final String key;
  final List<ChatLine> processLines;
  final int messageCount;
  final int toolCallCount;

  const ProcessGroupEntry({
    required this.key,
    required this.processLines,
    required this.messageCount,
    required this.toolCallCount,
  });
}

/// Split a flat line list into transcript rows.
///
/// [liveTail] keeps the final turn flat. The desktop uses
/// `agentRunning || isStreaming` here; the mobile page passes its turn mirror.
List<TranscriptEntry> buildTranscriptEntries(List<ChatLine> lines, {required bool liveTail}) {
  final entries = <TranscriptEntry>[];
  var index = 0;

  // Lines before the first user message (resumed mid-turn, truncated history)
  // have no turn to fold into; render them as they are.
  while (index < lines.length && lines[index].role != 'user') {
    entries.add(TranscriptEntry.line(lines[index]));
    index += 1;
  }

  while (index < lines.length) {
    final userIndex = index;
    var end = userIndex + 1;
    while (end < lines.length && lines[end].role != 'user') {
      end += 1;
    }
    final isLastTurn = end == lines.length;
    entries.add(TranscriptEntry.line(lines[userIndex]));

    if (liveTail && isLastTurn) {
      for (var i = userIndex + 1; i < end; i++) {
        entries.add(TranscriptEntry.line(lines[i]));
      }
      return entries;
    }

    // The answer is whatever trails the last process block of the turn, which
    // is the desktop splitFinalAssistantBlocks rule collapsed to line level.
    var lastProcessIndex = -1;
    for (var i = userIndex + 1; i < end; i++) {
      final kind = lines[i].kind;
      if (kind == 'thinking' || kind == 'tool') lastProcessIndex = i;
    }

    if (lastProcessIndex == -1) {
      for (var i = userIndex + 1; i < end; i++) {
        entries.add(TranscriptEntry.line(lines[i]));
      }
    } else {
      final processLines = lines.sublist(userIndex + 1, lastProcessIndex + 1);
      entries.add(TranscriptEntry.group(ProcessGroupEntry(
        key: _groupKey(lines[userIndex], userIndex),
        processLines: processLines,
        messageCount: _messageCount(processLines),
        toolCallCount: _toolCallCount(processLines),
      )));
      for (var i = lastProcessIndex + 1; i < end; i++) {
        entries.add(TranscriptEntry.line(lines[i]));
      }
    }
    index = end;
  }

  return entries;
}

/// Stable per-turn key for the expanded-state set. Prefers the source message
/// ordinal so it survives rebuilds; falls back to the row position.
String _groupKey(ChatLine userLine, int userIndex) {
  final messageIndex = userLine.messageIndex;
  return 'process:${messageIndex ?? userIndex}';
}

int _messageCount(List<ChatLine> lines) {
  final indices = <int>{};
  for (final line in lines) {
    final index = line.messageIndex;
    if (index != null) indices.add(index);
  }
  // Without message ordinals (older writers/tests) count each line as one.
  return indices.isEmpty ? lines.length : indices.length;
}

int _toolCallCount(List<ChatLine> lines) =>
    lines.where((line) => line.kind == 'tool' && line.fromToolCall).length;