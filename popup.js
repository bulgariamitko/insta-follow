let usernames = [];
let fileName = '';

const fileInput = document.getElementById('fileInput');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resumeBtn = document.getElementById('resumeBtn');
const clearBtn = document.getElementById('clearBtn');
const copyLogBtn = document.getElementById('copyLogBtn');
const copyFailedBtn = document.getElementById('copyFailedBtn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const previewEl = document.getElementById('preview');
const lastFileEl = document.getElementById('lastFile');
const progressEl = document.getElementById('progress');
const progressBar = document.getElementById('progressBar');
const minDelayInput = document.getElementById('minDelay');
const maxDelayInput = document.getElementById('maxDelay');
const skipExistingCb = document.getElementById('skipExisting');

// Load state on popup open
loadState();

// Poll for live updates
const pollInterval = setInterval(loadState, 1500);

function loadState() {
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (chrome.runtime.lastError || !state) return;

    // Last file info
    if (state.fileName) {
      lastFileEl.style.display = 'block';
      lastFileEl.textContent = `Last file: ${state.fileName} (${state.total} users)`;
    }

    // Progress bar
    if (state.total > 0) {
      progressEl.style.display = 'block';
      const pct = Math.round((state.currentIndex / state.total) * 100);
      progressBar.style.width = pct + '%';
    }

    // Status text
    if (state.statusText) {
      statusEl.textContent = state.statusText;
    }

    // Log entries
    const logEntries = state.log || [];
    renderLog(logEntries);
    copyLogBtn.style.display = logEntries.length > 0 ? 'block' : 'none';
    const hasFailed = logEntries.some((e) => isFailed(e.result));
    copyFailedBtn.style.display = hasFailed ? 'block' : 'none';

    // Button visibility
    if (state.status === 'running') {
      startBtn.style.display = 'none';
      resumeBtn.style.display = 'none';
      stopBtn.style.display = 'block';
      clearBtn.style.display = 'none';
      fileInput.disabled = true;
    } else if (state.status === 'stopped' && state.currentIndex < state.total) {
      startBtn.style.display = 'block';
      startBtn.disabled = usernames.length === 0;
      resumeBtn.style.display = 'block';
      stopBtn.style.display = 'none';
      clearBtn.style.display = 'block';
      fileInput.disabled = false;
      usernames = state.usernames || [];
      fileName = state.fileName || '';
      resumeBtn.textContent = `Resume (${state.currentIndex}/${state.total})`;
    } else if (state.status === 'completed') {
      startBtn.style.display = 'block';
      startBtn.disabled = usernames.length === 0;
      resumeBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      clearBtn.style.display = 'block';
      fileInput.disabled = false;
    } else {
      startBtn.style.display = 'block';
      resumeBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      clearBtn.style.display = 'none';
      fileInput.disabled = false;
    }
  });
}

function renderLog(logEntries) {
  if (logEntries.length === 0) return;
  logEl.style.display = 'block';
  logEl.innerHTML = '';

  for (let i = logEntries.length - 1; i >= 0; i--) {
    const entry = logEntries[i];
    const div = document.createElement('div');
    const label = formatResult(entry.result);
    div.textContent = `${entry.index}. @${entry.username} - ${label}`;
    div.className = getResultClass(entry.result);
    logEl.appendChild(div);
  }
}

function formatResult(result) {
  if (result === 'followed') return 'Followed';
  if (result === 'already_following') return 'Already following';
  if (result === 'skipped_already_following') return 'Skipped (already following)';
  if (result === 'page_not_found') return 'Profile not found';
  if (result === 'clicked_unverified') return 'Clicked Follow (unverified)';
  if (result === 'click_failed') return 'Click failed';
  if (result.startsWith('not_found')) return 'Follow btn not found';
  if (result.startsWith('error')) return result;
  return result;
}

function isFailed(result) {
  return result === 'page_not_found' ||
    result.startsWith('not_found') ||
    result === 'click_failed' ||
    result.startsWith('click_error') ||
    result.startsWith('error');
}

