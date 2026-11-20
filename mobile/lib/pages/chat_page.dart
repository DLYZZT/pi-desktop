/// Chat page bound to a real PC session: history from sessions.get, live
/// agent.events stream, prompt / steer commands, approval cards, abort.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;
import '../core/chat_scroll_policy.dart';
import '../core/remote_connection.dart';
import '../widgets/ask_sheet.dart';
import '../widgets/markdown_text.dart';
import '../widgets/session_models.dart';

/// PC `agentState.running` means the session object is still alive
/// (`isAlive()`), NOT that a turn is in flight. A turn is running only when
/// the runtime snapshot returned by `get_state` says so; the desktop makes
/// the same distinction in useAgentSession.ts. Reading `running` here made
/// every live session look like "turn in progress", so the first message was
/// sent as `steer` and sat in pi's steering queue with no run to consume it.
bool turnRunningFromAgentState(Object? agentState) {
  if (agentState is! Map) return false;
  final runtime = agentState['state'];
  if (runtime is! Map) return false;
  return runtime['isStreaming'] == true || runtime['isPromptRunning'] == true;
}

class ChatPage extends StatefulWidget {
  const ChatPage({
    required this.connection,
    required this.sessionId,
    required this.title,
    super.key,
  });

  final RemoteConnection connection;
  final String sessionId;
  final String title;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with WidgetsBindingObserver {
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();
  final _lines = <ChatLine>[];
  final _toolIndexByCallId = <String, int>{};
  final _expandedTools = <String>{};
  final _expandedThinking = <String>{};
  final _approvals = <Map<String, dynamic>>[];
  /// Pending ask requests keyed by requestId. The sheet shows one at a time and
  /// the map survives a sheet being dismissed so it can be reopened.
  final _asks = <String, Map<String, dynamic>>{};
  /// Set while the active ask settled elsewhere (desktop answered) — the open
  /// sheet watches it and closes without sending a second answer.
  ValueNotifier<bool>? _askResolvedElsewhere;
  String? _activeAskId;
  bool _askSheetOpen = false;
  String? _error;
  /// sessions.get 还没回来（进页到首帧历史渲染之间）：显示加载指示，
  /// 而不是把"还没加载"误渲染成"空会话"。
  bool _loadingHistory = true;
  StreamSubscription<RemoteSessionEvent>? _events;
  Timer? _renderThrottle;
  bool _pendingRender = false;
  /// 滚动磁吸（对齐桌面端 chat-scroll-policy）：流式输出跟随到底；用户
  /// 上滚立即脱开，滚回距底 96px 内重新吸附。
  bool _scrollMagnetEngaged = true;
  /// 离底状态（驱动悬浮"回到底部"按钮），磁吸脱开且不在底部时为 true。
  bool _awayFromBottom = false;
  Map<String, String>? _currentModel; // {provider, modelId}
  /// Display names from the PC catalog, keyed by `provider/modelId`.
  Map<String, String> _modelNames = const {};
  Timer? _modelRefreshDebounce;
  bool _switchingModel = false;
  String? _sendingText;
  bool _awaitingFirst = false;
  bool _slashOpen = false;
  bool _slashSkillsLoaded = false;
  /// Turn-state mirror (PC `isStreaming` equivalent): true while the agent
  /// is running a turn on the PC. Drives steer-vs-prompt and the queue bar.
  bool _turnRunning = false;
  Timer? _queuePollTimer;
  List<String> _steeringQueue = const [];
  List<String> _followUpQueue = const [];
  bool _clearingQueue = false;
  List<Map<String, String>> _slashItems = const [
    {'name': 'compact', 'desc': '压缩上下文，可附指令', 'source': '内置'},
    {'name': 'reload', 'desc': '重载扩展、技能、提示词与工具', 'source': '内置'},
    {'name': 'name', 'desc': '设置会话显示名', 'source': '内置'},
    {'name': 'session', 'desc': '查看会话消息/token/费用统计', 'source': '内置'},
    {'name': 'copy', 'desc': '复制最后一条助手回复', 'source': '内置'},
  ];
  late final String _sessionId = widget.sessionId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _attach();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Reconcile the chip when the user returns to the app, even if the
    // sessions.changed event was missed while suspended.
    if (state == AppLifecycleState.resumed) _scheduleModelRefresh();
  }

  Future<void> _attach() async {
    _events = widget.connection.onEvent.listen(_onEvent);
    try {
      await widget.connection.subscribe('agent.events', _sessionId);
      await widget.connection.subscribe('agent.running', _sessionId);
      // PC writes model_change / messages into the session file; the watcher
      // broadcasts sessions.changed. Use it to keep the model chip in sync.
      await widget.connection.subscribe('sessions.changed', _sessionId);
      // Mirrored dialogs; subscribing also replays requests still pending at
      // the PC (the host answers this subscribe with the unresolved ones).
      await widget.connection.subscribe('remote.approval', _sessionId);
      unawaited(_loadModelNames());
      // includeState is required or the PC omits agentState entirely,
      // which would break the running-mirror restore below.
      final detail = await widget.connection.request(
        'sessions.get',
        {'id': _sessionId, 'includeState': true},
      );
      setState(() {
        _lines
          ..clear()
          ..addAll(historyLinesFromDetail(detail));
        _currentModel = _modelFromDetail(detail);
        _loadingHistory = false;
        // Restore the turn mirror from the runtime snapshot so the
        // steer-vs-prompt choice is correct right after opening the page.
        _turnRunning = turnRunningFromAgentState(detail['agentState']);
      });
      _applyTurnRunning(_turnRunning);
      // agent.running broadcasts changes only and never replays a snapshot on
      // subscribe; reconcile against the authoritative running-session ids so
      // an idle PC cannot leave this page stuck in "turn in progress".
      await _reconcileTurnRunning();
      _throttledScroll();
    } catch (err) {
      setState(() {
        _error = err.toString();
        _loadingHistory = false;
      });
    }
  }

