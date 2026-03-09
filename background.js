let running = false;
let stopped = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    startFollowing(msg.usernames, msg.startIndex, msg.minDelay, msg.maxDelay, msg.fileName);
    sendResponse({ ok: true });
  } else if (msg.action === 'stop') {
    stopped = true;
    sendResponse({ ok: true });
  } else if (msg.action === 'getState') {
    chrome.storage.local.get(['state'], (res) => {
      sendResponse(res.state || null);
    });
    return true;
  } else if (msg.action === 'clearHistory') {
    chrome.storage.local.remove(['state'], () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function saveState(updates) {
  const { state: prev } = await chrome.storage.local.get(['state']);
  const state = { ...(prev || {}), ...updates };
  await chrome.storage.local.set({ state });
  return state;
}

async function appendLog(entry) {
  const { state } = await chrome.storage.local.get(['state']);
  const log = state?.log || [];
  log.push(entry);
  if (log.length > 500) log.splice(0, log.length - 500);
  await saveState({ log });
  return log;
}

// Service worker safe sleep - keeps alive with periodic storage pings
async function safeSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const remaining = end - Date.now();
    const wait = Math.min(4000, remaining);
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, wait));
    await chrome.storage.local.get(['keepalive']);
  }
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    let resolved = false;
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete' && !resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, 20000);
  });
}

// ---- Injected functions (run in MAIN world for proper CSS access) ----

function injectedCheckPage() {
  const pageText = document.body?.innerText || '';

  // Check for 404 page
  if (pageText.includes("Sorry, this page isn't available") ||
      document.querySelector('svg[aria-label="Broken link"]')) {
    return { status: 'page_not_found' };
  }

  const header = document.querySelector('header');
  if (!header) return { status: 'loading', detail: 'no header' };

  const headerBtn = header.querySelector('button');
  if (!headerBtn) return { status: 'loading', detail: 'no button in header' };

  // Check by CSS class - _aswu = Follow (blue), _aswv = Following (grey)
  const classes = headerBtn.className;
  const text = headerBtn.textContent.trim();
  const bgColor = window.getComputedStyle(headerBtn).backgroundColor;

  if (classes.includes('_aswu')) {
    return { status: 'ready', text, bgColor, classes };
  }

  if (classes.includes('_aswv')) {
    return { status: 'already_following', text, bgColor, classes };
  }

  // Fallback: check background color
  const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    const r = parseInt(match[1]);
    const g = parseInt(match[2]);
    const b = parseInt(match[3]);
    if (b > 200 && r < 130 && g < 130) {
      return { status: 'ready', text, bgColor, classes };
    }
    // Non-blue = already following or other state
    return { status: 'already_following', text, bgColor, classes };
  }

  return { status: 'loading', detail: 'unknown', text, bgColor, classes };
}

function injectedClickFollow() {
  const header = document.querySelector('header');
  if (!header) return { clicked: false, error: 'no header' };

  const btn = header.querySelector('button');
  if (!btn) return { clicked: false, error: 'no button' };

  // Just click it - we already verified it's the Follow button in checkPage
  btn.click();
  return { clicked: true, text: btn.textContent.trim() };
}

function injectedVerify() {
  const header = document.querySelector('header');
  if (!header) return { verified: false };

  const btn = header.querySelector('button');
  if (!btn) return { verified: false };

  const classes = btn.className;
  // _aswv = Following state
  if (classes.includes('_aswv')) {
    return { verified: true };
  }

  // Fallback: check bg color changed from blue
  const bgColor = window.getComputedStyle(btn).backgroundColor;
  const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    const b = parseInt(match[3]);
    const r = parseInt(match[1]);
    if (!(b > 200 && r < 130)) {
      return { verified: true, bgColor };
    }
  }

  return { verified: false, bgColor };
}

// ---- Main logic ----

async function executeOnTab(tabId, func) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    world: 'MAIN',
  });
  return results[0]?.result;
}

async function tryFollowUser(tabId, username) {
  let lastCheck = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      lastCheck = await executeOnTab(tabId, injectedCheckPage);

      if (!lastCheck) {
        await safeSleep(1500);
        continue;
      }

      if (lastCheck.status === 'page_not_found') return 'page_not_found';
      if (lastCheck.status === 'already_following') return 'already_following';
      if (lastCheck.status === 'ready') break;

      await safeSleep(1500);
    } catch (err) {
      await safeSleep(1500);
    }
  }

  if (!lastCheck || lastCheck.status === 'loading') {
    return `not_found (${lastCheck?.detail || 'timeout'})`;
  }

  // Click follow
  try {
    const clickResult = await executeOnTab(tabId, injectedClickFollow);
    if (!clickResult?.clicked) return `click_failed (${clickResult?.error || 'unknown'})`;
  } catch (err) {
    return 'click_error: ' + err.message;
  }

  // Wait and verify
  await safeSleep(2500);
  try {
    const v = await executeOnTab(tabId, injectedVerify);
    return v?.verified ? 'followed' : 'clicked_unverified';
  } catch (err) {
    return 'clicked_unverified';
  }
}

async function startFollowing(usernames, startIndex, minDelay, maxDelay, fileName) {
  if (running) return;
  running = true;
  stopped = false;

  const { state: prevState } = await chrome.storage.local.get(['state']);
  const existingLog = (startIndex > 0 && prevState?.log) ? prevState.log : [];

  await chrome.storage.local.set({
    state: {
      fileName,
      usernames,
      currentIndex: startIndex,
      total: usernames.length,
      status: 'running',
      log: existingLog,
      startedAt: new Date().toISOString(),
    },
  });

  let tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
  } catch (err) {
    await saveState({ status: 'stopped', statusText: 'No active tab found' });
    running = false;
    return;
  }

  for (let i = startIndex; i < usernames.length; i++) {
    if (stopped) {
      await saveState({
        currentIndex: i,
        status: 'stopped',
        statusText: `Stopped at ${i}/${usernames.length}`,
      });
      running = false;
      return;
    }

    const username = usernames[i];
    await saveState({
      currentIndex: i,
      statusText: `Processing ${i + 1}/${usernames.length}: @${username}`,
    });

    try {
      await chrome.tabs.update(tabId, { url: `https://www.instagram.com/${username}/` });
    } catch (err) {
      await appendLog({ index: i + 1, username, result: 'error', message: 'Tab closed' });
      await saveState({ currentIndex: i, status: 'stopped', statusText: 'Tab was closed' });
      running = false;
      return;
    }

    await waitForTabLoad(tabId);
    await safeSleep(3000);

    const result = await tryFollowUser(tabId, username);
    await appendLog({ index: i + 1, username, result });
    await saveState({ currentIndex: i + 1 });

    if (i < usernames.length - 1 && !stopped) {
      const delay = randomDelay(minDelay, maxDelay);
      await saveState({
        statusText: `Waiting ${delay}s before next... (${i + 1}/${usernames.length} done)`,
      });
      await safeSleep(delay * 1000);
    }
  }

  await saveState({
    currentIndex: usernames.length,
    status: 'completed',
    statusText: `Done! Processed ${usernames.length} users.`,
    completedAt: new Date().toISOString(),
  });

  running = false;
}
