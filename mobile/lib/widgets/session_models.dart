/// Shared models + parsing helpers for the remote session UI. Tool rendering
/// mirrors the desktop MessageView: toolCall blocks become collapsible cards,
/// toolResult messages pair into their card by toolCallId.
library;

/// One rendered line in the chat view: a text bubble, thinking card or tool card.
class ChatLine {
  final String kind; // 'text' | 'thinking' | 'tool'
  String role;
  String text;
  bool done;
  /// Ordinal of the source message in the transcript. History assigns it while
  /// walking `context.messages`; live events count `message_start`. Process
  /// groups use it for stable keys and per-message counts.
  int? messageIndex;
  // Tool card fields (kind == 'tool').
  String? toolCallId;
  String? toolName;
  /// True for a toolCall block; false for a standalone toolResult card.
  bool fromToolCall;
  /// Raw tool arguments, kept so the card can derive its action title and
  /// serialize the args only while expanded.
  Map<dynamic, dynamic>? input;
  String? resultText;
  bool resultIsError;
  bool running;
  ChatLine.text({required this.role, required this.text, this.done = false, this.messageIndex})
      : kind = 'text',
        fromToolCall = false,
        resultIsError = false,
        running = false;
  ChatLine.thinking({required this.role, required this.text, this.done = false, this.messageIndex})
      : kind = 'thinking',
        fromToolCall = false,
        resultIsError = false,
        running = false;
  ChatLine.tool({
    required this.toolCallId,
    required this.toolName,
    this.input,
    this.running = false,
    this.messageIndex,
    this.fromToolCall = false,
  })  : kind = 'tool',
        role = 'assistant',
        text = '',
        done = false,
        resultIsError = false;
}

/// A PC session as returned by sessions.list (SessionInfo subset).
class SessionSummary {
  final String id;
  final String cwd;
  final String? name;
  final String firstMessage;
  final int messageCount;
  final DateTime modified;
  final String projectRoot;
  SessionSummary({
    required this.id,
    required this.cwd,
    required this.name,
    required this.firstMessage,
    required this.messageCount,
    required this.modified,
    required this.projectRoot,
  });

  factory SessionSummary.fromMap(Map<String, dynamic> map) {
    return SessionSummary(
      id: map['id'] as String? ?? '',
      cwd: map['cwd'] as String? ?? '',
      name: map['name'] as String?,
      firstMessage: (map['firstMessage'] as String? ?? '').trim(),
      messageCount: (map['messageCount'] as num?)?.toInt() ?? 0,
      modified: DateTime.tryParse(map['modified'] as String? ?? '') ?? DateTime.now(),
      projectRoot: (map['projectRoot'] as String?) ?? (map['cwd'] as String? ?? ''),
    );
  }

  String get title {
    final n = name;
    if (n != null && n.trim().isNotEmpty) return n.trim();
    final f = firstMessage;
    if (f.isNotEmpty) return f.length > 40 ? '${f.substring(0, 40)}…' : f;
    return '(无标题)';
  }
}

String projectName(String root) {
  final normalized = root.replaceAll('\\', '/');
  final parts = normalized.split('/').where((p) => p.isNotEmpty).toList();
  return parts.isEmpty ? root : parts.last;
}

String relativeTime(DateTime time) {
  final diff = DateTime.now().difference(time);
  if (diff.inMinutes < 1) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays < 30) return '${diff.inDays} 天前';
  return '${time.year}-${time.month}-${time.day}';
}

String? extractText(Object? content) {
  if (content is String) return content;
  if (content is List) {
    final buffer = StringBuffer();
    for (final block in content) {
      if (block is Map && block['type'] == 'text') buffer.write(block['text'] as String? ?? '');
    }
    return buffer.toString();
  }
  return null;
}

/// Upsert a tool card line by toolCallId; returns its index.
///
/// [live] cards start out running until their result pairs in. History cards
/// never do: a toolCall with no recorded result (truncated history) must not
/// spin forever.
int upsertToolCard(
  List<ChatLine> lines,
  Map<String, int> indexByCallId,
  Map<dynamic, dynamic> block, {
  bool live = true,
  int? messageIndex,
}) {
  final toolCallId = block['toolCallId'] as String? ?? '';
  final rawInput = block['input'];
  final input = rawInput is Map ? rawInput : null;
  final toolName = block['toolName'] as String? ?? 'tool';
  final existing = indexByCallId[toolCallId];
  if (existing != null && existing < lines.length && lines[existing].kind == 'tool') {
    final line = lines[existing];
    line.toolName = toolName;
    // Early streaming snapshots may carry a partial or missing input; keep
    // the last complete one so the action title does not flicker backwards.
    if (input != null) line.input = input;
    return existing;
  }
  lines.add(ChatLine.tool(
    toolCallId: toolCallId,
    toolName: toolName,
    input: input,
    running: live,
    messageIndex: messageIndex,
    fromToolCall: true,
  ));
  indexByCallId[toolCallId] = lines.length - 1;
  return lines.length - 1;
}

