/// PC home: real sessions.list grouped into collapsible per-project groups
/// (search bar → group header: path / running dot / count / ＋ / ⋯ → session
/// rows: status dot / title / time · count / ⋯).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/host_store.dart';
import '../core/remote_connection.dart';
import '../widgets/session_models.dart';
import 'chat_page.dart';
import 'connect_page.dart';
import 'settings_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({required this.connection, super.key});

  final RemoteConnection connection;

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  List<SessionSummary> _sessions = [];
  List<String> _runningIds = [];
  bool _loading = true;
  String? _error;
  String _query = '';
  final Set<String> _expanded = {};
  bool _defaultsApplied = false;
  String? _creatingFor;
  List<RemoteHostInfo> _hosts = const [];
  RemoteHostInfo? _currentHost;
  /// 已配对（本机持有该电脑凭证）的 hostId 集合。
  Set<String> _pairedHostIds = const {};
  StreamSubscription<LinkState>? _stateSub;

  @override
  void initState() {
    super.initState();
    _restoreHostSelection();
    _stateSub = widget.connection.onState.listen((state) {
      if (state != LinkState.ready || !mounted) return;
      // 每次握手成功都清掉上一次的失败横幅：链路上来了，红字留着只会
      // 让人以为还断着。
      setState(() => _error = null);
      _syncHostState();
      // 重连/从离线恢复：静默刷新，失败由 _refresh 自己处理。
      unawaited(_refresh());
    });
    _refresh();
  }

  @override
  void dispose() {
    _stateSub?.cancel();
    super.dispose();
  }

  /// 列表与本次配对绑定：凭证被拒或解除绑定后，屏幕上的会话属于上一段
  /// 关系，既不能继续展示，也不该留在磁盘上等下次冷启动再冒出来。
  void _discardSessions({String? hostId}) {
    final id = hostId ?? widget.connection.hostId;
    if (id != null) unawaited(deleteCachedSessions(id));
    if (!mounted) return;
    setState(() {
      _sessions = [];
      _runningIds = [];
      _expanded.clear();
      _defaultsApplied = false;
    });
  }

  Future<void> _restoreHostSelection() async {
    final saved = await loadPreferredHost();
    // 只在「本连接没有显式目标、也尚未解析出主机」时才恢复上次的选择：
    // 扫码配对是明确意图（targetHostId 已定），此刻 preferredHostId 还没被
    // hello_ack 赋值，拿它当守卫会把刚扫的新电脑拽回上一台——relay 侧
    // 绑定照常完成（电脑端显示配对成功），但签发的凭证随被掐断的 socket
    // 丢失，手机从此显示「未配对」。
    if (saved != null &&
        widget.connection.targetHostId == null &&
        widget.connection.hostId == null) {
      setState(() {
        _hosts = const [];
      });
      // Set the preference before handshake flushes queued requests.
      await widget.connection.selectHost(saved);
      _refresh();
    }
    final cached = await loadKnownHosts();
    if (mounted && cached.isNotEmpty && _hosts.isEmpty) {
      setState(() => _hosts = cached);
    }
    await _reloadPairedHosts();
  }

  Future<void> _reloadPairedHosts() async {
    final ids = await loadPairedHostIds(
      widget.connection.deviceId,
      relayUrl: widget.connection.relayUrl,
    );
    if (mounted) setState(() => _pairedHostIds = ids);
  }

  void _syncHostState() {
    final hosts = widget.connection.knownHosts;
    final currentId = widget.connection.hostId;
    final current = hosts.where((h) => h.id == currentId).toList();
    setState(() {
      if (hosts.isNotEmpty) _hosts = hosts;
      _currentHost = current.isNotEmpty
          ? current.first
          : (_currentHost?.id == currentId ? _currentHost : null);
    });
    if (hosts.isNotEmpty) {
      saveKnownHosts(hosts);
      final id = widget.connection.hostId;
      if (id != null) savePreferredHost(id);
    }
    unawaited(_reloadPairedHosts());
  }

  Future<void> _refresh() async {
    final hostId = widget.connection.hostId;
    // 凭证已被拒/主机身份不符：缓存属于上一段配对，直接作废，不当成
    // 「本次会话的加速展示」再渲染一遍。
    final terminal = widget.connection.isTerminalFailure;
    if (terminal) {
      _discardSessions(hostId: hostId);
    } else if (hostId != null && _sessions.isEmpty) {
      // 断线重连/进页先渲染本机缓存（按 hostId 隔离），随后静默刷新；
      // 运行中状态不进缓存，永远以刷新结果为准。
      final cached = await loadCachedSessions(hostId);
      if (mounted && cached.isNotEmpty && _sessions.isEmpty) {
        setState(() {
          _sessions = cached;
          if (!_defaultsApplied) {
            _expanded.add(cached.first.projectRoot);
            _defaultsApplied = true;
          }
        });
      }
    }
    if (!mounted) return;
    setState(() {
      // 终态下列表已空：保持 loading 直到 request 立刻抛错，避免先闪一下
      // 「没有匹配的会话」再跳到错误态。
      _loading = _sessions.isEmpty;
      _error = null;
    });
    try {
      final result = await widget.connection.request('sessions.list', null);
      final raw = result['sessions'];
      final sessions = <SessionSummary>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is Map) sessions.add(SessionSummary.fromMap(Map<String, dynamic>.from(item)));
        }
      }
      sessions.sort((a, b) => b.modified.compareTo(a.modified));
      final running = result['runningSessionIds'];
      if (hostId != null) {
        // 失败可容忍：缓存只是加速展示，写不进去不影响本次渲染。
        unawaited(saveCachedSessions(hostId, sessions));
      }
      setState(() {
        _sessions = sessions;
        _runningIds = running is List ? running.map((e) => e.toString()).toList() : [];
        _loading = false;
        _error = null;
        if (!_defaultsApplied && sessions.isNotEmpty) {
          // Most recent project starts expanded.
          _expanded.add(sessions.first.projectRoot);
          _defaultsApplied = true;
        }
        _syncHostState();
      });
    } catch (err) {
      final message = err is StateError ? err.message.replaceFirst('Bad state: ', '') : err.toString();
      // 终态失败（凭证被拒/主机身份不符）：列表连同磁盘快照一起作废，
      // 让整页错误态与「重新扫码配对」成为唯一出口。离线/超时是瞬态，
      // 保留快照——那正是缓存的价值。
      if (widget.connection.isTerminalFailure) _discardSessions(hostId: hostId);
      if (!mounted) return;
      setState(() {
        // 离线是已知状态而非异常：用空态提示，不显示红色超时错误。
        // 但配对被拒/协议违规等服务器主动断链要原样呈现给用户。
        _error = widget.connection.isTargetHostOffline ? null : widget.connection.describeLastFailure() ?? message;
        _loading = false;
      });
    }
  }

  Future<void> _openChat(SessionSummary session) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatPage(
          connection: widget.connection,
          sessionId: session.id,
          title: session.title,
        ),
      ),
    );
    _refresh();
  }

  /// 配对被拒（4003）的自救入口：停掉本连接的重连循环，回到连接页重新
  /// 扫码——一次性 token 已消费时任何重试都无济于事，只有新扫码能重新
  /// 配对并签发凭证。
  Future<void> _rescanPairing() async {
    _discardSessions();
    widget.connection.disconnect();
    if (!mounted) return;
    await Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const ConnectPage()),
      (route) => false,
    );
  }

  Future<void> _renameSession(SessionSummary session, String name) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return;
    try {
      await widget.connection.request('sessions.rename', {'id': session.id, 'name': trimmed});
      await _refresh();
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Future<void> _deleteSession(SessionSummary session) async {
    try {
      await widget.connection.request('sessions.delete', {'id': session.id});
      await _refresh();
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  void _confirmDelete(SessionSummary session) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('确定删除「${session.title}」？该操作不可撤销。'),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            onPressed: () {
              Navigator.of(dialogContext).pop();
              _deleteSession(session);
            },
            child: const Text('删除'),
          ),
        ],
      ),
    );
  }

  /// 移除项目：逐个删除该项目下的会话记录（磁盘代码不动，与桌面端
  /// SessionSidebar.handleRemoveProject 同语义），完成后刷新列表。部分
  /// 失败如实汇报，不让用户以为全删干净了。
  Future<void> _confirmRemoveProject(String projectRoot) async {
    final count = _sessions.where((s) => s.projectRoot == projectRoot).length;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('移除项目'),
        content: Text(
          count > 0
              ? '移除「${projectName(projectRoot)}」？其 $count 条会话记录将被删除；磁盘上的代码不受影响。该操作不可撤销。'
              : '从列表中移除「${projectName(projectRoot)}」？',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('移除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final targets = _sessions.where((s) => s.projectRoot == projectRoot).toList();
    final failures = <String>[];
    for (final session in targets) {
      try {
        await widget.connection.request('sessions.delete', {'id': session.id, 'force': true});
      } catch (err) {
        failures.add(err is StateError ? err.message.replaceFirst('Bad state: ', '') : err.toString());
      }
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          failures.isEmpty
              ? '已移除「${projectName(projectRoot)}」'
              : '部分会话记录删除失败：${failures.first}${failures.length > 1 ? '（等 $failures 条）' : ''}',
        ),
      ),
    );
    await _refresh();
  }

  void _renameDialog(SessionSummary session) {
    final controller = TextEditingController(text: session.name ?? '');
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '输入新名称', border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              _renameSession(session, controller.text);
            },
            child: const Text('重命名'),
          ),
        ],
      ),
    );
  }

  Future<void> _newTask(String projectRoot, {String? provider, String? modelId}) async {
    if (_creatingFor != null) return;
    setState(() => _creatingFor = projectRoot);
    try {
      final params = <String, dynamic>{'cwd': projectRoot};
      if (provider != null && modelId != null) {
        params['provider'] = provider;
        params['modelId'] = modelId;
        params['modelSelectionExplicit'] = true;
      }
      final result = await widget.connection.request('agent.new', params);
      final sessionId = result['sessionId'] as String?;
      if (!mounted) return;
      if (sessionId == null || sessionId.isEmpty) {
        setState(() => _error = 'agent.new 未返回 sessionId');
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ChatPage(
            connection: widget.connection,
            sessionId: sessionId,
            title: '${projectName(projectRoot)} · 新任务',
          ),
        ),
      );
      _refresh();
    } catch (err) {
      setState(() => _error = err.toString());
    } finally {
      if (mounted) setState(() => _creatingFor = null);
    }
  }

  /// 模型选择 sheet：默认模型 + 桌面端启用的模型列表，选择后创建新任务。
  Future<void> _pickModelAndCreate(String projectRoot) async {
    try {
      final prefs = await widget.connection.request('models.preferences.get', null);
      if (!mounted) return;
      final models = <Map<String, dynamic>>[
        if (prefs['models'] is List)
          for (final m in prefs['models'] as List)
            if (m is Map) Map<String, dynamic>.from(m),
      ];
      final defaultModel = prefs['defaultModel'];
      await showModalBottomSheet<void>(
        context: context,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
        builder: (sheetContext) => SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                  child: Text('新建任务 · 选择模型（${projectName(projectRoot)}）',
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
                ),
                const Divider(height: 1),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      ListTile(
                        dense: true,
                        leading: const Icon(Icons.auto_awesome, size: 18),
                        title: const Text('默认模型（跟随 PC 设置）', style: TextStyle(fontSize: 14)),
                        onTap: () {
                          Navigator.of(sheetContext).pop();
                          _newTask(projectRoot);
                        },
                      ),
                      for (final m in models)
                        ListTile(
                          dense: true,
                          title: Text(
                            m['name'] as String? ?? m['id'] as String? ?? '',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 14),
                          ),
                          subtitle: Text('${m['provider']}/${m['id']}',
                              maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
                          trailing: defaultModel is Map &&
                                  defaultModel['provider'] == m['provider'] &&
                                  defaultModel['modelId'] == m['id']
                              ? Text('默认', style: TextStyle(fontSize: 11, color: Colors.green.shade700))
                              : null,
                          onTap: () {
                            Navigator.of(sheetContext).pop();
                            _newTask(projectRoot, provider: m['provider'] as String, modelId: m['id'] as String);
                          },
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _query.isEmpty
        ? _sessions
        : _sessions
            .where((s) =>
                s.title.toLowerCase().contains(_query) ||
                projectName(s.projectRoot).toLowerCase().contains(_query) ||
                s.projectRoot.toLowerCase().contains(_query))
            .toList();
    final grouped = groupByProject(filtered);
    final projects = grouped.keys.toList()
      ..sort((a, b) {
        final ra = grouped[a]!.first.modified;
        final rb = grouped[b]!.first.modified;
        return rb.compareTo(ra);
      });
    return Scaffold(
      appBar: AppBar(
        title: _HostSelectorButton(
          current: _currentHost,
          fallbackName: widget.connection.hostId ?? '我的电脑',
          onTap: _openHostSelector,
        ),
        actions: [
          IconButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => SettingsPage(connection: widget.connection)),
            ),
            icon: const Icon(Icons.settings_outlined),
            tooltip: '设置',
          ),
          IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh), tooltip: '刷新'),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null && _sessions.isEmpty
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!, style: const TextStyle(color: Colors.red), textAlign: TextAlign.center),
                      const SizedBox(height: 12),
                      FilledButton(onPressed: _refresh, child: const Text('重试')),
                      if (widget.connection.lastFailureWasPairingReject) ...[
                        const SizedBox(height: 8),
                        OutlinedButton(onPressed: _rescanPairing, child: const Text('重新扫码配对')),
                      ],
                    ],
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
                    children: [
                      _searchField(),
                      const SizedBox(height: 8),
                      if (_error != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
                              if (widget.connection.lastFailureWasPairingReject)
                                TextButton(
                                  onPressed: _rescanPairing,
                                  child: const Text('重新扫码配对'),
                                ),
                            ],
                          ),
                        ),
                      if (projects.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Center(
                            child: Text(
                              widget.connection.isTargetHostOffline
                                  ? '所选电脑当前离线\n它重新上线后会自动加载会话'
                                  : '没有匹配的会话',
                              textAlign: TextAlign.center,
                              style: const TextStyle(color: Colors.black38, height: 1.6),
                            ),
                          ),
                        ),
                      for (final root in projects)
                        _ProjectGroup(
                          root: root,
                          sessions: grouped[root]!,
                          runningIds: _runningIds,
                          expanded: _query.isNotEmpty || _expanded.contains(root),
                          creating: _creatingFor == root,
                          onToggle: () => setState(() {
                            if (!_expanded.remove(root)) _expanded.add(root);
                          }),
                          onNewTask: () => _pickModelAndCreate(root),
                          onOpenSession: _openChat,
                          onRename: _renameDialog,
                          onDelete: _confirmDelete,
                          onRefresh: _refresh,
                          onRemoveProject: () => _confirmRemoveProject(root),
                        ),
                    ],
                  ),
                ),
    );
  }

  /// 多 PC：设备选择器 sheet（在线优先，离线带上次在线时间）。
  Future<void> _openHostSelector() async {
    // Ask the relay for a fresh directory first, then refresh local pairing
    // state so the sheet reflects the latest per-host credentials.
    widget.connection.refreshHosts();
    await _reloadPairedHosts();
    if (!mounted) return;
    final currentId = widget.connection.hostId;
    final hosts = [...widget.connection.knownHosts, ..._hosts.where((h) => !widget.connection.knownHosts.any((k) => k.id == h.id))];
    hosts.sort((a, b) {
      if (a.online != b.online) return a.online ? -1 : 1;
      return a.id.compareTo(b.id);
    });
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.55),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                child: Row(
                  children: [
                    const Text('选择电脑', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    const Spacer(),
                    IconButton(
                      icon: const Icon(Icons.refresh, size: 20),
                      onPressed: () {
                        widget.connection.refreshHosts();
                        Future.delayed(const Duration(milliseconds: 600), () {
                          if (sheetContext.mounted) {
                            Navigator.of(sheetContext).pop();
                            unawaited(_openHostSelector());
                          }
                        });
                      },
                      tooltip: '刷新',
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Flexible(
                child: hosts.isEmpty
                    ? const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: Text('暂无已知电脑', style: TextStyle(color: Colors.black38))),
                      )
                    : ListView(
                        shrinkWrap: true,
                        children: [
                          for (final host in hosts)
                            ListTile(
                              dense: true,
                              leading: Icon(
                                host.online ? Icons.computer : Icons.computer_outlined,
                                color: host.online ? Colors.green.shade600 : Colors.black26,
                              ),
                              title: Text(
                                host.displayName,
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: host.id == currentId ? FontWeight.bold : FontWeight.w500,
                                ),
                              ),
                              subtitle: Text(
                                '${host.online ? '在线' : (host.lastSeenAt != null ? '离线 · 上次在线 ${relativeTime(DateTime.fromMillisecondsSinceEpoch(host.lastSeenAt!))}' : '离线')}'
                                '${_pairedHostIds.contains(host.id) ? '' : ' · 未配对'}',
                                style: TextStyle(
                                  fontSize: 11,
                                  color: host.online ? Colors.green.shade700 : Colors.black38,
                                ),
                              ),
                              trailing: host.id == currentId
                                  ? Icon(Icons.check_circle, size: 20, color: Theme.of(context).colorScheme.primary)
                                  : const Icon(Icons.chevron_right, size: 18, color: Colors.black26),
                              onLongPress: () => _confirmDeleteHost(host, sheetContext),
                              onTap: host.id == currentId
                                  ? null
                                  : () async {
                                      if (!_pairedHostIds.contains(host.id)) {
                                        Navigator.of(sheetContext).pop();
                                        if (mounted) {
                                          ScaffoldMessenger.of(context).showSnackBar(
                                            const SnackBar(content: Text('这台电脑尚未配对，请先在连接页扫码配对')),
                                          );
                                        }
                                        return;
                                      }
                                      Navigator.of(sheetContext).pop();
                                      // 切换时立即清空上一台机器的列表，避免误以为数据没变。
                                      setState(() {
                                        _loading = true;
                                        _sessions = [];
                                        _runningIds = [];
                                        _error = null;
                                        _expanded.clear();
                                        _defaultsApplied = false;
                                      });
                                      await widget.connection.selectHost(host.id);
                                      _refresh();
                                    },
                            ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 长按删除：relay 侧解绑 + 本机凭证清除，之后必须重新扫码。
  Future<void> _confirmDeleteHost(RemoteHostInfo host, BuildContext sheetContext) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除电脑'),
        content: Text(
          '确定删除「${host.displayName}」？\n\n删除后，需要重新扫码才能再次连接。'
          '${host.id == widget.connection.hostId ? '\n\n这台电脑当前正在连接，删除后会断开。' : ''}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade600),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final wasCurrent = host.id == widget.connection.hostId;
    widget.connection.unbindHost(host.id);
    await deleteDeviceSecret(
      widget.connection.deviceId,
      relayUrl: widget.connection.relayUrl,
      hostId: host.id,
    );
    // 会话快照与凭证同生同灭：留着它，下次配对新凭证时会先闪一遍旧数据。
    await deleteCachedSessions(host.id);
    if (wasCurrent && mounted) {
      setState(() {
        _sessions = [];
        _runningIds = [];
        _expanded.clear();
        _defaultsApplied = false;
      });
    }
    await _reloadPairedHosts();
    // 当前连接用的是刚删掉的凭证，主动断开避免自动重连循环。
    if (wasCurrent) widget.connection.disconnect();
    if (sheetContext.mounted) Navigator.of(sheetContext).pop();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已删除，需要重新扫码才能再次连接')),
      );
    }
  }

  Widget _searchField() {
    return TextField(
      onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
      decoration: InputDecoration(
        hintText: '搜索会话…',
        prefixIcon: const Icon(Icons.search, size: 20),
        suffixIcon: _query.isEmpty
            ? null
            : IconButton(
                icon: const Icon(Icons.close, size: 18),
                onPressed: () => setState(() => _query = ''),
              ),
        isDense: true,
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
      ),
    );
  }
}

class _ProjectGroup extends StatelessWidget {
  final String root;
  final List<SessionSummary> sessions;
  final List<String> runningIds;
  final bool expanded;
  final bool creating;
  final VoidCallback onToggle;
  final VoidCallback onNewTask;
  final void Function(SessionSummary) onOpenSession;
  final void Function(SessionSummary) onRename;
  final void Function(SessionSummary) onDelete;
  final VoidCallback onRefresh;
  final VoidCallback onRemoveProject;

  const _ProjectGroup({
    required this.root,
    required this.sessions,
    required this.runningIds,
    required this.expanded,
    required this.creating,
    required this.onToggle,
    required this.onNewTask,
    required this.onOpenSession,
    required this.onRename,
    required this.onDelete,
    required this.onRefresh,
    required this.onRemoveProject,
  });

  int get runningCount => sessions.where((s) => runningIds.contains(s.id)).length;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: const Color(0xFFFDF3E7),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        children: [
          InkWell(
            onTap: onToggle,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 10, 4, 10),
              child: Row(
                children: [
                  AnimatedRotation(
                    turns: expanded ? 0 : -0.25,
                    duration: const Duration(milliseconds: 160),
                    child: const Icon(Icons.expand_more, size: 20, color: Colors.black54),
                  ),
                  const SizedBox(width: 6),
                  const Icon(Icons.folder_outlined, size: 18, color: Color(0xFF534AB7)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      root,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
                    ),
                  ),
                  if (runningCount > 0) ...[
                    Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(color: Colors.red.shade400, shape: BoxShape.circle),
                    ),
                    const SizedBox(width: 4),
                  ],
                  Text('${sessions.length}', style: const TextStyle(fontSize: 13, color: Colors.black54)),
                  const SizedBox(width: 4),
                  _IconAction(
                    icon: creating ? Icons.hourglass_top : Icons.add,
                    tooltip: creating ? '正在创建…' : '新建任务',
                    onTap: creating ? null : onNewTask,
                  ),
                  PopupMenuButton<String>(
                    icon: const Icon(Icons.more_horiz, size: 20, color: Colors.black54),
                    tooltip: '更多',
                    onSelected: (value) {
                      if (value == 'refresh') {
                        onRefresh();
                      } else if (value == 'remove') {
                        onRemoveProject();
                      }
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'refresh', child: Text('刷新')),
                      PopupMenuItem(value: 'remove', child: Text('移除项目')),
                    ],
                  ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: expanded
                ? Column(
                    children: [
                      for (final s in sessions)
                        _SessionRow(
                          summary: s,
                          running: runningIds.contains(s.id),
                          onTap: () => onOpenSession(s),
                          onRename: () => onRename(s),
                          onDelete: () => onDelete(s),
                        ),
                    ],
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

class _IconAction extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  const _IconAction({required this.icon, required this.tooltip, this.onTap});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      visualDensity: VisualDensity.compact,
      iconSize: 20,
      tooltip: tooltip,
      onPressed: onTap,
      icon: Icon(icon, color: Colors.black54),
    );
  }
}

class _SessionRow extends StatelessWidget {
  final SessionSummary summary;
  final bool running;
  final VoidCallback onTap;
  final VoidCallback onRename;
  final VoidCallback onDelete;

  const _SessionRow({
    required this.summary,
    required this.running,
    required this.onTap,
    required this.onRename,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 4, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 8,
              height: 8,
              margin: const EdgeInsets.only(top: 6),
              decoration: BoxDecoration(
                color: running ? Colors.red.shade400 : const Color(0xFF8D3B34),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    summary.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${relativeTime(summary.modified)}   ${summary.messageCount} 条消息',
                    style: const TextStyle(fontSize: 12, color: Colors.black45),
                  ),
                ],
              ),
            ),
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_horiz, size: 20, color: Colors.black45),
              onSelected: (value) {
                if (value == 'copy') {
                  Clipboard.setData(ClipboardData(text: summary.id));
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('会话 ID 已复制')));
                } else if (value == 'rename') {
                  onRename();
                } else if (value == 'delete') {
                  onDelete();
                }
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'rename', child: Text('重命名')),
                const PopupMenuItem(value: 'delete', child: Text('删除')),
                const PopupMenuItem(value: 'copy', child: Text('复制会话 ID')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Home AppBar title: current PC name + online badge; taps open the
/// multi-PC selector sheet (WorkBuddy-style device picker).
class _HostSelectorButton extends StatelessWidget {
  final RemoteHostInfo? current;
  final String fallbackName;
  final VoidCallback onTap;

  const _HostSelectorButton({required this.current, required this.fallbackName, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final name = current?.displayName ?? fallbackName;
    final online = current?.online ?? false;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.computer,
              size: 22,
              color: online ? Colors.green.shade600 : Colors.black38,
            ),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 180),
              child: Text(
                name,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
            ),
            const SizedBox(width: 4),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: online ? Colors.green.shade50 : Colors.black12,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                online ? '在线' : '离线',
                style: TextStyle(
                  fontSize: 12,
                  color: online ? Colors.green.shade700 : Colors.black45,
                ),
              ),
            ),
            const SizedBox(width: 2),
            const Icon(Icons.expand_more, size: 18, color: Colors.black38),
          ],
        ),
      ),
    );
  }
}