  /// Apply a turn-state change from any source (snapshot restore, running
  /// broadcast, sessions.list reconciliation), keeping the queue bar and its
  /// polling in sync with the mirror.
  void _applyTurnRunning(bool running) {
    if (!mounted) return;
    setState(() {
      _turnRunning = running;
      if (!running) {
        _steeringQueue = const [];
        _followUpQueue = const [];
      }
    });
    if (running) {
      _startQueuePolling();
    } else {
      _stopQueuePolling();
    }
  }

  /// `sessions.list.runningSessionIds` comes from `isRunning()` on the PC
  /// (the same source the home page uses for its running dot). Best-effort:
  /// a failure here must not break the page, the snapshot restore above is
  /// already a reasonable fallback.
  Future<void> _reconcileTurnRunning() async {
    try {
      final result = await widget.connection.request('sessions.list', null);
      final ids = result['runningSessionIds'];
      if (ids is! List) return;
      final running = ids.map((e) => e.toString()).contains(_sessionId);
      if (running != _turnRunning) _applyTurnRunning(running);
    } catch (_) {
      // Keep the value restored from the session snapshot.
    }
  }

  Map<String, String>? _modelFromDetail(Map<String, dynamic> detail) {
    final context = detail['context'];
    if (context is Map) {
      for (final key in ['selectedModel', 'model']) {
        final m = context[key];
        if (m is Map && m['provider'] is String && m['modelId'] is String) {
          return {'provider': m['provider'] as String, 'modelId': m['modelId'] as String};
        }
      }
    }
    final agentState = detail['agentState'];
    if (agentState is Map) {
      final m = agentState['model'];
      if (m is Map && m['provider'] is String && m['id'] is String) {
        return {'provider': m['provider'] as String, 'modelId': m['id'] as String};
      }
    }
    return null;
  }

  /// Full model catalog from the PC. `models.preferences.get` already returns
  /// every available model; `enabledModels` is Pi's own scoped-picker filter
  /// and the desktop picker deliberately ignores it (see
  /// projectModelPreferences in model-catalog.ts), so this sheet must not
  /// narrow the list either. Also caches display names for the AppBar chip.
  Future<Map<String, dynamic>> _loadModelNames() async {
    final prefs = await widget.connection.request('models.preferences.get', null);
    final names = <String, String>{};
    final raw = prefs['models'];
    if (raw is List) {
      for (final m in raw) {
        if (m is Map && m['provider'] is String && m['id'] is String && m['name'] is String) {
          names['${m['provider']}/${m['id']}'] = m['name'] as String;
        }
      }
    }
    if (mounted) setState(() => _modelNames = names);
    return prefs;
  }

  void _scheduleModelRefresh() {
    _modelRefreshDebounce?.cancel();
    _modelRefreshDebounce = Timer(const Duration(milliseconds: 600), () => _refreshCurrentModel());
  }

  /// Re-read only the session's selected model, without rebuilding the
  /// transcript, so scroll position and the draft survive PC-side switches.
  Future<void> _refreshCurrentModel() async {
    if (!mounted) return;
    try {
      final detail = await widget.connection.request(
        'sessions.get',
        {'id': _sessionId, 'includeState': true},
      );
      final model = _modelFromDetail(detail);
      if (!mounted || model == null) return;
      setState(() => _currentModel = model);
    } catch (_) {
      // Keep the last known selection; transient relay errors are harmless.
    }
  }

  Future<void> _pickModel() async {
    try {
      final prefs = await _loadModelNames();
      if (!mounted) return;
      await showModalBottomSheet<void>(
        context: context,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
        builder: (sheetContext) => _ModelPickerSheet(prefs: prefs, current: _currentModel, onPick: _setModel),
      );
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  Future<void> _setModel(String provider, String modelId, BuildContext sheetContext) async {
    if (_switchingModel) return;
    setState(() => _switchingModel = true);
    try {
      await widget.connection.agentCommand(_sessionId, {'type': 'set_model', 'provider': provider, 'modelId': modelId});
      if (!mounted) return;
      setState(() {
        _currentModel = {'provider': provider, 'modelId': modelId};
        _error = null;
      });
      if (sheetContext.mounted) Navigator.of(sheetContext).pop();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('已切换到 $modelId')));
    } catch (err) {
      final message = err is StateError ? err.message.replaceFirst('Bad state: ', '') : err.toString();
      if (sheetContext.mounted) {
        ScaffoldMessenger.of(sheetContext).showSnackBar(
          SnackBar(content: Text(message), backgroundColor: Colors.red.shade700),
        );
      }
    } finally {
      if (mounted) setState(() => _switchingModel = false);
    }
  }

