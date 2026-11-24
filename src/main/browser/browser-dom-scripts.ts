export const SNAPSHOT_WORLD_ID = 99_911;

export function externalProtocolGuardScript(token: string): string {
  const prefix = `pi-browser-external:${token}:`;
  return `(() => {
    if (globalThis.__piExternalProtocolGuardInstalled) return;
    Object.defineProperty(globalThis, '__piExternalProtocolGuardInstalled', { value: true });
    document.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const anchor = event.composedPath().find((node) => node && node.nodeType === 1 && node.tagName === 'A');
      if (!anchor) return;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { return; }
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      console.info(${JSON.stringify(prefix)} + url.href.slice(0, 8192));
    }, true);
  })()`;
}

export function createSnapshotScript(
  snapshotId: string,
  maxNodes: number,
  maxTextChars: number,
  startIndex = 0,
): string {
  return `(() => {
    const token = ${JSON.stringify(snapshotId)};
    for (const old of document.querySelectorAll('[data-pi-browser-ref]')) old.removeAttribute('data-pi-browser-ref');
    const store = { token, refs: new Map() };
    globalThis.__piBrowserRefStore = store;
    const selector = 'a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]';
    const roots = [];
    let shadowRootsTruncated = false;
    let scannedElements = 0;
    const collectRoots = (root) => {
      roots.push(root);
      let elements;
      try { elements = root.querySelectorAll('*'); } catch { return; }
      for (const element of elements) {
        if (++scannedElements > 20000) { shadowRootsTruncated = true; return; }
        if (!element.shadowRoot) continue;
        if (roots.length >= 200) { shadowRootsTruncated = true; return; }
        collectRoots(element.shadowRoot);
      }
    };
    collectRoots(document);
    const all = [];
    for (const root of roots) {
      try {
        for (const element of root.querySelectorAll(selector)) all.push(element);
      } catch {}
    }
    const nodes = [];
    let nodesTruncated = shadowRootsTruncated;
    let index = ${startIndex};
    for (const element of all) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (nodes.length >= ${maxNodes}) {
        nodesTruncated = true;
        break;
      }
      const ref = 'e' + (++index);
      store.refs.set(ref, element);
      element.setAttribute('data-pi-browser-ref', token + ':' + ref);
      const tag = element.tagName.toLowerCase();
      const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
      const secretInput = tag === 'input' && (element.type === 'password' || /(?:password|one-time-code|cc-number|cc-csc)/.test(autocomplete));
      const safeValue = secretInput || (tag === 'input' && element.type === 'file') ? '' : (typeof element.value === 'string' ? element.value : '');
      const role = element.getAttribute('role') || ({a:'link',button:'button',input:(element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : element.type === 'file' ? 'file-upload' : element.type === 'password' ? 'password' : 'textbox'),textarea:'textbox',select:'combobox',summary:'button'}[tag] || 'generic');
      const name = (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('placeholder') || element.innerText || safeValue || element.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
      const rootNode = element.getRootNode?.();
      nodes.push({ ref, role, name, value: secretInput ? undefined : safeValue.slice(0, 2000), description: secretInput ? 'Sensitive value redacted' : undefined, disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true', focused: document.activeElement === element || rootNode?.activeElement === element, checked: typeof element.checked === 'boolean' ? element.checked : undefined, level: Number(element.getAttribute('aria-level')) || undefined, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
    }
    const rawText = (document.body?.innerText || '').replace(/\\r/g, '');
    const textTruncated = rawText.length > ${maxTextChars};
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const blockers = [];
    const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (passwordInput) {
      blockers.push({ kind: 'login', confidence: 'high', evidence: 'visible password input' });
    } else if (
      /(?:^|\\/)(?:login|signin|sign-in|auth|sso|oauth)(?:[/?#]|$)/.test(location.pathname + location.search) ||
      /(?:sign in|log in|登录|登入)/i.test(document.title || '')
    ) {
      blockers.push({ kind: 'login', confidence: 'medium', evidence: 'login route or page title' });
    }
    const captchaFrame = Array.from(document.querySelectorAll('iframe')).find((frame) =>
      /(?:recaptcha|hcaptcha|turnstile|geetest|captcha)/i.test(frame.src || ''),
    );
    if (captchaFrame) {
      blockers.push({ kind: 'captcha', confidence: 'high', evidence: 'captcha iframe' });
    } else {
      let captchaNode;
      try {
        captchaNode = document.querySelector(
          '[id*="captcha" i], [class*="captcha" i], [id*="geetest" i], [class*="geetest" i]',
        );
      } catch {}
      if (isVisible(captchaNode)) {
        blockers.push({ kind: 'captcha', confidence: 'medium', evidence: 'captcha element' });
      }
    }
    const oneTimeCode = Array.from(document.querySelectorAll('input')).find(
      (element) =>
        isVisible(element) &&
        (element.autocomplete === 'one-time-code' ||
          /(?:otp|one-time|2fa|verify|verification)/i.test(
            (element.name || '') + ' ' + (element.id || '') + ' ' + (element.getAttribute('placeholder') || ''),
          )),
    );
    if (oneTimeCode) {
      blockers.push({ kind: 'two-factor', confidence: 'high', evidence: 'one-time-code input' });
    }
    return { text: rawText.slice(0, ${maxTextChars}), nodes, blockers, textTruncated, nodesTruncated };
  })()`;
}

