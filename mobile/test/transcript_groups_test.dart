import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/session_models.dart';
import 'package:pi_remote/widgets/transcript_groups.dart';

ChatLine user(String text, int messageIndex) =>
    ChatLine.text(role: 'user', text: text, done: true, messageIndex: messageIndex);

ChatLine text(String value, int messageIndex) =>
    ChatLine.text(role: 'assistant', text: value, done: true, messageIndex: messageIndex);

ChatLine thinking(String value, int messageIndex) =>
    ChatLine.thinking(role: 'assistant', text: value, done: true, messageIndex: messageIndex);

ChatLine tool(String id, int messageIndex) => ChatLine.tool(
      toolCallId: id,
      toolName: 'bash',
      messageIndex: messageIndex,
      fromToolCall: true,
    );

void main() {
  test('a completed turn folds its process and keeps the answer visible', () {
    final entries = buildTranscriptEntries([
      user('跑一下测试', 0),
      thinking('先看看仓库状态', 1),
      tool('c1', 1),
      text('测试全部通过', 2),
    ], liveTail: false);

    expect(entries, hasLength(3));
    expect(entries[0].line!.role, 'user');
    final group = entries[1].group!;
    expect(group.key, 'process:0');
    expect(group.processLines.map((line) => line.kind), ['thinking', 'tool']);
    expect(group.messageCount, 1);
    expect(group.toolCallCount, 1);
    expect(entries[2].line!.text, '测试全部通过');
  });

  test('interim text before the last process block stays inside the group', () {
    final entries = buildTranscriptEntries([
      user('查一下', 0),
      text('我先检查工作区', 1),
      tool('c1', 1),
      text('干净，没有改动', 2),
    ], liveTail: false);

    final group = entries[1].group!;
    expect(group.processLines.map((line) => line.kind), ['text', 'tool']);
    expect(entries[2].line!.text, '干净，没有改动');
  });

  test('the streaming turn stays flat so live output is never hidden', () {
    final lines = [
      user('跑一下测试', 0),
      thinking('先看看仓库状态', 1),
      tool('c1', 1),
      text('测试全部通过', 2),
    ];
    final entries = buildTranscriptEntries(lines, liveTail: true);

    expect(entries, hasLength(lines.length));
    expect(entries.any((entry) => entry.isGroup), isFalse);
  });

  test('only the last turn is live; earlier turns are folded', () {
    final entries = buildTranscriptEntries([
      user('第一轮', 0),
      tool('c1', 1),
      text('第一轮完成', 2),
      user('第二轮', 3),
      tool('c2', 4),
      text('第二轮进行中', 5),
    ], liveTail: true);

    final groups = entries.where((entry) => entry.isGroup).toList();
    expect(groups, hasLength(1));
    expect(groups.single.group!.key, 'process:0');
    expect(groups.single.group!.processLines.single.toolCallId, 'c1');
    // The live turn's tool card is still a plain line.
    expect(entries.last.line!.text, '第二轮进行中');
    expect(entries.any((entry) => entry.line?.toolCallId == 'c2'), isTrue);
  });

  test('a turn with no process content is not folded', () {
    final entries = buildTranscriptEntries([
      user('你好', 0),
      text('你好，有什么可以帮你的？', 1),
    ], liveTail: false);

    expect(entries, hasLength(2));
    expect(entries.any((entry) => entry.isGroup), isFalse);
  });

  test('lines before the first user message stay flat', () {
    final entries = buildTranscriptEntries([
      text('恢复的片段', 0),
      user('继续', 1),
      tool('c1', 2),
      text('完成', 3),
    ], liveTail: false);

    expect(entries.first.line!.text, '恢复的片段');
    expect(entries[2].group!.key, 'process:1');
  });

  test('the header counts messages, not lines, and ignores unpaired results', () {
    final lines = [
      user('多步任务', 0),
      thinking('第一步', 1),
      tool('c1', 1),
      text('第二步说明', 2),
      tool('c2', 2),
      // Standalone result card without a toolCall block (truncated history).
      ChatLine.tool(toolCallId: 'gone', toolName: 'bash', messageIndex: 3),
      text('收尾', 4),
    ];
    final entries = buildTranscriptEntries(lines, liveTail: false);
    final group = entries[1].group!;

    expect(group.messageCount, 3);
    expect(group.toolCallCount, 2);
  });

  test('the group key falls back to the row position without ordinals', () {
    final entries = buildTranscriptEntries([
      ChatLine.text(role: 'user', text: 'hi', done: true),
      ChatLine.tool(toolCallId: 'c1', toolName: 'bash', fromToolCall: true),
      ChatLine.text(role: 'assistant', text: 'ok', done: true),
    ], liveTail: false);

    expect(entries[1].group!.key, 'process:0');
  });
}