  void _onEvent(RemoteSessionEvent event) {
    if (event.topic == 'sessions.changed') {
      // PC wrote to the session (model switch, new message, rename). Collapse
      // the burst into one lightweight snapshot read.
      _scheduleModelRefresh();
      return;
    }
    if (event.topic == 'remote.approval') {
      final data = Map<String, dynamic>.from(event.data as Map);
      if ((data['sessionId'] as String?) != _sessionId) return;
      final requestId = data['requestId'] as String?;
      if (data['resolved'] == true) {
        // Answered on the PC (or timed out / aborted): drop every card and
        // close the sheet if it is the one showing this request.
        if (requestId != null) _settleRequest(requestId);
        return;
      }
      if (data['method'] == 'ask') {
        if (requestId != null) _enqueueAsk(requestId, data);
        return;
      }
      // A reconnect replays the pending set; never stack the same card twice.
      if (requestId != null && _approvals.any((entry) => entry['requestId'] == requestId)) return;
      setState(() => _approvals.add(data));
      return;
    }
    if (event.topic == 'agent.running') {
      // Turn lifecycle from the PC: refresh running state + queue bar.
      // PC emits a global payload: {type, sessionIds, runningSessionIds}.
      final data = event.data is Map ? event.data as Map : const {};
      final raw = data['runningSessionIds'] ?? data['sessionIds'];
      final ids = raw is List ? raw.map((e) => e.toString()).toSet() : const <String>{};
      final nowRunning = ids.contains(_sessionId);
      if (nowRunning != _turnRunning || nowRunning) _applyTurnRunning(nowRunning);
      return;
    }
    if (event.topic != 'agent.events' || event.key != _sessionId) return;
    final data = event.data;
    if (data is! Map) return;
    final type = data['type'] as String?;
    final message = data['message'];
    if (message is! Map) return;
    final role = message['role'] as String?;
    setState(() {
      if (role == 'toolResult') {
        // Tool results pair into their toolCall card (desktop MessageView
        // behavior); unpaired ones become standalone result cards.
        applyToolResult(_lines, _toolIndexByCallId, message);
        _throttledScroll();
        return;
      }
      final text = extractText(message['content']);
      final content = message['content'];
      switch (type) {
        case 'message_start':
          // Text lines are created on first non-empty content; tool calls are
          // upserted from content blocks below.
          break;
        case 'message_update':
          _applyStreamedMessage(role, content, text, done: false);
          break;
        case 'message_end':
          _applyStreamedMessage(role, content, text, done: true);
          break;
        default:
          break;
      }
    });
    _throttledScroll();
  }

  void _applyStreamedMessage(String? role, Object? content, String? text, {required bool done}) {
    var hasContent = false;
    if (content is List) {
      for (final block in content) {
        if (block is! Map) continue;
        if (block['type'] == 'toolCall') {
          hasContent = true;
          upsertToolCard(_lines, _toolIndexByCallId, block);
        } else if (block['type'] == 'thinking') {
          hasContent = true;
          _upsertThinkingLine(role ?? 'assistant', block['thinking'] as String? ?? '', done: done);
        } else if (block['type'] == 'text') {
          final blockText = (block['text'] as String? ?? '').trim();
          if (blockText.isEmpty) continue;
          hasContent = true;
          _upsertTextLine(role ?? 'assistant', blockText, done: done);
        }
      }
    }
    if (!hasContent && text != null && text.trim().isNotEmpty && content is! List) {
      _upsertTextLine(role ?? 'assistant', text.trim(), done: done);
      hasContent = true;
    }
    if (done && role != 'user') {
      for (final line in _lines) {
        if ((line.kind == 'text' || line.kind == 'thinking') && line.role == role) line.done = true;
      }
    }
    if (hasContent && role == 'assistant') _awaitingFirst = false;
    if (role == 'user') _sendingText = null;
  }

  /// 流式 upsert 的行查找：从尾向前找同 role 同 kind 且未完结的行。
  /// 只看 last 会在 thinking/text 交替的消息里每轮 update 追加新行
  /// （同一条回复渲染 2-3 份的根因）。任何 done 行或不同 role 行都是
  /// 消息边界，停止扫描。
  ChatLine? _findOpenLine(String role, String kind) {
    for (var i = _lines.length - 1; i >= 0; i--) {
      final line = _lines[i];
      if (line.done) return null;
      if (line.role != role) return null;
      if (line.kind == kind) return line;
    }
    return null;
  }

  void _upsertThinkingLine(String role, String chunk, {required bool done}) {
    final open = _findOpenLine(role, 'thinking');
    if (open != null) {
      open.text = chunk;
      open.done = done;
    } else {
      _lines.add(ChatLine.thinking(role: role, text: chunk, done: done));
    }
  }

