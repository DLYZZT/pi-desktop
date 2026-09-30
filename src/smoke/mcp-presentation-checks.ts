import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";

/** Exercise actual preference controls and MCP form layout; captures are optional local QA artifacts. */
export async function runMcpPresentationChecks(window: BrowserWindow): Promise<void> {
  const bounds = window.getBounds(),
    minimum = window.getMinimumSize();
  const script = String.raw`async (language, theme, restore = false) => {
    const until = async (read) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { const value = read(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,20)); }
      throw new Error('MCP presentation control did not appear');
    };
    const click = async (labels) => (await until(()=>Array.from(document.querySelectorAll('button')).find(button=>labels.includes(button.textContent?.trim())))).click();
    const set = (element,value) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,value);
      element.dispatchEvent(new Event('change',{bubbles:true}));
    };
    if(document.querySelector('.mcp-editor')) await click(['Cancel','取消']);
    await click(['General','通用','一般']);
    const languageControl = await until(()=>Array.from(document.querySelectorAll('select')).find(select=>Array.from(select.options).some(option=>option.value==='en-US')));
    const themeControl = await until(()=>Array.from(document.querySelectorAll('select')).find(select=>Array.from(select.options).some(option=>option.value==='dark')));
    const previous = {language:languageControl.value,theme:themeControl.value};
    set(languageControl,language);
    await until(()=>document.documentElement.lang===language);
    set(themeControl,theme);
    await until(()=>document.documentElement.classList.contains('dark')===(theme==='dark'));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await until(()=>document.getAnimations().filter(animation=>animation.effect?.pseudoElement?.includes('view-transition')).every(animation=>animation.playState!=='running'));
    if(restore) return previous;
    await click(['MCP']);
    await until(()=>document.querySelector('[data-mcp-config] h3')?.textContent===({'en-US':'MCP servers','zh-CN':'MCP 服务器','zh-TW':'MCP 伺服器'})[language]);
    const row = await until(()=>Array.from(document.querySelectorAll('[data-mcp-config] .mcp-server-row')).find(row=>row.querySelector('strong')?.textContent==='smoke'));
    Array.from(row.querySelectorAll('button')).find(button=>['Edit','编辑','編輯'].includes(button.textContent?.trim())).click();
    const editor = await until(()=>document.querySelector('.mcp-editor'));
    editor.querySelector('input').focus();
    const container=document.querySelector('[data-mcp-config]');
    if(container.scrollWidth>container.clientWidth+2) throw new Error('MCP form overflows its settings pane');
    if(document.documentElement.scrollWidth>window.innerWidth+2) throw new Error('MCP settings overflow the viewport');
    for(const input of editor.querySelectorAll('input:not([type="checkbox"]),textarea,select')) {
      if(!input.labels?.length && !input.getAttribute('aria-label')) throw new Error('MCP form control has no associated label');
    }
    const save=Array.from(editor.querySelectorAll('button')).find(button=>['Save configuration','保存配置','儲存設定'].includes(button.textContent?.trim()));
    save.scrollIntoView({block:'center'});
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const rect=save.getBoundingClientRect();
    if(rect.top<0 || rect.bottom>window.innerHeight || document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)!==save) throw new Error('MCP save button cannot be reached by scrolling');
    container.scrollTop=0;
    await new Promise(resolve=>requestAnimationFrame(resolve));
    return {previous,title:container.querySelector('h3').textContent,width:container.clientWidth};
  }`;
  let previous: { language: string; theme: string } | undefined;
  try {
    for (const width of [1440, Math.max(minimum[0], 800)]) {
      window.setBounds({ ...bounds, width, height: 900 });
      for (const language of ["en-US", "zh-CN", "zh-TW"])
        for (const theme of ["light", "dark"]) {
          const result = (await window.webContents.executeJavaScript(
            `(${script})(${JSON.stringify(language)},${JSON.stringify(theme)})`,
          )) as { previous: { language: string; theme: string }; title: string; width: number };
          previous ??= result.previous;
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
          const focused = await window.webContents.executeJavaScript(
            "document.activeElement?.closest('.mcp-editor') !== null",
          );
          if (!focused) throw new Error("MCP form lost keyboard focus");
          const captures = process.env.PI_DESKTOP_MCP_PRESENTATION_DIR;
          if (captures) {
            await mkdir(captures, { recursive: true });
            const capture = await window.webContents.capturePage();
            await writeFile(path.join(captures, `${language}-${theme}-${width}.png`), capture.toPNG());
          }
          console.log(
            `MCP presentation passed: ${language}, ${theme}, window=${window.getBounds().width}, pane=${result.width}`,
          );
        }
    }
  } finally {
    window.setBounds(bounds);
    if (previous)
      await window.webContents.executeJavaScript(
        `(${script})(${JSON.stringify(previous.language)},${JSON.stringify(previous.theme)},true)`,
      );
  }
}
