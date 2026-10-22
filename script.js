// PickTogether — Supabase-backed rooms and real-time voting.
// Install supabase_setup.sql and enable Authentication > Anonymous Sign-Ins first.
// The publishable/anon key belongs in browser code; NEVER put a service_role/secret key here.
const SUPABASE_URL = 'https://hsfuypbcwbiyczzrfdlo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_LZFLW3gSwjckCZxRAQ08Vg_Rh7Xl0y0';
const db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) ?? null;
const SESSION_KEY = 'picktogether:test:last-room';

let state = freshState();
let modalResolve = null;
let refreshPromise = null;
let refreshQueued = false;
let refreshTimer = null;
let pollTimer = null;


function freshState() {
    return { roomKey: null, userId: null, username: null, isHost: false,
        participants: [], polls: [], activePollId: null, options: [], myVote: null,
        counts: {}, subscriptions: [] };
}

function el(id) { return document.getElementById(id); }
function assertOK(response, action) {
    if (response.error) throw new Error(`${action}: ${response.error.message}`);
    return response.data;
}
function message(error) {
    const raw = error instanceof Error ? error.message : String(error);
    console.error(raw);
    let detail = raw;
    if (/duplicate key|unique constraint|23505/i.test(raw))
        detail = /room|create/i.test(raw) ? 'This room code or name is already used. Please try again.'
            : 'That name or option is already in use.';
    if (/row-level security|permission denied|42501/i.test(raw))
        detail = 'Supabase blocked this action. Check that supabase_setup.sql ran and Anonymous Sign-Ins are enabled.';
    const box = el('message');
    if (box) { box.textContent = detail; box.hidden = false; }
    else alert(detail);
}
function clearMessage() { if (el('message')) el('message').hidden = true; }
function friendlyError(error) { message(error); }

async function ensureIdentity() {
    if (!db) throw new Error('Supabase did not load. Check internet access and the Supabase script in index.html.');
    const session = assertOK(await db.auth.getSession(), 'Checking login').session;
    if (session?.user?.id) return session.user.id;
    const { data, error } = await db.auth.signInAnonymously();
    if (error) throw new Error('Guest login failed. Enable Anonymous Sign-Ins in Supabase Authentication settings. ' + error.message);
    return data.user.id;
}

function closeAllDropdowns() {
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
}
function toggleDropdown(id) {
    const item = el(id), opening = !item.classList.contains('active');
    closeAllDropdowns();
    if (opening) item.classList.add('active');
}
function showCustomPrompt(title, description, defaultValue = '') {
    return new Promise(resolve => {
        closeAllDropdowns();
        // Resolve a prior prompt if a second action was triggered before the first finished.
        if (modalResolve) modalResolve(null);
        modalResolve = resolve;
        el('modal-title').textContent = title;
        el('modal-desc').textContent = description;
        const input = el('modal-input');
        input.value = defaultValue;
        el('custom-modal').classList.add('active');
        input.onkeydown = e => { if (e.key === 'Enter') closeModal(true); };
        input.focus();
    });
}
function closeModal(submitted) {
    const value = el('modal-input').value.trim();
    el('custom-modal').classList.remove('active');
    if (modalResolve) { modalResolve(submitted ? value : null); modalResolve = null; }
}
function makeRoomCode() {
    const numbers = new Uint32Array(1);
    crypto.getRandomValues(numbers);
    return String(100000 + (numbers[0] % 900000));
}
function rememberRoom() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ key: state.roomKey, name: state.username }));
    const url = new URL(location.href);
    url.searchParams.set('room', state.roomKey);
    history.replaceState({}, '', url);
}