export function createReadScript(
  mode: "article" | "tables" | "links" | "forms",
  maxChars: number,
  maxRows: number,
): string {
  return `(() => {
    const roots = [];
    const collectRoots = (root) => {
      roots.push(root);
      let elements;
      try { elements = root.querySelectorAll('*'); } catch { return; }
      for (const element of elements) if (element.shadowRoot) collectRoots(element.shadowRoot);
    };
    collectRoots(document);
    const query = (selector) => {
      const found = [];
      for (const root of roots) {
        try { for (const element of root.querySelectorAll(selector)) found.push(element); } catch {}
      }
      return found;
    };
    const textOf = (element) => (element?.innerText || element?.textContent || '').replace(/\\s+/g, ' ').trim();
    const out = [];
    let used = 0;
    let truncated = false;
    const push = (value) => {
      const line = String(value ?? '').trim();
      if (!line) return true;
      if (used + line.length + 1 > ${maxChars}) { truncated = true; return false; }
      out.push(line);
      used += line.length + 1;
      return true;
    };
    const mode = ${JSON.stringify(mode)};
    if (mode === 'article') {
      const candidates = query('article, main, [role="main"]');
      let best = document.body;
      let bestScore = 0;
      for (const candidate of candidates.length ? candidates : [document.body]) {
        if (!candidate) continue;
        const text = textOf(candidate);
        const links = Array.from(candidate.querySelectorAll('a')).reduce((total, anchor) => total + textOf(anchor).length, 0);
        const density = text.length ? 1 - Math.min(0.9, links / text.length) : 0;
        const score = text.length * density;
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      const walk = (node) => {
        if (!node || truncated) return;
        if (node.nodeType !== 1) return;
        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'form'].includes(tag)) return;
        if (/^h[1-6]$/.test(tag)) {
          if (!push('#'.repeat(Number(tag[1])) + ' ' + textOf(node))) return;
        } else if (tag === 'p') {
          if (!push(textOf(node))) return;
        } else if (tag === 'li') {
          if (!push('- ' + textOf(node))) return;
        } else if (tag === 'pre') {
          if (!push('\\n' + (node.textContent || '').trim().slice(0, 4000) + '\\n')) return;
        } else if (tag === 'blockquote') {
          if (!push('> ' + textOf(node))) return;
        } else if (tag === 'table') {
          walkTable(node);
          return;
        } else {
          for (const child of node.children) walk(child);
        }
      };
      const walkTable = (table) => {
        for (const row of Array.from(table.rows || []).slice(0, ${maxRows})) {
          const cells = Array.from(row.cells || []).map((cell) => textOf(cell).replace(/\\|/g, '\\\\|').slice(0, 200));
          if (!cells.length) continue;
          if (!push('| ' + cells.join(' | ') + ' |')) return;
          if (row.rowIndex === 0) push('| ' + cells.map(() => '---').join(' | ') + ' |');
        }
        push('');
      };
      walk(best);
    } else if (mode === 'tables') {
      for (const table of query('table')) {
        if (truncated) break;
        const rows = Array.from(table.rows || []).slice(0, ${maxRows});
        if (!rows.length) continue;
        const caption = textOf(table.caption);
        if (caption) push('## ' + caption.slice(0, 200));
        for (const row of rows) {
          const cells = Array.from(row.cells || []).map((cell) => textOf(cell).replace(/\\|/g, '\\\\|').slice(0, 200));
          if (!cells.length) continue;
          if (!push('| ' + cells.join(' | ') + ' |')) break;
          if (row.rowIndex === 0) push('| ' + cells.map(() => '---').join(' | ') + ' |');
        }
        push('');
      }
    } else if (mode === 'links') {
      const seen = new Set();
      for (const anchor of query('a[href]')) {
        if (truncated) break;
        const href = anchor.href || '';
        if (!/^(?:https?|mailto):/i.test(href)) continue;
        const label = textOf(anchor).slice(0, 200) || href;
        const key = href + '|' + label;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!push('- ' + label + ' — ' + href.slice(0, 500))) break;
      }
    } else if (mode === 'forms') {
      for (const element of query('input, textarea, select, button')) {
        if (truncated) break;
        const tag = element.tagName.toLowerCase();
        const type = element.type || tag;
        if (type === 'hidden') continue;
        const label = (
          element.getAttribute('aria-label') ||
          element.getAttribute('placeholder') ||
          element.labels?.[0]?.innerText ||
          element.name ||
          element.id ||
          ''
        ).trim().replace(/\\s+/g, ' ').slice(0, 160);
        const rawValue = type === 'password' ? '[redacted]' : String(element.value ?? '');
        const options = tag === 'select'
          ? ' {' + Array.from(element.options || []).slice(0, 30).map((option) => (option.textContent || '').trim()).join(' / ') + '}'
          : '';
        const flags = [element.required ? ' (required)' : '', element.disabled ? ' (disabled)' : ''].join('');
        if (!push('- ' + tag + (type && type !== tag ? '[' + type + ']' : '') + ': ' + label + (rawValue ? ' = ' + rawValue.slice(0, 160) : '') + options + flags)) break;
      }
    }
    return { content: out.join('\\n').slice(0, ${maxChars}), truncated };
  })()`;
}

