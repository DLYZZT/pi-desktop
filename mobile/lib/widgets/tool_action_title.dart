/// Readable action titles for tool cards, mirroring the desktop renderer's
/// `src/renderer/lib/tool-action-title.ts`.
///
/// The mobile UI is Chinese-only, so the label table is the desktop zhCN
/// dictionary. Keep the two switches in sync: the desktop test file lists the
/// same cases, and `test/tool_action_title_test.dart` mirrors them here.
library;

const int _maxTitleLength = 160;

/// Collapse whitespace and bound the length, matching the desktop `shortText`.
String _shortText(Object? value) {
  if (value is! String) return '';
  final text = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  return text.length > _maxTitleLength ? '${text.substring(0, _maxTitleLength - 1)}…' : text;
}

/// Describe the requested action, never infer success or the intent of
/// arbitrary shell code.
String toolActionTitle(String toolName, Map<dynamic, dynamic>? input) {
  String target(String template, Object? value) {
    final text = _shortText(value);
    return text.isEmpty ? template : '$template: $text';
  }

  final path = input?['path'] ?? input?['file_path'];
  switch (toolName) {
    case 'bash':
    case 'powershell':
      final description = _shortText(input?['description']);
      return description.isNotEmpty ? description : target('运行命令', input?['command']);
    case 'read':
      return target('查看文件', path);
    case 'write':
      return target('写入文件', path);
    case 'edit':
      return target('修改文件', path);
    case 'ls':
      return target('查看目录', path);
    case 'find':
      return target('查找文件', input?['pattern']);
    case 'grep':
      return target('搜索文件内容', input?['pattern']);
    case 'web_search':
      return target('搜索网页', input?['query']);
    case 'web_fetch':
      return target('读取网页', input?['url']);
    case 'browser_open':
    case 'browser_navigate':
      return target('打开网页', input?['url']);
    case 'browser_inspect':
      return '查看网页内容';
    case 'browser_screenshot':
      return '截取网页截图';
    case 'codemode':
      return '批量执行操作';
    default:
      return '调用工具：${_shortText(toolName)}';
  }
}