async function createRoom() {
    closeAllDropdowns(); clearMessage();
    const name = await showCustomPrompt('Create Room', 'Enter your display name as the host:', 'HostUser');
    if (!name) return;
    try {
        const userId = await ensureIdentity();
        let created;
        for (let tries = 0; tries < 5; tries++) {
            const key = makeRoomCode();
            const result = await db.rpc('pt_create_room', { p_room_key: key, p_name: name });
            if (!result.error) { created = result.data[0]; break; }
            if (result.error.code !== '23505') throw result.error;
        }
        if (!created) throw new Error('Could not generate a unique room code. Try again.');
        clearSubscriptions();
        state = freshState();
        state.userId = userId; state.username = name;
        state.roomKey = created.room_key; state.activePollId = created.poll_id;
        await enterRoom();
    } catch (err) { friendlyError(err); }
}
async function promptJoinRoom() {
    closeAllDropdowns(); clearMessage();
    const key = await showCustomPrompt('Join Room', 'Enter the six-digit room code:');
    if (key === null) return;
    if (!/^\d{6}$/.test(key)) { message('Please enter a valid six-digit code.'); return; }
    const name = await showCustomPrompt('Join Room', `Enter your name to join room ${key}:`, 'Participant');
    if (!name) return;
    await joinRoom(key, name);
}
async function joinRoom(key, name) {
    clearMessage();
    if (!/^\d{6}$/.test(key) || !name.trim()) { message('Enter a valid room code and display name.'); return; }
    try {
        const userId = await ensureIdentity();
        const joined = assertOK(await db.rpc('pt_join_room', {
            p_room_key: key, p_name: name.trim()
        }), 'Joining room');
        if (!joined?.length) throw new Error('Could not join room.');
        clearSubscriptions();
        state = freshState();
        state.userId = userId; state.username = name.trim(); state.roomKey = key;
        state.isHost = joined[0].role === 'Host';
        await enterRoom();
    } catch (err) { friendlyError(err); }
}
async function enterRoom() {
    clearSubscriptions();
    el('home-view').classList.remove('active');
    el('room-view').classList.add('active');
    el('room-key-display').style.display = 'inline-flex';
    el('key-value').textContent = state.roomKey;
    rememberRoom();
    try { await refreshRoom(); }
    catch (err) { friendlyError(err); goHome(false); return; }
    subscribeToRoom(state.roomKey);
    // Backup refresh if browser/Realtime connection is interrupted.
    pollTimer = setInterval(() => { if (state.roomKey) queueRefresh(); }, 20000);
}

async function fetchRoomData() {
    const key = state.roomKey;
    if (!key) return;
    const [membersResponse, pollsResponse] = await Promise.all([
        db.from('pt_participants').select('id,room_key,user_id,name,role').eq('room_key', key).order('created_at'),
        db.from('pt_polls').select('*').eq('room_key', key).order('created_at')
    ]);
    const members = assertOK(membersResponse, 'Loading members');
    const polls = assertOK(pollsResponse, 'Loading polls');
    if (key !== state.roomKey) return;
    const self = members.find(p => p.user_id === state.userId);
    if (!self) {
        goHome();
        message('You are no longer a member of this room.');
        return;
    }
    state.participants = members;
    state.isHost = self.role === 'Host';
    state.username = self.name;
    state.polls = polls;
    if (!polls.some(p => p.id === state.activePollId)) state.activePollId = polls[0]?.id ?? null;
    renderMembers(); renderPollTabs(); renderHostControls();
    await fetchActivePollDetails();
}
async function fetchActivePollDetails() {
    const pollId = state.activePollId;
    const poll = state.polls.find(p => p.id === pollId);
    if (!poll) {
        state.options = []; state.myVote = null; state.counts = {};
        el('poll-title-heading').textContent = 'No polls yet';
        el('options-list').replaceChildren();
        el('outcome-box').textContent = 'The host can create a poll.';
        return;
    }
    const [optionResponse, myVoteResponse, countResponse] = await Promise.all([
        db.from('pt_options').select('*').eq('poll_id', pollId).order('created_at'),
        db.from('pt_votes').select('option_id').eq('poll_id', pollId).eq('voter_id', state.userId).maybeSingle(),
        db.rpc('pt_vote_totals', { p_poll_id: pollId })
    ]);
    const options = assertOK(optionResponse, 'Loading options');
    const myVote = assertOK(myVoteResponse, 'Loading your vote');
    const totals = assertOK(countResponse, 'Loading results');
    if (pollId !== state.activePollId || !state.roomKey) return;
    state.options = options;
    state.myVote = myVote;
    state.counts = Object.fromEntries(totals.map(r => [r.option_id, Number(r.vote_count)]));
    renderOptionsAndResults(poll);
}
function queueRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshRoom().catch(friendlyError); }, 125);
}
async function refreshRoom() {
    if (refreshPromise) { refreshQueued = true; return refreshPromise; }
    refreshPromise = (async () => {
        do {
            refreshQueued = false;
            if (state.roomKey) await fetchRoomData();
        } while (refreshQueued && state.roomKey);
    })();
    try { await refreshPromise; }
    finally { refreshPromise = null; }
}
function subscribeToRoom(key) {
    if (!db) return;
    const channel = db.channel(`pt-room-${key}-${state.userId}`);
    for (const table of ['pt_participants', 'pt_polls', 'pt_options', 'pt_votes']) {
        channel.on('postgres_changes', {
            event: '*', schema: 'public', table, filter: `room_key=eq.${key}`
        }, () => { if (state.roomKey === key) queueRefresh(); });
    }
    channel.subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
            console.warn('Realtime disconnected; periodic refresh will continue.', status);
        if (status === 'SUBSCRIBED') queueRefresh();
    });
    state.subscriptions.push(channel);
}
function clearSubscriptions() {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (db) state.subscriptions.forEach(ch => db.removeChannel(ch));
    state.subscriptions = [];
}

