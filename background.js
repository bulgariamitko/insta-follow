let running = false;
let stopped = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'start') {
    startFollowing(msg.usernames, msg.startIndex, msg.minDelay, msg.maxDelay, msg.fileName, msg.skipExisting);
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

async function executeOnTab(tabId, func) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    world: 'MAIN',
  });
  return results[0]?.result;
}

// ---- Injected: get logged-in username ----

function injectedGetMyUsername() {
  // Instagram stores the logged-in user info in various places
  // Method 1: meta tag
  const metaEl = document.querySelector('meta[property="al:ios:url"]');
  if (metaEl) {
    const content = metaEl.getAttribute('content') || '';
    const match = content.match(/user\?username=([^&]+)/);
    if (match) return match[1];
  }
  // Method 2: link with href to own profile in the nav
  const profileLinks = document.querySelectorAll('a[href*="/"][role="link"]');
  for (const link of profileLinks) {
    const img = link.querySelector('img[alt]');
    if (img && link.href) {
      const match = link.href.match(/instagram\.com\/([^/?]+)/);
      if (match && match[1] !== 'explore' && match[1] !== 'reels' &&
          match[1] !== 'direct' && match[1] !== 'p' && match[1] !== 'stories') {
        return match[1];
      }
    }
  }
  // Method 3: check _sharedData
  try {
    if (window._sharedData?.config?.viewer?.username) {
      return window._sharedData.config.viewer.username;
    }
  } catch (e) {}
  return null;
}

// ---- Injected: click the Following count to open dialog ----

function injectedClickFollowingLink() {
  // Find all links in header section, the "following" link contains /following/
  const links = document.querySelectorAll('a[href*="/following"]');
  for (const link of links) {
    if (link.href.includes('/following')) {
      link.click();
      return { clicked: true, href: link.href };
    }
  }
  // Fallback: find by the section with following count (usually the 3rd <li> or <a> in header)
  const header = document.querySelector('header');
  if (header) {
    const allLinks = header.querySelectorAll('a');
    for (const link of allLinks) {
      if (link.href && link.href.includes('/following')) {
        link.click();
        return { clicked: true, href: link.href };
      }
    }
  }
  return { clicked: false };
}

// ---- Injected: scroll the Following dialog and collect usernames ----

function injectedCollectFollowing() {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { usernames: [], done: false, error: 'no dialog' };

  const links = dialog.querySelectorAll('a[href*="/"]');
  const usernames = new Set();
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href && href.match(/^\/[^/]+\/$/)) {
      const username = href.replace(/\//g, '');
      // Skip common non-user paths
      if (!['explore', 'reels', 'direct', 'p', 'stories', 'accounts'].includes(username)) {
        usernames.add(username);
      }
    }
  }

  // Scroll the dialog's scrollable container
  const scrollable = dialog.querySelector('[style*="overflow"]') ||
    dialog.querySelector('[class*="scroll"]') ||
    dialog.querySelector('div > div > div');

  // Find the scrollable element inside the dialog
  let scrollEl = null;
  const allDivs = dialog.querySelectorAll('div');
  for (const div of allDivs) {
    if (div.scrollHeight > div.clientHeight + 10 && div.clientHeight > 100) {
      scrollEl = div;
      break;
    }
  }

  if (scrollEl) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  return { usernames: Array.from(usernames), scrolled: !!scrollEl };
}

// ---- Fetch all following usernames ----

async function fetchFollowingList(tabId) {
  // Step 1: Go to instagram.com to get logged-in username
  await saveState({ statusText: 'Fetching your following list...' });

  await chrome.tabs.update(tabId, { url: 'https://www.instagram.com/' });
  await waitForTabLoad(tabId);
  await safeSleep(3000);

  const myUsername = await executeOnTab(tabId, injectedGetMyUsername);
  if (!myUsername) {
    await saveState({ statusText: 'Could not detect your username. Skipping pre-check.' });
    return null;
  }

  await saveState({ statusText: `Found your account: @${myUsername}. Loading following list...` });

  // Step 2: Navigate to own profile
  await chrome.tabs.update(tabId, { url: `https://www.instagram.com/${myUsername}/` });
  await waitForTabLoad(tabId);
  await safeSleep(3000);

  // Step 3: Click the "Following" link
  const clickResult = await executeOnTab(tabId, injectedClickFollowingLink);
  if (!clickResult?.clicked) {
    await saveState({ statusText: 'Could not open Following dialog. Skipping pre-check.' });
    return null;
  }

  await safeSleep(2000);

  // Step 4: Scroll and collect all usernames
  const allFollowing = new Set();
  let prevCount = 0;
  let staleRounds = 0;

  for (let i = 0; i < 150; i++) { // max 150 scroll rounds (~3000+ users)
    const result = await executeOnTab(tabId, injectedCollectFollowing);
    if (result.error) {
      await safeSleep(1500);
      continue;
    }

    for (const u of result.usernames) {
      allFollowing.add(u.toLowerCase());
    }

    const newCount = allFollowing.size;
    await saveState({
      statusText: `Loading following list... (${newCount} users found)`,
    });

    if (newCount === prevCount) {
      staleRounds++;
      if (staleRounds >= 5) break; // no new users after 5 scroll rounds = done
    } else {
      staleRounds = 0;
    }
    prevCount = newCount;

    await safeSleep(800);
  }

  await saveState({
    statusText: `Following list loaded: ${allFollowing.size} users. Starting follows...`,
  });

  return allFollowing;
}