  /// Queue polling (PC parity): only while the turn is running, refresh the
  /// steering/follow-up lists from agentState.queuedMessages.
  void _startQueuePolling() {
    _queuePollTimer?.cancel();
    _pollQueueOnce();
    _queuePollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _pollQueueOnce());
  }

  void _stopQueuePolling() {
    _queuePollTimer?.cancel();
    _queuePollTimer = null;
  }

  Future<void> _pollQueueOnce() async {
    try {
      final state = await widget.connection.request('agent.state', {'sessionId': _sessionId});
      final agentState = state['state'] is Map ? state['state'] as Map : state;
      final queued = agentState['queuedMessages'];
      if (!mounted) return;
      final steeringList = queued is Map ? queued['steering'] : null;
      final followUpList = queued is Map ? queued['followUp'] : null;
      setState(() {
        _steeringQueue = [
          if (steeringList is List)
            for (final s in steeringList)
              if (s != null) s.toString(),
        ];
        _followUpQueue = [
          if (followUpList is List)
            for (final s in followUpList)
              if (s != null) s.toString(),
        ];
      });
    } catch (_) {
      // Transient (host restart etc.); the next tick retries.
    }
  }

  Future<void> _clearQueue() async {
    if (_clearingQueue) return;
    setState(() => _clearingQueue = true);
    try {
      final result = await widget.connection.agentCommand(_sessionId, {'type': 'clear_queue'});
      final steeringList = result['steering'];
      final followUpList = result['followUp'];
      if (!mounted) return;
      setState(() {
        _steeringQueue = [
          if (steeringList is List)
            for (final s in steeringList)
              if (s != null) s.toString(),
        ];
        _followUpQueue = [
          if (followUpList is List)
            for (final s in followUpList)
              if (s != null) s.toString(),
        ];
        _clearingQueue = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() {
          _error = err.toString();
          _clearingQueue = false;
        });
      }
    }
  }

  /// "/" 命令面板：首字符输入 "/" 时展示内置命令 + PC 端技能列表。
  void _onPromptChanged(String text) {
    if (text.startsWith('/')) {
      if (!_slashOpen) {
        _slashOpen = true;
        if (!_slashSkillsLoaded) {
          _slashSkillsLoaded = true;
          widget.connection
              .request('skills.list', null)
              .then((result) {
                final skills = result['skills'];
                if (skills is! List) return;
                setState(() {
                  _slashItems = [
                    ..._slashItems,
                    for (final s in skills)
                      if (s is Map)
                        {
                          'name': (s['name'] as String? ?? '').replaceFirst('/', ''),
                          'desc': s['description'] as String? ?? '',
                          'source': '技能',
                        },
                  ];
                });
              })
              .catchError((Object err) {
                // Skill catalog unavailable — builtin commands still work.
              });
        }
      }
      setState(() {});
    } else if (_slashOpen) {
      setState(() => _slashOpen = false);
    }
  }

  List<Map<String, String>> _filteredSlashItems() {
    final query = _promptController.text.startsWith('/')
        ? _promptController.text.substring(1).trim().toLowerCase()
        : '';
    if (query.isEmpty) return _slashItems;
    return _slashItems
        .where((item) =>
            item['name']!.toLowerCase().contains(query) || item['desc']!.toLowerCase().contains(query))
        .toList();
  }

  void _applySlashCommand(String name) {
    _promptController.text = '/$name ';
    _promptController.selection = TextSelection.fromPosition(
      TextPosition(offset: _promptController.text.length),
    );
    setState(() => _slashOpen = false);
  }

  void _upsertTextLine(String role, String blockText, {required bool done}) {
    final open = _findOpenLine(role, 'text');
    if (open != null) {
      open.text = blockText;
      open.done = done;
    } else {
      _lines.add(ChatLine.text(role: role, text: blockText, done: done));
    }
  }

  void _throttledScroll() {
    if (_pendingRender) return;
    _pendingRender = true;
    _renderThrottle = Timer(const Duration(milliseconds: 50), () {
      _pendingRender = false;
      if (!_scrollController.hasClients) return;
      // 磁吸脱开时不跟随流式输出——展开思考过程/工具卡后用户才能停在
      // 原地查看，收起按钮不再被流式滚底拽出视口。
      if (!_scrollMagnetEngaged) {
        _syncAwayFromBottom();
        return;
      }
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    });
  }

  /// 依据当前滚动位置更新"离底"标记（驱动悬浮回底按钮）。磁吸吸附中
  /// 恒为 false（jumpTo 之后必然在底部）。
  void _syncAwayFromBottom() {
    final position = _scrollController.position;
    final away = !isNearChatBottom(maxScrollExtent: position.maxScrollExtent, offset: position.pixels);
    if (away != _awayFromBottom) setState(() => _awayFromBottom = away);
  }

  /// 用户滚动手势（ScrollNotification 的 drag/scroll 只来自触摸，jumpTo
  /// 不产生）：上滚立即脱开磁吸；下滚回到 96px 内重新吸附。
  bool _onScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    if (notification.metrics.axis != Axis.vertical) return false;
    if (notification is UserScrollNotification) {
      final direction = notification.direction;
      if (direction == ScrollDirection.forward) {
        // 手指下拖（内容向下）= 看更新的内容；回到窗口内即重新吸附。
        _maybeReattachMagnet(notification.metrics);
      } else if (direction == ScrollDirection.reverse) {
        // 上滚（看历史）：立即脱开，优先级最高。
        if (_scrollMagnetEngaged) setState(() => _scrollMagnetEngaged = false);
        _syncAwayFromBottom();
      }
      return false;
    }
    if (notification is ScrollUpdateNotification) {
      final delta = notification.scrollDelta;
      if (delta == null) return false;
      // 惯性滚动（fling）阶段 UserScrollNotification 不再更新，用位移兜底。
      if (delta < -userScrollMinPx) {
        if (_scrollMagnetEngaged) setState(() => _scrollMagnetEngaged = false);
        _syncAwayFromBottom();
      } else if (delta > userScrollMinPx) {
        _maybeReattachMagnet(notification.metrics);
      }
      return false;
    }
    return false;
  }

  void _maybeReattachMagnet(ScrollMetrics metrics) {
    final near = isNearChatBottom(maxScrollExtent: metrics.maxScrollExtent, offset: metrics.pixels);
    if (near != _awayFromBottom) setState(() => _awayFromBottom = !near);
    if (near && !_scrollMagnetEngaged) setState(() => _scrollMagnetEngaged = true);
  }

  /// 悬浮"回到底部"：跳到底并重新吸附，后续流式输出继续跟随。
  void _scrollToBottomAndReattach() {
    if (!_scrollController.hasClients) return;
    setState(() => _scrollMagnetEngaged = true);
    _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    _syncAwayFromBottom();
  }

  /// 展开/收起思考过程与工具卡后的磁吸协同（对齐桌面端行为）：
  /// - 吸附中 + 展开：内容立即变高，直接跟随到底（新内容可视）。
  /// - 脱开中 + 收起：原地不动——用户正在看的位置不能被跳走，否则
  ///   "收起"按钮会瞬间移位点不到（本任务修复的原始症状）。
  void _scrollMagnetOnToggle() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      if (_scrollMagnetEngaged) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
      _syncAwayFromBottom();
    });
  }

  Future<void> _respondApproval(Map<String, dynamic> approval, bool confirmed) async {
    final requestId = approval['requestId'] as String?;
    if (requestId == null) return;
    setState(() => _approvals.remove(approval));
    await _sendUiResponse(requestId, {'confirmed': confirmed});
  }

  /// Flat extension_ui_response body — the Host's ExtensionUiResponse shape.
  Future<void> _sendUiResponse(String requestId, Map<String, dynamic> body) async {
    try {
      await widget.connection.agentCommand(_sessionId, {
        'type': 'extension_ui_response',
        'id': requestId,
        ...body,
      });
    } catch (err) {
      if (mounted) setState(() => _error = err.toString());
    }
  }

  void _enqueueAsk(String requestId, Map<String, dynamic> data) {
    if (_asks.containsKey(requestId)) return;
    _asks[requestId] = data;
    unawaited(_openNextAsk());
  }

  /// Drops every card for a request and closes the sheet showing it.
  void _settleRequest(String requestId) {
    if (!mounted) return;
    setState(() {
      _approvals.removeWhere((entry) => entry['requestId'] == requestId);
      _asks.remove(requestId);
    });
    if (_activeAskId == requestId) _askResolvedElsewhere?.value = true;
  }

  /// Shows the oldest pending ask; asks are sequential, so one sheet at a time.
  Future<void> _openNextAsk() async {
    if (!mounted || _askSheetOpen || _asks.isEmpty) return;
    final entry = _asks.entries.first;
    final questions = parseAskQuestions(entry.value['questions']);
    if (questions == null) {
      _asks.remove(entry.key);
      await _sendUiResponse(entry.key, {'cancelled': true});
      return _openNextAsk();
    }
    _askSheetOpen = true;
    _activeAskId = entry.key;
    final resolved = ValueNotifier<bool>(false);
    _askResolvedElsewhere = resolved;
    List<Map<String, dynamic>>? answers;
    try {
      answers = await showAskSheet(
        context: context,
        questions: questions,
        resolvedElsewhere: resolved,
      );
    } finally {
      final settledElsewhere = resolved.value;
      _askSheetOpen = false;
      _activeAskId = null;
      _askResolvedElsewhere = null;
      resolved.dispose();
      _asks.remove(entry.key);
      if (!settledElsewhere) {
        await _sendUiResponse(entry.key, answers == null ? {'cancelled': true} : {'answers': answers});
      }
    }
    if (mounted) unawaited(_openNextAsk());
  }

  Future<void> _send() async {
    final text = _promptController.text.trim();
    if (text.isEmpty) return;
    // Optimistic feedback immediately (the stream mirrors the user message
    // back later; until then this pending bubble + loading row show).
    setState(() {
      _sendingText = text;
      _awaitingFirst = true;
    });
    _promptController.clear();
    _throttledScroll();
    try {
      // PC parity: while a turn is running, Enter steers (queued into the
      // current turn); when idle the message starts a fresh turn.
      final type = _turnRunning ? 'steer' : 'prompt';
      await widget.connection.agentCommand(_sessionId, {'type': type, 'message': text});
    } catch (err) {
      setState(() {
        _sendingText = null;
        _awaitingFirst = false;
        _error = err.toString();
      });
    }
  }

  Future<void> _abort() async {
    try {
      await widget.connection.agentCommand(_sessionId, {'type': 'abort'});
      setState(() => _lines.add(ChatLine.text(role: 'system', text: '— 已发送中止 —', done: true)));
    } catch (err) {
      setState(() => _error = err.toString());
    }
  }

  @override
  void dispose() {
    _renderThrottle?.cancel();
    _stopQueuePolling();
    _modelRefreshDebounce?.cancel();
    _events?.cancel();
    widget.connection.unsubscribe('agent.events', _sessionId);
    widget.connection.unsubscribe('agent.running', _sessionId);
    widget.connection.unsubscribe('sessions.changed', _sessionId);
    widget.connection.unsubscribe('remote.approval', _sessionId);
    WidgetsBinding.instance.removeObserver(this);
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Widget _buildLine(BuildContext context, ChatLine line) {
    if (line.kind == 'tool') {
      final callId = line.toolCallId ?? '';
      return _ToolCard(
        line: line,
        expanded: _expandedTools.contains(callId),
        onToggle: () => setState(() {
          if (!_expandedTools.remove(callId)) _expandedTools.add(callId);
          // 展开/收起不是"看历史"手势：磁吸状态保持不变，收起后不跳。
          _scrollMagnetOnToggle();
        }),
      );
    }
    if (line.kind == 'thinking') {
      final thinkingId = 'think-${_lines.indexOf(line)}';
      return _ThinkingCard(
        line: line,
        expanded: _expandedThinking.contains(thinkingId),
        onToggle: () => setState(() {
          if (!_expandedThinking.remove(thinkingId)) _expandedThinking.add(thinkingId);
          _scrollMagnetOnToggle();
        }),
      );
    }
    final isUser = line.role == 'user';
    final baseStyle = TextStyle(
      fontSize: 13,
      height: 1.35,
      fontStyle: line.done ? FontStyle.normal : FontStyle.italic,
      color: Colors.black87,
    );
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: BoxConstraints(maxWidth: isUser ? 320 : 340),
        decoration: BoxDecoration(
          color: isUser ? Theme.of(context).colorScheme.primaryContainer : Colors.white,
          borderRadius: BorderRadius.circular(10),
        ),
        child: isUser
            ? Text(line.text.isEmpty && !line.done ? '…' : line.text, style: baseStyle)
            : MarkdownText(data: line.text.isEmpty && !line.done ? '…' : line.text, baseStyle: baseStyle),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ready = widget.connection.isReady;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, overflow: TextOverflow.ellipsis),
        actions: [
          _ModelChip(
            model: _currentModel,
            modelNames: _modelNames,
            busy: _switchingModel,
            onTap: _pickModel,
          ),
          IconButton(
            tooltip: '中止当前回合',
            onPressed: _abort,
            icon: const Icon(Icons.stop_circle_outlined),
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ),
          for (final approval in _approvals)
            _ApprovalCard(approval: approval, onRespond: _respondApproval),
          if (_turnRunning && (_steeringQueue.isNotEmpty || _followUpQueue.isNotEmpty))
            _QueueBar(
              steering: _steeringQueue,
              followUp: _followUpQueue,
              clearing: _clearingQueue,
              onClear: _clearQueue,
            ),
          if (_slashOpen)
            Container(
              margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              constraints: const BoxConstraints(maxHeight: 220),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.black12),
              ),
              child: ListView(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                children: [
                  for (final item in _filteredSlashItems())
                    ListTile(
                      dense: true,
                      leading: Icon(
                        item['source'] == '技能' ? Icons.extension : Icons.build_circle_outlined,
                        size: 16,
                        color: Colors.black45,
                      ),
                      title: Text('/${item['name']}',
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, fontFamily: 'monospace')),
                      subtitle: Text(item['desc'] ?? '',
                          maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
                      onTap: () => _applySlashCommand(item['name']!),
                    ),
                  if (_filteredSlashItems().isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(14),
                      child: Text('没有匹配的命令', style: TextStyle(fontSize: 12, color: Colors.black38)),
                    ),
                ],
              ),
            ),
          Expanded(
            child: _loadingHistory
                ? const Center(
                    child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2.2),
                    ),
                  )
                : (_lines.isEmpty && _sendingText == null && !_awaitingFirst)
                ? const Center(
                    child: Text('向 PC 上的 agent 发送第一条指令…', style: TextStyle(color: Colors.black38)),
                  )
                : Stack(
                    children: [
                      NotificationListener<ScrollNotification>(
                        onNotification: _onScrollNotification,
                        child: ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    itemCount:
                        _lines.length + (_sendingText != null ? 1 : 0) + (_awaitingFirst ? 1 : 0),
                    itemBuilder: (context, index) {
                      if (index < _lines.length) {
                        return _buildLine(context, _lines[index]);
                      }
                      final pendingIndex = index - _lines.length;
                      if (_sendingText != null && pendingIndex == 0) {
                        return Align(
                          alignment: Alignment.centerRight,
                          child: Container(
                            margin: const EdgeInsets.symmetric(vertical: 4),
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                            constraints: const BoxConstraints(maxWidth: 320),
                            decoration: BoxDecoration(
                              color: Theme.of(context).colorScheme.primaryContainer,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Text(_sendingText!, style: const TextStyle(fontSize: 13, height: 1.35)),
                          ),
                        );
                      }
                      return Align(
                        alignment: Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const SizedBox(
                                width: 13,
                                height: 13,
                                child: CircularProgressIndicator(strokeWidth: 1.8),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                '正在回复…',
                                style: const TextStyle(fontSize: 12, color: Colors.black45, fontStyle: FontStyle.italic),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                      ),
                      // 悬浮"回到底部"（PC ChatWindow 同款）：磁吸脱开且
                      // 离底时浮现，一键回底并重新吸附。
                      if (_awayFromBottom)
                        Positioned(
                          right: 12,
                          bottom: 12,
                          child: FloatingActionButton.small(
                            heroTag: 'chat-scroll-to-bottom',
                            onPressed: _scrollToBottomAndReattach,
                            tooltip: _turnRunning ? '跳到最新' : '回到底部',
                            child: const Icon(Icons.arrow_downward, size: 20),
                          ),
                        ),
                    ],
                  ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _promptController,
                      enabled: ready,
                      onChanged: _onPromptChanged,
                      onSubmitted: (_) => _send(),
                      decoration: InputDecoration(
                        hintText: _turnRunning ? '回合进行中，发送将插队…' : '发送指令到 PC 会话…（/ 唤起命令）',
                        border: OutlineInputBorder(
                          borderSide: BorderSide(
                            color: _turnRunning ? const Color(0xFFEAB836) : Colors.black12,
                            width: _turnRunning ? 1.4 : 1,
                          ),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderSide: BorderSide(
                            color: _turnRunning ? const Color(0xFFEAB836) : Colors.black12,
                            width: _turnRunning ? 1.4 : 1,
                          ),
                        ),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Collapsible thinking card (desktop-aligned): shows the model's reasoning
/// dimmed and collapsed by default, expandable to the full text.
/// Queued steering / follow-up messages bar (PC ChatInput parity): shows
/// what is queued while a turn is running, with a clear-all action.
class _QueueBar extends StatelessWidget {
  final List<String> steering;
  final List<String> followUp;
  final bool clearing;
  final VoidCallback onClear;

  const _QueueBar({
    required this.steering,
    required this.followUp,
    required this.clearing,
    required this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    final total = steering.length + followUp.length;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF8E1),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFEAB836)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.bolt, size: 14, color: Color(0xFFB8860B)),
                const SizedBox(width: 5),
                Text(
                  '已排队 $total 条（回合中送达）',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF8D6E00),
                  ),
                ),
                const Spacer(),
                TextButton(
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  onPressed: clearing ? null : onClear,
                  child: clearing
                      ? const SizedBox(
                          width: 12,
                          height: 12,
                          child: CircularProgressIndicator(strokeWidth: 1.6),
                        )
                      : const Text('清空', style: TextStyle(fontSize: 12, color: Color(0xFFB8860B))),
                ),
              ],
            ),
            for (final text in steering)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '⚡ 插队：$text',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: Color(0xFF8D6E00)),
                ),
              ),
            for (final text in followUp)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  '⏭ 排队：$text',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: Colors.black54),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ThinkingCard extends StatelessWidget {
  final ChatLine line;
  final bool expanded;
  final VoidCallback onToggle;

  const _ThinkingCard({required this.line, required this.expanded, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    final preview = line.text.length > 80 ? '${line.text.substring(0, 80)}…' : line.text;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: onToggle,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(
                children: [
                  Icon(Icons.psychology_outlined, size: 15, color: Colors.black45),
                  const SizedBox(width: 6),
                  Text('思考过程', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.black54)),
                  const SizedBox(width: 6),
                  if (!expanded)
                    Expanded(
                      child: Text(
                        preview,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: Colors.black45),
                      ),
                    )
                  else
                    const Spacer(),
                  AnimatedRotation(
                    turns: expanded ? 0 : -0.25,
                    duration: const Duration(milliseconds: 140),
                    child: const Icon(Icons.expand_more, size: 16, color: Colors.black38),
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Text(
                line.text,
                style: const TextStyle(fontSize: 11.5, height: 1.4, fontStyle: FontStyle.italic, color: Colors.black54),
              ),
            ),
        ],
      ),
    );
  }
}