/// Pair a toolResult message into its tool card; returns true when paired.
bool applyToolResult(
  List<ChatLine> lines,
  Map<String, int> indexByCallId,
  Map<dynamic, dynamic> message, {
  int? messageIndex,
}) {
  final toolCallId = message['toolCallId'] as String?;
  final text = extractText(message['content']) ?? '';
  final isError = message['isError'] == true;
  final existing = toolCallId == null ? null : indexByCallId[toolCallId];
  if (existing != null && existing < lines.length && lines[existing].kind == 'tool') {
    final line = lines[existing];
    line.resultText = text.trim().isEmpty ? '(无输出)' : text;
    line.resultIsError = isError;
    line.running = false;
    line.done = true;
    return true;
  }
  if (text.trim().isEmpty && !isError) return false;
  // Unpaired result (e.g. truncated history): standalone tool line.
  lines.add(ChatLine.tool(
    toolCallId: toolCallId ?? '',
    toolName: message['toolName'] as String? ?? 'tool',
    messageIndex: messageIndex,
  ));
  final line = lines.last;
  line.resultText = text.trim().isEmpty ? '(无输出)' : text;
  line.resultIsError = isError;
  line.running = false;
  line.done = true;
  return true;
}

/// Build chat lines from a sessions.get detail (history), including tool
/// cards paired with their results.
List<ChatLine> historyLinesFromDetail(Map<String, dynamic> detail) {
  final lines = <ChatLine>[];
  final indexByCallId = <String, int>{};
  final context = detail['context'];
  final messages = context is Map ? context['messages'] : null;
  if (messages is List) {
    for (var messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      final message = messages[messageIndex];
      if (message is! Map) continue;
      final role = message['role'] as String? ?? 'assistant';
      if (role == 'toolResult') {
        applyToolResult(lines, indexByCallId, message, messageIndex: messageIndex);
        continue;
      }
      if (role != 'user' && role != 'assistant') continue;
      final content = message['content'];
      if (content is! List) {
        final text = extractText(content);
        if (text != null && text.trim().isNotEmpty) {
          lines.add(ChatLine.text(role: role, text: text.trim(), done: true, messageIndex: messageIndex));
        }
        continue;
      }
      for (final block in content) {
        if (block is! Map) continue;
        if (block['type'] == 'toolCall') {
          upsertToolCard(lines, indexByCallId, block, live: false, messageIndex: messageIndex);
        } else if (block['type'] == 'thinking') {
          final thinking = (block['thinking'] as String? ?? '').trim();
          if (thinking.isNotEmpty) {
            lines.add(ChatLine.thinking(role: role, text: thinking, done: true, messageIndex: messageIndex));
          }
        } else if (block['type'] == 'text') {
          final text = (block['text'] as String? ?? '').trim();
          if (text.isNotEmpty) {
            lines.add(ChatLine.text(role: role, text: text, done: true, messageIndex: messageIndex));
          }
        }
      }
    }
  }
  return lines;
}

/// Number of messages in a sessions.get detail, used to seed the live message
/// ordinal so freshly streamed lines never collide with history entries.
int historyMessageCount(Map<String, dynamic> detail) {
  final context = detail['context'];
  final messages = context is Map ? context['messages'] : null;
  return messages is List ? messages.length : 0;
}

/// Group session summaries by project root, sorted by recency.
Map<String, List<SessionSummary>> groupByProject(List<SessionSummary> sessions) {
  final grouped = <String, List<SessionSummary>>{};
  for (final s in sessions) {
    grouped.putIfAbsent(s.projectRoot.isEmpty ? s.cwd : s.projectRoot, () => []).add(s);
  }
  for (final list in grouped.values) {
    list.sort((a, b) => b.modified.compareTo(a.modified));
  }
  return grouped;
}
