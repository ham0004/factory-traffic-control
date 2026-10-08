// The dashboard only displays backend state and sends requests. It never decides a signal itself.
const DIRECTIONS = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
const POLL_MS = 1000;

const $ = (selector) => document.querySelector(selector);
let junctionId = 'A';
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

function showResult(label, result) {
  const el = $('#last-result');
  const message = result.data?.message ?? result.data?.error ?? (result.data?.duplicate ? 'duplicate (ignored)' : 'ok');
  const details = result.data?.details ? ` - ${result.data.details.map((d) => `${d.path}: ${d.message}`).join('; ')}` : '';
  el.textContent = `${label}: HTTP ${result.status} ${message}${details}`;
  el.className = `result ${result.ok ? 'ok' : 'err'}`;
}

async function send(label, path, body) {
  try {
    const result = await api(path, { method: 'POST', body });
    showResult(label, result);
    refresh();
    return result;
  } catch {
    $('#last-result').textContent = `${label}: backend unavailable`;
    $('#last-result').className = 'result err';
    return null;
  }
}

// ---- rendering ----

function text(selector, value) {
  $(selector).textContent = value ?? '-';
}

function renderLights(status) {
  for (const light of document.querySelectorAll('.light')) {
    const dir = light.dataset.dir;
    const desired = status.desired_signals?.[dir] ?? 'UNKNOWN';
    const actual = status.actual_signals?.[dir] ?? 'UNKNOWN';
    light.innerHTML = `
      <div class="lamp ${desired}" title="desired ${desired}"></div>
      <div class="dot ${actual}" title="confirmed ${actual}"></div>
      <span>${dir}</span>`;
  }
  text('#center-label', status.stage?.kind === 'ALL_RED' ? 'ALL RED' : status.phase);
}

function renderStatus(status) {
  latestStatus = status;
  const mode = status.mode ?? 'UNKNOWN';
  $('#mode-badge').textContent = mode;
  $('#mode-badge').className = `badge ${mode}`;
  text('#phase-badge', status.phase);

  renderLights(status);

  const stage = status.stage;
  text('#controller-status', status.controller_status);
  text('#stage', stage ? `${stage.kind} ${stage.phase ?? ''}${stage.next_phase ? ` -> ${stage.next_phase}` : ''} (${Math.round(stage.elapsed_ms / 1000)}s)` : null);
  text('#confirmed', status.signals_confirmed ? 'yes' : 'no - waiting for controller');

  const pending = status.pending_command;
  text('#pending', pending ? `${pending.command_id}, ${(pending.age_ms / 1000).toFixed(1)}s old, attempt ${pending.attempts}` : 'none');

  const manual = status.manual;
  text('#manual', manual ? `${manual.direction} by ${manual.issued_by ?? 'unknown'} until ${new Date(manual.expires_at).toLocaleTimeString()}` : 'not active');

  const queue = status.emergency?.queue ?? [];
  text('#emergencies', queue.length ? queue.map((e) => `${e.vehicle_id} (${e.direction})`).join(', ') : 'none');

  for (const dir of DIRECTIONS) {
    text(`#q-${dir}`, status.queues?.[dir]);
    const sensor = status.sensors?.[dir] ?? 'UNKNOWN';
    text(`#s-${dir}`, sensor);
    $(`#s-${dir}`).className = sensor;
  }

  const alerts = status.alerts ?? [];
  $('#alerts').innerHTML = alerts.length
    ? alerts.map((a) => `<li class="${a.level}">${escapeHtml(a.message)}</li>`).join('')
    : '<li class="muted">none</li>';

  const emergencyBanner = $('#emergency-banner');
  emergencyBanner.hidden = mode !== 'EMERGENCY';
  if (mode === 'EMERGENCY' && queue[0]) {
    emergencyBanner.textContent = `EMERGENCY at junction ${status.junction_id}: ${queue[0].vehicle_id} from ${queue[0].direction} - currently ${stage?.kind} ${stage?.phase ?? ''}`;
  }

  const failures = alerts.filter((a) => a.level === 'error' && a.code !== 'EMERGENCY');
  const failureBanner = $('#failure-banner');
  failureBanner.hidden = failures.length === 0;
  failureBanner.textContent = failures.map((a) => a.message).join(' | ');
}

function renderHistory(rows) {
  $('#history').innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${new Date(r.created_at).toLocaleTimeString()}</td>
        <td>${escapeHtml(r.event_type)}</td>
        <td>${escapeHtml(r.direction ?? '')}</td>
        <td>${escapeHtml(r.previous_state ?? '')}</td>
        <td>${escapeHtml(r.new_state ?? '')}</td>
        <td>${escapeHtml(r.command_id ?? '')}</td>
        <td>${escapeHtml(r.details ? JSON.stringify(r.details) : '')}</td>
      </tr>`,
    )
    .join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- polling ----

async function refresh() {
  try {
    const [status, history, simulator] = await Promise.all([
      api(`/api/junctions/${encodeURIComponent(junctionId)}/status`),
      api(`/api/junctions/${encodeURIComponent(junctionId)}/history?limit=30`),
      api('/api/simulator'),
    ]);
    $('#offline-banner').hidden = true;

    if (!status.ok) {
      $('#failure-banner').hidden = false;
      $('#failure-banner').textContent = `Cannot load junction ${junctionId}: ${status.data?.message ?? `HTTP ${status.status}`}`;
      return;
    }
    renderStatus(status.data);
    if (history.ok && Array.isArray(history.data)) renderHistory(history.data);
    if (simulator.ok) $('#auto-ack').checked = Boolean(simulator.data?.auto_ack);
  } catch {
    $('#offline-banner').hidden = false;
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
  } catch {
    $('#offline-banner').hidden = false;
  }
}

// ---- actions ----

function newVehicleId() {
  $('#sensor-form').vehicle_id.value = `VH-${Math.floor(Math.random() * 9000 + 1000)}`;
}

$('#junction-select').addEventListener('change', (e) => {
  junctionId = e.target.value;
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
  if (lastSensorEvent) send(`resend ${lastSensorEvent.event_id}`, '/api/sensor-events', lastSensorEvent);
});

for (const button of document.querySelectorAll('[data-manual]')) {
  button.addEventListener('click', () =>
    send(`manual green ${button.dataset.manual}`, `/api/junctions/${encodeURIComponent(junctionId)}/commands`, {
      command: 'MANUAL_GREEN_REQUEST',
      direction: button.dataset.manual,
      issued_by: $('#operator').value || undefined,
    }),
  );
}

$('#return-auto').addEventListener('click', () =>
  send('return to automatic', `/api/junctions/${encodeURIComponent(junctionId)}/commands`, {
    command: 'RETURN_TO_AUTOMATIC',
    issued_by: $('#operator').value || undefined,
  }),
);

for (const button of document.querySelectorAll('[data-controller]')) {
  button.addEventListener('click', () =>
    send(`controller ${button.dataset.controller}`, '/api/device-status', {
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
  send(`auto-ACK ${e.target.checked ? 'on' : 'off'}`, '/api/simulator/settings', { auto_ack: e.target.checked }),
);

for (const button of document.querySelectorAll('[data-ack]')) {
  button.addEventListener('click', () => {
    const pending = latestStatus?.pending_command;
    if (!pending) {
      $('#last-result').textContent = 'No pending command to acknowledge.';
      $('#last-result').className = 'result err';
      return;
    }
    const kind = button.dataset.ack;
    let actual = pending.desired_signals;
    if (kind === 'WRONG') actual = { NORTH: 'GREEN', SOUTH: 'GREEN', EAST: 'GREEN', WEST: 'GREEN' };
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