function getResultClass(result) {
  if (result === 'followed') return 'followed';
  if (result === 'already_following') return 'already_following';
  if (result === 'skipped_already_following') return 'skipped';
  if (result === 'clicked_unverified') return 'clicked_but_unverified';
  return 'error';
}

function extractInstagramUsernames(data) {
  const results = [];

  function search(obj) {
    if (Array.isArray(obj)) {
      obj.forEach(search);
    } else if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        if (key.toLowerCase() === 'instagram' && typeof value === 'string' && value.trim()) {
          let username = value.trim();
          if (username.includes('instagram.com/')) {
            username = username.split('instagram.com/')[1].split(/[/?#]/)[0];
          }
          if (username.startsWith('@')) {
            username = username.substring(1);
          }
          if (username) results.push(username);
        } else if (typeof value === 'object') {
          search(value);
        }
      }
    }
  }

  search(data);
  return results;
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  fileName = file.name;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      usernames = extractInstagramUsernames(data);
      if (usernames.length === 0) {
        previewEl.textContent = 'No "Instagram" keys found in the JSON.';
        startBtn.disabled = true;
      } else {
        previewEl.textContent = `Found ${usernames.length} Instagram usernames.`;
        startBtn.disabled = false;
      }
    } catch (err) {
      previewEl.textContent = 'Invalid JSON file.';
      startBtn.disabled = true;
    }
  };
  reader.readAsText(file);
});

startBtn.addEventListener('click', () => {
  if (usernames.length === 0) return;
  const minDelay = Math.max(1, parseInt(minDelayInput.value) || 3);
  const maxDelay = Math.max(minDelay + 1, parseInt(maxDelayInput.value) || 6);

  chrome.runtime.sendMessage({
    action: 'start',
    usernames,
    startIndex: 0,
    minDelay,
    maxDelay,
    fileName,
    skipExisting: skipExistingCb.checked,
  });
});

resumeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (chrome.runtime.lastError || !state?.usernames) return;
    const minDelay = Math.max(5, parseInt(minDelayInput.value) || 15);
    const maxDelay = Math.max(minDelay + 1, parseInt(maxDelayInput.value) || 45);

    chrome.runtime.sendMessage({
      action: 'start',
      usernames: state.usernames,
      startIndex: state.currentIndex,
      minDelay,
      maxDelay,
      fileName: state.fileName,
    });
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stop' });
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clearHistory' }, () => {
    logEl.innerHTML = '';
    logEl.style.display = 'none';
    lastFileEl.style.display = 'none';
    progressEl.style.display = 'none';
    statusEl.textContent = '';
    resumeBtn.style.display = 'none';
    clearBtn.style.display = 'none';
    copyLogBtn.style.display = 'none';
    copyFailedBtn.style.display = 'none';
    startBtn.disabled = true;
    startBtn.style.display = 'block';
    previewEl.textContent = '';
    usernames = [];
  });
});

copyLogBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (chrome.runtime.lastError || !state?.log?.length) return;
    const lines = state.log.map((e) => {
      return `${e.index}. @${e.username} - ${formatResult(e.result)}`;
    });
    const text = `Insta Follow Log - ${state.fileName} (${state.log.length} entries)\n` +
      `${'='.repeat(50)}\n` +
      lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copyLogBtn.textContent = 'Copied!';
      copyLogBtn.classList.add('copied');
      setTimeout(() => {
        copyLogBtn.textContent = 'Copy Log';
        copyLogBtn.classList.remove('copied');
      }, 2000);
    });
  });
});

copyFailedBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
    if (chrome.runtime.lastError || !state?.log?.length) return;
    const failed = state.log.filter((e) => isFailed(e.result));
    if (failed.length === 0) return;
    const lines = failed.map((e) => `@${e.username} - ${formatResult(e.result)}`);
    const text = `Failed/Not Found (${failed.length} usernames)\n` +
      `${'='.repeat(40)}\n` +
      lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copyFailedBtn.textContent = 'Copied!';
      copyFailedBtn.classList.add('copied');
      setTimeout(() => {
        copyFailedBtn.textContent = 'Copy Failed';
        copyFailedBtn.classList.remove('copied');
      }, 2000);
    });
  });
});