/// Collapsible tool card mirroring the desktop ToolCallBlock: header with a
/// display label + input preview, running/error state, expandable full input
/// JSON and paired result text.
class _ToolCard extends StatelessWidget {
  final ChatLine line;
  final bool expanded;
  final VoidCallback onToggle;

  const _ToolCard({required this.line, required this.expanded, required this.onToggle});

  IconData get _icon {
    final name = (line.toolName ?? '').toLowerCase();
    if (name == 'bash' || name == 'powershell' || name.contains('command')) return Icons.terminal;
    if (name == 'read') return Icons.description_outlined;
    if (name == 'write' || name == 'edit' || name == 'multiedit') return Icons.edit_outlined;
    if (name.startsWith('browser')) return Icons.language;
    if (name.contains('search') || name.contains('fetch')) return Icons.travel_explore;
    return Icons.build_outlined;
  }

  @override
  Widget build(BuildContext context) {
    final label = toolDisplayName(line.toolName ?? 'tool');
    final hasBody = (line.inputJson?.isNotEmpty ?? false) || (line.resultText?.isNotEmpty ?? false);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
        border: line.resultIsError ? Border.all(color: Colors.red.shade300) : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: hasBody ? onToggle : null,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Icon(_icon, size: 15, color: Colors.black54),
                  const SizedBox(width: 6),
                  Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      line.preview ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Colors.black54, fontFamily: 'monospace'),
                    ),
                  ),
                  if (line.running)
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(strokeWidth: 1.6),
                    )
                  else
                    AnimatedRotation(
                      turns: expanded ? 0 : -0.25,
                      duration: const Duration(milliseconds: 140),
                      child: Icon(hasBody ? Icons.expand_more : Icons.remove, size: 16, color: Colors.black38),
                    ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: expanded && hasBody
                ? Container(
                    width: double.infinity,
                    padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (line.inputJson?.isNotEmpty ?? false)
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(6),
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.04),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              line.inputJson!,
                              style: const TextStyle(fontSize: 10, fontFamily: 'monospace', color: Colors.black87),
                            ),
                          ),
                        if (line.resultText?.isNotEmpty ?? false) ...[
                          Padding(
                            padding: const EdgeInsets.only(top: 6, bottom: 2),
                            child: Text(
                              line.resultIsError ? '结果（出错）' : '结果',
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.bold,
                                color: line.resultIsError ? Colors.red.shade700 : Colors.black45,
                              ),
                            ),
                          ),
                          Text(
                            line.resultText!,
                            maxLines: 14,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: Colors.black87),
                          ),
                        ],
                      ],
                    ),
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}

