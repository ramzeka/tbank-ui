
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function until(check, description, timeout = 8500) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(30);
  } while (Date.now() < deadline);
  throw new Error('Не дождались: ' + description);
}

async function edgePath() {
  const candidates = [
    process.env.TBANK_QA_EDGE,
    join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error('Укажите путь к Edge в переменной TBANK_QA_EDGE.');
}

export async function startBrowser(profile, port) {
  const flags = [
    '--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--disable-background-networking',
    '--no-first-run', '--disable-default-apps', '--no-default-browser-check', '--log-level=3',
    '--window-size=1440,1000', '--user-data-dir=' + profile, '--remote-debugging-port=' + port, 'about:blank',
  ];
  if (process.env.TBANK_QA_EDGE_NO_SANDBOX === '1') flags.unshift('--no-sandbox');
  const child = spawn(await edgePath(), flags, { windowsHide: true, stdio: 'ignore' });
  let startupError;
  child.on('error', error => { startupError = error; });
  const exceptions = [];
  const pages = new Set();
  async function targetMatching(predicate) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error('Edge завершился с кодом ' + child.exitCode);
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(650) });
      const targets = await response.json();
      return targets.find(target => target.type === 'page' && predicate(target));
    } catch {
      return false;
    }
  }
  try {
    const target = await until(() => targetMatching(target => target.url === 'about:blank'), 'страница Edge CDP', 15000);
    const page = await connectPage(target, exceptions);
    pages.add(page);
    return {
      ...page, exceptions,
      async openTab(url) {
        const { targetId } = await page.send('Target.createTarget', { url });
        try {
          const target = await until(() => targetMatching(target => target.id === targetId), 'новая вкладка Edge');
          const tab = await connectPage(target, exceptions);
          pages.add(tab);
          return {
            ...tab,
            async closeTab() {
              tab.disconnect();
              pages.delete(tab);
              await page.send('Target.closeTarget', { targetId });
            },
          };
        } catch (error) {
          await page.send('Target.closeTarget', { targetId });
          throw error;
        }
      },
      async close() {
        for (const tab of pages) tab.disconnect();
        if (child.exitCode === null) {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        }
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function connectPage(target, exceptions) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      }),
      delay(6000, undefined, { ref: false }).then(() => { throw new Error('Edge не открыл WebSocket.'); }),
    ]);

    let id = 0;
    const pending = new Map();
    let acceptNextDialog = true;
    function send(method, params = {}) {
      const ticket = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(ticket);
          reject(new Error('Тайм-аут команды CDP ' + method));
        }, 10000);
        pending.set(ticket, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id: ticket, method, params }));
        } catch (error) {
          pending.delete(ticket);
          clearTimeout(timer);
          reject(error);
        }
      });
    }

    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        send('Page.handleJavaScriptDialog', { accept: acceptNextDialog }).catch(error => exceptions.push(error.message));
        acceptNextDialog = true;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        exceptions.push(details.exception?.description ?? details.text);
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');

    async function evaluate(fn, ...args) {
      const expression = '(' + fn.toString() + ')(' + args.map(value => JSON.stringify(value)).join(',') + ')';
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    }
    const visible = selector => evaluate(selector => Boolean(document.querySelector(selector)?.getClientRects().length), selector);
    const text = selector => evaluate(selector => document.querySelector(selector)?.textContent?.trim() ?? '', selector);
    const wait = (selector, timeout) => until(() => visible(selector), selector, timeout);
    const gone = selector => until(async () => !await visible(selector), 'скрытие ' + selector);
    const has = (selector, value, timeout) => until(async () => (await text(selector)).includes(value), selector + ' содержит ' + value, timeout);
    async function click(selector) {
      await until(() => evaluate(selector => {
        const control = document.querySelector(selector);
        if (!control?.getClientRects().length || control.matches(':disabled')) return false;
        control.click();
        return true;
      }, selector), 'кнопка ' + selector);
    }
    async function clickText(root, value) {
      await until(() => evaluate((root, value) => {
        const section = document.querySelector(root);
        const control = [...(section?.querySelectorAll('button, a') ?? [])].find(button =>
          button.getClientRects().length && !button.matches(':disabled') && button.textContent.trim().includes(value));
        if (!control) return false;
        control.click();
        return true;
      }, root, value), root + ' кнопка ' + value);
    }
    async function fill(selector, value) {
      await until(() => evaluate((selector, value) => {
        const control = document.querySelector(selector);
        if (!control?.getClientRects().length || control.matches(':disabled')) return false;
        control.value = value;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, selector, value), 'поле ' + selector);
    }
    async function navigate(section) {
      await click('.nav[data-section="' + section + '"]');
      await until(() => evaluate(section => document.querySelector('#data-view').dataset.section === section, section), 'раздел ' + section);
    }
    async function key(key, windowsVirtualKeyCode) {
      const params = { key, code: key, windowsVirtualKeyCode };
      const chars = key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...chars });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    }
    return {
      send, evaluate, visible, text, wait, gone, has, click, clickText, fill, navigate, key,
      cancelConfirm() { acceptNextDialog = false; },
      disconnect() { socket.close(); },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}
