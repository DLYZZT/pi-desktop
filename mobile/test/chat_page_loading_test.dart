/// 回归测试：进入会话页时，sessions.get 返回前必须显示加载指示，而不是
/// 把"还没加载"误渲染成"空会话"（修复前历史会在空态文案后突然蹦出）。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/chat_page.dart';

/// 只覆盖测试关心的成员；不调用 connect()，不产生真实 socket。
class FakeConnection extends RemoteConnection {
  /// sessions.get 的应答由测试手动控制（模拟 PC 端慢响应）。
  final completer = Completer<Map<String, dynamic>>();
  int sessionsGetCalls = 0;

  FakeConnection({
    required super.relayUrl,
    required super.deviceId,
    required super.deviceLabel,
  });

  @override
  Future<void> subscribe(String topic, String key) async {}

  @override
  Future<void> unsubscribe(String topic, String key) async {}

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async {
    switch (method) {
      case 'sessions.get':
        sessionsGetCalls += 1;
        return completer.future;
      case 'sessions.list':
        return {'runningSessionIds': <dynamic>[]};
      case 'models.preferences.get':
        return {'models': <dynamic>[]};
      default:
        return <String, dynamic>{};
    }
  }
}

/// 两条普通文本消息的最小历史（user 走 Text，assistant 走 MarkdownText）。
Map<String, dynamic> historyDetail() => {
  'context': {
    'messages': [
      {'role': 'user', 'content': '你好'},
      {
        'role': 'assistant',
        'content': [
          {'type': 'text', 'text': '你好！有什么可以帮你？'},
        ],
      },
    ],
  },
};

Future<void> pumpFrames(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(MaterialApp(home: child));
  // 加载中的 CircularProgressIndicator 是无限动画，绝不能 pumpAndSettle。
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('sessions.get 未返回时显示加载指示而非空会话文案', (tester) async {
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));

    expect(connection.sessionsGetCalls, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget,
        reason: '历史加载中必须有 loading 指示');
    expect(find.text('向 PC 上的 agent 发送第一条指令…'), findsNothing,
        reason: '加载中不得误显示空会话文案');
  });

  testWidgets('历史返回后 loading 消失、消息渲染', (tester) async {
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));
    connection.completer.complete(historyDetail());
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(CircularProgressIndicator), findsNothing,
        reason: '历史到达后加载指示必须消失');
    expect(find.text('你好'), findsOneWidget);
    expect(find.textContaining('有什么可以帮你', findRichText: true), findsOneWidget);
  });

  testWidgets('空会话（历史为空）仍显示空态文案', (tester) async {
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));
    connection.completer.complete(<String, dynamic>{});
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('向 PC 上的 agent 发送第一条指令…'), findsOneWidget);
  });

  testWidgets('sessions.get 失败时退出加载态并显示错误', (tester) async {
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
    );

    await pumpFrames(tester, ChatPage(connection: connection, sessionId: 's1', title: '会话'));
    connection.completer.completeError(StateError('rpc error'));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(CircularProgressIndicator), findsNothing,
        reason: '失败后不能停在转圈');
    expect(find.textContaining('rpc error'), findsOneWidget);
  });
}