/// Compact current-model chip shown in the AppBar; opens the picker sheet.
class _ModelChip extends StatelessWidget {
  final Map<String, String>? model;
  final Map<String, String> modelNames;
  final bool busy;
  final VoidCallback onTap;

  const _ModelChip({
    required this.model,
    required this.modelNames,
    required this.busy,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // Show the catalog display name (desktop parity) instead of the raw
    // upstream model id; fall back to the id if the catalog is not loaded yet.
    var label = '选择模型';
    if (busy) {
      label = '切换中…';
    } else {
      final m = model;
      if (m != null) {
        label = modelNames['${m['provider']}/${m['modelId']}'] ?? m['modelId'] ?? label;
      }
    }
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 140),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 2),
              const Icon(Icons.expand_more, size: 16),
            ],
          ),
        ),
      ),
    );
  }
}

/// Bottom-sheet model picker backed by models.preferences.get. Shows the full
/// PC catalog (same set as the desktop picker); `enabledModels` is Pi's own
/// scoped-picker filter and must not narrow this list. Marks the current
/// selection and the PC-side default.
class _ModelPickerSheet extends StatelessWidget {
  final Map<String, dynamic> prefs;
  final Map<String, String>? current;
  final Future<void> Function(String provider, String modelId, BuildContext) onPick;

