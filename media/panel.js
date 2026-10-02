const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

let hasWorkspace = false;
let workspacePath = '';
let attachedFiles = [];   // [{ name, content }]

// --- Init ---
vscode.postMessage({ type: 'ready' });

// --- Welcome handlers ---
$('attach').addEventListener('click', () => {
  vscode.postMessage({ type: 'pickFile' });
});

$('start').addEventListener('click', () => {
  const name = $('name').value.trim();
  const description = $('description').value.trim();
  if (!hasWorkspace || !name) return;
  if (!description && attachedFiles.length === 0) return;

  vscode.postMessage({
    type: 'start',
    name,
    description,
    attachments: attachedFiles
  });
});

$('name').addEventListener('input', updateStartButton);
$('description').addEventListener('input', updateStartButton);

function updateStartButton() {
  const name = $('name').value.trim();
  const description = $('description').value.trim();
  const canStart =
    hasWorkspace &&
    !!name &&
    (!!description || attachedFiles.length > 0);
  $('start').disabled = !canStart;
}

// --- Attachments list ---
function renderAttachments() {
  const list = $('attached-list');
  list.innerHTML = '';

  for (let i = 0; i < attachedFiles.length; i++) {
    const f = attachedFiles[i];
    const li = document.createElement('li');

    const span = document.createElement('span');
    span.textContent = f.name;
    span.title = f.name;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.className = 'detach';
    btn.title = 'Detach';
    btn.addEventListener('click', () => {
      attachedFiles.splice(i, 1);
      renderAttachments();
      updateStartButton();
    });

    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }

  $('attach-info').textContent = attachedFiles.length
    ? 'attached: ' + attachedFiles.length
    : '';
}

// --- Progress / Done ---
$('stop').addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
});

$('reset').addEventListener('click', () => {
  attachedFiles = [];
  renderAttachments();
  $('name').value = '';
  $('description').value = '';
  $('status-executor').textContent = '—';
  $('status-critic').textContent = '—';
  $('turn-executor').textContent = '0';
  $('turn-critic').textContent = '0';
  $('elapsed').textContent = '00:00';
  vscode.postMessage({ type: 'reset' });
  updateStartButton();
});

// --- Messages from extension ---
window.addEventListener('message', (e) => {
  const m = e.data;

  switch (m.type) {
    case 'workspaceStatus': {
      hasWorkspace = !!m.hasWorkspace;
      workspacePath = m.workspacePath || '';
      const info = $('workspace-info');
      if (hasWorkspace) {
        info.textContent = 'Project: ' + workspacePath;
        info.className = 'workspace ok';
      } else {
        info.textContent =
          'Open a project folder (File -> Open Folder) to start.';
        info.className = 'workspace warn';
      }
      updateStartButton();
      break;
    }

    case 'showWelcome':
      show('view-welcome');
      break;

    case 'showProgress':
      $('project-name').textContent = m.name;
      show('view-progress');
      break;

    case 'filesAttached':
      for (const f of m.files) {
        const dup = attachedFiles.some(
          x => x.name === f.name && x.content === f.content
        );
        if (!dup) attachedFiles.push(f);
      }
      renderAttachments();
      updateStartButton();
      break;

    case 'status':
      $(`status-${m.who}`).textContent = m.status;
      break;

    case 'turn': {
      const el = $(`turn-${m.who}`);
      el.textContent = String(Number(el.textContent) + 1);
      break;
    }

    case 'elapsed':
      $('elapsed').textContent = fmt(m.elapsedMs);
      $('total').textContent = fmt(m.totalMs);
      break;

    case 'done':
      $('done-summary').textContent = m.summary || reasonText(m.reason);
      show('view-done');
      break;
  }
});

// --- Utils ---
function show(id) {
  ['view-welcome', 'view-progress', 'view-done'].forEach(v => {
    $(v).hidden = (v !== id);
  });
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function reasonText(r) {
  const map = {
    context_exhausted: 'DeepSeek session context exhausted. Code saved.',
    server_busy: 'DeepSeek is busy. Try again later — code saved.',
    timeout: 'Task time limit exceeded. Code saved.',
    protocol_violation: 'Agent violated the protocol. Code saved.',
    malformed_tool_call: 'Failed to parse tool call.',
    unknown_tool: 'Agent called an unknown tool.',
    user_stopped: 'Stopped by user.',
    deadlock: 'Deadlock: agents stopped responding.',
    no_workspace: 'Open a project folder.',
    unauthorized: 'No API access.',
    bad_request: 'Invalid request.',
    network_error: 'Network error.',
    crash: 'Internal error.'
  };
  return map[r] || r;
}

updateStartButton();
