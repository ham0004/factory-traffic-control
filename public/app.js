// The dashboard only displays backend state and sends requests. It never decides a signal itself.
const DIRECTIONS = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
const POLL_MS = 1000;

const $ = (selector) => document.querySelector(selector);
let junctionId = 'A';
let junctionConfig = null;
let latestStatus = null;
let lastSensorEvent = null;
let sequenceNo = Math.floor(Date.now() / 1000);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body; keep data null.
  }
  return { ok: response.ok, status: response.status, data };
}

function setResult(message, ok) {
  const el = $('#last-result');
  el.textContent = message;
  el.className = `result ${ok ? 'ok' : 'err'}`;
}

function showResult(label, result) {
  const data = result.data ?? {};
  const message = data.message ?? data.error ?? (data.duplicate ? 'duplicate, ignored' : 'ok');
  const details = data.details ? ` - ${data.details.map((d) => `${d.path}: ${d.message}`).join('; ')}` : '';
  setResult(`${label}: HTTP ${result.status} ${message}${details}`, result.ok);
}

async function send(label, path, body) {
  try {
    const result = await api(path, { method: 'POST', body });
    showResult(label, result);
    refresh();
    return result;
  } catch {
    setResult(`${label}: backend unavailable`, false);
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function text(selector, value) {
  $(selector).textContent = value ?? '-';
}

function seconds(ms) {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

// ---- intersection ----

function renderApproach(el, dir, status) {
  const desired = status.desired_signals?.[dir] ?? 'UNKNOWN';
  const actual = status.actual_signals?.[dir] ?? 'UNKNOWN';
  const queue = status.queues?.[dir] ?? 0;
  const lamp = (color) => {
    if (desired === 'UNKNOWN') return '<span class="lamp unknown"></span>';
    return `<span class="lamp ${color.toLowerCase()} ${desired === color ? 'on' : ''}"></span>`;
  };

  el.innerHTML = `
    <div class="signal-head" title="Desired: ${desired}">${lamp('RED')}${lamp('YELLOW')}${lamp('GREEN')}</div>
    <div class="approach-meta">
      <span class="dir-name">${dir}</span>
      <span class="chip ${actual}" title="Confirmed by controller">${actual === 'UNKNOWN' ? '? unknown' : `&#10003; ${actual.toLowerCase()}`}</span>
      <span class="queue-badge ${queue > 0 ? 'busy' : ''}">${queue} waiting</span>
    </div>`;
}

// Progress of the current stage against its configured duration (display only).
function stageProgress(stage) {
  const timings = junctionConfig?.timings;
  if (!stage || !timings) return 0;
  const expected = { GREEN: timings.normalGreenMs, YELLOW: timings.yellowMs, ALL_RED: timings.allRedMs }[stage.kind];
  return expected ? Math.min(100, (stage.elapsed_ms / expected) * 100) : 0;
}

function renderIntersection(status) {
  for (const el of document.querySelectorAll('.approach')) renderApproach(el, el.dataset.dir, status);

  const stage = status.stage;
  text('#center-label', stage?.kind === 'ALL_RED' ? 'ALL RED' : `${stage?.kind ?? '-'}`);
  text('#center-sub', stage ? `${(stage.phase ?? `next ${stage.next_phase}`).replace('_', ' / ')} · ${seconds(stage.elapsed_ms)}` : '');

  const bar = $('#stage-bar');
  bar.className = `stage-bar-fill ${stage?.kind ?? ''}`;
  bar.style.width = `${stageProgress(stage)}%`;
}

// ---- status panel ----

function renderStatus(status) {
  latestStatus = status;
  const mode = status.mode ?? 'UNKNOWN';
  const stage = status.stage;

  $('#mode-badge').textContent = mode;
  $('#mode-badge').className = `pill ${mode}`;
  text('#phase-badge', status.phase?.replace('_', ' / '));

  renderIntersection(status);

  const controller = status.controller_status ?? 'UNKNOWN';
  text('#controller-status', controller);
  $('#controller-status').className = `stat-value ${controller === 'ONLINE' ? 'ok' : 'bad'}`;

  text('#confirmed', status.signals_confirmed ? 'Yes' : 'Waiting for controller');
  $('#confirmed').className = `stat-value ${status.signals_confirmed ? 'ok' : 'bad'}`;

  text('#stage', stage ? `${stage.kind} ${stage.phase ?? ''}${stage.next_phase ? ` → ${stage.next_phase}` : ''}` : null);

  const pending = status.pending_command;
  text('#pending', pending ? `${pending.command_id} · ${(pending.age_ms / 1000).toFixed(1)}s · try ${pending.attempts}` : 'None');

  const manual = status.manual;
  text('#manual', manual ? `${manual.direction} by ${manual.issued_by ?? 'unknown'}, until ${new Date(manual.expires_at).toLocaleTimeString()}` : 'Not active');
  for (const button of document.querySelectorAll('[data-manual]')) {
    button.classList.toggle('active', mode === 'MANUAL' && manual?.direction === button.dataset.manual);
  }

  const queue = status.emergency?.queue ?? [];
  text('#emergencies', queue.length ? queue.map((e) => `${e.vehicle_id} (${e.direction})`).join(', ') : 'None');

  for (const dir of DIRECTIONS) {
    text(`#q-${dir}`, status.queues?.[dir] ?? '-');
    const sensor = status.sensors?.[dir] ?? 'UNKNOWN';
    text(`#s-${dir}`, `sensor ${sensor.toLowerCase()}`);
    $(`#s-${dir}`).className = `sensor ${sensor}`;
  }

  const alerts = status.alerts ?? [];
  $('#alerts').innerHTML = alerts.length
    ? alerts.map((a) => `<li class="${a.level}">${escapeHtml(a.message)}</li>`).join('')
    : '<li class="alert-none">No active alerts</li>';

  const emergencyBanner = $('#emergency-banner');
  emergencyBanner.hidden = mode !== 'EMERGENCY';
  if (mode === 'EMERGENCY' && queue[0]) {
    emergencyBanner.textContent =
      `Emergency preemption at junction ${status.junction_id}: ${queue[0].vehicle_id} from ${queue[0].direction}. ` +
      `Now ${stage?.kind ?? ''} ${stage?.phase ?? stage?.next_phase ?? ''}`;
  }

  const failures = alerts.filter((a) => a.level === 'error' && a.code !== 'EMERGENCY');
  $('#failure-banner').hidden = failures.length === 0;
  $('#failure-banner').textContent = failures.map((a) => a.message).join('  |  ');
}

// ---- activity ----

const EVENT_GROUPS = {
  error: ['CONTROLLER_TIMEOUT', 'STATE_MISMATCH', 'COMMAND_FAILED', 'DEVICE_FAILURE', 'SENSOR_FAILURE', 'EMERGENCY_DETECTED', 'REJECTED_EVENT', 'MANUAL_REJECTED', 'EVENT_ID_CONFLICT'],
  warn: ['DUPLICATE_EVENT', 'DUPLICATE_VEHICLE', 'DUPLICATE_ACK', 'OUT_OF_ORDER', 'CLEAR_WITHOUT_ARRIVAL', 'COMMAND_RETRY', 'SEQUENCE_GAP', 'SEQUENCE_OUT_OF_ORDER', 'EMERGENCY_STALE', 'EMERGENCY_TIMEOUT', 'ACK_IGNORED', 'MANUAL_EXPIRED'],
  signal: ['SIGNAL_TRANSITION', 'SIGNAL_REQUESTED', 'SIGNAL_CONFIRMED', 'CONTROLLER_ACK'],
  mode: ['MODE_CHANGED', 'MANUAL_OVERRIDE', 'RETURN_TO_AUTOMATIC', 'RECOVERY_STARTED', 'RECOVERED', 'DEVICE_ONLINE', 'SENSOR_ONLINE', 'EMERGENCY_CLEARED'],
  vehicle: ['VEHICLE_DETECTED', 'VEHICLE_CLEARED'],
};

function eventGroup(type) {
  return Object.keys(EVENT_GROUPS).find((group) => EVENT_GROUPS[group].includes(type)) ?? '';
}

function renderHistory(rows) {
  if (!rows.length) {
    $('#history').innerHTML = '<tr><td colspan="6" class="empty">No activity yet</td></tr>';
    return;
  }
  $('#history').innerHTML = rows
    .map((r) => {
      const transition = [r.previous_state, r.new_state].filter(Boolean).join(' → ');
      return `<tr>
        <td class="time">${new Date(r.created_at).toLocaleTimeString()}</td>
        <td><span class="tag ${eventGroup(r.event_type)}">${escapeHtml(r.event_type)}</span></td>
        <td>${escapeHtml(r.direction ?? '')}</td>
        <td>${escapeHtml(transition)}</td>
        <td>${escapeHtml(r.command_id ?? '')}</td>
        <td class="details">${escapeHtml(r.details ? JSON.stringify(r.details) : '')}</td>
      </tr>`;
    })
    .join('');
}

// ---- polling ----

function setLive(online) {
  $('#live-indicator').className = `live ${online ? 'on' : 'off'}`;
  text('#live-text', online ? 'Live' : 'Offline');
  $('#offline-banner').hidden = online;
}

async function loadConfig() {
  try {
    const result = await api(`/api/junctions/${encodeURIComponent(junctionId)}`);
    junctionConfig = result.ok ? result.data?.config : null;
  } catch {
    junctionConfig = null;
  }
}

async function refresh() {
  try {
    const [status, history, simulator] = await Promise.all([
      api(`/api/junctions/${encodeURIComponent(junctionId)}/status`),
      api(`/api/junctions/${encodeURIComponent(junctionId)}/history?limit=30`),
      api('/api/simulator'),
    ]);
    setLive(true);

    if (!status.ok) {
      $('#failure-banner').hidden = false;
      $('#failure-banner').textContent = `Cannot load junction ${junctionId}: ${status.data?.message ?? `HTTP ${status.status}`}`;
      return;
    }
    if (!junctionConfig) await loadConfig();
    renderStatus(status.data);
    if (history.ok && Array.isArray(history.data)) renderHistory(history.data);
    if (simulator.ok) $('#auto-ack').checked = Boolean(simulator.data?.auto_ack);
  } catch {
    setLive(false);
  }
}

async function poll() {
  await refresh();
  setTimeout(poll, POLL_MS);
}

async function loadJunctions() {
  try {
    const result = await api('/api/junctions');
    const junctions = result.ok && Array.isArray(result.data) ? result.data : [{ id: 'A', name: 'Junction A' }];
    $('#junction-select').innerHTML = junctions
      .map((j) => `<option value="${escapeHtml(j.id)}">${escapeHtml(j.name)}</option>`)
      .join('');
    junctionId = junctions[0]?.id ?? 'A';
    await loadConfig();
  } catch {
    setLive(false);
  }
}

// ---- actions ----

function newVehicleId() {
  $('#sensor-form').vehicle_id.value = `VH-${Math.floor(Math.random() * 9000 + 1000)}`;
}

function commandsPath() {
  return `/api/junctions/${encodeURIComponent(junctionId)}/commands`;
}

$('#junction-select').addEventListener('change', async (e) => {
  junctionId = e.target.value;
  junctionConfig = null;
  await loadConfig();
  refresh();
});

$('#new-vehicle').addEventListener('click', newVehicleId);

$('#sensor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  sequenceNo += 1;
  const event = {
    event_id: `ui-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    junction_id: junctionId,
    direction: form.direction.value,
    event_type: form.event_type.value,
    vehicle_id: form.vehicle_id.value.trim(),
    sequence_no: sequenceNo,
    timestamp: new Date().toISOString(),
  };
  if (event.event_type === 'VEHICLE_ARRIVED') event.vehicle_type = form.vehicle_type.value;

  lastSensorEvent = event;
  $('#resend').disabled = false;
  await send(`${event.event_type} ${event.vehicle_id}`, '/api/sensor-events', event);
});

$('#resend').addEventListener('click', () => {
  if (lastSensorEvent) send(`Resend ${lastSensorEvent.event_id}`, '/api/sensor-events', lastSensorEvent);
});

for (const button of document.querySelectorAll('[data-manual]')) {
  button.addEventListener('click', () =>
    send(`Manual green ${button.dataset.manual}`, commandsPath(), {
      command: 'MANUAL_GREEN_REQUEST',
      direction: button.dataset.manual,
      issued_by: $('#operator').value || undefined,
    }),
  );
}

$('#return-auto').addEventListener('click', () =>
  send('Return to automatic', commandsPath(), { command: 'RETURN_TO_AUTOMATIC', issued_by: $('#operator').value || undefined }),
);

for (const button of document.querySelectorAll('[data-controller]')) {
  button.addEventListener('click', () =>
    send(`Controller ${button.dataset.controller}`, '/api/device-status', {
      junction_id: junctionId,
      device_type: 'SIGNAL_CONTROLLER',
      status: button.dataset.controller,
    }),
  );
}

for (const button of document.querySelectorAll('[data-sensor]')) {
  button.addEventListener('click', () => {
    const direction = $('#sensor-form').direction.value;
    send(`${direction} sensor ${button.dataset.sensor}`, '/api/device-status', {
      junction_id: junctionId,
      device_type: 'SENSOR',
      direction,
      status: button.dataset.sensor,
    });
  });
}

$('#auto-ack').addEventListener('change', (e) =>
  send(`Auto-ACK ${e.target.checked ? 'on' : 'off'}`, '/api/simulator/settings', { auto_ack: e.target.checked }),
);

for (const button of document.querySelectorAll('[data-ack]')) {
  button.addEventListener('click', () => {
    const pending = latestStatus?.pending_command;
    if (!pending) {
      setResult('No pending command to acknowledge. Turn auto-ACK off and request a change first.', false);
      return;
    }
    const kind = button.dataset.ack;
    const actual = kind === 'WRONG' ? { NORTH: 'GREEN', SOUTH: 'GREEN', EAST: 'GREEN', WEST: 'GREEN' } : pending.desired_signals;
    send(`${kind} ${pending.command_id}`, '/api/controller-events', {
      command_id: pending.command_id,
      junction_id: junctionId,
      status: kind === 'NACK' ? 'NACK' : 'ACK',
      actual_signals: kind === 'NACK' ? undefined : actual,
    });
  });
}

newVehicleId();
loadJunctions().then(poll);
