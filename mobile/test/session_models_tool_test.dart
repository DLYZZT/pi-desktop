import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/session_models.dart';
import 'package:pi_remote/widgets/tool_action_title.dart';

/// Tool-card bookkeeping: history pairs results by toolCallId and never leaves
/// a card looking like it is still running; live cards run until they pair.
void main() {
  test('history tool cards keep their input and pair the recorded result', () {
    final lines = historyLinesFromDetail({
      'context': {
        'messages': [
          {
            'role': 'assistant',
            'content': [
              {
                'type': 'toolCall',
                'toolCallId': 'c1',
                'toolName': 'read',
                'input': {'path': 'src/a.ts'},
              },
            ],
          },
          {'role': 'toolResult', 'toolCallId': 'c1', 'content': 'file body'},
        ],
      },
    });

    expect(lines, hasLength(1));
    final line = lines.single;
    expect(line.kind, 'tool');
    expect(line.running, isFalse);
    expect(line.resultText, 'file body');
    expect(toolActionTitle(line.toolName!, line.input), '查看文件: src/a.ts');
  });

  test('a history tool call without a recorded result does not spin forever', () {
    final lines = historyLinesFromDetail({
      'context': {
        'messages': [
          {
            'role': 'assistant',
            'content': [
              {
                'type': 'toolCall',
                'toolCallId': 'c1',
                'toolName': 'write',
                'input': {'path': 'new.ts'},
              },
            ],
          },
        ],
      },
    });

    expect(lines.single.kind, 'tool');
    expect(lines.single.running, isFalse);
    expect(lines.single.resultText, isNull);
  });

  test('live tool cards stay running until the result pairs', () {
    final lines = <ChatLine>[];
    final indexByCallId = <String, int>{};

    upsertToolCard(lines, indexByCallId, {
      'toolCallId': 'c1',
      'toolName': 'bash',
      'input': {'description': 'Check repository state'},
    });
    expect(lines.single.running, isTrue);
    expect(toolActionTitle(lines.single.toolName!, lines.single.input), 'Check repository state');

    applyToolResult(lines, indexByCallId, {'role': 'toolResult', 'toolCallId': 'c1', 'content': 'ok'});
    expect(lines.single.running, isFalse);
    expect(lines.single.resultText, 'ok');
  });

  test('a later snapshot without input keeps the last complete arguments', () {
    final lines = <ChatLine>[];
    final indexByCallId = <String, int>{};

    upsertToolCard(lines, indexByCallId, {'toolCallId': 'c1', 'toolName': 'read'});
    expect(lines.single.input, isNull);

    upsertToolCard(lines, indexByCallId, {
      'toolCallId': 'c1',
      'toolName': 'read',
      'input': {'path': 'a.ts'},
    });
    expect(toolActionTitle(lines.single.toolName!, lines.single.input), '查看文件: a.ts');

    upsertToolCard(lines, indexByCallId, {'toolCallId': 'c1', 'toolName': 'read'});
    expect(toolActionTitle(lines.single.toolName!, lines.single.input), '查看文件: a.ts');
  });
}