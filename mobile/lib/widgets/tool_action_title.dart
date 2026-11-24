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
    case 'browser_tab':
      if (input?['action'] == 'open' || input?['action'] == 'navigate') {
        return target('打开网页', input?['url']);
      }
      return '查看网页内容';
    case 'browser_device':
      return '切换设备预览';
    case 'browser_inspect':
    case 'browser_read':
      return '查看网页内容';
    case 'browser_pointer':
      return '操作网页';
    case 'browser_input':
      return '输入网页内容';
    case 'browser_wait':
      return '等待网页';
    case 'browser_request_user_help':
      return '等待你操作';
    case 'browser_upload':
      return '上传文件';
    case 'browser_downloads':
      return '查看下载';
    case 'browser_network':
      return '查看网络请求';
    case 'browser_console':
      return '查看控制台';
    case 'browser_js':
      return '运行页面脚本';
    case 'browser_clipboard':
      return '使用剪贴板';
    case 'browser_header_rules':
      return '修改请求头';
    case 'browser_get_cookies':
      return '读取 Cookie';
    case 'browser_send_cdp_command':
      return '发送 CDP 命令';
    case 'browser_screenshot':
      return input?['action'] == 'compare' ? '对比网页截图' : '截取网页截图';
    case 'browser_batch':
      return '批量执行操作';
    case 'codemode':
      return '批量执行操作';
    default:
      return '调用工具：${_shortText(toolName)}';
  }
}