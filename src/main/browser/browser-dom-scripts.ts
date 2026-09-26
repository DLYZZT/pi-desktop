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
      if (url.protocol === 'mailto:') console.info(${JSON.stringify(prefix)} + url.href.slice(0, 8192));
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
    const selector = 'a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]';
    const all = Array.from(document.querySelectorAll(selector));
    const nodes = [];
    let nodesTruncated = false;
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
      element.setAttribute('data-pi-browser-ref', token + ':' + ref);
      const tag = element.tagName.toLowerCase();
      const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
      const secretInput = tag === 'input' && (element.type === 'password' || /(?:password|one-time-code|cc-number|cc-csc)/.test(autocomplete));
      const safeValue = secretInput || (tag === 'input' && element.type === 'file') ? '' : (typeof element.value === 'string' ? element.value : '');
      const role = element.getAttribute('role') || ({a:'link',button:'button',input:(element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : element.type === 'file' ? 'file-upload' : element.type === 'password' ? 'password' : 'textbox'),textarea:'textbox',select:'combobox',summary:'button'}[tag] || 'generic');
      const name = (element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('placeholder') || element.innerText || safeValue || element.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
      nodes.push({ ref, role, name, value: secretInput ? undefined : safeValue.slice(0, 2000), description: secretInput ? 'Sensitive value redacted' : undefined, disabled: Boolean(element.disabled), focused: document.activeElement === element, checked: typeof element.checked === 'boolean' ? element.checked : undefined, level: Number(element.getAttribute('aria-level')) || undefined, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
    }
    const rawText = (document.body?.innerText || '').replace(/\\r/g, '');
    const textTruncated = rawText.length > ${maxTextChars};
    return { text: rawText.slice(0, ${maxTextChars}), nodes, textTruncated, nodesTruncated };
  })()`;
}

export function elementPointScript(snapshotId: string, ref: string, focus: boolean): string {
  return `(() => {
    const element = document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(`${snapshotId}:${ref}`)}) + ']');
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
    return { x, y, externalUrl };
  })()`;
}

export function elementHighlightScript(snapshotId: string, ref: string, show: boolean): string {
  const token = `${snapshotId}:${ref}`;
  return `(() => {
    const markerId = 'pi-browser-action-highlight';
    document.getElementById(markerId)?.remove();
    if (!${show}) return;
    const element = document.querySelector('[data-pi-browser-ref=' + CSS.escape(${JSON.stringify(token)}) + ']');
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