export function elementPointScript(snapshotId: string, ref: string, focus: boolean): string {
  return `(() => {
    const store = globalThis.__piBrowserRefStore;
    const element =
      (store && store.token === ${JSON.stringify(snapshotId)} && store.refs.get(${JSON.stringify(ref)})) ||
      document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(`${snapshotId}:${ref}`)}) + ']');
    if (!element || !element.isConnected) return null;
    let rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      rect = element.getBoundingClientRect();
    }
    const left = Math.max(0, rect.left);
    const right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    const x = Math.round(left + (right - left) / 2);
    const y = Math.round(top + (bottom - top) / 2);
    ${focus ? "element.focus(); if (element.matches?.('input:not([type=file]),textarea') && typeof element.select === 'function') element.select();" : ""}
    const anchor = element.closest?.('a[href]');
    let externalUrl;
    if (anchor) {
      try {
        const target = new URL(anchor.href, location.href);
        if (target.protocol !== 'http:' && target.protocol !== 'https:' && target.href !== 'about:blank') externalUrl = target.href.slice(0, 8192);
      } catch {}
    }
    const style = getComputedStyle(element);
    const disabled =
      Boolean(element.disabled) ||
      element.getAttribute?.('aria-disabled') === 'true' ||
      Boolean(element.closest?.('[aria-disabled="true"]'));
    const pointerNone = style.pointerEvents === 'none';
    let coveredBy;
    try {
      const hit = element.ownerDocument?.elementFromPoint?.(x, y);
      const rootNode = element.getRootNode?.();
      const host = rootNode && rootNode.host;
      const hitIsShadowHost = Boolean(host && hit && (hit === host || host.contains(hit)));
      if (hit && hit !== element && !element.contains(hit) && !hit.contains(element) && !hitIsShadowHost) {
        coveredBy = String(hit.getAttribute?.('aria-label') || hit.innerText || hit.tagName || '')
          .trim()
          .replace(/\\s+/g, ' ')
          .slice(0, 120);
      }
    } catch {}
    const actionable = !disabled && !pointerNone && !coveredBy;
    const reason = disabled ? 'disabled' : pointerNone ? 'pointer-events-none' : coveredBy ? 'covered' : undefined;
    return { x, y, externalUrl, actionable, ...(reason ? { reason } : {}), ...(coveredBy ? { coveredBy } : {}) };
  })()`;
}

export function selectOptionScript(
  snapshotId: string,
  ref: string,
  choice: { value?: string; label?: string; index?: number },
): string {
  return `(() => {
    const store = globalThis.__piBrowserRefStore;
    const element =
      (store && store.token === ${JSON.stringify(snapshotId)} && store.refs.get(${JSON.stringify(ref)})) ||
      document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(`${snapshotId}:${ref}`)}) + ']');
    if (!element || !element.isConnected) return { ok: false, reason: 'stale' };
    if (element.tagName !== 'SELECT') return { ok: false, reason: 'not-select' };
    const options = Array.from(element.options || []);
    const choice = ${JSON.stringify(choice)};
    let option;
    if (Number.isInteger(choice.index)) option = options[choice.index];
    else if (typeof choice.value === 'string') option = options.find((entry) => entry.value === choice.value);
    else if (typeof choice.label === 'string') {
      option = options.find((entry) => (entry.textContent || '').trim() === choice.label.trim());
    }
    if (!option) return { ok: false, reason: 'option-not-found' };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(element, option.value);
    else element.value = option.value;
    element.focus();
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: element.value, label: (option.textContent || '').trim() };
  })()`;
}

export function elementHighlightScript(snapshotId: string, ref: string, show: boolean): string {
  const token = `${snapshotId}:${ref}`;
  return `(() => {
    const markerId = 'pi-browser-action-highlight';
    document.getElementById(markerId)?.remove();
    if (!${show}) return;
    const store = globalThis.__piBrowserRefStore;
    const element =
      (store && store.token === ${JSON.stringify(snapshotId)} && store.refs.get(${JSON.stringify(ref)})) ||
      document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(token)}) + ']');
    if (!element || !element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.id = markerId;
    marker.setAttribute('aria-hidden', 'true');
    Object.assign(marker.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
      left: Math.max(0, rect.left - 3) + 'px', top: Math.max(0, rect.top - 3) + 'px',
      width: Math.max(1, rect.width + 6) + 'px', height: Math.max(1, rect.height + 6) + 'px',
      border: '2px solid #f59e0b', borderRadius: '5px', boxSizing: 'border-box',
      background: 'rgba(245, 158, 11, 0.12)'
    });
    document.documentElement.appendChild(marker);
  })()`;
}