function appendText(parent, tag, text, className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
}
function renderHostControls() {
    el('add-poll-btn').style.display = state.isHost ? 'inline-block' : 'none';
    el('poll-settings-box').style.display = state.isHost ? 'block' : 'none';
}
function renderMembers() {
    const tbody = el('user-table-body'); tbody.replaceChildren();
    state.participants.forEach(member => {
        const row = document.createElement('tr');
        appendText(row, 'td', member.name);
        const roleCell = document.createElement('td');
        appendText(roleCell, 'span', member.role, `badge ${member.role.toLowerCase()}`);
        row.appendChild(roleCell);
        const action = document.createElement('td');
        if (state.isHost && member.user_id !== state.userId) {
            const kick = appendText(action, 'button', 'Kick', 'btn btn-danger');
            kick.style.padding = '2px 6px';
            kick.onclick = () => kickUser(member.user_id);
        }
        row.appendChild(action); tbody.appendChild(row);
    });
}
function renderPollTabs() {
    const container = el('poll-tabs-container'); container.replaceChildren();
    state.polls.forEach(poll => {
        const button = appendText(container, 'button', poll.title,
            `poll-tab ${poll.id === state.activePollId ? 'active' : ''}`);
        button.onclick = () => {
            state.activePollId = poll.id;
            renderPollTabs();
            fetchActivePollDetails().catch(friendlyError);
        };
    });
}
function isPollClosed(poll) {
    return poll.status === 'closed' || (poll.deadline && new Date(poll.deadline) <= new Date());
}
function localDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso), pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function renderOptionsAndResults(poll) {
    const closed = isPollClosed(poll);
    const title = el('poll-title-heading'); title.replaceChildren();
    appendText(title, 'span', poll.title);
    appendText(title, 'span', closed ? 'CLOSED' : 'OPEN', `badge ${closed ? 'closed' : 'open'}`);
    el('result-visibility-select').value = poll.result_visibility || 'live';
    el('poll-deadline-input').value = localDateTime(poll.deadline);
    const optionInput = el('new-option-input');
    optionInput.disabled = closed;
    el('add-option-btn').disabled = closed;
    el('close-poll-btn').disabled = closed;
    const showCounts = poll.result_visibility === 'live' || closed;
    const list = el('options-list'); list.replaceChildren();
    for (const option of state.options) {
        const item = document.createElement('li');
        item.className = `option-item ${state.myVote?.option_id === option.id ? 'voted' : ''}`;
        const main = document.createElement('span');
        appendText(main, 'span', option.text);
        if (showCounts) appendText(main, 'strong', ` (${state.counts[option.id] ?? 0} votes)`);
        item.appendChild(main);
        const right = document.createElement('div');
        const owner = state.participants.find(p => p.user_id === option.added_by)?.name ?? 'Former member';
        const small = appendText(right, 'small', `By: ${owner}`);
        small.style.marginRight = '10px';
        if (!closed) {
            const picked = state.myVote?.option_id === option.id;
            const button = appendText(right, 'button', picked ? 'Your Vote' : 'Vote',
                `btn ${picked ? 'btn-secondary' : 'btn-primary'}`);
            button.disabled = picked;
            button.onclick = () => castVote(option.id);
        }
        item.appendChild(right); list.appendChild(item);
    }
    const outcome = el('outcome-box');
    if (!closed) {
        outcome.textContent = showCounts ? 'Poll open. You can change your vote while voting is open.'
            : 'Results are hidden until voting closes.';
    } else {
        const best = Math.max(0, ...state.options.map(opt => state.counts[opt.id] ?? 0));
        const winning = state.options.filter(opt => (state.counts[opt.id] ?? 0) === best);
        if (best === 0) outcome.textContent = 'Voting closed: No votes were cast.';
        else if (winning.length > 1) outcome.textContent = `Tie: ${winning.map(o => o.text).join(', ')} (${best} votes each)`;
        else outcome.textContent = `Winner: 🎉 ${winning[0].text} (${best} votes)`;
    }
}

