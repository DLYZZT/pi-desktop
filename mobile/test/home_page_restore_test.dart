/// 回归测试：扫码配对新电脑时，恢复的全局偏好绝不能覆盖二维码显式指定的
/// 目标主机（targetHostId）。
///
/// 真实事故：手机已与电脑 A 配对（全局偏好 = A），随后扫码配对电脑 B。
/// hello_ack 尚未到达时 `preferredHostId` 还是 null，旧的恢复逻辑调用
/// selectHost('A') 把握手目标拽回 A，B 的连接被掐断——relay 侧已经完成
/// 绑定并签发了凭证（电脑端显示「绑定成功」），但凭证随断链丢失，手机
/// 从此在「选择电脑」里把 B 显示为「未配对」。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/core/host_store.dart';
import 'package:pi_remote/core/remote_connection.dart';
import 'package:pi_remote/pages/home_page.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 只覆盖测试关心的成员；不调用 connect()，不会产生真实 socket。
class FakeConnection extends RemoteConnection {
  final List<String> selectHostCalls = [];
  FakeConnection({
    required super.relayUrl,
    required super.deviceId,
    required super.deviceLabel,
    super.targetHostId,
  });

  @override
  Future<void> selectHost(String hostId) async {
    selectHostCalls.add(hostId);
  }

  @override
  Future<Map<String, dynamic>> request(String method, Object? params) async =>
      {'sessions': <dynamic>[], 'runningSessionIds': <dynamic>[]};
}

Future<SharedPreferences> _seedPrefs() async {
  SharedPreferences.setMockInitialValues({'remote.preferredHostId': 'host-a'});
  return SharedPreferences.getInstance();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('扫码指定的目标主机不被全局偏好覆盖', (tester) async {
    await _seedPrefs();
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
      targetHostId: 'host-b', // 刚扫的电脑 B
    );

    await tester.pumpWidget(MaterialApp(home: HomePage(connection: connection)));
    await tester.pumpAndSettle();

    // 修复前：恢复逻辑把目标拽回上一台电脑 A（selectHostCalls == ['host-a']），
    // B 的 hello_ack 随断链丢失，凭证存不下来。
    expect(connection.selectHostCalls, isEmpty,
        reason: '扫码是明确意图：全局偏好（上一台电脑 A）不得覆盖 targetHostId');
    expect(connection.hostId, 'host-b');
  });

  testWidgets('无显式目标时仍恢复上次选择的电脑', (tester) async {
    await _seedPrefs();
    final connection = FakeConnection(
      relayUrl: 'ws://relay.example:8788/ws',
      deviceId: 'dev-1',
      deviceLabel: 'phone',
      // 手动连接：没有扫码目标，应恢复上次偏好 A。
    );

    await tester.pumpWidget(MaterialApp(home: HomePage(connection: connection)));
    await tester.pumpAndSettle();

    expect(connection.selectHostCalls, ['host-a'],
        reason: '冷启动无扫码目标时，恢复上次选择的电脑是预期行为');
  });

  testWidgets('配对集合按 (relay, device, host) 读取（防止误报未配对）', (tester) async {
    await _seedPrefs();
    await saveDeviceSecret(
      'dev-1',
      'secret-b',
      relayUrl: 'ws://relay.example:8788/ws',
      hostId: 'host-b',
    );

    final ids = await loadPairedHostIds(
      'dev-1',
      relayUrl: 'ws://relay.example:8788/ws',
    );
    expect(ids, contains('host-b'));

    // 换一个 relay 作用域：凭证互不可见（避免跨 relay 误用）。
    final other = await loadPairedHostIds('dev-1', relayUrl: 'ws://other.example:8788/ws');
    expect(other, isNot(contains('host-b')));
  });
}
