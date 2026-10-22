'use strict';
/* PickTogether Final — client-only UI; authorization and vote rules live in SQL.
 * Only the Supabase PUBLISHABLE key belongs here. Never paste sb_secret/service_role.
 * These credentials target the separate PickTogether2.0 test project.
 */
const SUPABASE_URL = 'https://hsfuypbcwbiyczzrfdlo.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_LZFLW3gSwjckCZxRAQ08Vg_Rh7Xl0y0';
const db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) ?? null;
const SESSION_KEY = 'picktogether:final:room';
const REFRESH_INTERVAL_MS = 12000; // Resilience when a WebSocket is blocked.

let epoch = 0;
let state = freshState();
let modalResolve = null;
let scheduledRefresh = null;
let refreshPromise = null;
let refreshEpoch = -1;
let refreshAgain = false;
let fallbackTimer = null;
let deadlineTimer = null;
let isNavigating = false;
const pending = new Set();
const deadlinesSeen = new Set();

function freshState() {
  return { epoch, roomKey: null, userId: null, name: null, isHost: false,
    participants: [], polls: [], activePollId: null, options: [], myVote: null,
    totals: {}, channels: [] };
}
function el(id) { return document.getElementById(id); }
function active(token, key) { return state.epoch === token && state.roomKey === key; }
function check(response, context) {
  if (response?.error) {
    const failure = new Error(`${context}: ${response.error.message}`);
    failure.code = response.error.code;
    throw failure;
  }
  return response.data;
}
function errorText(error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/PGRST202|Could not find the function|404.*rpc/i.test(raw))
    return 'Database functions not found. Run the FINAL supabase_setup.sql in this exact Supabase project and reload the page.';
  if (/42501|row-level security|permission denied/i.test(raw))
    return 'Database permission denied. Run the FINAL SQL file and check Anonymous Sign-Ins in Supabase.';
  if (/42P01|relation .* does not exist/i.test(raw))
    return 'PickTogether tables are missing. Run the FINAL supabase_setup.sql file.';
  if (/23505|duplicate key|unique constraint/i.test(raw))
    return 'That name, option or room code is already used. Try a different one.';
  if (/failed to fetch|networkerror|fetch failed/i.test(raw))
    return 'Network error. Check your internet connection and Supabase project status.';
  return raw;
}
function showError(error) {
  console.error('PickTogether:', error);
  el('message').textContent = errorText(error);
  el('message').hidden = false;
  el('notice').hidden = true;
}
function clearError() { el('message').hidden = true; }
function showNotice(msg) {
  clearError(); el('notice').textContent = msg; el('notice').hidden = false;
}
function clearNotice() { el('notice').hidden = true; }
function status(text, mode) {
  const node = el('connection-status');
  node.textContent = text; node.dataset.state = mode; node.hidden = !state.roomKey;
}
async function ensureIdentity() {
  if (!db) throw new Error('Supabase failed to load. Check your connection and the CDN in index.html.');
  const existing = check(await db.auth.getSession(), 'Checking your session');
  if (existing?.session?.user?.id) return existing.session.user.id;
  const newSession = await db.auth.signInAnonymously();
  if (newSession.error) {
    throw new Error('Guest sign-in failed. Enable Authentication > Providers > Anonymous Sign-Ins in Supabase. ' + newSession.error.message);
  }
  if (!newSession.data?.user?.id) throw new Error('Guest sign-in returned no user.');
  return newSession.data.user.id;
}
function closeAllDropdowns() {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
}
function toggleDropdown(id) {
  const item = el(id);
  if (!item) return;
  const willOpen = !item.classList.contains('active');
  closeAllDropdowns();
  if (willOpen) item.classList.add('active');
}
function showCustomPrompt(title, description, defaultValue = '', maxLength = 40) {
  return new Promise(resolve => {
    closeAllDropdowns();
    if (modalResolve) modalResolve(null);
    modalResolve = resolve;
    el('modal-title').textContent = title;
    el('modal-desc').textContent = description;
    const input = el('modal-input');
    input.value = defaultValue;
    input.maxLength = maxLength;
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); closeModal(true); }
      if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
    };
    el('custom-modal').classList.add('active');
    el('custom-modal').setAttribute('aria-hidden', 'false');
    input.focus(); input.select();
  });
}
function closeModal(confirmed) {
  const value = el('modal-input').value.trim();
  el('custom-modal').classList.remove('active');
  el('custom-modal').setAttribute('aria-hidden', 'true');
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(confirmed ? value : null);
}
function roomCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + buf[0] % 900000);
}
function storeRoom() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({key: state.roomKey, name: state.name}));
  } catch (e) { console.warn('Storage unavailable; refresh will require a new join:', e); }
  const url = new URL(location.href);
  url.searchParams.set('room', state.roomKey);
  history.replaceState({}, '', url);
}
function forgetRoom() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* private mode */ }
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState({}, '', url);
}
async function createRoom() {
  if (isNavigating) return;
  clearError(); clearNotice();
  const name = await showCustomPrompt('Create a room', 'What should we call you?', '', 40);
  if (!name) return;
  isNavigating = true;
  try {
    const userId = await ensureIdentity();
    let created = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await db.rpc('pt_create_room', {p_room_key: roomCode(), p_name: name});
      if (!result.error) { created = result.data?.[0]; break; }
      // Only retry a genuine room-code collision, not every unique violation.
      if (result.error.code !== '23505' || !/pt_rooms_pkey/i.test(result.error.message))
        throw result.error;
    }
    if (!created) throw new Error('Unable to generate a free room code. Try again.');
    await enterRoom(created.room_key, name, userId, created.poll_id);
  } catch (e) { showError(e); }
  finally { isNavigating = false; }
}
async function promptJoinRoom() {
  if (isNavigating) return;
  clearError(); clearNotice();
  const key = await showCustomPrompt('Join a room', 'Enter the 6-digit room code:', '', 6);
  if (key === null) return;
  if (!/^\d{6}$/.test(key)) { showError('Please enter exactly six digits.'); return; }
  const name = await showCustomPrompt('Join a room', `Your name in room ${key}:`, '', 40);
  if (!name) return;
  await joinRoom(key, name);
}
async function joinRoom(key, name) {
  if (isNavigating) return;
  clearError(); clearNotice();
  if (!/^\d{6}$/.test(key)) { showError('Please enter exactly six digits.'); return; }
  if (!name?.trim() || name.trim().length > 40) { showError('Name must be 1–40 characters.'); return; }
  isNavigating = true;
  try {
    const userId = await ensureIdentity();
    const rows = check(await db.rpc('pt_join_room', {p_room_key: key, p_name: name.trim()}), 'Joining room');
    if (!rows?.length) throw new Error('The database did not confirm your join.');
    await enterRoom(key, name.trim(), userId);
  } catch (e) { showError(e); }
  finally { isNavigating = false; }
}
function cancelUpdates() {
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  if (fallbackTimer) clearInterval(fallbackTimer);
  if (deadlineTimer) clearInterval(deadlineTimer);
  scheduledRefresh = fallbackTimer = deadlineTimer = null;
  if (db) state.channels.forEach(ch => db.removeChannel(ch));
  state.channels = [];
  deadlinesSeen.clear();
}
function goHome(clearSaved = true) {
  cancelUpdates();
  ++epoch;
  state = freshState();
  el('room-view').classList.remove('active');
  el('home-view').classList.add('active');
  el('room-key-display').hidden = true;
  el('connection-status').hidden = true;
  closeAllDropdowns();
  if (clearSaved) forgetRoom();
}
async function enterRoom(key, name, userId, requestedPollId = null) {
  cancelUpdates();
  ++epoch;
  state = freshState();
  state.epoch = epoch;
  state.roomKey = key;
  state.name = name;
  state.userId = userId;
  state.activePollId = requestedPollId;
  el('home-view').classList.remove('active');
  el('room-view').classList.add('active');
  el('room-key-display').hidden = false;
  el('key-value').textContent = key;
  status('Connecting…', 'connecting');
  el('poll-title-heading').textContent = 'Loading room…';
  el('options-list').replaceChildren();
  el('outcome-box').textContent = '';
  storeRoom();
  const token = epoch;
  try {
    await refreshRoom();
  } catch (e) {
    if (active(token, key)) showError(e);
  }
  if (!active(token, key)) return;
  subscribeToRoom(key, token);
  fallbackTimer = setInterval(() => {
    if (active(token, key)) scheduleRefresh();
  }, REFRESH_INTERVAL_MS);
  deadlineTimer = setInterval(() => {
    if (!active(token, key)) return;
    for (const poll of state.polls) {
      if (poll.deadline && Date.parse(poll.deadline) <= Date.now() && !deadlinesSeen.has(poll.id)) {
        deadlinesSeen.add(poll.id);
        scheduleRefresh();
      }
    }
  }, 1000);
}
function scheduleRefresh() {
  if (!state.roomKey || scheduledRefresh) return;
  const token = state.epoch, key = state.roomKey;
  scheduledRefresh = setTimeout(() => {
    scheduledRefresh = null;
    if (active(token, key)) refreshRoom().catch(e => { if (active(token, key)) showError(e); });
  }, 100);
}
async function refreshRoom() {
  if (!state.roomKey) return;
  const token = state.epoch, key = state.roomKey;
  if (refreshPromise && refreshEpoch === token) {
    refreshAgain = true;
    return refreshPromise;
  }
  refreshEpoch = token;
  const work = (async () => {
    do {
      refreshAgain = false;
      await loadRoom(token, key);
    } while (refreshAgain && active(token, key));
  })();
  refreshPromise = work;
  try { await work; }
  finally { if (refreshPromise === work) refreshPromise = null; }
}
async function loadRoom(token, key) {
  const [membersResult, pollsResult] = await Promise.all([
    db.from('pt_participants').select('id,room_key,user_id,name,role').eq('room_key', key).order('created_at'),
    db.from('pt_polls').select('id,room_key,title,status,result_visibility,deadline,created_at,updated_at')
      .eq('room_key', key).order('created_at')
  ]);
  const members = check(membersResult, 'Loading members');
  const polls = check(pollsResult, 'Loading polls');
  if (!active(token, key)) return;
  const me = members.find(m => m.user_id === state.userId);
  if (!me) {
    goHome();
    showError('You are no longer a member of this room, or you were removed by the host.');
    return;
  }
  state.participants = members;
  state.polls = polls;
  state.isHost = me.role === 'Host';
  state.name = me.name;
  if (!polls.some(p => p.id === state.activePollId)) state.activePollId = polls[0]?.id ?? null;
  renderMembers(); renderTabs(); renderHostControls();
  await loadActivePoll(token, key);
}
async function loadActivePoll(token, key) {
  const pollId = state.activePollId;
  const poll = state.polls.find(p => p.id === pollId);
  if (!poll) {
    state.options = []; state.myVote = null; state.totals = {};
    el('poll-title-heading').textContent = 'No polls yet';
    el('options-list').replaceChildren();
    el('outcome-box').textContent = 'The host can create a poll.';
    el('add-option-btn').disabled = true;
    el('new-option-input').disabled = true;
    el('poll-settings-box').hidden = true;
    return;
  }
  const [optionsResult, voteResult, totalsResult] = await Promise.all([
    db.from('pt_options').select('id,poll_id,text,added_by,created_at').eq('poll_id', pollId).order('created_at'),
    db.from('pt_votes').select('option_id').eq('poll_id', pollId).eq('voter_id', state.userId).maybeSingle(),
    db.rpc('pt_vote_totals', {p_poll_id: pollId})
  ]);
  const options = check(optionsResult, 'Loading options');
  const vote = check(voteResult, 'Loading your vote');
  const totals = check(totalsResult, 'Loading results');
  if (!active(token, key) || state.activePollId !== pollId) return;
  state.options = options;
  state.myVote = vote;
  state.totals = Object.fromEntries((totals || []).map(r => [r.option_id, Number(r.vote_count)]));
  renderPoll(poll);
}
function subscribeToRoom(key, token) {
  if (!db || !active(token, key)) return;
  const channel = db.channel(`picktogether:${key}:${state.userId}:${token}`);
  for (const table of ['pt_participants', 'pt_polls', 'pt_options']) {
    channel.on('postgres_changes', {
      event: '*', schema: 'public', table, filter: `room_key=eq.${key}`
    }, () => { if (active(token, key)) scheduleRefresh(); });
  }
  channel.subscribe(next => {
    if (!active(token, key)) return;
    if (next === 'SUBSCRIBED') { status('Live updates on', 'live'); scheduleRefresh(); }
    if (next === 'CHANNEL_ERROR' || next === 'TIMED_OUT' || next === 'CLOSED')
      status('Periodic sync (12s)', 'backup');
  });
  state.channels.push(channel);
}
function addText(parent, tag, value, className = '') {
  const n = document.createElement(tag);
  n.textContent = String(value);
  if (className) n.className = className;
  parent.appendChild(n);
  return n;
}
function renderHostControls() {
  el('add-poll-btn').hidden = !state.isHost;
  el('poll-settings-box').hidden = !state.isHost || !state.activePollId;
}
function renderMembers() {
  const tbody = el('user-table-body'); tbody.replaceChildren();
  el('member-count').textContent = `(${state.participants.length})`;
  for (const member of state.participants) {
    const tr = document.createElement('tr');
    addText(tr, 'td', member.name + (member.user_id === state.userId ? ' (you)' : ''));
    const roleCell = document.createElement('td');
    addText(roleCell, 'span', member.role, `badge ${member.role === 'Host' ? 'host' : 'participant'}`);
    tr.appendChild(roleCell);
    const actions = document.createElement('td');
    if (state.isHost && member.user_id !== state.userId) {
      const kick = addText(actions, 'button', 'Remove', 'btn btn-danger');
      kick.type = 'button';
      kick.onclick = () => kickUser(member.user_id, member.name);
    }
    tr.appendChild(actions); tbody.appendChild(tr);
  }
}
function renderTabs() {
  const tabs = el('poll-tabs-container'); tabs.replaceChildren();
  for (const poll of state.polls) {
    const button = addText(tabs, 'button', poll.title,
      `poll-tab ${poll.id === state.activePollId ? 'active' : ''}`);
    button.type = 'button'; button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(poll.id === state.activePollId));
    button.onclick = () => {
      if (state.activePollId === poll.id) return;
      state.activePollId = poll.id;
      el('poll-title-heading').textContent = 'Loading poll…';
      el('options-list').replaceChildren();
      el('outcome-box').textContent = '';
      renderTabs();
      scheduleRefresh();
    };
  }
}
function closed(poll) {
  return poll.status === 'closed' || (!!poll.deadline && Date.parse(poll.deadline) <= Date.now());
}
function datetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function renderPoll(poll) {
  const isClosed = closed(poll);
  const heading = el('poll-title-heading'); heading.replaceChildren();
  addText(heading, 'span', poll.title);
  addText(heading, 'span', isClosed ? 'CLOSED' : 'OPEN', `badge ${isClosed ? 'closed' : 'open'}`);
  el('poll-settings-box').hidden = !state.isHost;
  el('result-visibility-select').value = poll.result_visibility;
  el('poll-deadline-input').value = datetimeLocal(poll.deadline);
  el('result-visibility-select').disabled = isClosed;
  el('poll-deadline-input').disabled = isClosed;
  el('save-poll-settings-btn').disabled = isClosed;
  el('close-poll-btn').disabled = isClosed;
  el('new-option-input').disabled = isClosed;
  el('add-option-btn').disabled = isClosed;
  const showCounts = poll.result_visibility === 'live' || isClosed;
  const list = el('options-list'); list.replaceChildren();
  for (const option of state.options) {
    const li = document.createElement('li');
    li.className = `option-item ${state.myVote?.option_id === option.id ? 'voted' : ''}`;
    const text = document.createElement('div'); text.className = 'option-details';
    addText(text, 'span', option.text);
    if (showCounts) addText(text, 'strong', ` — ${state.totals[option.id] || 0} vote(s)`);
    li.appendChild(text);
    const action = document.createElement('div'); action.className = 'option-action';
    const author = state.participants.find(m => m.user_id === option.added_by)?.name || 'Former member';
    addText(action, 'small', `By ${author}`);
    if (!isClosed) {
      const selected = state.myVote?.option_id === option.id;
      const button = addText(action, 'button', selected ? 'Your vote' : 'Vote',
        `btn ${selected ? 'btn-secondary' : 'btn-primary'}`);
      button.type = 'button'; button.disabled = selected || pending.has('vote');
      button.onclick = () => castVote(option.id);
    }
    li.appendChild(action); list.appendChild(li);
  }
  const outcome = el('outcome-box');
  if (!isClosed) {
    outcome.textContent = showCounts
      ? 'Voting is open. You can change your vote.'
      : 'Results are hidden until voting closes. Your own vote is highlighted.';
  } else {
    const max = Math.max(0, ...state.options.map(o => state.totals[o.id] || 0));
    const winners = state.options.filter(o => (state.totals[o.id] || 0) === max);
    outcome.textContent = max === 0 ? 'Voting closed: No votes were cast.'
      : winners.length > 1 ? `Tie: ${winners.map(w => w.text).join(', ')} (${max} votes each)`
        : `Winner: 🎉 ${winners[0].text} (${max} votes)`;
  }
}
async function runAction(label, task) {
  if (pending.has(label) || !state.roomKey) return;
  pending.add(label); clearError(); clearNotice();
  try { await task(); await refreshRoom(); }
  catch (e) { showError(e); scheduleRefresh(); }
  finally { pending.delete(label); }
}
async function addOption() {
  const poll = state.polls.find(p => p.id === state.activePollId);
  const value = el('new-option-input').value.trim();
  if (!poll || closed(poll)) return;
  if (!value || value.length > 200) { showError('Option must be 1–200 characters.'); return; }
  if (state.options.some(o => o.text.toLocaleLowerCase() === value.toLocaleLowerCase())) {
    showError('This option already exists.'); return;
  }
  await runAction('option', async () => {
    check(await db.rpc('pt_add_option', {p_poll_id: poll.id, p_text: value}), 'Adding option');
    el('new-option-input').value = '';
  });
}
async function castVote(optionId) {
  const poll = state.polls.find(p => p.id === state.activePollId);
  if (!poll || closed(poll)) return;
  await runAction('vote', async () => {
    check(await db.rpc('pt_cast_vote', {p_poll_id: poll.id, p_option_id: optionId}), 'Submitting vote');
  });
}
async function promptCreatePoll() {
  if (!state.isHost || pending.has('newPoll')) return;
  const title = await showCustomPrompt('New poll', 'Enter a topic or question:', '', 160);
  if (!title) return;
  await runAction('newPoll', async () => {
    const id = check(await db.rpc('pt_create_poll', {
      p_room_key: state.roomKey, p_title: title
    }), 'Creating poll');
    if (!id) throw new Error('Poll creation returned no ID.');
    state.activePollId = id;
  });
}
async function updatePollSettings() {
  const poll = state.polls.find(p => p.id === state.activePollId);
  if (!state.isHost || !poll || closed(poll)) return;
  const value = el('poll-deadline-input').value;
  const parsed = value ? new Date(value) : null;
  if (parsed && (!Number.isFinite(parsed.valueOf()) || parsed.getTime() <= Date.now())) {
    showError('Please choose a valid future deadline, or leave it blank.'); return;
  }
  const visibility = el('result-visibility-select').value;
  await runAction('settings', async () => {
    check(await db.rpc('pt_set_poll_settings', {
      p_poll_id: poll.id, p_result_visibility: visibility,
      p_deadline: parsed ? parsed.toISOString() : null
    }), 'Saving settings');
  });
}
async function closeCurrentPoll() {
  const poll = state.polls.find(p => p.id === state.activePollId);
  if (!state.isHost || !poll || closed(poll) || !confirm('Close this poll? Voting cannot be reopened.')) return;
  await runAction('closePoll', async () => {
    check(await db.rpc('pt_close_poll', {p_poll_id: poll.id}), 'Closing poll');
  });
}
async function kickUser(userId, name) {
  if (!state.isHost || userId === state.userId || !confirm(`Remove ${name} from this room?`)) return;
  await runAction('kick', async () => {
    check(await db.rpc('pt_kick_user', {p_room_key: state.roomKey, p_user_id: userId}), 'Removing member');
  });
}
async function copyInviteLink() {
  if (!state.roomKey) return;
  const url = new URL(location.href);
  url.searchParams.set('room', state.roomKey);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url.toString());
    showNotice('Invite link copied! Send it to someone in a separate browser or device.');
  } catch (_) {
    window.prompt('Copy your invite link:', url.toString());
  }
}
window.addEventListener('click', event => {
  if (!event.target.closest('.nav-item')) closeAllDropdowns();
});
window.addEventListener('DOMContentLoaded', async () => {
  const param = new URLSearchParams(location.search).get('room');
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { /* bad cache */ }
  const key = param || saved?.key;
  if (!key) return;
  if (!/^\d{6}$/.test(key)) { showError('The invite link contains an invalid room code.'); return; }
  // The same browser keeps its anonymous Supabase identity (including host role).
  let name = saved?.key === key && saved?.name ? saved.name : null;
  if (!name) name = await showCustomPrompt('Join a room', `Enter your name for room ${key}:`, '', 40);
  if (name) await joinRoom(key, name);
});