async function addOption() {
    clearMessage();
    const input = el('new-option-input');
    const value = input.value.trim();
    const poll = state.polls.find(p => p.id === state.activePollId);
    if (!value || !poll || isPollClosed(poll)) return;
    if (state.options.some(o => o.text.toLocaleLowerCase() === value.toLocaleLowerCase())) {
        message('That option already exists.'); return;
    }
    try {
        assertOK(await db.from('pt_options').insert({
            room_key: state.roomKey, poll_id: poll.id, text: value, added_by: state.userId
        }), 'Adding option');
        input.value = '';
        await refreshRoom();
    } catch (err) { friendlyError(err); }
}
async function castVote(optionId) {
    clearMessage();
    const poll = state.polls.find(p => p.id === state.activePollId);
    if (!poll || isPollClosed(poll)) return;
    try {
        assertOK(await db.from('pt_votes').upsert({
            room_key: state.roomKey, poll_id: poll.id, option_id: optionId, voter_id: state.userId
        }, { onConflict: 'poll_id,voter_id' }), 'Voting');
        await refreshRoom();
    } catch (err) { friendlyError(err); }
}
async function promptCreatePoll() {
    if (!state.isHost) return;
    clearMessage();
    const title = await showCustomPrompt('New Poll', 'Enter a question or topic:', 'Where should we eat?');
    if (!title) return;
    try {
        const added = assertOK(await db.from('pt_polls')
            .insert({ room_key: state.roomKey, title, status: 'open' }).select('id').single(), 'Creating poll');
        state.activePollId = added.id;
        await refreshRoom();
    } catch (err) { friendlyError(err); }
}
async function updatePollSettings() {
    if (!state.isHost) return;
    clearMessage();
    const deadlineInput = el('poll-deadline-input').value;
    const parsed = deadlineInput ? new Date(deadlineInput) : null;
    if (parsed && Number.isNaN(parsed.valueOf())) { message('Invalid deadline date.'); return; }
    try {
        assertOK(await db.from('pt_polls').update({
            result_visibility: el('result-visibility-select').value,
            deadline: parsed ? parsed.toISOString() : null
        }).eq('id', state.activePollId).select('id').single(), 'Updating poll settings');
        await refreshRoom();
    } catch (err) { friendlyError(err); await refreshRoom().catch(friendlyError); }
}
async function closeCurrentPoll() {
    if (!state.isHost) return;
    clearMessage();
    try {
        assertOK(await db.from('pt_polls').update({status:'closed'}).eq('id', state.activePollId).select('id').single(), 'Closing poll');
        await refreshRoom();
    } catch (err) { friendlyError(err); }
}
async function kickUser(userId) {
    if (!state.isHost || userId === state.userId) return;
    clearMessage();
    try {
        assertOK(await db.rpc('pt_kick_user', {
            p_room_key: state.roomKey, p_user_id: userId
        }), 'Removing member');
        await refreshRoom();
    } catch (err) { friendlyError(err); }
}
async function copyInviteLink() {
    const url = new URL(location.href);
    url.searchParams.set('room', state.roomKey);
    try {
        await navigator.clipboard.writeText(url.toString());
        alert('Invite link copied!');
    } catch (err) { friendlyError(new Error('Could not copy automatically. Your invite link is: ' + url)); }
}
function goHome(clearSaved = true) {
    clearSubscriptions();
    state = freshState();
    el('room-view').classList.remove('active');
    el('home-view').classList.add('active');
    el('room-key-display').style.display = 'none';
    if (clearSaved) localStorage.removeItem(SESSION_KEY);
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState({}, '', url);
}

window.addEventListener('click', e => {
    if (!e.target.closest('.nav-item')) closeAllDropdowns();
});
window.addEventListener('DOMContentLoaded', async () => {
    const fromUrl = new URLSearchParams(location.search).get('room');
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    const key = fromUrl || saved?.key;
    if (!key) return;
    if (!/^\d{6}$/.test(key)) { message('This invite link contains an invalid room code.'); return; }
    const name = saved?.key === key && saved?.name ? saved.name
        : await showCustomPrompt('Join Room', `Enter your display name to join room ${key}:`, 'Participant');
    if (name) await joinRoom(key, name);
});
