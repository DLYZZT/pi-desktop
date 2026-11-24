import 'package:flutter_test/flutter_test.dart';
import 'package:pi_remote/widgets/tool_action_title.dart';

/// Mirrors the desktop `src/renderer/lib/tool-action-title.test.mjs` cases so
/// the two implementations cannot drift silently.
void main() {
  test('shell actions prefer a short description and fall back for missing or malformed ones', () {
    for (final name in ['bash', 'powershell']) {
      expect(
        toolActionTitle(name, {'description': 'Compare\n  two pages', 'command': 'diff a b'}),
        'Compare two pages',
      );
      for (final description in <Object?>[null, '  ', <String, dynamic>{}, 42]) {
        expect(
          toolActionTitle(name, {'description': description, 'command': 'git status'}),
          '运行命令: git status',
        );
      }
    }
  });

  test('known tools use input templates without treating document content as intent', () {
    const cases = <List<Object?>>[
      ['read', {'path': 'src/a.ts', 'description': 'Untrusted content'}, '查看文件: src/a.ts'],
      ['edit', {'file_path': 'src/a.ts', 'newText': 'secret'}, '修改文件: src/a.ts'],
      ['write', {'path': 'new.ts', 'content': 'secret'}, '写入文件: new.ts'],
      ['ls', {'path': 'src'}, '查看目录: src'],
      ['find', {'pattern': '*.html'}, '查找文件: *.html'],
      ['grep', {'pattern': 'LiveServer', 'path': 'src'}, '搜索文件内容: LiveServer'],
      ['web_search', {'query': 'Pi tools'}, '搜索网页: Pi tools'],
      ['web_fetch', {'url': 'https://example.com/docs'}, '读取网页: https://example.com/docs'],
      ['browser_navigate', {'url': 'https://example.com'}, '打开网页: https://example.com'],
      ['browser_tab', {'action': 'open', 'url': 'https://example.com'}, '打开网页: https://example.com'],
      ['browser_tab', {'action': 'list'}, '查看网页内容'],
      ['browser_pointer', {'action': 'click'}, '操作网页'],
      ['browser_input', {'action': 'type'}, '输入网页内容'],
      ['browser_screenshot', {'action': 'compare'}, '对比网页截图'],
      ['browser_network', {'action': 'summary'}, '查看网络请求'],
      ['browser_request_user_help', {'kind': 'login'}, '等待你操作'],
      ['browser_inspect', <String, dynamic>{}, '查看网页内容'],
      ['codemode', {'code': 'private script'}, '批量执行操作'],
      ['mcp_custom', {'description': 'not a display field', 'content': 'secret'}, '调用工具：mcp_custom'],
    ];
    for (final entry in cases) {
      expect(
        toolActionTitle(entry[0]! as String, entry[1] as Map<dynamic, dynamic>),
        entry[2],
        reason: '${entry[0]}',
      );
    }
    expect(toolActionTitle('read', null), '查看文件');
    expect(toolActionTitle('read', {'path': <String, dynamic>{}}), '查看文件');
  });

  test('long titles stay bounded without mutating the arguments', () {
    final description = List.filled(200, 'x').join();
    final input = <String, dynamic>{'description': description, 'command': 'git status'};
    expect(toolActionTitle('bash', input), '${List.filled(159, 'x').join()}…');
    expect(input['description'], description);
    expect(input['command'], 'git status');
  });
}