// ---- Injected functions for follow detection ----

// Helper to find Follow/Following button - inlined in each injected function
// because executeScript runs each function in isolation.
// The button has class _aswr (action button), NOT _aswq (link-style button).

function injectedCheckPage() {
  const pageText = document.body?.innerText || '';

  if (pageText.includes("Sorry, this page isn't available") ||
      document.querySelector('svg[aria-label="Broken link"]')) {
    return { status: 'page_not_found' };
  }

  const header = document.querySelector('header');
  if (!header) return { status: 'loading', detail: 'no header' };

  // Find the follow action button (_aswr), not other header buttons
  let headerBtn = header.querySelector('button._aswr');
  if (!headerBtn) {
    // Fallback: find by blue bg
    const buttons = header.querySelectorAll('button');
    for (const btn of buttons) {
      const bg = window.getComputedStyle(btn).backgroundColor;
      const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (m && parseInt(m[3]) > 200 && parseInt(m[1]) < 130) { headerBtn = btn; break; }
    }
  }
  if (!headerBtn) headerBtn = header.querySelector('button._aswv');
  if (!headerBtn) return { status: 'loading', detail: 'no follow button in header' };

  const classes = headerBtn.className;
  const text = headerBtn.textContent.trim();
  const bgColor = window.getComputedStyle(headerBtn).backgroundColor;

  if (classes.includes('_aswv')) {
    return { status: 'already_following', text, bgColor };
  }

  const match = bgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    const r = parseInt(match[1]);
    const b = parseInt(match[3]);
    if (b > 200 && r < 130) {
      return { status: 'ready', text, bgColor };
    }
    return { status: 'already_following', text, bgColor };
  }

  return { status: 'loading', detail: 'unknown', text, bgColor };
}

function injectedClickFollow() {
  const header = document.querySelector('header');
  if (!header) return { clicked: false, error: 'no header' };

  let btn = header.querySelector('button._aswr');
  if (!btn) {
    const buttons = header.querySelectorAll('button');
    for (const b of buttons) {
      const bg = window.getComputedStyle(b).backgroundColor;
      const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (m && parseInt(m[3]) > 200 && parseInt(m[1]) < 130) { btn = b; break; }
    }
  }
  if (!btn) return { clicked: false, error: 'no follow button' };

  btn.click();
  return { clicked: true, text: btn.textContent.trim() };
}

function injectedVerify() {
  const header = document.querySelector('header');
  if (!header) return { verified: false };

  let btn = header.querySelector('button._aswr') || header.querySelector('button._aswv');
  if (!btn) return { verified: false };

  if (btn.className.includes('_aswv')) {
    return { verified: true };
  }

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

  try {
    const clickResult = await executeOnTab(tabId, injectedClickFollow);
    if (!clickResult?.clicked) return `click_failed (${clickResult?.error || 'unknown'})`;
  } catch (err) {
    return 'click_error: ' + err.message;
  }

  await safeSleep(2500);
  try {
    const v = await executeOnTab(tabId, injectedVerify);
    return v?.verified ? 'followed' : 'clicked_unverified';
  } catch (err) {
    return 'clicked_unverified';
  }
}

async function startFollowing(usernames, startIndex, minDelay, maxDelay, fileName, skipExisting) {
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

  // Pre-fetch following list if enabled
  let followingSet = null;
  if (skipExisting && startIndex === 0) {
    try {
      followingSet = await fetchFollowingList(tabId);
      if (followingSet) {
        // Filter out already-following users and log them as skipped
        const filtered = [];
        let skippedCount = 0;
        for (let i = 0; i < usernames.length; i++) {
          if (followingSet.has(usernames[i].toLowerCase())) {
            await appendLog({ index: i + 1, username: usernames[i], result: 'skipped_already_following' });
            skippedCount++;
          } else {
            filtered.push(usernames[i]);
          }
        }
        await saveState({
          statusText: `Skipped ${skippedCount} already-following. ${filtered.length} to follow.`,
          skippedCount,
        });
        usernames = filtered;
        await saveState({ usernames, total: usernames.length });
        await safeSleep(2000);
      }
    } catch (err) {
      await saveState({ statusText: 'Pre-check failed, continuing without it...' });
    }
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