  const _ModelPickerSheet({required this.prefs, required this.current, required this.onPick});

  List<Map<String, dynamic>> _models() {
    final raw = prefs['models'];
    return <Map<String, dynamic>>[
      if (raw is List)
        for (final m in raw)
          if (m is Map) Map<String, dynamic>.from(m),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final models = _models();
    final defaultModel = prefs['defaultModel'];
    bool isDefault(Map<String, dynamic>? m) {
      if (m == null || defaultModel is! Map) return false;
      return defaultModel['provider'] == m['provider'] && defaultModel['modelId'] == m['id'];
    }

    bool isCurrent(Map<String, dynamic> m) =>
        current?['provider'] == m['provider'] && current?['modelId'] == m['id'];
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Row(
                children: [
                  const Text('选择模型', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const Spacer(),
                  IconButton(icon: const Icon(Icons.close, size: 20), onPressed: () => Navigator.of(context).pop()),
                ],
              ),
            ),
            const Divider(height: 1),
            Flexible(
              child: models.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: Text('没有可用模型', style: TextStyle(color: Colors.black38))),
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: models.length,
                      itemBuilder: (context, index) {
                        final m = models[index];
                        final currentHere = isCurrent(m);
                        return ListTile(
                          dense: true,
                          title: Text(
                            m['name'] as String? ?? m['id'] as String? ?? '',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: currentHere ? FontWeight.bold : FontWeight.w500,
                            ),
                          ),
                          subtitle: Text(
                            '${m['provider']}/${m['id']}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 11, color: Colors.black45),
                          ),
                          trailing: currentHere
                              ? Icon(Icons.check_circle, size: 20, color: Theme.of(context).colorScheme.primary)
                              : isDefault(m)
                                  ? Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: Colors.green.shade50,
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                      child: Text('默认', style: TextStyle(fontSize: 11, color: Colors.green.shade700)),
                                    )
                                  : null,
                          onTap: currentHere
                              ? null
                              : () => onPick(m['provider'] as String, m['id'] as String, context),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({required this.approval, required this.onRespond});

  final Map<String, dynamic> approval;
  final Future<void> Function(Map<String, dynamic>, bool) onRespond;

  @override
  Widget build(BuildContext context) {
    final hasExpiry = approval['expiresAt'] != null;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '待审批：${approval['method'] ?? 'confirm'}',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(approval['title']?.toString() ?? '', style: const TextStyle(fontSize: 13)),
            if (hasExpiry)
              const Text('此审批在桌面端有超时，到点将自动拒绝。', style: TextStyle(fontSize: 11)),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: () => onRespond(approval, false),
                  child: const Text('拒绝'),
                ),
                FilledButton(
                  onPressed: () => onRespond(approval, true),
                  child: const Text('批准'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
